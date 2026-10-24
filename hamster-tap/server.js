'use strict';
// Единственный процесс: раздаёт мини-апп из web/ и обслуживает JSON API.
// Запуск: node server.js            (порт 8020 по умолчанию)
//         node server.js --bot      (+ long polling Telegram-бота, если задан BOT_TOKEN)
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./lib/config');
const { createStore } = require('./lib/db');
const auth = require('./lib/auth');
const service = require('./lib/service');
const invoice = require('./lib/invoice');
const paylink = require('./lib/paylink');
const yookassa = require('./lib/payments/yookassa');
const { startBot, notifyReferral, notifyReferralPayout } = require('./lib/bot');

const store = createStore(config.DB_PATH);
const WEB_DIR = path.join(config.ROOT, 'web');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

function sendJson(res, status, payload, origin = '*') {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    // Токен передаётся заголовком, cookie не используются — CORS безопасен.
    // Для платёжных маршрутов внешней страницы origin ограничивается её доменом.
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Auth, X-Telegram-Init-Data',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > config.MAX_BODY_BYTES) {
        reject(service.fail(413, 'слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(service.fail(400, 'тело запроса не является JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Токен сессии берём из заголовка X-Auth (клиент хранит его в localStorage).
function tokenFrom(req) {
  const header = req.headers['x-auth'] || req.headers.authorization || '';
  return String(header).replace(/^Bearer\s+/i, '').trim();
}

function requireUser(req, now) {
  const user = store.sessionUser(tokenFrom(req), now);
  if (!user) throw service.fail(401, 'сессия истекла — откройте игру заново');
  return user;
}

// Обёртка для обработчиков: единый разбор тела, ошибки -> JSON.
function route(handler) {
  return async (req, res) => {
    try {
      const now = Date.now();
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = await handler({ req, res, now, body });
      if (result !== undefined) sendJson(res, 200, result);
    } catch (error) {
      const status = error.status || 500;
      if (status >= 500) console.error('[api]', error);
      sendJson(res, status, { error: error.message || 'внутренняя ошибка' });
    }
  };
}

// Помощник: для действий нужен актуальный игрок с уже начисленным офлайн-доходом.
function settledUser(req, now) {
  return service.settle(store, requireUser(req, now), now);
}

/**
 * Состояние для ответа: достижения проверяются ровно один раз за запрос — уже после
 * действия игрока, поэтому новая награда приходит в том же ответе (state.unlocked).
 */
function finishState(user, now, passiveCoins = 0) {
  const checked = service.checkAchievements(store, user, now);
  return {
    ...service.state(store, checked.user, now, {
      unlocked: checked.unlocked,
      achievementsDone: checked.owned.size
    }),
    passiveCoins
  };
}

// --- API ---

const routes = {
  // Вход: проверяем initData Telegram (или dev-идентификатор в локальном режиме).
  'POST /api/auth': route(({ now, body }) => {
    const result = auth.login(store, body, config, now);
    if (result.error) throw service.fail(result.status || 401, result.error);
    // Сразу начисляем офлайн-доход и регенерацию, чтобы клиент показал «пока тебя не было».
    const settled = service.settle(store, result.user, now);
    const state = finishState(settled.user, now, settled.passiveCoins);
    // Поздравляем обоих участников приглашения, не задерживая ответ на два
    // запроса в Telegram: приветственный бонус другу уже начислен в auth.login,
    // награда пригласившему придёт после порога тапов (см. POST /api/tap).
    if (result.referral) notifyReferral(config, result.referral).catch(() => {});
    return {
      token: result.token,
      referralApplied: !!result.referralApplied,
      referralCoins: result.referral ? result.referral.invitedBonus : state.friends.friendBonus,
      botUsername: config.BOT_USERNAME,
      devMode: config.ALLOW_DEV && !config.BOT_TOKEN,
      state
    };
  }),

  'GET /api/state': route(({ req, now }) => {
    const settled = service.settle(store, requireUser(req, now), now);
    // Сколько монет накапало за время отсутствия, клиент покажет окошком (passiveCoins).
    return finishState(settled.user, now, settled.passiveCoins);
  }),

  'POST /api/tap': route(({ req, now, body }) => {
    const mine = settledUser(req, now);
    const result = service.tap(store, mine.user, body.count, now);
    // Друг добрал порог активности — сообщаем пригласившему, не задерживая ответ.
    if (result.payout) notifyReferralPayout(config, result.payout).catch(() => {});
    return {
      accepted: result.accepted,
      gained: result.gained,
      state: finishState(result.user, now, mine.passiveCoins)
    };
  }),

  'POST /api/cards/buy': route(({ req, now, body }) => {
    const mine = settledUser(req, now);
    const result = service.buyCard(store, mine.user, body.cardId, now);
    return {
      bought: result.card.id,
      level: result.level,
      cost: result.cost,
      state: finishState(result.user, now, mine.passiveCoins)
    };
  }),

  'POST /api/upgrades/buy': route(({ req, now, body }) => {
    const mine = settledUser(req, now);
    const result = service.buyUpgrade(store, mine.user, body.kind, now);
    return {
      kind: result.kind,
      level: result.level,
      cost: result.cost,
      state: finishState(result.user, now, mine.passiveCoins)
    };
  }),

  'POST /api/boosts/use': route(({ req, now, body }) => {
    const mine = settledUser(req, now);
    const result = service.useBoost(store, mine.user, body.boostId, now);
    return {
      boostId: result.boostId,
      used: result.used,
      limit: result.limit,
      state: finishState(result.user, now, mine.passiveCoins)
    };
  }),

  // Энергия за рекламу (Monetag, Chanify): запрос показа, награда за ролик
  // внутри мини-аппа и подтверждение по возвращении из чата. Дневного лимита
  // нет — только общая для всех сетей пауза между попытками. skip перечисляет
  // сети, которые на клиенте уже не сработали: запрос уходит следующей.
  'POST /api/energy/ad/request': route(async ({ req, now, body }) => {
    const mine = settledUser(req, now);
    return service.requestAdEnergy(store, config, mine.user, now, { skip: body.skip });
  }),

  'POST /api/energy/ad/claim': route(({ req, now, body }) => {
    const mine = settledUser(req, now);
    const result = service.claimAdEnergy(store, config, mine.user, body, now);
    // Не признан досмотренным, сеть ещё не подтвердила показ или награда уже выдана
    // (постбеком): состояние меняется не всегда, поэтому state отдаём только когда
    // энергия реально обновилась, а клиент ориентируется по флагам.
    return {
      credited: !!result.credited,
      waiting: !!result.waiting,
      rejected: !!result.rejected,
      // 'grace' — выдали без постбека по страховке (видно и в базе: postback_at = 0).
      fallback: result.fallback || null,
      retryInMs: result.retryInMs || 0,
      graceMs: result.graceMs || 0,
      energy: result.energy || 0,
      restored: result.restored || 0,
      provider: result.provider || null,
      status: result.status,
      ...(result.user ? { state: finishState(result.user, now, mine.passiveCoins) } : {})
    };
  }),

  'POST /api/energy/ad/confirm': route(({ req, now, body }) => {
    const mine = settledUser(req, now);
    const result = service.confirmAdEnergy(store, config, mine.user, body.token, now);
    return {
      credited: true,
      energy: result.energy,
      restored: result.restored,
      provider: result.provider,
      status: result.status,
      state: finishState(result.user, now, mine.passiveCoins)
    };
  }),

  'GET /api/energy/ad/status': route(({ req, now }) => {
    const mine = settledUser(req, now);
    return service.adStatus(store, config, mine.user, now);
  }),

  'POST /api/daily/claim': route(({ req, now }) => {
    const mine = settledUser(req, now);
    const result = service.claimDaily(store, mine.user, now);
    return {
      reward: result.reward,
      streak: result.streak,
      state: finishState(result.user, now, mine.passiveCoins)
    };
  }),

  'GET /api/quests': route(({ req, now }) =>
    service.questsView(store, settledUser(req, now).user, now)),

  'POST /api/quests/claim': route(({ req, now, body }) => {
    const mine = settledUser(req, now);
    const result = service.claimQuest(store, mine.user, body.questId, now);
    return {
      quest: result.quest.id,
      coins: result.coins,
      cosmetic: result.cosmetic,
      state: finishState(result.user, now, mine.passiveCoins)
    };
  }),

  'GET /api/achievements': route(({ req, now }) =>
    service.achievementsView(store, settledUser(req, now).user)),

  'GET /api/cosmetics': route(({ req, now }) =>
    service.cosmeticsView(store, settledUser(req, now).user)),

  // Магазин: товары с ценами в двух валютах (звёзды для Telegram, рубли для внешней
  // страницы). Ссылку на счёт звёзд создаёт Telegram (XTR), товар выдаёт бот после
  // оплаты; рублёвый канал описан ниже (createShopPayment + уведомления ЮKassa).
  'GET /api/shop': route(({ req, now }) =>
    service.shopView(store, settledUser(req, now).user, config)),

  // Единая точка создания платежа: внутри Telegram отдаём ссылку на счёт Telegram,
  // вне Telegram — ссылку на оплату на внешней странице. Товар выдаёт вебхук канала.
  'POST /api/shop/payment': route(async ({ req, now, body }) => {
    const mine = settledUser(req, now);
    return service.createShopPayment(store, config, mine.user, body.itemId, {
      email: body.email,
      now
    });
  }),

  // Статус платежа: клиент и внешняя страница опрашивают его после оплаты.
  'GET /api/shop/payment': route(async ({ req, now }) => {
    const mine = settledUser(req, now);
    const id = new URL(req.url, 'http://localhost').searchParams.get('id');
    return { payment: await service.paymentStatus(store, config, mine.user, id, now) };
  }),

  // Личная ссылка на внешнюю страницу оплаты (её же показывает бот командой /buy).
  'GET /api/pay/link': route(({ req, now }) => {
    const mine = settledUser(req, now);
    return {
      link: paylink.linkFor(config, mine.user.id, now),
      page: paylink.payPageUrl(config),
      ttlMs: config.PAY_LINK_TTL_MS
    };
  }),

  'POST /api/shop/invoice': route(async ({ req, now, body }) => {
    const mine = settledUser(req, now);
    const { good, invoice: draft } = service.invoiceFor(mine.user, body.itemId);
    let link;
    try {
      link = await invoice.createInvoiceLink({ botToken: config.BOT_TOKEN, invoice: draft });
    } catch (error) {
      if (error.status === 503) throw error;
      throw service.fail(502, `Telegram не создал счёт: ${error.message}`);
    }
    return { item: good.id, stars: good.stars, link };
  }),

  'POST /api/cosmetics/equip': route(({ req, now, body }) => {
    const mine = settledUser(req, now);
    const result = service.equipCosmetic(store, mine.user, body.itemId);
    return {
      item: result.item.id,
      state: finishState(result.user, now, mine.passiveCoins)
    };
  }),

  // Переключатели напоминаний бота (в облаке их читает рассылка по расписанию).
  'POST /api/push': route(({ req, now, body }) => {
    const result = service.pushPrefs(store, settledUser(req, now).user, body);
    return { notify: service.notifyPrefs(result.user) };
  }),

  // Код дня: статус (сам код выдаёт бот командой /code) и приём кода.
  'GET /api/code': route(({ req, now }) =>
    service.codeView(store, settledUser(req, now).user, now)),

  'POST /api/code/claim': route(({ req, now, body }) => {
    const mine = settledUser(req, now);
    const result = service.claimCode(store, mine.user, body.code, now);
    return {
      day: result.day,
      coins: result.coins,
      state: finishState(result.user, now, mine.passiveCoins)
    };
  }),

  // /api/profile/<id> — путь с идентификатором, поэтому разбирается в диспетчере.
  'GET /api/profile': route(({ req, now }) => {
    const id = Number((req.url.split('/')[3] || '').split('?')[0]);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw service.fail(400, 'неверный идентификатор игрока');
    }
    return service.profile(store, settledUser(req, now).user, id, now);
  }),

  // Удаление профиля: идентификатор не принимаем — удаляем только того, кто
  // прислал свою сессию, поэтому чужой профиль тронуть нельзя по конструкции.
  'POST /api/profile/delete': route(({ req, now }) => {
    const result = service.deleteProfile(store, requireUser(req, now), now);
    return { deleted: true, purchases: result.purchases };
  }),

  'GET /api/leaderboard': route(({ req, now }) =>
    service.leaderboard(store, settledUser(req, now).user, 20)),

  'GET /api/friends': route(({ req, now }) =>
    service.friends(store, settledUser(req, now).user, config.BOT_USERNAME)),

  'GET /api/health': route(() => ({
    ok: true,
    players: store.playersCount(),
    bot: !!config.BOT_TOKEN,
    devMode: config.ALLOW_DEV && !config.BOT_TOKEN,
    webappUrl: config.WEBAPP_URL || null
  }))
};

// --- статика мини-аппа ---

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(WEB_DIR, urlPath));
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + urlPath);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

