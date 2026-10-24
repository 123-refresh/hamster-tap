'use strict';
// Рекламные сети: восстановление энергии за просмотр.
//
// Chanify — реклама приходит сообщением от бота в чат: клиентского SDK у мини-аппа
// нет, зовём их POST-напрямую (fetch есть и в Node, и в Cloudflare Workers).
// Monetag — rewarded-ролик внутри мини-аппа: показ идёт на клиенте через их SDK
// (`show_<zone>` из тега данных кабинета), сервер только выдаёт одноразовую сессию
// и параметры показа. Подробности вызова — в web/app.js.
//
// Важно: функции сети никогда не бросают исключение — недоступная реклама не
// должна ломать игру, максимум игрок увидит «реклама сейчас недоступна».

const API = 'https://api.chanify.online/v1/ad';
const TIMEOUT_MS = 3000;

/**
 * Просит Chanify отправить рекламу в чат игрока.
 * config: CHANIFY_API_KEY (секрет), AD_MODE ('live' | 'stub').
 * Возвращает { shown, reason, impressionId } — reason заполняется и при отказе
 * (cooldown, frequency_cap, no_matching_campaign, delivery_failed, disabled).
 */
async function showChatAd(config, { chatId, userId, userMeta = {} } = {}) {
  if (!config || !config.CHANIFY_API_KEY) return { shown: false, reason: 'disabled', impressionId: null };

  // Тестовый режим: сеть не дёргаем, но выдачу считаем успешной, чтобы можно было
  // прогнать весь путь «реклама → возврат → энергия» без настоящей рекламы.
  if (config.AD_MODE === 'stub') {
    const id = `stub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return { shown: true, reason: 'stub', impressionId: id };
  }

  // Тестовый режим «рекламы нет»: проверяем ветку отказа, не ходя в сеть.
  if (config.AD_MODE === 'stub-none') {
    return { shown: false, reason: 'no_matching_campaign', impressionId: null };
  }

  const payload = {
    apiKey: config.CHANIFY_API_KEY,
    chatId,
    userId,
    userMeta: {
      languageCode: userMeta.languageCode || undefined,
      isPremium: !!userMeta.isPremium,
      country: userMeta.country || undefined
    }
  };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller && typeof setTimeout === 'function'
    ? setTimeout(() => controller.abort(), TIMEOUT_MS)
    : null;

  try {
    const response = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller ? controller.signal : undefined
    });
    const data = await response.json().catch(() => ({}));
    return {
      shown: data && data.shown === true,
      reason: (data && (data.reason || data.error)) || null,
      impressionId: (data && data.impressionId) || null
    };
  } catch {
    // Таймаут, недоступная сеть, неожиданный ответ — штатная ситуация.
    return { shown: false, reason: 'request_failed', impressionId: null };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Причина отказа в человеческом виде: её показываем игроку. */
function reasonText(reason) {
  if (reason === 'cooldown') return 'реклама уже показывалась недавно — попробуйте чуть позже';
  if (reason === 'frequency_cap') return 'эта реклама уже встречалась слишком часто — попробуйте позже';
  if (reason === 'no_matching_campaign') return 'сейчас нет подходящей рекламы — попробуйте позже';
  if (reason === 'disabled') return 'реклама пока недоступна';
  if (reason === 'client_failed') return 'видео не запустилось — пришлём рекламу в чат';
  return 'не удалось получить рекламу — попробуйте позже';
}

// --- реестр провайдеров ------------------------------------------------------
// Состав и порядок задаёт AD_PROVIDERS (по умолчанию monetag,chanify): первый
// доступный показывает рекламу, следующий подхватывает, если у первого нет
// кампании или он выключен. Провайдер доступен, если заданы его параметры —
// включение новой сети сводится к правке конфига, логика выбора общая.
const KNOWN_PROVIDERS = ['monetag', 'chanify'];

/** Список id провайдеров из конфига в порядке приоритета (без skip). */
function listProviders(config, skip = []) {
  const raw = String((config && config.AD_PROVIDERS) || '').trim();
  const ids = (raw ? raw.split(',') : KNOWN_PROVIDERS)
    .map((id) => id.trim().toLowerCase())
    .filter((id, index, all) => !!id && all.indexOf(id) === index);
  const skipped = (skip || []).map((id) => String(id).trim().toLowerCase());
  return ids.filter((id) => skipped.indexOf(id) === -1);
}

/**
 * Настройки пассивного формата In-App Interstitial из строки вида
 * «2/0.1/30/5/0» (как в data-auto у Monetag): частота, окно в часах, интервал
 * в секундах, задержка первого показа и сброс таймера при каждой перезагрузке.
 * Пусто или мусор — формат выключен (null).
 */
function parseInAppSettings(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const parts = text.split('/').map((part) => part.trim());
  if (parts.length < 4) return null;
  const [frequency, capping, interval, timeout] = parts.map((part) => Number(part));
  if (![frequency, capping, interval, timeout].every((value) => Number.isFinite(value) && value >= 0)) return null;
  return {
    frequency,
    capping,
    interval,
    timeout,
    everyPage: parts[4] === '1' || parts[4] === 'true'
  };
}

/**
 * Параметры провайдера: id, режим показа, доступность и публичные данные показа.
 * Monetag включается, когда в кабинете выданы главная зона SDK и адрес скрипта:
 * одна зона обслуживает все форматы сети, поэтому она же используется для
 * rewarded-ролика (show_<зона>) и для пассивного In-App Interstitial.
 */
function providerInfo(config, id) {
  if (id === 'monetag') {
    const zoneId = String((config && config.MONETAG_ZONE) || '').trim();
    const sdkUrl = String((config && config.MONETAG_SDK_URL) || '').trim();
    return {
      id: 'monetag',
      mode: 'client',
      enabled: !!zoneId && !!sdkUrl,
      zoneId,
      sdkUrl,
      // Пассивный формат: показывается сам по настройкам кабинета, награды не даёт.
      inApp: parseInAppSettings(config && config.MONETAG_INAPP_SETTINGS)
    };
  }
  if (id === 'chanify') {
    return { id: 'chanify', mode: 'chat', enabled: !!(config && config.CHANIFY_API_KEY) };
  }
  return { id, mode: 'unknown', enabled: false };
}

/** Все провайдеры из конфига в порядке приоритета — для статуса и диагностики. */
function providerList(config) {
  return listProviders(config).map((id) => providerInfo(config, id));
}

/** Первый доступный провайдер с учётом уже пробованных. */
function pickProvider(config, skip = []) {
  return listProviders(config, skip)
    .map((id) => providerInfo(config, id))
    .find((provider) => provider.enabled) || null;
}

module.exports = {
  showChatAd,
  reasonText,
  listProviders,
  providerInfo,
  providerList,
  pickProvider,
  parseInAppSettings,
  KNOWN_PROVIDERS,
  API,
  TIMEOUT_MS
};