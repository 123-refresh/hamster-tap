// HTTP-API воркера: маршруты и коды ошибок совпадают с локальной версией (server.js),
// поэтому клиент web/app.js работает без изменений.
import { createStore } from './store.js';
import * as service from './service.js';
import { login } from './auth.js';
import game from '../../lib/game.js';
import cosmetics from '../../lib/cosmetics.js';
import { createInvoiceLink } from '../../lib/invoice.js';
import paylink from '../../lib/paylink.js';
import yookassa from '../../lib/payments/yookassa.js';
import { notifyReferral, notifyReferralPayout } from './bot.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RANK_CACHE_TTL_S = 120; // как часто пересчитывается рейтинг (экономит чтения D1)

function configOf(env) {
  // Окно ожидания постбека после подтверждения клиента: пусто — значение по
  // умолчанию, 0 — не выдавать награду без подтверждения сети вовсе.
  const graceRaw = env.MONETAG_POSTBACK_GRACE_MS;
  const graceMs = graceRaw === undefined || graceRaw === '' ? 20000 : Number(graceRaw);
  return {
    BOT_TOKEN: env.BOT_TOKEN || '',
    BOT_USERNAME: env.BOT_USERNAME || '',
    WEBAPP_URL: (env.WEBAPP_URL || '').replace(/\/+$/, ''),
    // В облаке локальный вход выключен по умолчанию: включаем только явным ALLOW_DEV=1
    // (так сделано окружение staging для автотестов).
    ALLOW_DEV: env.ALLOW_DEV === '1',
    // Реклама за энергию (Monetag, Chanify): ключ живёт в секретах воркера,
    // AD_MODE=stub выставляют автотесты, чтобы не рассылать настоящую рекламу.
    CHANIFY_API_KEY: env.CHANIFY_API_KEY || '',
    AD_MODE: env.AD_MODE || 'live',
    // Сети рекламы за энергию в порядке приоритета (первые — предпочтительнее) и
    // публичные параметры Monetag: главную зону SDK и адрес скрипта выдаёт кабинет,
    // настройки In-App Interstitial задаём строкой «частота/окно/интервал/задержка».
    AD_PROVIDERS: (env.AD_PROVIDERS || 'monetag,chanify').trim(),
    MONETAG_ZONE: (env.MONETAG_ZONE || '').trim(),
    MONETAG_SDK_URL: (env.MONETAG_SDK_URL || '').trim(),
    MONETAG_INAPP_SETTINGS: (env.MONETAG_INAPP_SETTINGS || '').trim(),
    // Постбеки Monetag: секрет живёт секретом воркера, поэтому в репозитории его нет.
    MONETAG_POSTBACK_SECRET: (env.MONETAG_POSTBACK_SECRET || '').trim(),
    MONETAG_REQUIRE_POSTBACK: env.MONETAG_REQUIRE_POSTBACK === '1',
    MONETAG_POSTBACK_GRACE_MS: Number.isFinite(graceMs) ? graceMs : 20000,
    // Оплата: звёзды внутри Telegram, ЮKassa — на внешней странице (карта/СБП).
    // По умолчанию звёзды: рублёвый канал включается осознанно.
    PAYMENTS_PROVIDER: (env.PAYMENTS_PROVIDER || 'stars').trim(),
    PAY_PAGE_ORIGIN: (env.PAY_PAGE_ORIGIN || '').trim().replace(/\/+$/, ''),
    PAY_PAGE_URL: (env.PAY_PAGE_URL || '').trim(),
    PAY_LINK_SECRET: (env.PAY_LINK_SECRET || '').trim(),
    PAY_LINK_TTL_MS: Number(env.PAY_LINK_TTL_MS) > 0 ? Number(env.PAY_LINK_TTL_MS) : 30 * 60 * 1000,
    YOOKASSA_SHOP_ID: (env.YOOKASSA_SHOP_ID || '').trim(),
    YOOKASSA_SECRET_KEY: (env.YOOKASSA_SECRET_KEY || '').trim(),
    YOOKASSA_WEBHOOK_SECRET: (env.YOOKASSA_WEBHOOK_SECRET || '').trim(),
    YOOKASSA_RETURN_URL: (env.YOOKASSA_RETURN_URL || '').trim(),
    YOOKASSA_RECEIPTS: env.YOOKASSA_RECEIPTS === '1',
    AUTH_MAX_AGE_MS,
    SESSION_TTL_MS
  };
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Auth, X-Telegram-Init-Data',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

/** CORS для платёжных маршрутов внешней страницы: только её домен, не «*». */
function payCors(config) {
  return {
    ...CORS,
    'Access-Control-Allow-Origin': config.PAY_PAGE_ORIGIN || '*'
  };
}

/** JSON-ответ с явными заголовками (платёжные маршруты ограничивают origin). */
function jsonWith(status, payload, headers) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }
  });
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS
    }
  });
}

