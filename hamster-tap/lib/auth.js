'use strict';
// Авторизация: доверяем данным Telegram только после проверки подписи initData.
// Алгоритм из документации Telegram Mini Apps:
//   secret = HMAC_SHA256(key="WebAppData", data=<bot_token>)
//   hash   = hex(HMAC_SHA256(key=secret, data=<data_check_string>))
// где data_check_string — все поля initData, кроме hash, отсортированные по имени
// и склеенные через "\n".
const crypto = require('crypto');
const { GAME } = require('./game');

// Разбор строки initData (URL-encoded набор полей).
function parseInitData(initData) {
  const params = new URLSearchParams(initData || '');
  const out = {};
  for (const [key, value] of params.entries()) out[key] = value;
  return out;
}

// Проверка подписи. botToken — токен от BotFather, теперь всегда с префиксом "WebAppData".
function validateInitData(initData, botToken, { now = Date.now(), maxAgeMs = 0 } = {}) {
  const params = parseInitData(initData);
  const hash = params.hash;
  if (!hash) return { ok: false, error: 'initData без hash' };

  const dataCheckString = Object.keys(params)
    .filter((key) => key !== 'hash')
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'подпись initData не совпала' };
  }

  const authDate = Number(params.auth_date || 0) * 1000;
  if (maxAgeMs > 0 && authDate > 0 && now - authDate > maxAgeMs) {
    return { ok: false, error: 'initData устарела' };
  }

  let user = null;
  try {
    user = params.user ? JSON.parse(params.user) : null;
  } catch {
    return { ok: false, error: 'поле user не является JSON' };
  }
  if (!user || !user.id) return { ok: false, error: 'в initData нет пользователя' };

  return { ok: true, user, startParam: params.start_param || '', authDate: authDate || now };
}

// Идентификатор пригласившего из start_param: "ref_123456" -> 123456.
function parseReferrer(startParam) {
  const match = /^ref_(\d{1,20})$/.exec(String(startParam || '').trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Вход в игру. В Telegram — по проверенной initData, в dev-режиме (ALLOW_DEV)
 * — по локальному идентификатору из браузера. Новый игрок создаётся сразу;
 * для него применяется реферальный бонус, если пришёл по ссылке-приглашению.
 */
function login(store, payload, config, now = Date.now()) {
  const { initData = '', devId = '', devName = '', startParam = '' } = payload || {};

  let tgId;
  let profile;
  let refParam = startParam;

  if (config.BOT_TOKEN && initData) {
    const verdict = validateInitData(initData, config.BOT_TOKEN, {
      now,
      maxAgeMs: config.AUTH_MAX_AGE_MS
    });
    if (!verdict.ok) return { error: verdict.error, status: 401 };
    tgId = Number(verdict.user.id);
    profile = {
      username: verdict.user.username || null,
      firstName: verdict.user.first_name || null,
      lastName: verdict.user.last_name || null,
      // Язык и Premium берём из проверенной initData: они уходят в userMeta
      // рекламной сети, поэтому подделывать их со стороны клиента нельзя.
      languageCode: verdict.user.language_code || null,
      isPremium: verdict.user.is_premium ? 1 : 0
    };
    refParam = verdict.startParam || startParam;
  } else if (initData && !config.BOT_TOKEN) {
    // initData есть, но токен не настроен — проверить подпись нечем.
    return { error: 'сервер не настроен: не задан BOT_TOKEN', status: 503 };
  } else if (config.ALLOW_DEV) {
    const id = Number(devId);
    if (!Number.isSafeInteger(id) || id === 0) {
      return { error: 'нужен devId для локального входа', status: 400 };
    }
    tgId = id;
    profile = {
      username: `dev${Math.abs(id) % 10000}`,
      firstName: devName || 'Dev Игрок',
      lastName: null,
      languageCode: null,
      isPremium: 0
    };
  } else {
    return { error: 'нет initData: открывайте игру из Telegram', status: 401 };
  }

  let user = store.userByTgId(tgId);
  let referralApplied = false;
  // Данные для поздравления обоих участников приглашения (нужны только на первом входе).
  let referralInfo = null;
  if (!user) {
    // Приглашение может прийти ссылкой на мини-апп (start_param = ref_<tg_id>)
    // или через бота (/start ref_<tg_id>).
    const referrerTgId = parseReferrer(refParam) || store.takePendingRef(tgId);
    let referrerId = null;
    if (referrerTgId && referrerTgId !== tgId) {
      const referrer = store.userByTgId(referrerTgId);
      if (referrer) {
        referrerId = referrer.id;
        // Награда пригласившему не начисляется сразу: она придёт, когда друг
        // реально поиграет (referralTapsTarget тапов, см. service.tap). Поэтому
        // здесь только привязка — за пустые приглашения платить не нужно.
        referralApplied = true;
        referralInfo = {
          referrerTgId: referrer.tg_id,
          referrerName: referrer.first_name,
          invitedTgId: tgId,
          invitedName: profile.firstName,
          referrerBonus: GAME.referralBonus,
          invitedBonus: GAME.referralInvitedBonus,
          tapsTarget: GAME.referralTapsTarget
        };
      }
    }
    user = store.createUser({ tgId, ...profile, referrerId, now });
    const patch = { language_code: profile.languageCode, is_premium: profile.isPremium };
    if (referralApplied) {
      // Приветственный бонус другу — сразу; награду пригласившему начислит
      // первый тап, которым друг доберёт порог активности.
      patch.coins = user.coins + GAME.referralInvitedBonus;
      patch.total_earned = user.total_earned + GAME.referralInvitedBonus;
    }
    user = store.updateUser(user.id, patch);
  } else {
    // Уже игравший не может стать приглашённым — старый «отложенный» реферал убираем.
    store.takePendingRef(tgId);
    const patch = {};
    if (profile.username !== user.username) patch.username = profile.username;
    if (profile.firstName !== user.first_name) patch.first_name = profile.firstName;
    // Язык и Premium могли измениться — держим их актуальными для userMeta рекламы.
    if (profile.languageCode !== (user.language_code || null)) patch.language_code = profile.languageCode;
    if (Number(profile.isPremium) !== Number(user.is_premium || 0)) patch.is_premium = profile.isPremium;
    if (Object.keys(patch).length) user = store.updateUser(user.id, patch);
  }

  const token = crypto.randomBytes(24).toString('hex');
  store.createSession(token, user.id, now, config.SESSION_TTL_MS);
  return { token, user, referralApplied, referral: referralInfo };
}

module.exports = { parseInitData, validateInitData, parseReferrer, login };
