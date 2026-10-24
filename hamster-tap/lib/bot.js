'use strict';
// Telegram-бот на «голом» Bot API: long polling через глобальный fetch.
// Библиотеки не нужны — бот умеет ровно то, что требуется мини-аппу:
//  /start [ref_<id>]  — приветствие, кнопка «Открыть игру», приглашение друзей
//  /play              — кнопка запуска мини-аппа
//  /me                — прогресс игрока
//  /top               — топ-10 игроков
const game = require('./game');
const shop = require('./shop');
const cosmetics = require('./cosmetics');
const dailycode = require('./dailycode');
const ads = require('./ads');
const paylink = require('./paylink');
const service = require('./service');

const API = 'https://api.telegram.org';

// Компактный формат чисел для сообщений: 12345 -> «12,3 тыс.»
function fmt(value) {
  return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/**
 * Best-effort рассылка: если Telegram недоступен или игрок не начинал чат с
 * ботом, игровое действие всё равно должно пройти — ошибки проглатываем.
 * messages — пары [chat_id, текст].
 */
async function sendAll(base, messages) {
  let sent = 0;
  for (const [chatId, text] of messages) {
    if (!chatId) continue;
    try {
      const res = await fetch(`${base}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      if (res.ok) sent += 1;
    } catch {
      /* уведомление не критично */
    }
  }
  return sent > 0;
}

/**
 * Сообщает о привязке приглашения: друг получил приветственный бонус сразу,
 * а пригласившему награда придёт после referralTapsTarget тапов друга.
 */
async function notifyReferral(config, info) {
  if (!config.BOT_TOKEN || !info || !info.referrerTgId) return false;
  const base = `${API}/bot${config.BOT_TOKEN}`;
  const target = info.tapsTarget || 100;
  return sendAll(base, [
    [
      info.referrerTgId,
      [
        '🎁 <b>Друг присоединился!</b>',
        `${info.invitedName || 'Твой друг'} зашёл в игру по твоей ссылке.`,
        `Награда 🪙 <b>+${fmt(info.referrerBonus)}</b> придёт, как только он сделает ${target} тапов.`
      ].join('\n')
    ],
    [
      info.invitedTgId,
      [
        ' <b>Приветственный бонус</b>',
        `${info.referrerName || 'Друг'} пригласил тебя в игру.`,
        `Начислено: 🪙 <b>+${fmt(info.invitedBonus)}</b>`
      ].join('\n')
    ]
  ]);
}

/** Награда пригласившему: друг доиграл до порога активности. */
async function notifyReferralPayout(config, info) {
  if (!config.BOT_TOKEN || !info || !info.referrerTgId) return false;
  const base = `${API}/bot${config.BOT_TOKEN}`;
  return sendAll(base, [
    [
      info.referrerTgId,
      [
        '🎁 <b>Награда за друга!</b>',
        `${info.invitedName || 'Твой друг'} сделал ${info.taps} тапов.`,
        `Начислено: 🪙 <b>+${fmt(info.bonus)}</b>`
      ].join('\n')
    ]
  ]);
}

function createBot(store, config) {
  const base = `${API}/bot${config.BOT_TOKEN}`;

  async function call(method, payload) {
    const res = await fetch(`${base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
      const error = new Error(`${method}: ${data.description || res.status}`);
      error.status = res.status;
      throw error;
    }
    return data.result;
  }

  // Кнопка запуска мини-аппа появляется только при HTTPS-адресе: так требует Telegram.
  function playKeyboard() {
    if (!config.WEBAPP_URL) return undefined;
    return { inline_keyboard: [[{ text: '🐹 Открыть игру', web_app: { url: config.WEBAPP_URL } }]] };
  }

  // Реклама после ответа бота — так рекомендует Chanify. Включается флагом
  // AD_BOT_ADS=1: по умолчанию чат остаётся чистым, а реклама живёт только в
  // кнопке «энергия за рекламу». Отправка best-effort и не задерживает ответ.
  function maybeShowAd(message) {
    if (config.AD_BOT_ADS !== '1' || !config.CHANIFY_API_KEY) return;
    const from = message && message.from;
    if (!from) return;
    ads.showChatAd(config, {
      chatId: message.chat.id,
      userId: from.id,
      userMeta: { languageCode: from.language_code, isPremium: !!from.is_premium }
    }).catch(() => {});
  }

  async function send(chatId, text, extra = {}) {
    return call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra
    });
  }

  function referralLink(user) {
    if (!config.BOT_USERNAME) return null;
    // Префикс ref_ обязателен: мини-апп отдаёт его как start_param, а сервер
    // разбирает строго ref_<tg_id> (см. lib/auth.parseReferrer).
    return `https://t.me/${config.BOT_USERNAME}?startapp=ref_${user.tg_id}`;
  }

  async function onStart(message, startParam) {
    const user = store.userByTgId(message.from.id);
    const link = user ? referralLink(user) : null;
    const hint = config.WEBAPP_URL
      ? ''
      : '\n\n⚠️ WEBAPP_URL не задан: укажите публичный HTTPS-адрес, чтобы в боте появилась кнопка запуска.';
    const text = [
      `🐹 <b>Hamster Tap</b>, ${message.from.first_name || 'игрок'}!`,
      '',
      'Тапай хомяка, качай карточки-бизнесы и собирай пассивный доход в час.',
      'Ежедневный бонус, бусты, лиги и лидерборд — всё внутри мини-аппа.',
      startParam
        ? user
          ? ''
          : `\n🎁 Приглашение принято — тебе ${fmt(game.GAME.referralInvitedBonus)} монет при первом входе в игру.`
        : '',
      link
        ? `\n👥 Твоя ссылка-приглашение (другу ${fmt(game.GAME.referralInvitedBonus)} сразу, тебе ${fmt(game.GAME.referralBonus)} — как только он сделает ${game.GAME.referralTapsTarget} тапов):\n${link}`
        : '',
      hint
    ].join('\n');
    await send(message.chat.id, text, { reply_markup: playKeyboard() });
    maybeShowAd(message);
  }

  // /start ref_123 — запоминаем пригласившего: приглашение применится при входе в игру.
  async function handleReferral(message, payload) {
    const referrerTgId = Number((/^ref_(\d{1,20})$/.exec(payload) || [])[1]);
    if (!Number.isSafeInteger(referrerTgId) || referrerTgId <= 0) return false;
    if (referrerTgId === message.from.id) return true;
    const invited = store.userByTgId(message.from.id);
    if (invited) return true; // игрок уже в игре, приглашение не применяется
    const referrer = store.userByTgId(referrerTgId);
    if (!referrer) return true;
    store.setPendingRef(message.from.id, referrerTgId, Date.now());
    return true;
  }

  async function onMe(message) {
    const user = store.userByTgId(message.from.id);
    if (!user) {
      await send(message.chat.id, 'Профиля ещё нет — открой игру и тапни хомяка.', {
        reply_markup: playKeyboard()
      });
      return;
    }
    const level = game.levelInfo(user.profit_per_hour);
    const rank = store.rankOf(user);
    const text = [
      `🐹 <b>${user.first_name || 'Игрок'}</b>`,
      `${level.emoji} Лига: <b>${level.name}</b>`,
      `🪙 Монет: <b>${fmt(user.coins)}</b>`,
      `📈 Доход: <b>${fmt(user.profit_per_hour)}</b>/час`,
      `👆 Сила тапа: <b>${user.tap_power}</b> · 🔋 Энергия: ${user.energy}/${user.energy_limit}`,
      `🏆 Место в топе: <b>${rank}</b> из ${store.playersCount()}`,
      `👥 Приглашено друзей: <b>${store.referralCount(user.id)}</b>`,
      `🎁 Награда за друга: ${fmt(game.GAME.referralBonus)} — после ${game.GAME.referralTapsTarget} тапов друга`
    ].join('\n');
    await send(message.chat.id, text, { reply_markup: playKeyboard() });
    maybeShowAd(message);
  }

  async function onTop(message) {
    const rows = store.leaderboard(10);
    if (!rows.length) {
      await send(message.chat.id, 'Топ пока пуст — станьте первым!', { reply_markup: playKeyboard() });
      return;
    }
    const medals = ['🥇', '🥈', '🥉'];
    const lines = rows.map(
      (row) => `${medals[row.rank - 1] || `${row.rank}.`} ${row.name} — 🪙 ${fmt(row.coins)} · 🏅 ${row.ach || 0}`
    );
    await send(message.chat.id, ['🏆 <b>Топ игроков по монетам</b>', '', ...lines].join('\n'), {
      reply_markup: playKeyboard()
    });
    maybeShowAd(message);
  }

  // Напоминания: в локальной версии рассылки нет (её ведёт воркер по расписанию),
  // но настройки хранятся в той же базе, поэтому команда показывает и меняет их.
  const PUSH_KINDS = { energy: 'об энергии', daily: 'о бонусе дня', rank: 'о месте в топе' };

  function notifyState(user) {
    return { energy: !!user.notify_energy, daily: !!user.notify_daily, rank: !!user.notify_rank };
  }

  function pushText(prefs) {
    return [
      '🔔 <b>Напоминания</b>',
      '',
      'Их рассылает облачная версия бота по расписанию (не чаще раза в сутки):',
      '',
      ...Object.entries(PUSH_KINDS).map(
        ([kind, label]) => `${prefs[kind] ? '🔔 включено' : '🔕 выключено'} — ${label}`
      )
    ].join('\n');
  }

  function pushKeyboard(prefs) {
    const rows = Object.entries(PUSH_KINDS).map(([kind, label]) => [{
      text: `${prefs[kind] ? '🔔' : '🔕'} ${label}`,
      callback_data: `push_${prefs[kind] ? 'off' : 'on'}_${kind}`
    }]);
    const play = playKeyboard();
    if (play) rows.push(play.inline_keyboard[0]);
    return { inline_keyboard: rows };
  }

  async function onPush(message, argument) {
    const user = store.userByTgId(message.from.id);
    if (!user) {
      await send(message.chat.id, 'Профиля ещё нет — открой игру и тапни хомяка.', {
        reply_markup: playKeyboard()
      });
      return;
    }

    // Аргумент (/push energy) переключает вид напоминаний — удобно без кнопок.
    const kind = String(argument || '').toLowerCase();
    let current = user;
    if (PUSH_KINDS[kind]) {
      const fresh = store.userByTgId(message.from.id);
      current = store.updateUser(user.id, { [`notify_${kind}`]: fresh[`notify_${kind}`] ? 0 : 1 });
    }
    const prefs = notifyState(current);
    await send(message.chat.id, pushText(prefs), { reply_markup: pushKeyboard(prefs) });
  }

  // Кнопки под сообщением: переключают напоминания (те же настройки, что и в мини-аппе).
  async function onPushCallback(query) {
    const match = /^push_(on|off)_(energy|daily|rank)$/.exec(query.data || '');
    if (!match) {
      await call('answerCallbackQuery', { callback_query_id: query.id });
      return;
    }
    const enabled = match[1] === 'on';
    const kind = match[2];
    const user = store.userByTgId(query.from.id);
    if (!user) {
      await call('answerCallbackQuery', { callback_query_id: query.id, text: 'Профиля нет — открой игру.' });
      return;
    }
    const updated = store.updateUser(user.id, { [`notify_${kind}`]: enabled ? 1 : 0 });
    const prefs = notifyState(updated || user);
    await call('answerCallbackQuery', {
      callback_query_id: query.id,
      text: enabled ? `Напоминания включены: ${PUSH_KINDS[kind]}` : `Напоминания выключены: ${PUSH_KINDS[kind]}`
    });
    if (query.message) {
      await call('editMessageText', {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        text: pushText(prefs),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: pushKeyboard(prefs)
      });
    }
  }

  // --- оплата звёздами (Telegram Stars) ---

  // Telegram ждёт ответ на pre_checkout_query не дольше 10 секунд.
  async function onPreCheckout(query) {
    const parsed = shop.parsePayload(query.invoice_payload);
    const good = parsed ? shop.goodById(parsed.itemId, cosmetics.COSMETICS) : null;
    if (!good) {
      await call('answerPreCheckoutQuery', {
        pre_checkout_query_id: query.id,
        ok: false,
        error_message: 'Товар недоступен — откройте магазин заново.'
      });
      return;
    }
    await call('answerPreCheckoutQuery', { pre_checkout_query_id: query.id, ok: true });
  }

  // Оплата прошла: пишем платёж (charge_id уникален) и выдаём товар один раз.
  async function onSuccessfulPayment(message) {
    const payment = message.successful_payment;
    const parsed = shop.parsePayload(payment.invoice_payload);
    const user = store.userByTgId(message.from.id);

    if (!user || !parsed || parsed.userId !== user.id) {
      await send(message.chat.id, '⚠️ Не удалось сопоставить платёж с игроком. Напишите /paysupport.', {
        reply_markup: playKeyboard()
      });
      return;
    }

    const result = service.deliverPurchase(store, user, {
      itemId: parsed.itemId,
      chargeId: payment.telegram_payment_charge_id,
      stars: payment.total_amount,
      item: payment,
      now: Date.now()
    });
    if (result.duplicate) return;

    await send(message.chat.id, [
      '✅ <b>Оплата прошла!</b>',
      `${result.good.emoji} ${result.good.title}`,
      shop.deliveredText(result.good),
      '',
      `Чек: <code>${payment.telegram_payment_charge_id}</code>`,
      'Нужна помощь или возврат — /paysupport.'
    ].join('\n'), { reply_markup: playKeyboard() });
  }

  async function onPaySupport(message) {
    await send(message.chat.id, [
      '🛟 <b>Помощь с оплатой</b>',
      '',
      'Все покупки в игре — за Telegram Stars. Чек есть в сообщении об оплате и в магазине внутри игры.',
      'Если товар не пришёл или нужен возврат, напишите владельцу бота и пришлите чек:',
      'возврат оформляется в Telegram на тот же чек.'
    ].join('\n'), { reply_markup: playKeyboard() });
  }

  // Код дня: одно и то же значение для всех, действует до конца суток UTC.
  async function onCode(message) {
    const day = game.utcDay(Date.now());
    const code = dailycode.codeFor(day);
    const user = store.userByTgId(message.from.id);
    const claimed = user ? store.questsOfDay(user.id, day).includes(dailycode.CODE_QUEST_ID) : false;
    const minutesLeft = Math.floor(dailycode.msUntilDayEnd(day, Date.now()) / 60000);

    await send(message.chat.id, [
      '🔐 <b>Код дня</b>',
      '',
      'Введите его в игре на вкладке «Задания» и получите награду:',
      '',
      `<code>${code}</code>`,
      '',
      `🪙 ${fmt(dailycode.CODE_REWARD)} · действует ещё ${Math.floor(minutesLeft / 60)} ч ${minutesLeft % 60} мин`,
      claimed ? 'Сегодняшний код вы уже использовали — новый появится после 00:00 UTC.' : ''
    ].filter(Boolean).join('\n'), { reply_markup: playKeyboard() });
    maybeShowAd(message);
  }

  async function onHelp(message) {
    await send(
      message.chat.id,
      [
        '🐹 <b>Hamster Tap</b>',
        '',
        '/play — открыть игру',
        '/me — мой прогресс',
        '/top — топ игроков',
        '/buy — оплата картой или СБП',
        '/push — напоминания о прогрессе',
        '/code — код дня для награды',
        '/paysupport — помощь с оплатой'
      ].join('\n'),
      { reply_markup: playKeyboard() }
    );
  }

  /**
   * Оплата картой/СБП идёт на внешней странице (вне Telegram), поэтому присылаем
   * личную подписанную ссылку: внутри мини-аппа платим звёздами, как требует платформа.
   */
  async function onBuy(message) {
    const user = store.userByTgId(message.from.id);
    const link = user ? paylink.linkFor(config, user.id, Date.now()) : '';
    if (!link) {
      await send(
        message.chat.id,
        'Оплата картой пока не подключена — покупки доступны за звёзды в приложении.',
        { reply_markup: playKeyboard() }
      );
      return;
    }
    const minutes = Math.max(1, Math.round((config.PAY_LINK_TTL_MS || paylink.DEFAULT_TTL_MS) / 60000));
    await send(
      message.chat.id,
      [
        '💳 <b>Оплата картой или СБП</b>',
        'Откройте страницу, выберите товар — он сразу зачислится в игру.',
        '',
        `Ссылка личная и действует ${minutes} минут.`
      ].join('\n'),
      { reply_markup: { inline_keyboard: [[{ text: 'Перейти к оплате', url: link }]] } }
    );
  }

  async function handleUpdate(update) {
    // Счёт: Telegram спрашивает подтверждение до оплаты.
    if (update.pre_checkout_query) return onPreCheckout(update.pre_checkout_query);

    // Кнопки под сообщениями (включая «выключить напоминания») приходят как callback_query.
    if (update.callback_query) return onPushCallback(update.callback_query);

    const message = update.message;
    if (!message) return;
    // Сообщение об оплате приходит без текста — обрабатываем до проверки текста.
    if (message.successful_payment) return onSuccessfulPayment(message);
    if (!message.text) return;
    const text = message.text.trim();
    if (!text.startsWith('/')) return;

    // "/start@MyBot ref_5" -> command = "/start", payload = "ref_5"
    const [rawCommand, ...args] = text.split(/\s+/);
    const command = rawCommand.split('@')[0].toLowerCase();
    const payload = args[0] || '';

    if (command === '/start') {
      await handleReferral(message, payload);
      return onStart(message, payload);
    }
    if (command === '/play') {
      return send(message.chat.id, 'Погнали! 🐹', { reply_markup: playKeyboard() });
    }
    if (command === '/me') return onMe(message);
    if (command === '/top') return onTop(message);
    if (command === '/push') return onPush(message, payload);
    if (command === '/code') return onCode(message);
    if (command === '/buy') return onBuy(message);
    if (command === '/paysupport') return onPaySupport(message);
    return onHelp(message);
  }

  // Основной цикл long polling с растущей паузой при сбоях сети.
  async function poll() {
    let offset = 0;
    let failures = 0;
    for (;;) {
      try {
        const updates = await call('getUpdates', {
          offset,
          timeout: 25,
          // pre_checkout_query обязателен: без него Telegram не доставит запрос
          // подтверждения оплаты и покупка звёздами не пройдёт.
          allowed_updates: ['message', 'callback_query', 'pre_checkout_query']
        });
        failures = 0;
        for (const update of updates) {
          offset = update.update_id + 1;
          try {
            await handleUpdate(update);
          } catch (error) {
            console.error('[bot] обработка апдейта:', error.message);
          }
        }
      } catch (error) {
        failures += 1;
        console.error('[bot] getUpdates:', error.message);
        const pause = Math.min(30000, 1000 * 2 ** failures);
        await new Promise((resolve) => setTimeout(resolve, pause));
      }
    }
  }

  // Быстрая проверка доступности Bot API: в РФ api.telegram.org часто блокируется,
  // и без внятного сообщения в логе непонятно, почему бот молчит.
  async function preflight() {
    try {
      const res = await fetch(`${API}/`, { signal: AbortSignal.timeout(8000) });
      return res.status > 0;
    } catch {
      return false;
    }
  }

  async function start() {
    if (!(await preflight())) {
      console.error('[bot] api.telegram.org недоступен (таймаут).');
      console.error('[bot] Включите VPN/прокси — иначе бот не получит сообщения.');
      console.error('[bot] Мини-апп и сервер при этом работают, просто кнопка в боте не появится.');
    }
    try {
      await call('setMyCommands', {
        commands: [
          { command: 'play', description: 'Открыть игру' },
          { command: 'me', description: 'Мой прогресс' },
          { command: 'top', description: 'Топ игроков' },
          { command: 'code', description: 'Код дня для награды' },
          { command: 'buy', description: 'Оплата картой или СБП' },
          { command: 'push', description: 'Напоминания о прогрессе' },
          { command: 'paysupport', description: 'Помощь с оплатой' },
          { command: 'help', description: 'Что умеет бот' }
        ]
      });
      const me = await call('getMe');
      console.log(`[bot] запущен: @${me.username}`);
      if (!config.WEBAPP_URL) {
        console.log('[bot] WEBAPP_URL не задан — кнопка запуска игры в боте не появится.');
      }
    } catch (error) {
      const hint = /fetch failed|ETIMEDOUT|ENOTFOUND/i.test(error.message)
        ? ' Похоже, нет доступа к api.telegram.org — включите VPN/прокси.'
        : '';
      console.error('[bot] не удалось инициализироваться:', error.message + hint);
      return;
    }
    poll();
  }

  start();
  return { send, call, poll, stop: () => {} };
}

function startBot(store, config) {
  if (!config.BOT_TOKEN) {
    console.log('[bot] BOT_TOKEN не задан — бот не запускается.');
    return null;
  }
  return createBot(store, config);
}

module.exports = { startBot, createBot, notifyReferral, notifyReferralPayout, fmt };