// --- внешняя страница оплаты (свой домен) ---
// Сессии Telegram у страницы нет: она приходит с личным подписанным токеном игрока,
// поэтому защита — подпись токена, короткий срок жизни и CORS по домену страницы.
// Ключи ЮKassa на страницу не попадают: платёж создаёт сервер.

function payCors() {
  return config.PAY_PAGE_ORIGIN || '*';
}

/** Локальные адреса разрешены для автотестов; остальных сверяем со списком ЮKassa. */
function webhookIpAllowed(ip) {
  const address = String(ip || '');
  if (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1') return true;
  return yookassa.ipInList(address);
}

async function handlePayPage(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const origin = payCors();
  const token = paylink.verify(config, url.searchParams.get('t'), Date.now());
  if (!token) {
    sendJson(res, 401, { error: 'ссылка недействительна или устарела — откройте /buy в боте' }, origin);
    return;
  }
  const user = store.userById(token.userId);
  if (!user) {
    sendJson(res, 404, { error: 'игрок не найден' }, origin);
    return;
  }

  if (url.pathname === '/api/pay/info' && req.method === 'GET') {
    const view = service.shopView(store, user, config);
    sendJson(res, 200, {
      player: user.first_name || user.username || `Игрок ${user.tg_id}`,
      expiresAt: token.exp,
      currency: 'RUB',
      // Нужен ли чек: страница покажет поле e-mail только тогда, когда чеки включены.
      receipts: !!config.YOOKASSA_RECEIPTS,
      payment: view.payment,
      items: view.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        emoji: item.emoji,
        price: item.price,
        priceText: item.priceText,
        stars: item.stars,
        owned: item.owned
      }))
    }, origin);
    return;
  }

  if (url.pathname === '/api/pay/create' && req.method === 'POST') {
    const body = await readBody(req);
    const created = await service.createShopPayment(store, config, user, body.itemId, {
      email: body.email
    });
    sendJson(res, 200, created, origin);
    return;
  }

  if (url.pathname === '/api/pay/status' || url.pathname === '/api/pay/status/') {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const id = url.searchParams.get('id') || body.id || body.chargeId;
    sendJson(res, 200, { payment: await service.paymentStatus(store, config, user, id) }, origin);
    return;
  }

  sendJson(res, 404, { error: `неизвестный маршрут ${req.method} ${url.pathname}` }, origin);
}