function tokenFrom(request) {
  const header = request.headers.get('x-auth') || request.headers.get('authorization') || '';
  return header.replace(/^Bearer\s+/i, '').trim();
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw service.fail(400, 'тело запроса не является JSON');
  }
}

/**
 * Снимок рейтинга кэшируется на edge: таблица сканируется раз в 2 минуты вместо
 * каждого запроса состояния. Без этого лимит «5 млн строк чтения в сутки»
 * расходовался бы на подсчёт места в топе.
 *
 * Ключ кэша включает номер двухминутного окна: так прочитанный снимок не может
 * быть старше окна, даже если кэш хранит записи дольше заявленного времени.
 */
async function rankSnapshot(store, now = Date.now()) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const bucket = Math.floor(now / (RANK_CACHE_TTL_S * 1000));
  const key = new Request(`https://hamster-tap.internal/rank-snapshot/${bucket}`);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) {
        const data = await hit.json();
        return { players: data.players, top: data.top, ranks: new Map(data.ranks) };
      }
    } catch {
      /* локальный режим может не поддерживать кэш — считаем напрямую */
    }
  }
  const snap = await store.rankSnapshot();
  if (cache) {
    try {
      const body = JSON.stringify({
        players: snap.players,
        top: snap.top,
        ranks: [...snap.ranks.entries()]
      });
      await cache.put(key, new Response(body, {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${RANK_CACHE_TTL_S}`
        }
      }));
    } catch {
      /* не критично */
    }
  }
  return snap;
}

export async function handleApi(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = request.method;
  const store = createStore(env.DB);
  const config = configOf(env);
  const now = Date.now();

  if (method === 'OPTIONS') return json(204, {});

  // Постбек Monetag: сеть подтверждает показ по нашему ymid. Секрет — часть адреса
  // (его вставляют в кабинете в поле Postback URL главной зоны), поэтому без
  // совпадения эндпоинт отвечает 404 и снаружи неотличим от несуществующего.
  if (path.startsWith('/ads/monetag/')) {
    const secret = decodeURIComponent(path.slice('/ads/monetag/'.length));
    if (!config.MONETAG_POSTBACK_SECRET || secret !== config.MONETAG_POSTBACK_SECRET) {
      return json(404, { error: 'неизвестный маршрут' });
    }
    // Имена параметров задаёт настройка постбека в кабинете, поэтому принимаем и
    // короткие имена, и названия макросов из документации Monetag.
    const result = await service.recordAdPostback(store, config, {
      ymid: url.searchParams.get('ymid'),
      event: url.searchParams.get('event') || url.searchParams.get('event_type'),
      value: url.searchParams.get('value') || url.searchParams.get('reward_event_type'),
      subId: url.searchParams.get('sub') || url.searchParams.get('sub_zone_id'),
      price: url.searchParams.get('price') || url.searchParams.get('estimated_price')
    }, now);
    // Всегда 200: на любой другой ответ сеть будет повторять постбек по кругу.
    return json(200, { ok: true, result });
  }

  // Внешняя страница оплаты (свой домен) и уведомления ЮKassa. Сессии Telegram здесь
  // нет: защита — подписанный личный токен игрока (CORS только для домена страницы) и
  // секрет в адресе уведомления; ключи ЮKassa живут только в секретах воркера.
  if (path.startsWith('/pay/')) {
    const payUrl = new URL(request.url);
    const headers = payCors(config);
    const token = paylink.verify(config, payUrl.searchParams.get('t'), now);
    if (!token) {
      return jsonWith(401, { error: 'ссылка недействительна или устарела — откройте /buy в боте' }, headers);
    }
    const user = await store.userById(token.userId);
    if (!user) return jsonWith(404, { error: 'игрок не найден' }, headers);

    if (path === '/pay/info' && method === 'GET') {
      const view = await service.shopView(store, user, config);
      return jsonWith(200, {
        player: user.first_name || user.username || `Игрок ${user.tg_id}`,
        expiresAt: token.exp,
        currency: 'RUB',
        // Нужен ли чек: страница покажет поле e-mail только тогда, когда чеки включены.
        receipts: config.YOOKASSA_RECEIPTS === true,
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
      }, headers);
    }

    if (path === '/pay/create' && method === 'POST') {
      const body = await readJson(request);
      const created = await service.createShopPayment(store, config, user, body.itemId, {
        email: body.email,
        now
      });
      return jsonWith(200, created, headers);
    }

    if (path === '/pay/status') {
      const body = method === 'POST' ? await readJson(request) : {};
      const id = payUrl.searchParams.get('id') || body.id || body.chargeId;
      return jsonWith(200, { payment: await service.paymentStatus(store, config, user, id, now) }, headers);
    }

    return jsonWith(404, { error: `неизвестный маршрут ${method} ${path}` }, headers);
  }

  if (path.startsWith('/payments/yookassa/')) {
    const secret = decodeURIComponent(path.slice('/payments/yookassa/'.length));
    if (!config.YOOKASSA_WEBHOOK_SECRET || secret !== config.YOOKASSA_WEBHOOK_SECRET) {
      return json(404, { error: 'неизвестный маршрут' });
    }
    // Подписи у уведомлений ЮKassa нет: проверяем адрес отправителя и статус платежа.
    const clientIp = request.headers.get('cf-connecting-ip') || '';
    if (!yookassa.ipInList(clientIp)) {
      return json(403, { error: 'источник не из списка ЮKassa' });
    }
    const body = await readJson(request).catch(() => ({}));
    try {
      // Всегда 200: на другой код ЮKassa повторяет уведомление сутки.
      return json(200, await service.handleYookassaNotification(store, config, body, now));
    } catch {
      return json(200, { ok: true });
    }
  }

  const requireUser = async () => {
    const user = await store.sessionUser(tokenFrom(request), now);
    if (!user) throw service.fail(401, 'сессия истекла — откройте игру заново');
    return user;
  };

  // Игрок с уже начисленным офлайн-доходом и досчитанными покупками.
  const settledUser = async () => service.settle(store, await requireUser(), now);

  const stateFor = async (user, passiveCoins = 0, unlocked = [], achievementsDone = undefined) => {
    const snap = await rankSnapshot(store, now);
    const state = await service.state(store, user, now, {
      rank: snap.ranks.get(user.id) || null,
      players: snap.players,
      botUsername: config.BOT_USERNAME,
      webappUrl: config.WEBAPP_URL,
      unlocked,
      achievementsDone
    });
    return { ...state, passiveCoins };
  };

  /**
   * Проверка достижений ровно один раз за запрос — уже после действия игрока,
   * поэтому новая награда приходит в том же ответе (state.unlocked).
   */
  const finishState = async (user, passiveCoins = 0) => {
    const checked = await service.checkAchievements(store, user, now);
    return stateFor(checked.user, passiveCoins, checked.unlocked, checked.owned.size);
  };

  try {
    if (path === '/health' && method === 'GET') {
      const snap = await rankSnapshot(store, now);
      return json(200, {
        ok: true,
        players: snap.players,
        bot: !!config.BOT_TOKEN,
        devMode: config.ALLOW_DEV,
        webappUrl: config.WEBAPP_URL || null,
        runtime: 'cloudflare-workers'
      });
    }

    if (path === '/auth' && method === 'POST') {
      const body = await readJson(request);
      const result = await login(store, body, config, now);
      if (result.error) throw service.fail(result.status || 401, result.error);
      const settled = await service.settle(store, result.user, now);
      const state = await finishState(settled.user, settled.passiveCoins);
      // Поздравляем обоих участников приглашения, не задерживая ответ: в воркере
      // отправку додерживает ctx.waitUntil (иначе runtime может её отменить).
      if (result.referral) {
        const job = notifyReferral(env, result.referral).catch(() => false);
        if (ctx && ctx.waitUntil) ctx.waitUntil(job);
      }
      return json(200, {
        token: result.token,
        referralApplied: !!result.referralApplied,
        referralCoins: result.referral ? result.referral.invitedBonus : game.GAME.referralInvitedBonus,
        botUsername: config.BOT_USERNAME,
        devMode: config.ALLOW_DEV,
        state
      });
    }

    if (path === '/state' && method === 'GET') {
      const settled = await service.settle(store, await requireUser(), now);
      return json(200, await finishState(settled.user, settled.passiveCoins));
    }

    if (path === '/tap' && method === 'POST') {
      const body = await readJson(request);
      const mine = await settledUser();
      const result = await service.tap(store, mine.user, body.count, now);
      // Друг добрал порог активности — сообщаем пригласившему, не задерживая ответ.
      if (result.payout) {
        const job = notifyReferralPayout(env, result.payout).catch(() => false);
        if (ctx && ctx.waitUntil) ctx.waitUntil(job);
      }
      return json(200, {
        accepted: result.accepted,
        gained: result.gained,
        state: await finishState(result.user, mine.passiveCoins)
      });
    }

    if (path === '/cards/buy' && method === 'POST') {
      const body = await readJson(request);
      const mine = await settledUser();
      const result = await service.buyCard(store, mine.user, body.cardId, now);
      return json(200, {
        bought: result.card.id,
        level: result.level,
        cost: result.cost,
        state: await finishState(result.user, mine.passiveCoins)
      });
    }

    if (path === '/upgrades/buy' && method === 'POST') {
      const body = await readJson(request);
      const mine = await settledUser();
      const result = await service.buyUpgrade(store, mine.user, body.kind, now);
      return json(200, {
        kind: result.kind,
        level: result.level,
        cost: result.cost,
        state: await finishState(result.user, mine.passiveCoins)
      });
    }

    if (path === '/boosts/use' && method === 'POST') {
      const body = await readJson(request);
      const mine = await settledUser();
      const result = await service.useBoost(store, mine.user, body.boostId, now);
      return json(200, {
        boostId: result.boostId,
        used: result.used,
        limit: result.limit,
        state: await finishState(result.user, mine.passiveCoins)
      });
    }

    // Энергия за рекламу (Monetag, Chanify): запрос показа, награда за ролик
    // внутри мини-аппа и подтверждение по возвращении из чата. Дневного лимита
    // нет — только общая для всех сетей пауза между попытками. skip перечисляет
    // сети, которые на клиенте уже не сработали: запрос уходит следующей.
    if (path === '/energy/ad/request' && method === 'POST') {
      const body = await readJson(request);
      const mine = await settledUser();
      return json(200, await service.requestAdEnergy(store, config, mine.user, now, { skip: body.skip }));
    }

    if (path === '/energy/ad/claim' && method === 'POST') {
      const body = await readJson(request);
      const mine = await settledUser();
      const result = await service.claimAdEnergy(store, config, mine.user, body, now);
      // Не признан досмотренным, сеть ещё не подтвердила показ или награда уже выдана
      // (постбеком): state отдаём только когда энергия реально обновилась, а клиент
      // ориентируется по флагам.
      return json(200, {
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
        ...(result.user ? { state: await finishState(result.user, mine.passiveCoins) } : {})
      });
    }

    if (path === '/energy/ad/confirm' && method === 'POST') {
      const body = await readJson(request);
      const mine = await settledUser();
      const result = await service.confirmAdEnergy(store, config, mine.user, body.token, now);
      return json(200, {
        credited: true,
        energy: result.energy,
        restored: result.restored,
        provider: result.provider,
        status: result.status,
        state: await finishState(result.user, mine.passiveCoins)
      });
    }

    if (path === '/energy/ad/status' && method === 'GET') {
      const mine = await settledUser();
      return json(200, await service.adStatus(store, config, mine.user, now));
    }

    if (path === '/daily/claim' && method === 'POST') {
      const mine = await settledUser();
      const result = await service.claimDaily(store, mine.user, now);
      return json(200, {
        reward: result.reward,
        streak: result.streak,
        state: await finishState(result.user, mine.passiveCoins)
      });
    }

    if (path === '/quests' && method === 'GET') {
      const mine = await settledUser();
      return json(200, await service.questsView(store, mine.user, now));
    }

    if (path === '/quests/claim' && method === 'POST') {
      const body = await readJson(request);
      const mine = await settledUser();
      const result = await service.claimQuest(store, mine.user, body.questId, now);
      return json(200, {
        quest: result.quest.id,
        coins: result.coins,
        cosmetic: result.cosmetic,
        state: await finishState(result.user, mine.passiveCoins)
      });
    }

    if (path === '/achievements' && method === 'GET') {
      const mine = await settledUser();
      return json(200, await service.achievementsView(store, mine.user));
    }

    if (path === '/cosmetics' && method === 'GET') {
      const mine = await settledUser();
      return json(200, await service.cosmeticsView(store, mine.user));
    }

    if (path === '/cosmetics/equip' && method === 'POST') {
      const body = await readJson(request);
      const mine = await settledUser();
      const result = await service.equipCosmetic(store, mine.user, body.itemId);
      return json(200, {
        item: result.item.id,
        state: await finishState(result.user, mine.passiveCoins)
      });
    }

    // Переключатели напоминаний бота (вкладка «Профиль» в мини-аппе).
    if (path === '/push' && method === 'POST') {
      const body = await readJson(request);
      const mine = await settledUser();
      const result = await service.pushPrefs(store, mine.user, body);
      return json(200, { notify: service.notifyPrefs(result.user) });
    }

    // Магазин: товары с ценами в двух валютах (звёзды для Telegram, рубли для
    // внешней страницы) и последние покупки игрока.
    if (path === '/shop' && method === 'GET') {
      const mine = await settledUser();
      return json(200, await service.shopView(store, mine.user, config));
    }

    // Единая точка создания платежа: внутри Telegram — счёт Telegram (звёзды), вне —
    // ссылка на оплату на внешней странице. Товар выдаёт вебхук канала.
    if (path === '/shop/payment' && method === 'POST') {
      const body = await readJson(request);
      const mine = await settledUser();
      return json(200, await service.createShopPayment(store, config, mine.user, body.itemId, {
        email: body.email,
        now
      }));
    }

    // Статус платежа: клиент и внешняя страница опрашивают его после оплаты.
    if (path === '/shop/payment' && method === 'GET') {
      const mine = await settledUser();
      return json(200, {
        payment: await service.paymentStatus(store, config, mine.user, url.searchParams.get('id'), now)
      });
    }

    // Личная ссылка на внешнюю страницу оплаты (её же показывает бот командой /buy).
    if (path === '/pay/link' && method === 'GET') {
      const mine = await settledUser();
      return json(200, {
        link: paylink.linkFor(config, mine.user.id, now),
        page: paylink.payPageUrl(config),
        ttlMs: config.PAY_LINK_TTL_MS
      });
    }

    /**
     * Счёт за товар. Ссылку создаёт Telegram (валюта XTR), клиент открывает её
     * через WebApp.openInvoice, а товар выдаётся в боте после successful_payment.
     */
    if (path === '/shop/invoice' && method === 'POST') {
      const body = await readJson(request);
      const mine = await settledUser();
      const { good, invoice } = service.invoiceFor(mine.user, body.itemId);
      let link;
      try {
        link = await createInvoiceLink({ botToken: config.BOT_TOKEN, invoice });
      } catch (error) {
        if (error.status === 503) throw error;
        throw service.fail(502, `Telegram не создал счёт: ${error.message}`);
      }
      return json(200, { item: good.id, stars: good.stars, link });
    }

    // Код дня: сам код выдаёт бот (/code), здесь — только статус и приём.
    if (path === '/code' && method === 'GET') {
      const mine = await settledUser();
      return json(200, await service.codeView(store, mine.user, now));
    }

    if (path === '/code/claim' && method === 'POST') {
      const body = await readJson(request);
      const mine = await settledUser();
      const result = await service.claimCode(store, mine.user, body.code, now);
      return json(200, {
        day: result.day,
        coins: result.coins,
        state: await finishState(result.user, mine.passiveCoins)
      });
    }

    // Удаление профиля: идентификатор не принимаем — удаляем только того, кто
    // прислал свою сессию, поэтому чужой профиль тронуть нельзя по конструкции.
    // Ветка стоит до профиля по идентификатору и всё равно не конфликтует с ней:
    // там требуется метод GET.
    if (path === '/profile/delete' && method === 'POST') {
      const result = await service.deleteProfile(store, await requireUser(), now);
      return json(200, { deleted: true, purchases: result.purchases });
    }

    // Публичный профиль игрока: открывается по тапу на строку в топе.
    if (path.startsWith('/profile/') && method === 'GET') {
      const mine = await settledUser();
      const id = Number(path.slice('/profile/'.length));
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw service.fail(400, 'неверный идентификатор игрока');
      }
      const snap = await rankSnapshot(store, now);
      return json(200, await service.profile(store, mine.user, id, now, {
        rank: snap.ranks.get(id) || null,
        players: snap.players
      }));
    }

    if (path === '/leaderboard' && method === 'GET') {
      const mine = await settledUser();
      const snap = await rankSnapshot(store, now);
      return json(200, {
        // Значок игрока отдаём эмодзи: клиенту не нужен весь каталог косметики.
        top: snap.top.map((row) => ({ ...row, badge: cosmetics.emojiOf(row.badge) })),
        me: service.publicUser(mine.user),
        myRank: snap.ranks.get(mine.user.id) || null,
        players: snap.players,
        updatedAt: now
      });
    }

    if (path === '/friends' && method === 'GET') {
      const mine = await settledUser();
      const user = mine.user;
      const list = await store.referrals(user.id);
      const target = game.GAME.referralTapsTarget;
      return json(200, {
        invited: list.length,
        bonus: game.GAME.referralBonus,
        friendBonus: game.GAME.referralInvitedBonus,
        // Сколько друзей уже доиграли до награды, а сколько ещё в пути.
        tapsTarget: target,
        rewardsPaid: list.filter((friend) => friend.paid).length,
        rewardsWaiting: list.filter((friend) => !friend.paid).length,
        // Префикс ref_ обязателен: сервер разбирает start_param как ref_<tg_id>.
        link: config.BOT_USERNAME
          ? `https://t.me/${config.BOT_USERNAME}?startapp=ref_${user.tg_id}`
          : '',
        list: list.map((friend) => ({ ...friend, progress: Math.min(target, friend.taps) }))
      });
    }

    return json(404, { error: `неизвестный маршрут ${method} ${path}` });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error('[api]', error.stack || error.message);
    return json(status, { error: error.message || 'внутренняя ошибка' });
  }
}
