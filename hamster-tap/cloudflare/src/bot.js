// Бот на webhook: Telegram присылает апдейты на /webhook/<secret>, поэтому
// постоянный процесс не нужен — в этом главное отличие от локальной версии,
// где бот работает через long polling.
import game from '../../lib/game.js';
import shop from '../../lib/shop.js';
import cosmetics from '../../lib/cosmetics.js';
import dailycode from '../../lib/dailycode.js';
import ads from '../../lib/ads.js';
import paylink from '../../lib/paylink.js';
import * as service from './service.js';

const API = 'https://api.telegram.org';

function fmt(value) {
  return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 })
    .format(value);
}

async function call(env, method, payload) {
  const res = await fetch(`${API}/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  return res.json().catch(() => ({}));
}

// Кнопка запуска мини-аппа: Telegram требует https-адрес.
function playKeyboard(env) {
  const url = (env.WEBAPP_URL || '').replace(/\/+$/, '');
  if (!url) return undefined;
  return { inline_keyboard: [[{ text: '🐹 Открыть игру', web_app: { url } }]] };
}

function send(env, chatId, text, extra = {}) {
  return call(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra
  });
}

// Реклама после ответа бота — так рекомендует Chanify. Включается флагом
// AD_BOT_ADS=1: по умолчанию чат остаётся чистым, а реклама живёт только в
// кнопке «энергия за рекламу». Отправка best-effort и не задерживает ответ.
function maybeShowAd(env, message) {
  if (env.AD_BOT_ADS !== '1') return;
  const from = message && message.from;
  if (!from) return;
  ads.showChatAd(env, {
    chatId: message.chat.id,
    userId: from.id,
    userMeta: { languageCode: from.language_code, isPremium: !!from.is_premium }
  }).catch(() => {});
}

function referralLink(env, user) {
  if (!env.BOT_USERNAME) return null;
  // Префикс ref_ обязателен: мини-апп отдаёт его как start_param, а сервер
  // разбирает строго ref_<tg_id> (lib/auth.parseReferrer).
  return `https://t.me/${env.BOT_USERNAME}?startapp=ref_${user.tg_id}`;
}

// Best-effort рассылка: сбой Telegram не должен ломать игровое действие,
// поэтому ошибки проглатываем. messages — пары [chat_id, текст].
async function sendAll(env, messages) {
  let sent = 0;
  for (const [chatId, text] of messages) {
    if (!chatId) continue;
    try {
      const data = await call(env, 'sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      if (data && data.ok) sent += 1;
    } catch {
      /* уведомление не критично */
    }
  }
  return sent > 0;
}

// Сообщает о привязке приглашения: другу приветственный бонус начислен сразу,
// а пригласившему награда придёт после referralTapsTarget тапов друга.
export async function notifyReferral(env, info) {
  if (!env.BOT_TOKEN || !info || !info.referrerTgId) return false;
  const target = info.tapsTarget || 100;
  return sendAll(env, [
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

// Награда пригласившему: друг доиграл до порога активности.
export async function notifyReferralPayout(env, info) {
  if (!env.BOT_TOKEN || !info || !info.referrerTgId) return false;
  return sendAll(env, [
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

// --- напоминания: /push и кнопки «выключить/включить» под сообщениями ---

const PUSH_KINDS = {
  energy: 'об энергии',
  daily: 'о бонусе дня',
  rank: 'о месте в топе'
};

function notifyState(user) {
  return {
    energy: !!user.notify_energy,
    daily: !!user.notify_daily,
    rank: !!user.notify_rank
  };
}

function pushText(prefs) {
  return [
    '🔔 <b>Напоминания</b>',
    '',
    'Бот напоминает о восстановленной энергии, готовом бонусе дня и твоём месте в топе.',
    'Каждое напоминание приходит не чаще одного раза в сутки, пока оно включено:',
    '',
    ...Object.entries(PUSH_KINDS).map(
      ([kind, label]) => `${prefs[kind] ? '🔔 включено' : '🔕 выключено'} — ${label}`
    )
  ].join('\n');
}

// Кнопки настроек: каждая переключает свой вид напоминаний.
function pushKeyboard(env, prefs) {
  const rows = Object.entries(PUSH_KINDS).map(([kind, label]) => [{
    text: `${prefs[kind] ? '🔔' : '🔕'} ${label}`,
    callback_data: `push_${prefs[kind] ? 'off' : 'on'}_${kind}`
  }]);
  const play = playKeyboard(env);
  if (play) rows.push(play.inline_keyboard[0]);
  return { inline_keyboard: rows };
}

async function onPush(store, env, message) {
  const user = await store.userByTgId(message.from.id);
  if (!user) {
    await send(env, message.chat.id, 'Профиля ещё нет — открой игру и тапни хомяка.', {
      reply_markup: playKeyboard(env)
    });
    return;
  }
  const prefs = notifyState(user);
  await send(env, message.chat.id, pushText(prefs), { reply_markup: pushKeyboard(env, prefs) });
}

// Кнопка «выключить напоминания» из самой рассылки (см. push.js).
async function onPushCallback(store, env, query) {
  const match = /^push_(on|off)_(energy|daily|rank)$/.exec(query.data || '');
  if (!match) {
    await call(env, 'answerCallbackQuery', { callback_query_id: query.id });
    return;
  }

  const enabled = match[1] === 'on';
  const kind = match[2];
  const user = await store.userByTgId(query.from.id);
  if (!user) {
    await call(env, 'answerCallbackQuery', { callback_query_id: query.id, text: 'Профиля нет — открой игру.' });
    return;
  }

  const updated = await store.updateUser(user.id, { [`notify_${kind}`]: enabled ? 1 : 0 });
  const prefs = notifyState(updated || user);
  await call(env, 'answerCallbackQuery', {
    callback_query_id: query.id,
    text: enabled ? `Напоминания включены: ${PUSH_KINDS[kind]}` : `Напоминания выключены: ${PUSH_KINDS[kind]}`
  });

  // Обновляем текст сообщения: кнопка теперь предлагает обратное действие.
  if (query.message) {
    await call(env, 'editMessageText', {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text: pushText(prefs),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: pushKeyboard(env, prefs)
    });
  }
}

// /start ref_123 — запоминаем пригласившего: приглашение применится при входе в игру.
async function rememberReferral(store, message, payload) {
  const match = /^ref_(\d{1,20})$/.exec(payload || '');
  if (!match) return;
  const referrerTgId = Number(match[1]);
  if (!Number.isSafeInteger(referrerTgId) || referrerTgId <= 0) return;
  if (referrerTgId === message.from.id) return;
  if (await store.userByTgId(message.from.id)) return; // игрок уже в игре
  if (!(await store.userByTgId(referrerTgId))) return;
  await store.setPendingRef(message.from.id, referrerTgId, Date.now());
}

async function onStart(store, env, message, payload) {
  const user = await store.userByTgId(message.from.id);
  const link = user ? referralLink(env, user) : null;
  const hint = env.WEBAPP_URL
    ? ''
    : '\n\n⚠️ Не задан WEBAPP_URL: укажите адрес воркера, чтобы появилась кнопка запуска.';
  const invited = payload && /^ref_\d+$/.test(payload) && !user;
  const text = [
    `🐹 <b>Hamster Tap</b>, ${message.from.first_name || 'игрок'}!`,
    '',
    'Тапай хомяка, качай карточки-бизнесы и собирай пассивный доход в час.',
    'Ежедневный бонус, бусты, лиги и лидерборд — всё внутри мини-аппа.',
    invited ? `\n🎁 Приглашение принято — тебе ${fmt(game.GAME.referralInvitedBonus)} монет при первом входе.` : '',
    link
      ? `\n👥 Твоя ссылка-приглашение (другу ${fmt(game.GAME.referralInvitedBonus)} сразу, тебе ${fmt(game.GAME.referralBonus)} — как только он сделает ${game.GAME.referralTapsTarget} тапов):\n${link}`
      : '',
    hint
  ].join('\n');
  await send(env, message.chat.id, text, { reply_markup: playKeyboard(env) });
  maybeShowAd(env, message);
}

async function onMe(store, env, message) {
  const user = await store.userByTgId(message.from.id);
  if (!user) {
    await send(env, message.chat.id, 'Профиля ещё нет — открой игру и тапни хомяка.', {
      reply_markup: playKeyboard(env)
    });
    return;
  }
  const level = game.levelInfo(user.profit_per_hour);
  const snap = await store.rankSnapshot();
  const invited = await store.referralCount(user.id);
  const text = [
    `🐹 <b>${user.first_name || 'Игрок'}</b>`,
    `${level.emoji} Лига: <b>${level.name}</b>`,
    `🪙 Монет: <b>${fmt(user.coins)}</b>`,
    `📈 Доход: <b>${fmt(user.profit_per_hour)}</b>/час`,
    `👆 Сила тапа: <b>${user.tap_power}</b> · 🔋 Энергия: ${user.energy}/${user.energy_limit}`,
    `🏆 Место в топе: <b>${snap.ranks.get(user.id) || '—'}</b> из ${snap.players}`,
    `👥 Приглашено друзей: <b>${invited}</b>`,
    `🎁 Награда за друга: ${fmt(game.GAME.referralBonus)} — после ${game.GAME.referralTapsTarget} тапов друга`
  ].join('\n');
  await send(env, message.chat.id, text, { reply_markup: playKeyboard(env) });
  maybeShowAd(env, message);
}

async function onTop(store, env, message) {
  const snap = await store.rankSnapshot();
  if (!snap.top.length) {
    await send(env, message.chat.id, 'Топ пока пуст — станьте первым!', {
      reply_markup: playKeyboard(env)
    });
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  const lines = snap.top.slice(0, 10).map(
    (row) => `${medals[row.rank - 1] || `${row.rank}.`} ${row.name} — 🪙 ${fmt(row.coins)} · 🏅 ${row.ach || 0}`
  );
  await send(env, message.chat.id, ['🏆 <b>Топ игроков по монетам</b>', '', ...lines].join('\n'), {
    reply_markup: playKeyboard(env)
  });
  maybeShowAd(env, message);
}

async function onHelp(env, message) {
  await send(
    env,
    message.chat.id,
    [
      '🐹 <b>Hamster Tap</b>',
      '',
      '/play — открыть игру',
      '/me — мой прогресс',
      '/top — топ игроков',
      '/push — напоминания о прогрессе',
      '/code — код дня для награды',
      '/buy — оплата картой или СБП',
      '/paysupport — помощь с оплатой'
    ].join('\n'),
    { reply_markup: playKeyboard(env) }
  );
}

/**
 * Оплата картой/СБП идёт на внешней странице (вне Telegram), поэтому присылаем личную
 * подписанную ссылку: внутри мини-аппа платим звёздами, как требует платформа.
 */
async function onBuy(store, env, message) {
  const user = await store.userByTgId(message.from.id);
  const link = user ? paylink.linkFor(env, user.id, Date.now()) : '';
  if (!link) {
    await send(
      env,
      message.chat.id,
      'Оплата картой пока не подключена — покупки доступны за звёзды в приложении.',
      { reply_markup: playKeyboard(env) }
    );
    return;
  }
  const ttl = Number(env.PAY_LINK_TTL_MS) > 0 ? Number(env.PAY_LINK_TTL_MS) : paylink.DEFAULT_TTL_MS;
  await send(
    env,
    message.chat.id,
    [
      '💳 <b>Оплата картой или СБП</b>',
      'Откройте страницу, выберите товар — он сразу зачислится в игру.',
      '',
      `Ссылка личная и действует ${Math.max(1, Math.round(ttl / 60000))} минут.`
    ].join('\n'),
    { reply_markup: { inline_keyboard: [[{ text: 'Перейти к оплате', url: link }]] } }
  );
}

// --- оплата звёздами (Telegram Stars) ---

// Telegram ждёт ответ на pre_checkout_query не дольше 10 секунд: проверяем, что товар
// из payload ещё существует, и подтверждаем заказ.
async function onPreCheckout(env, query) {
  const parsed = shop.parsePayload(query.invoice_payload);
  const good = parsed ? shop.goodById(parsed.itemId, cosmetics.COSMETICS) : null;
  if (!good) {
    await call(env, 'answerPreCheckoutQuery', {
      pre_checkout_query_id: query.id,
      ok: false,
      error_message: 'Товар недоступен — откройте магазин заново.'
    });
    return;
  }
  await call(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: query.id, ok: true });
}

// Оплата прошла: пишем платёж (charge_id уникален) и выдаём товар один раз.
async function onSuccessfulPayment(store, env, message) {
  const payment = message.successful_payment;
  const parsed = shop.parsePayload(payment.invoice_payload);
  const user = await store.userByTgId(message.from.id);

  // Счёт создаётся для конкретного игрока: чужой payload молча не выдаём.
  if (!user || !parsed || parsed.userId !== user.id) {
    await send(env, message.chat.id, '⚠️ Не удалось сопоставить платёж с игроком. Напишите /paysupport.', {
      reply_markup: playKeyboard(env)
    });
    return;
  }

  const result = await service.deliverPurchase(store, user, {
    itemId: parsed.itemId,
    chargeId: payment.telegram_payment_charge_id,
    stars: payment.total_amount,
    item: payment,
    now: Date.now()
  });
  // Повторный апдейт Telegram (или повторная доставка) — товар уже зачислен.
  if (result.duplicate) return;

  await send(env, message.chat.id, [
    '✅ <b>Оплата прошла!</b>',
    `${result.good.emoji} ${result.good.title}`,
    shop.deliveredText(result.good),
    '',
    `Чек: <code>${payment.telegram_payment_charge_id}</code>`,
    'Нужна помощь или возврат — /paysupport.'
  ].join('\n'), { reply_markup: playKeyboard(env) });
}

async function onPaySupport(env, message) {
  await send(env, message.chat.id, [
    '🛟 <b>Помощь с оплатой</b>',
    '',
    'Все покупки в игре — за Telegram Stars. Чек есть в сообщении об оплате и в магазине внутри игры.',
    'Если товар не пришёл или нужен возврат, напишите владельцу бота и пришлите чек из сообщения об оплате:',
    'возврат оформляется в Telegram на тот же чек.'
  ].join('\n'), { reply_markup: playKeyboard(env) });
}

// Код дня: одно и то же значение для всех, действует до конца суток UTC.
async function onCode(store, env, message) {
  const day = game.utcDay(Date.now());
  const code = dailycode.codeFor(day);
  const user = await store.userByTgId(message.from.id);
  const claimed = user ? (await store.questsOfDay(user.id, day)).includes(dailycode.CODE_QUEST_ID) : false;
  const minutesLeft = Math.floor(dailycode.msUntilDayEnd(day, Date.now()) / 60000);

  await send(env, message.chat.id, [
    '🔐 <b>Код дня</b>',
    '',
    'Введите его в игре на вкладке «Задания» и получите награду:',
    '',
    `<code>${code}</code>`,
    '',
    `🪙 ${fmt(dailycode.CODE_REWARD)} · действует ещё ${Math.floor(minutesLeft / 60)} ч ${minutesLeft % 60} мин`,
    claimed ? 'Сегодняшний код вы уже использовали — новый появится после 00:00 UTC.' : ''
  ].filter(Boolean).join('\n'), { reply_markup: playKeyboard(env) });
  maybeShowAd(env, message);
}

async function handleUpdate(store, env, update) {
  // Счёт: Telegram спрашивает подтверждение до оплаты.
  if (update.pre_checkout_query) return onPreCheckout(env, update.pre_checkout_query);

  // Кнопки под сообщениями (в том числе «выключить напоминания») приходят как callback_query.
  if (update.callback_query) return onPushCallback(store, env, update.callback_query);

  const message = update.message;
  if (!message) return;
  // Сообщение об оплате приходит без текста — обрабатываем до проверки текста.
  if (message.successful_payment) return onSuccessfulPayment(store, env, message);
  if (!message.text) return;
  const text = message.text.trim();
  if (!text.startsWith('/')) return;

  const [rawCommand, ...args] = text.split(/\s+/);
  const command = rawCommand.split('@')[0].toLowerCase();
  const payload = args[0] || '';

  if (command === '/start') {
    await rememberReferral(store, message, payload);
    return onStart(store, env, message, payload);
  }
  if (command === '/play') {
    return send(env, message.chat.id, 'Погнали! 🐹', { reply_markup: playKeyboard(env) });
  }
  if (command === '/me') return onMe(store, env, message);
  if (command === '/top') return onTop(store, env, message);
  if (command === '/push') return onPush(store, env, message);
  if (command === '/code') return onCode(store, env, message);
  if (command === '/buy') return onBuy(store, env, message);
  if (command === '/paysupport') return onPaySupport(env, message);
  return onHelp(env, message);
}

export async function handleWebhook(request, env) {
  // Без верного секрета endpoint игнорируем: его знает только Telegram.
  const secret = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!env.BOT_WEBHOOK_SECRET || secret !== env.BOT_WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const { createStore } = await import('./store.js');
  const store = createStore(env.DB);
  try {
    await handleUpdate(store, env, update);
  } catch (error) {
    // Отвечаем 200 даже при ошибке: иначе Telegram будет повторять апдейт.
    console.error('[bot]', error.stack || error.message);
  }
  return new Response('ok');
}