/**
 * Уведомления ЮKassa. Подписи нет, поэтому проверяем секрет в адресе и адрес
 * отправителя, а решение о выдаче принимает сервис (он же сверяет статус платежа).
 * Отвечаем 200 в любом случае: на другой код ЮKassa повторяет уведомление сутки.
 */
async function handleYookassaWebhook(req, res) {
  const secret = decodeURIComponent(req.url.split('?')[0]).slice('/api/payments/yookassa/'.length);
  if (!config.YOOKASSA_WEBHOOK_SECRET || secret !== config.YOOKASSA_WEBHOOK_SECRET) {
    sendJson(res, 404, { error: 'неизвестный маршрут' });
    return;
  }
  const ip = (req.socket && req.socket.remoteAddress) || '';
  if (!webhookIpAllowed(ip)) {
    sendJson(res, 403, { error: 'источник не из списка ЮKassa' });
    return;
  }
  const body = await readBody(req).catch(() => ({}));
  try {
    sendJson(res, 200, service.handleYookassaNotification(store, config, body, Date.now()));
  } catch (error) {
    console.error('[yookassa]', error);
    sendJson(res, 200, { ok: true });
  }
}

/**
 * Постбек Monetag: сеть подтверждает показ по нашему ymid. Секрет — часть адреса
 * (его вставляют в кабинете в поле Postback URL главной зоны), поэтому без
 * совпадения эндпоинт отвечает 404 и снаружи неотличим от несуществующего.
 */
