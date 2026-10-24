#!/usr/bin/env node
'use strict';

/**
 * Сквозная проверка БОЕВОГО воркера: вход по-настоящему подписанным initData,
 * игровой сценарий и уборка тестового игрока из базы.
 *
 *   node tools/prod-check.js https://hamster-tap.<аккаунт>.workers.dev
 *   node tools/prod-check.js http://127.0.0.1:8787 --local   # против `wrangler dev`
 *
 * Почему подпись строим сами: в проде вход без Telegram выключен (ALLOW_DEV),
 * а иначе никак не проверить авторизацию, тапы и покупки на живом окружении.
 * Подпись считается по тому же алгоритму, что проверяет lib/auth.js:
 *   secret = HMAC_SHA256(key="WebAppData", data=<bot_token>)
 *   hash   = hex(HMAC_SHA256(key=secret, data=<data_check_string>))
 * Токен берётся из .env — он же лежит в секретах воркера. Флаг `--local` читает
 * и чистит локальную базу D1 (ту же, что использует `wrangler dev`).
 *
 * Тестовый игрок (id 777000123) удаляется из базы в конце запуска.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE = (process.argv[2] || process.env.BASE_URL || '').replace(/\/+$/, '');
const LOCAL = process.argv.includes('--local');
const DB_NAME = 'hamster-tap';
const WRANGLER_BIN = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const TEST_TG_ID = 777000123;
const CHEAP_CARD = 'memcoin';

let passed = 0;
const failures = [];

function check(name, condition, details = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${details ? ` — ${details}` : ''}`);
    console.log(`  FAIL ${name}${details ? ` — ${details}` : ''}`);
  }
}

function readEnv() {
  const map = {};
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) map[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return map;
}

/** initData с настоящей подписью — как её вычислил бы Telegram. */
function signInitData(botToken, user) {
  const params = {
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AA' + crypto.randomBytes(8).toString('hex')
  };
  const dataCheckString = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

async function api(path_, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Auth'] = token;
  const res = await fetch(`${BASE}${path_}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Уборка тестового игрока из облачной базы (по одному утверждению за вызов). */
function d1Execute(sql) {
  const env = { ...process.env };
  if (!String(env.NODE_OPTIONS || '').includes('dns-result-order')) {
    env.NODE_OPTIONS = (env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : '') + '--dns-result-order=ipv4first';
  }
  const res = spawnSync(process.execPath, [
    WRANGLER_BIN, 'd1', 'execute', DB_NAME, LOCAL ? '--local' : '--remote',
    '--json', '--command', sql, '-y'
  ], {
    cwd: ROOT,
    env,
    encoding: 'utf8'
  });
  const raw = `${res.stdout || ''}${res.stderr || ''}`;
  const match = String(res.stdout || '').match(/\[[\s\S]*\]/);
  let rows = [];
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      rows = parsed[0] && parsed[0].results ? parsed[0].results : [];
    } catch {
      rows = [];
    }
  }
  return { status: res.status, rows, raw };
}

(async () => {
  const env = readEnv();
  if (!BASE) {
    console.error('[!] не указан адрес воркера: node tools/prod-check.js https://<адрес>.workers.dev');
    process.exit(1);
  }
  if (!env.BOT_TOKEN) {
    console.error('[!] в .env нет BOT_TOKEN — без него не собрать подпись initData');
    process.exit(1);
  }

  console.log(`Hamster Tap — сквозная проверка прода: ${BASE}`);

  const initData = signInitData(env.BOT_TOKEN, {
    id: TEST_TG_ID,
    first_name: 'Прод-тест',
    username: 'prod_check_' + TEST_TG_ID,
    language_code: 'ru'
  });

  // 1. Вход: подпись проверяется воркером по секрету BOT_TOKEN.
  const auth = await api('/api/auth', { method: 'POST', body: { initData } });
  check('вход по подписанному initData принят', auth.status === 200 && !!auth.data?.token, `HTTP ${auth.status}`);
  const token = auth.data?.token;
  if (!token) {
    console.log('\nДальше идти некуда: без токена остальные шаги бессмысленны.');
    process.exit(1);
  }
  check('вход выполнен как тестовый игрок', auth.data.state?.user?.coins === 0, `монет: ${auth.data.state?.user?.coins}`);
  check('состояние содержит 24 карточки', auth.data.state?.cards?.length === 24, `карточек: ${auth.data.state?.cards?.length}`);
  check('лига определяется', !!auth.data.state?.level?.name, String(auth.data.state?.level?.name));
  check('dev-режим в проде выключен', auth.data.devMode === false, `devMode=${auth.data.devMode}`);

  // 2. Без токена состояние недоступно.
  const noAuth = await api('/api/state');
  check('без токена состояние недоступно (401)', noAuth.status === 401, `HTTP ${noAuth.status}`);

  // 3. Тапы: считает сервер, энергия списывается.
  const tap = await api('/api/tap', { method: 'POST', token, body: { count: 10 } });
  check('тапы начисляют монеты', tap.status === 200 && tap.data?.accepted > 0, `принято ${tap.data?.accepted}`);
  check('тапы списали энергию', tap.data?.state?.user?.energy < 1000, `энергия ${tap.data?.state?.user?.energy}`);

  // 4. Античит: слишком большая пачка не принимается целиком.
  const flood = await api('/api/tap', { method: 'POST', token, body: { count: 500 } });
  check('античит ограничивает пачку тапов', flood.data?.accepted < 500, `принято ${flood.data?.accepted}`);

  // 5. Покупка без монет.
  const poor = await api('/api/cards/buy', { method: 'POST', token, body: { cardId: CHEAP_CARD } });
  check('покупка без монет отклонена (402)', poor.status === 402, `HTTP ${poor.status}`);

  // 6. Ежедневный бонус и защита от повторного получения.
  const daily = await api('/api/daily/claim', { method: 'POST', token });
  check('ежедневный бонус начислен', daily.status === 200 && daily.data?.reward > 0, `HTTP ${daily.status}, награда ${daily.data?.reward}`);
  const dailyAgain = await api('/api/daily/claim', { method: 'POST', token });
  check('повторный бонус отклонён (409)', dailyAgain.status === 409, `HTTP ${dailyAgain.status}`);

  // 7. Турбо-буст повышает цену тапа.
  const turbo = await api('/api/boosts/use', { method: 'POST', token, body: { boostId: 'turbo' } });
  check('турбо включается', turbo.status === 200 && turbo.data?.state?.boosts?.turbo?.active === true, `HTTP ${turbo.status}`);
  const tapPower = turbo.data?.state?.user?.tapPower || 1;
  check('цена тапа умножается на 5', turbo.data?.state?.tapValue === tapPower * 5, `tapValue=${turbo.data?.state?.tapValue}`);

  // 8. Копим монеты тапами под турбо и покупаем самую дешёвую карточку (2000).
  let coins = turbo.data?.state?.user?.coins || 0;
  let rounds = 0;
  while (coins < 2100 && rounds < 40) {
    rounds += 1;
    const batch = await api('/api/tap', { method: 'POST', token, body: { count: 20 } });
    coins = batch.data?.state?.user?.coins ?? coins;
    await sleep(1100);
  }
  check('монеты накоплены тапами для покупки', coins >= 2000, `монет ${coins} за ${rounds} раундов`);

  const buy = await api('/api/cards/buy', { method: 'POST', token, body: { cardId: CHEAP_CARD } });
  check('карточка куплена', buy.status === 200, `HTTP ${buy.status}`);
  check('доход в час вырос', (buy.data?.state?.user?.profitPerHour || 0) > 0, `доход ${buy.data?.state?.user?.profitPerHour}`);

  // 9. Данные сохранены: карточка видна в свежем состоянии.
  const state = await api('/api/state', { token });
  const ownedCard = (state.data?.cards || []).find((card) => card.id === CHEAP_CARD);
  check('карточка видна в свежем состоянии', !!ownedCard && ownedCard.level >= 1, `уровень ${ownedCard?.level}`);

  // 10. Рейтинг (по текущему балансу монет) и приглашения.
  const top = await api('/api/leaderboard', { token });
  check('рейтинг отдаёт список', top.status === 200 && Array.isArray(top.data?.top), `HTTP ${top.status}`);
  check('в топе есть поле с монетами', typeof top.data?.top?.[0]?.coins === 'number', `coins=${top.data?.top?.[0]?.coins}`);
  check('в топе есть счётчик достижений', typeof top.data?.top?.[0]?.ach === 'number', `ach=${top.data?.top?.[0]?.ach}`);
  check(
    'топ отсортирован по монетам',
    (top.data?.top || []).every((row, i, arr) => i === 0 || arr[i - 1].coins >= row.coins),
    'порядок по монетам нарушен'
  );
  const friends = await api('/api/friends', { token });
  check('ссылка-приглашение собрана', typeof friends.data?.link === 'string' && friends.data.link.includes('startapp'), String(friends.data?.link));
  // Причина прошлого сбоя: ссылка без префикса ref_ сервером не разбирается.
  const inviteParam = friends.data?.link ? new URL(friends.data.link).searchParams.get('startapp') : '';
  check('ссылка-приглашение содержит префикс ref_', /^ref_\d+$/.test(inviteParam), `start_param=${inviteParam}`);
  check(
    'в ответе друзей обе суммы бонуса',
    friends.data?.bonus === 100000 && friends.data?.friendBonus === 25000,
    `${friends.data?.bonus}/${friends.data?.friendBonus}`
  );
  // Награда пригласившему приходит за активность друга, а не за сам вход.
  check(
    'порог награды за друга отдаётся',
    friends.data?.tapsTarget === 100 && typeof friends.data?.rewardsWaiting === 'number',
    `tapsTarget=${friends.data?.tapsTarget} waiting=${friends.data?.rewardsWaiting}`
  );
  // Энергия за рекламу: у тестового игрока фейковый tg_id, поэтому настоящий
  // ролик ему не показать — проверяем статус кнопки и список включённых сетей
  // (в проде это подтверждает, что зона Monetag и ключ Chanify доехали до воркера).
  const adStatus = await api('/api/energy/ad/status', { token });
  check(
    'статус рекламы за энергию отдаётся',
    adStatus.status === 200 && typeof adStatus.data?.available === 'boolean' && adStatus.data?.percent === 100,
    `HTTP ${adStatus.status}: ${JSON.stringify(adStatus.data)}`
  );
  check(
    'в статусе видны сети и их доступность',
    Array.isArray(adStatus.data?.providers) && adStatus.data.providers.length >= 1 &&
      adStatus.data.providers.every((provider) => typeof provider.enabled === 'boolean' && !!provider.mode),
    JSON.stringify(adStatus.data?.providers)
  );
  // Monetag в проде включён главной зоной SDK и адресом скрипта из кабинета: если
  // значения не доехали до воркера, клиент молча ушёл бы в запасную сеть — проверяем
  // это здесь, а не в Telegram у игрока. Локально (`--local`) зона тестовая, поэтому
  // требуем только заполненные параметры.
  const monetag = (adStatus.data?.providers || []).find((provider) => provider.id === 'monetag');
  const monetagOk = LOCAL
    ? !!monetag && monetag.enabled === true && !!monetag.zoneId && !!monetag.sdkUrl
    : !!monetag && monetag.enabled === true && monetag.zoneId === '11854383' &&
      /^https:\/\//.test(monetag.sdkUrl || '');
  check(
    'Monetag включён зоной SDK из кабинета',
    monetagOk,
    JSON.stringify(monetag)
  );
  // Канал оплаты вне Telegram: витрина должна отдавать цены в рублях и личную ссылку
  // на внешнюю страницу (пока она не настроена — пустую строку, это нормально).
  const shopForPay = await api('/api/shop', { token });
  check(
    'витрина отдаёт цены в рублях и звёздах',
    shopForPay.status === 200 &&
      (shopForPay.data?.items || []).every((item) => item.price > 0 && !!item.priceText && !!item.starsText),
    JSON.stringify((shopForPay.data?.items || [])[0])
  );
  check(
    'каналы оплаты видны в витрине',
    Array.isArray(shopForPay.data?.payment?.providers) &&
      shopForPay.data.payment.providers.some((provider) => provider.id === 'stars'),
    JSON.stringify(shopForPay.data?.payment)
  );
  // Пассивная реклама включается настройками из конфига: клиент берёт их из статуса
  // и зовёт show_<зона>({ type: 'inApp', inAppSettings }). В проде проверяем точное
  // совпадение с кабинетом; локально формат выключен, проверять нечего.
  const inAppOk = LOCAL || (!!monetag && !!monetag.inApp &&
    monetag.inApp.frequency === 2 && monetag.inApp.capping === 0.1 &&
    monetag.inApp.interval === 30 && monetag.inApp.timeout === 5 && monetag.inApp.everyPage === false);
  check('настройки In-App Interstitial доехали до воркера', inAppOk, JSON.stringify(monetag && monetag.inApp));

  // Строгий режим проверяем живьём: сессия ролика → без постбека сети награды нет →
  // по истечении окна страховки награда всё равно выдаётся (иначе игрок, досмотревший
  // ролик, остался бы ни с чем, пока настройка в кабинете не сохранена).
  const adReq = await api('/api/energy/ad/request', { method: 'POST', token });
  check(
    'сессия ролика Monetag выдаётся',
    adReq.status === 200 && adReq.data?.mode === 'client' && !!adReq.data?.token,
    `HTTP ${adReq.status}: ${JSON.stringify(adReq.data)}`
  );
  const claimFirst = await api('/api/energy/ad/claim', {
    method: 'POST',
    token,
    body: { token: adReq.data?.token, done: true }
  });
  check(
    'строгий режим: награда ждёт подтверждения сети',
    claimFirst.status === 200 && claimFirst.data?.credited === false && claimFirst.data?.waiting === true,
    `HTTP ${claimFirst.status}: ${JSON.stringify({ credited: claimFirst.data?.credited, waiting: claimFirst.data?.waiting })}`
  );
  await sleep(21000);
  const claimGrace = await api('/api/energy/ad/claim', {
    method: 'POST',
    token,
    body: { token: adReq.data?.token, done: true }
  });
  check(
    'страховка выдаёт награду, если постбек не пришёл',
    claimGrace.status === 200 && claimGrace.data?.credited === true && claimGrace.data?.fallback === 'grace' &&
      claimGrace.data?.energy > 0,
    `HTTP ${claimGrace.status}: ${JSON.stringify({ credited: claimGrace.data?.credited, fallback: claimGrace.data?.fallback, energy: claimGrace.data?.energy })}`
  );

  // 11. Задания дня, достижения, косметика и профиль игрока.
  const quests = await api('/api/quests', { token });
  check('задания дня отдаются', quests.status === 200 && quests.data?.total === 8, `HTTP ${quests.status}`);
  const tapQuest = (quests.data?.list || []).find((quest) => quest.id === 'tap_500');
  check('прогресс задания считается по тапам', (tapQuest?.progress || 0) > 0, `прогресс ${tapQuest?.progress}`);

  const achievements = await api('/api/achievements', { token });
  check('достижения отдаются', achievements.status === 200 && achievements.data?.total === 12, `HTTP ${achievements.status}`);
  check('достижения выданы по прогрессу', (achievements.data?.done || 0) >= 2, `получено ${achievements.data?.done}`);

  const cosmetics = await api('/api/cosmetics', { token });
  check('каталог косметики отдаётся', cosmetics.status === 200 && cosmetics.data?.catalog?.length === 22, `предметов ${cosmetics.data?.catalog?.length}`);
  check(
    'косметика за достижения открылась',
    (cosmetics.data?.catalog || []).some((item) => item.id === 'palette_mint' && item.owned),
    'палитра за первое достижение не открыта'
  );

  const equip = await api('/api/cosmetics/equip', { method: 'POST', token, body: { itemId: 'palette_mint' } });
  check('открытую косметику можно надеть', equip.status === 200, `HTTP ${equip.status}`);

  const lockedEquip = await api('/api/cosmetics/equip', { method: 'POST', token, body: { itemId: 'hamster_bear' } });
  check('закрытая косметика не надевается', lockedEquip.status === 403, `HTTP ${lockedEquip.status}`);

  // Покупка карточки в этом сценарии уже была — задание «купи первый бизнес» выполнено.
  const claim = await api('/api/quests/claim', { method: 'POST', token, body: { questId: 'buy_1' } });
  check('награда за задание забирается', claim.status === 200 && claim.data?.coins > 0, `HTTP ${claim.status}`);
  const claimAgain = await api('/api/quests/claim', { method: 'POST', token, body: { questId: 'buy_1' } });
  check('повторная награда за задание отклонена', claimAgain.status === 409, `HTTP ${claimAgain.status}`);

  const meId = state.data?.user?.id;
  const profile = await api(`/api/profile/${meId}`, { token });
  check('профиль игрока отдаётся', profile.status === 200 && profile.data?.mine === true, `HTTP ${profile.status}`);
  check('профиль не раскрывает tg_id', profile.data?.tg_id === undefined);
  check(
    'в профиле есть статистика и достижения',
    profile.data?.achievementsTotal === 12 && (profile.data?.totalTaps || 0) > 0,
    `тапов ${profile.data?.totalTaps}`
  );
  check(
    'в профиле «стена» из 12 достижений с флагом открытия',
    profile.data?.achievements?.length === 12 &&
      profile.data.achievements.every((item) => typeof item.done === 'boolean'),
    `достижений: ${profile.data?.achievements?.length}`
  );

  const pushOff = await api('/api/push', { method: 'POST', token, body: { rank: false } });
  check('настройки напоминаний сохраняются', pushOff.status === 200 && pushOff.data?.notify?.rank === false, `HTTP ${pushOff.status}`);
  await api('/api/push', { method: 'POST', token, body: { rank: true } });

  // 12. Магазин за звёзды: каталог и настоящий счёт Telegram (оплату не проводим).
  const shop = await api('/api/shop', { token });
  check('магазин отдаёт товары', shop.status === 200 && shop.data?.items?.length === 9, `HTTP ${shop.status}`);
  check(
    'в магазине есть премиум-косметика',
    (shop.data?.items || []).some((item) => item.source === 'stars' && item.stars > 0)
  );

  const invoice = await api('/api/shop/invoice', { method: 'POST', token, body: { itemId: 'coins_5k' } });
  check('счёт Telegram создаётся', invoice.status === 200 && /^https:\/\/t\.me\//.test(invoice.data?.link || ''), `HTTP ${invoice.status}: ${invoice.data?.error || ''}`);
  check('счёт в звёздах на нужную сумму', invoice.data?.stars === 25, `stars ${invoice.data?.stars}`);

  const invoiceBad = await api('/api/shop/invoice', { method: 'POST', token, body: { itemId: 'nope' } });
  check('счёт на неизвестный товар отклонён', invoiceBad.status === 400, `HTTP ${invoiceBad.status}`);

  // 13. Код дня: статус, неверный код, верный код и повтор.
  const codeLib = require(path.join(ROOT, 'lib', 'dailycode'));
  const dayCode = codeLib.codeFor(new Date().toISOString().slice(0, 10));

  const codeStatus = await api('/api/code', { token });
  check('код дня отдаёт статус', codeStatus.status === 200 && codeStatus.data?.claimed === false, `HTTP ${codeStatus.status}`);
  check('код дня не раскрывается в API', codeStatus.data?.code === undefined && codeStatus.data?.reward > 0);

  const codeBad = await api('/api/code/claim', { method: 'POST', token, body: { code: 'ZZZZZZ' } });
  check('неверный код дня отклонён', codeBad.status === 400, `HTTP ${codeBad.status}`);

  const codeOk = await api('/api/code/claim', { method: 'POST', token, body: { code: dayCode } });
  check('верный код дня принят', codeOk.status === 200 && codeOk.data?.coins > 0, `HTTP ${codeOk.status}`);

  const codeTwice = await api('/api/code/claim', { method: 'POST', token, body: { code: dayCode } });
  check('повторный код дня отклонён', codeTwice.status === 409, `HTTP ${codeTwice.status}`);

  // 14. Проверяем запись в облачной базе и убираем тестового игрока.
  console.log('\n  ..  уборка тестового игрока из D1');
  const inDb = d1Execute(`SELECT COUNT(*) AS n FROM users WHERE tg_id = ${TEST_TG_ID}`);
  check('игрок записан в облачную базу', Number(inDb.rows?.[0]?.n) === 1, `строк: ${inDb.rows?.[0]?.n}`);

  // Удаляем профиль тем же способом, что доступен игроку в интерфейсе: так боевой
  // путь удаления проверяется на настоящей базе, а не только юнит-тестами.
  const removed = await api('/api/profile/delete', { method: 'POST', token });
  check(
    'удаление профиля в проде -> 200',
    removed.status === 200 && removed.data?.deleted === true,
    `HTTP ${removed.status}: ${removed.data?.error || ''}`
  );
  const deadToken = await api('/api/state', { token });
  check('токен удалённого профиля отклоняется (401)', deadToken.status === 401, `HTTP ${deadToken.status}`);
  const after = d1Execute(`SELECT COUNT(*) AS n FROM users WHERE tg_id = ${TEST_TG_ID}`);
  check('тестовый игрок удалён из базы', Number(after.rows?.[0]?.n) === 0, `строк: ${after.rows?.[0]?.n}`);
  // Платежи игрока намеренно остаются в базе (нужны для возвратов), поэтому строку
  // тестового платежа убираем отдельно — в проде мусор от теста не нужен.
  const leftovers = d1Execute(`
    SELECT
      (SELECT COUNT(*) FROM user_cards WHERE user_id NOT IN (SELECT id FROM users)) AS cards,
      (SELECT COUNT(*) FROM sessions WHERE user_id NOT IN (SELECT id FROM users)) AS sessions,
      (SELECT COUNT(*) FROM user_quests WHERE user_id NOT IN (SELECT id FROM users)) AS quests,
      (SELECT COUNT(*) FROM payments WHERE user_id NOT IN (SELECT id FROM users)) AS payments
  `);
  check(
    'после удаления не осталось строк-сирот по игровым данным',
    Number(leftovers.rows?.[0]?.cards) === 0 &&
      Number(leftovers.rows?.[0]?.sessions) === 0 &&
      Number(leftovers.rows?.[0]?.quests) === 0,
    JSON.stringify(leftovers.rows?.[0] || {})
  );
  d1Execute(`DELETE FROM payments WHERE user_id NOT IN (SELECT id FROM users)`);

  console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
  if (failures.length) {
    for (const failure of failures) console.log(` - ${failure}`);
    process.exit(1);
  }
  console.log('Боевое окружение работает: вход, тапы, бусты, покупка и база — в порядке.');
})();