function handleAdPostback(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const secret = urlPath.slice('/api/ads/monetag/'.length);
  if (!config.MONETAG_POSTBACK_SECRET || secret !== config.MONETAG_POSTBACK_SECRET) {
    sendJson(res, 404, { error: `неизвестный маршрут ${req.method} ${urlPath}` });
    return;
  }
  // Имена параметров задаёт настройка постбека в кабинете, поэтому принимаем и
  // короткие имена, и названия макросов из документации Monetag.
  const query = new URL(req.url, 'http://localhost').searchParams;
  const result = service.recordAdPostback(store, config, {
    ymid: query.get('ymid'),
    event: query.get('event') || query.get('event_type'),
    value: query.get('value') || query.get('reward_event_type'),
    subId: query.get('sub') || query.get('sub_zone_id'),
    price: query.get('price') || query.get('estimated_price')
  }, Date.now());
  // Всегда 200: на любой другой ответ сеть будет повторять постбек по кругу.
  sendJson(res, 200, { ok: true, result });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }
  if (urlPath.startsWith('/api/ads/monetag/')) {
    handleAdPostback(req, res);
    return;
  }
  // Внешняя страница оплаты и уведомления ЮKassa: сессии Telegram тут нет,
  // защита — подписанный токен игрока (CORS по домену страницы) и секрет вебхука.
  // /api/pay/link — наоборот, авторизованный маршрут мини-аппа, его обрабатывает
  // таблица маршрутов ниже.
  if (urlPath.startsWith('/api/pay/') && urlPath !== '/api/pay/link') {
    handlePayPage(req, res).catch((error) =>
      sendJson(res, error.status || 500, { error: error.message || 'внутренняя ошибка' }, payCors())
    );
    return;
  }
  if (urlPath.startsWith('/api/payments/yookassa/')) {
    handleYookassaWebhook(req, res).catch(() => sendJson(res, 200, { ok: true }));
    return;
  }
  if (urlPath.startsWith('/api/')) {
    // Профиль игрока приходит с идентификатором: /api/profile/42 -> ключ 'GET /api/profile'.
    // Исключение — удаление профиля: у него отдельный маршрут без идентификатора.
    const key = urlPath.startsWith('/api/profile/') && urlPath !== '/api/profile/delete'
      ? `${req.method} /api/profile`
      : `${req.method} ${urlPath}`;
    const handler = routes[key];
    if (!handler) {
      sendJson(res, 404, { error: `неизвестный маршрут ${req.method} ${urlPath}` });
      return;
    }
    handler(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(config.PORT, () => {
  console.log(`Hamster Tap: http://localhost:${config.PORT}/`);
  console.log(`База: ${config.DB_PATH}`);
  if (config.ALLOW_DEV && !config.BOT_TOKEN) {
    console.log('Режим разработки: вход без Telegram (BOT_TOKEN не задан).');
  }
  if (config.WEBAPP_URL) console.log(`Публичный адрес мини-аппа: ${config.WEBAPP_URL}`);
  if (config.RUN_BOT) startBot(store, config);
  else if (config.BOT_TOKEN) console.log('Бот не запущен: добавьте флаг --bot или RUN_BOT=1.');
});

// Аккуратное завершение, чтобы WAL-файлы SQLite не остались «грязными».
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\nОстановка сервера...');
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}

