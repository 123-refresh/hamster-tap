'use strict';
// Smoke-тест без внешних зависимостей:
//   A) правила игры (lib/game) — чистые функции;
//   B) игровые операции с настоящей базой во временной папке (lib/service);
//   C) HTTP API поднятого сервера (auth, tap, покупки, ошибки).
// Запуск: node tools/smoke.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8021;
const BASE = `http://localhost:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-tap-test-'));

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

function section(title) {
  console.log(`\n== ${title}`);
}

// ---------------------------------------------------------------- A. правила

function testRules() {
  const game = require(path.join(ROOT, 'lib', 'game'));
  section('A. Правила игры (lib/game)');

  const memcoin = game.CARDS_BY_ID.get('memcoin');
  check('карточка MemCoin существует', !!memcoin);
  check('цена растёт с уровнем', game.cardCost(memcoin, 1) > game.cardCost(memcoin, 0));
  check('доход растёт с уровнем', game.cardProfit(memcoin, 2) > game.cardProfit(memcoin, 1));
  check('некупленная карточка не даёт дохода', game.cardProfit(memcoin, 0) === 0);

  check('всего 24 карточки', game.CARDS.length === 24, `получено ${game.CARDS.length}`);
  check('у каждой карточки есть категория', game.CARDS.every((c) => game.CATEGORIES[c.category]));
  check('tier карточки попадает в диапазон лиг', game.CARDS.every((c) => c.tier < game.LEVELS.length));
  check('номер уровня карточки не превышает максимум', game.CARDS.every((c) => c.maxLevel > 0 && game.cardProfit(c, c.maxLevel) > 0));

  const coffee = game.CARDS_BY_ID.get('coffee_shop');
  check(
    'доход суммируется по карточкам',
    game.profitPerHour({ memcoin: 1, coffee_shop: 1 }) ===
      game.cardProfit(memcoin, 1) + game.cardProfit(coffee, 1)
  );

  check('лига Бронза при нулевом доходе', game.levelInfo(0).name === 'Бронза');
  check('лига Серебро при 5000/ч', game.levelInfo(5000).name === 'Серебро');
  check('лига Легенда при 50 млн/ч', game.levelInfo(50_000_000).name === 'Легенда');
  const progress = game.levelInfo(10_000).progress;
  check('прогресс лиги в пределах 0..1', progress >= 0 && progress <= 1);
  check('цена мультитапа удваивается', game.upgradeCost('tap', 1) === 1000 && game.upgradeCost('tap', 2) === 2000);

  const base = {
    coins: 100, energy: 10, energy_limit: 1000, tap_power: 2, turbo_until: 0,
    profit_per_hour: 3600, total_earned: 100, last_seen: Date.now()
  };
  const now = Date.now();
  check('цена тапа равна силе тапа', game.tapValue(base, now) === 2);
  check('турбо множит тап', game.tapValue({ ...base, turbo_until: now + 5000 }, now) === 2 * game.GAME.turboMultiplier);

  const idle = game.applyIdle({ ...base, last_seen: now - 10 * 3600 * 1000 }, now);
  check('офлайн-доход ограничен 3 часами', idle.passiveCoins === 3 * 3600, `начислено ${idle.passiveCoins}`);
  const regen = game.applyIdle({ ...base, energy: 0, last_seen: now - 50 * 1000 }, now);
  check('энергия восстанавливается', regen.patch.energy === 50, `получено ${regen.patch.energy}`);

  // Каталоги заданий, достижений и косметики: они правятся в коде, поэтому проверяем
  // их согласованность (награда-косметика обязана существовать в каталоге).
  const questsMod = require(path.join(ROOT, 'lib', 'quests'));
  const achMod = require(path.join(ROOT, 'lib', 'achievements'));
  const cosMod = require(path.join(ROOT, 'lib', 'cosmetics'));

  check('восемь ежедневных заданий', questsMod.QUESTS.length === 8, `получено ${questsMod.QUESTS.length}`);
  check('у каждого задания есть монеты в награде', questsMod.QUESTS.every((q) => q.reward.coins > 0));
  check('двенадцать достижений', achMod.ACHIEVEMENTS.length === 12, `получено ${achMod.ACHIEVEMENTS.length}`);
  check('двадцать два предмета косметики', cosMod.COSMETICS.length === 22, `получено ${cosMod.COSMETICS.length}`);
  check(
    'награды-косметика есть в каталоге',
    [...questsMod.QUEST_COSMETICS, ...achMod.ACHIEVEMENT_COSMETICS].every((id) => !!cosMod.itemById(id))
  );
  check(
    'у каждого предмета есть видимая часть (эмодзи, цвета или фон)',
    cosMod.COSMETICS.every((item) => item.emoji || item.vars || item.css || item.id === 'badge_none')
  );
  check(
    'тип предмета описан и имеет колонку в users',
    cosMod.COSMETICS.every((item) => cosMod.TYPES[item.type] && cosMod.COLUMNS[item.type])
  );

  // Магазин за звёзды: товары, payload счёта и валюта XTR.
  const shopMod = require(path.join(ROOT, 'lib', 'shop'));
  const goods = shopMod.goodsList(cosMod.COSMETICS);
  check('в магазине девять товаров', goods.length === 9, `получено ${goods.length}`);
  check('у каждого товара цена в звёздах', goods.every((good) => good.stars > 0));
  check(
    'премиум-косметика помечена источником stars',
    cosMod.COSMETICS.filter((item) => item.source === 'stars').length === 5,
    `получено ${cosMod.COSMETICS.filter((item) => item.source === 'stars').length}`
  );
  check(
    'каждая премиум-вещь есть в магазине',
    cosMod.COSMETICS
      .filter((item) => item.source === 'stars')
      .every((item) => goods.some((good) => good.itemId === item.id))
  );

  const shopPayload = shopMod.payloadFor(4242, 'coins_5k');
  check(
    'payload счёта разбирается обратно',
    JSON.stringify(shopMod.parsePayload(shopPayload)) === JSON.stringify({ userId: 4242, itemId: 'coins_5k' })
  );
  check(
    'битый payload не разбирается',
    shopMod.parsePayload('мусор:coins_5k') === null && shopMod.parsePayload('') === null && shopMod.parsePayload('12:Плохой id') === null
  );
  const coinInvoice = shopMod.invoiceFor(shopMod.goodById('coins_5k', cosMod.COSMETICS), 4242);
  check(
    'счёт создаётся в валюте XTR с одной позицией',
    coinInvoice.currency === 'XTR' && coinInvoice.prices.length === 1 && coinInvoice.prices[0].amount === 25,
    JSON.stringify(coinInvoice.prices)
  );
  check('payload счёта укладывается в лимит Telegram', Buffer.byteLength(coinInvoice.payload, 'utf8') <= 128);

  // Код дня: генератор детерминированный, поэтому бот, сервер и тесты видят одно и то же.
  const codeMod = require(path.join(ROOT, 'lib', 'dailycode'));
  const codeToday = codeMod.codeFor('2026-09-19');
  check(
    'код дня детерминирован и нужной длины',
    codeMod.codeFor('2026-09-19') === codeToday && codeToday.length === codeMod.CODE_LENGTH,
    codeToday
  );
  check('коды соседних дней не совпадают', codeMod.codeFor('2026-09-19') !== codeMod.codeFor('2026-09-20'));

  const yearCodes = [];
  for (let i = 0; i < 120; i += 1) {
    yearCodes.push(codeMod.codeFor(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)));
  }
  check(
    'за четыре месяца коды не повторяются',
    new Set(yearCodes).size === yearCodes.length,
    `уникальных ${new Set(yearCodes).size} из ${yearCodes.length}`
  );
  check('в коде нет похожих символов (0, O, 1, I, L)', !/[01OIL]/.test(codeMod.ALPHABET), codeMod.ALPHABET);
  check(
    'код принимается в любом регистре, с пробелами и словом «код»',
    codeMod.check(` код: ${codeToday.toLowerCase()} `, '2026-09-19')
  );
  check(
    'чужой, пустой и мусорный код отклоняются',
    !codeMod.check(codeMod.codeFor('2026-09-20'), '2026-09-19') &&
      !codeMod.check('', '2026-09-19') &&
      !codeMod.check('привет', '2026-09-19')
  );
  check(
    'отсчёт кода дня считает остаток до полуночи UTC',
    codeMod.msUntilDayEnd('2026-09-19', Date.parse('2026-09-19T23:00:00Z')) === 60 * 60 * 1000
  );


  const staleCtx = questsMod.contextFrom({ user: { day_key: '2000-01-01', taps_today: 999 }, day: '2026-09-18' });
  check('вчерашние счётчики не идут в прогресс', staleCtx.taps === 0 && staleCtx.buys === 0);
  const streakCtx = questsMod.contextFrom({
    user: { day_key: '2026-09-18', daily_streak: 7 },
    day: '2026-09-18'
  });
  check(
    'стрик выполняет задание «7 дней подряд»',
    questsMod.questStatus(questsMod.QUESTS_BY_ID.get('streak_7'), streakCtx, false).done === true
  );
  check(
    'повторная сдача отмечается как полученная',
    questsMod.questsState(streakCtx, new Set(['streak_7'])).list
      .find((q) => q.id === 'streak_7').claimed === true
  );

  const dailyFree = game.dailyStatus({ daily_last: now - 25 * 3600 * 1000, daily_streak: 3 }, now);
  check('бонус дня доступен после 20 часов', dailyFree.available && dailyFree.nextStreak === 4);
  const dailyWaits = game.dailyStatus({ daily_last: now - 3600 * 1000, daily_streak: 3 }, now);
  check('бонус дня ждёт кулдаун', !dailyWaits.available && dailyWaits.cooldownLeftMs > 0);
  const dailyReset = game.dailyStatus({ daily_last: now - 72 * 3600 * 1000, daily_streak: 9 }, now);
  check('стрик сбрасывается после 48 часов', dailyReset.streak === 0 && dailyReset.nextStreak === 1);
}

// ------------------------------------------------- B. игровые операции и база

async function testService() {
  const { createStore } = require(path.join(ROOT, 'lib', 'db'));
  const service = require(path.join(ROOT, 'lib', 'service'));
  const ads = require(path.join(ROOT, 'lib', 'ads'));
  const shop = require(path.join(ROOT, 'lib', 'shop'));
  const paylink = require(path.join(ROOT, 'lib', 'paylink'));
  const paymentsMod = require(path.join(ROOT, 'lib', 'payments'));
  const cosmeticsMod = require(path.join(ROOT, 'lib', 'cosmetics'));
  const auth = require(path.join(ROOT, 'lib', 'auth'));
  const game = require(path.join(ROOT, 'lib', 'game'));
  section('B. Игровые операции (lib/service + SQLite)');

  const store = createStore(path.join(tmpDir, 'service.db'));
  const config = { BOT_TOKEN: '', ALLOW_DEV: true, AUTH_MAX_AGE_MS: 86400000, SESSION_TTL_MS: 86400000 };
  const now = Date.now();
  // --- миграция журнала покупок ---
  // База, сделанная до рублёвого канала, знает только звёздные платежи: колонки
  // провайдера/суммы/статуса добавляются на месте, а старые строки помечаются звёздными.
  const legacyPath = path.join(tmpDir, 'legacy-payments.db');
  {
    const { DatabaseSync } = require('node:sqlite');
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec(`
      CREATE TABLE payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        item_id TEXT NOT NULL,
        stars INTEGER NOT NULL,
        charge_id TEXT NOT NULL UNIQUE,
        at INTEGER NOT NULL
      );
    `);
    legacy.exec(
      `INSERT INTO payments (user_id, item_id, stars, charge_id, at)
       VALUES (1, 'coins_5k', 25, 'legacy_charge', ${now})`
    );
    legacy.close();
  }
  const migrated = createStore(legacyPath);
  const legacyRow = migrated.paymentByCharge('legacy_charge');
  check(
    'старая база: покупки помечаются звёздными',
    !!legacyRow && legacyRow.provider === 'stars' && legacyRow.amount === 25 &&
      legacyRow.currency === 'XTR' && legacyRow.status === 'succeeded',
    JSON.stringify(legacyRow)
  );
  check(
    'после миграции пишутся новые поля и статусы',
    migrated.recordPayment({
      userId: 1, itemId: 'coins_5k', stars: 0, chargeId: 'new_charge',
      provider: 'yookassa', amount: 9900, currency: 'RUB', status: 'pending', now
    }) === true &&
      migrated.paymentByCharge('new_charge').status === 'pending' &&
      migrated.markPaymentStatus('new_charge', 'pending', 'succeeded') === true &&
      migrated.markPaymentStatus('new_charge', 'pending', 'succeeded') === false &&
      migrated.paymentsSummary().rubles === 99,
    JSON.stringify(migrated.paymentsSummary())
  );



  // Вход по dev-идентификатору + игрок, пришедший по реферальной ссылке.
  const main = auth.login(store, { devId: 5001, devName: 'Хомяк' }, config, now);
  check('dev-вход создаёт сессию', !!main.token && main.user.tg_id === 5001);
  const invited = auth.login(store, { devId: 5002, startParam: 'ref_5001' }, config, now);
  check('игрок создан по приглашению', invited.referralApplied === true);
  check('приглашённый получил приветственный бонус', invited.user.coins === game.GAME.referralInvitedBonus);
  check(
    'данные для поздравления заполнены',
    !!invited.referral && invited.referral.invitedBonus === game.GAME.referralInvitedBonus,
    JSON.stringify(invited.referral)
  );
  // Награда пригласившему ждёт активности друга: за «пустые» приглашения не платим.
  check('награда пригласившему пока не начислена', store.userById(main.user.id).coins === game.GAME.startCoins);
  check('порог активности едет в данных приглашения', invited.referral.tapsTarget === game.GAME.referralTapsTarget);

  // Друг тапает: прогресс копится, а награда приходит ровно на пороге.
  // Рывок античита — 40 тапов на запрос, поэтому порог добираем тремя пачками.
  const friendTap = (count, at) => service.tap(store, store.userById(invited.user.id), count, at);
  const step1 = friendTap(40, now + 3000);
  check('тапы друга приняты', step1.accepted === 40, `принято ${step1.accepted}`);
  check('до порога награды нет', step1.payout === null && store.userById(main.user.id).coins === game.GAME.startCoins);
  const step2 = friendTap(40, now + 6000);
  check('прогресс приглашения растёт', step2.user.referral_taps === 80, `тапов ${step2.user.referral_taps}`);
  const step3 = friendTap(40, now + 9000);
  check('на пороге награда выплачена', !!step3.payout && step3.payout.taps === game.GAME.referralTapsTarget);
  check('пригласивший получил полную награду', store.userById(main.user.id).coins === game.GAME.referralBonus);
  check('выплата помечена в базе', store.userById(invited.user.id).referral_paid === 1);
  const step4 = friendTap(40, now + 12000);
  check(
    'следующие тапы награду не удваивают',
    step4.payout === null && store.userById(main.user.id).coins === game.GAME.referralBonus
  );

  // Тапы: списание энергии и античит по частоте.
  let user = store.userById(main.user.id);
  const tapped = service.tap(store, user, 30, now);
  check('тапы приняты', tapped.accepted === 30, `принято ${tapped.accepted}`);
  check('монеты начислены за тапы', tapped.user.coins > user.coins);
  check('энергия списана', tapped.user.energy === user.energy - 30);

  const flood = service.tap(store, store.userById(main.user.id), service.MAX_BATCH_TAPS, now + 10);
  check('античит режет слишком частые тапы', flood.accepted < service.MAX_BATCH_TAPS, `принято ${flood.accepted}`);

  user = store.updateUser(main.user.id, { energy: 5 });
  const overEnergy = service.tap(store, user, 50, now + 60000);
  check('тапов не больше, чем энергии', overEnergy.accepted === 5, `принято ${overEnergy.accepted}`);

  // Покупки: сперва не хватает монет, затем покупка даёт доход.
  user = store.updateUser(main.user.id, { coins: 10, energy: 1000 });
  let insufficient = null;
  try {
    service.buyCard(store, user, 'memcoin', now);
  } catch (error) {
    insufficient = error;
  }
  check('покупка без монет отклонена', !!insufficient && insufficient.status === 402);

  user = store.updateUser(main.user.id, { coins: 1_000_000 });
  const memcoin = game.CARDS_BY_ID.get('memcoin');
  const bought = service.buyCard(store, user, 'memcoin', now);
  check('карточка куплена', bought.level === 1 && bought.cost === game.cardCost(memcoin, 0));
  check('доход в час пересчитан', bought.user.profit_per_hour === game.cardProfit(memcoin, 1));

  let locked = null;
  try {
    service.buyCard(store, bought.user, 'web3_bank', now);
  } catch (error) {
    locked = error;
  }
  check('закрытая лигой карточка недоступна', !!locked && locked.status === 403);

  // Прокачки.
  const upgraded = service.buyUpgrade(store, store.userById(main.user.id), 'tap', now);
  check('мультитап улучшен', upgraded.user.tap_power === 2 && upgraded.user.tap_level === 2);
  const energyUpgrade = service.buyUpgrade(store, store.userById(main.user.id), 'energy', now);
  check('лимит энергии улучшен', energyUpgrade.user.energy_limit === game.GAME.startEnergyLimit + 500);

  // Бусты.
  const fresh = store.updateUser(main.user.id, { energy: 10, turbo_until: 0, energy_limit: 2000 });
  const full = service.useBoost(store, fresh, 'full_energy', now);
  check('энергия восстановлена бустом', full.user.energy === full.user.energy_limit);
  const turbo = service.useBoost(store, store.userById(main.user.id), 'turbo', now);
  check('турбо активирован', turbo.user.turbo_until > now);

  let turboAgain = null;
  try {
    service.useBoost(store, store.userById(main.user.id), 'turbo', now + 1000);
  } catch (error) {
    turboAgain = error;
  }
  check('повторный турбо отклонён', !!turboAgain && turboAgain.status === 409);

  const limitTurbo = game.GAME.boostDaily.turbo;
  for (let i = 2; i <= limitTurbo; i += 1) {
    const patched = store.updateUser(main.user.id, { turbo_until: 0 });
    service.useBoost(store, patched, 'turbo', now + i * 10000);
  }
  let boostLeft = null;
  try {
    service.useBoost(store, store.updateUser(main.user.id, { turbo_until: 0 }), 'turbo', now + 90000);
  } catch (error) {
    boostLeft = error;
  }
  check(`дневной лимит турбо (${limitTurbo}) соблюдается`, !!boostLeft && boostLeft.status === 409);

  // --- энергия за рекламу (Monetag, Chanify) ---
  // Сеть в тестах не дёргаем: AD_MODE=stub считает показ успешным. Monetag
  // проверяем без настоящего SDK — сервер выдаёт сессию и публичные параметры
  // показа, награду начисляет claim; реклама в чате подтверждается по возвращении.
  const adCfg = game.GAME.adEnergy;
  const adConfig = {
    ...config,
    CHANIFY_API_KEY: 'test-key',
    AD_MODE: 'stub',
    AD_PROVIDERS: 'monetag,chanify',
    MONETAG_ZONE: 'zone-test',
    MONETAG_SDK_URL: 'https://example.test/sdk.js',
    MONETAG_INAPP_SETTINGS: '2/0.1/30/5/0',
    MONETAG_POSTBACK_SECRET: 'postback-test-secret'
  };
  const adNow = now + 200000;
  const adLimit = store.userById(main.user.id).energy_limit;
  const adUser = () => store.userById(main.user.id);

  store.updateUser(main.user.id, { energy: 0 });
  const adStatusBefore = service.adStatus(store, adConfig, adUser(), adNow);
  check(
    'кнопка рекламы доступна при пустой энергии',
    adStatusBefore.available === true && adStatusBefore.readyInMs === 0,
    JSON.stringify(adStatusBefore)
  );
  check('дневного лимита у рекламы нет', game.GAME.adEnergy.dailyLimit === undefined);
  check(
    'в статусе сети идут по приоритету и включены',
    adStatusBefore.providers.map((p) => p.id).join(',') === 'monetag,chanify' &&
      adStatusBefore.providers.every((p) => p.enabled),
    JSON.stringify(adStatusBefore.providers)
  );
  // Пассивный формат: настройки приходят строкой из кабинета и разбираются в объект.
  const monetagStatus = adStatusBefore.providers.find((p) => p.id === 'monetag');
  check(
    'настройки In-App Interstitial разобраны',
    !!monetagStatus.inApp && monetagStatus.inApp.frequency === 2 && monetagStatus.inApp.capping === 0.1 &&
      monetagStatus.inApp.interval === 30 && monetagStatus.inApp.timeout === 5 && monetagStatus.inApp.everyPage === false,
    JSON.stringify(monetagStatus.inApp)
  );
  check(
    'мусор в настройках In-App выключает формат',
    ads.parseInAppSettings('') === null && ads.parseInAppSettings('2/0.1') === null &&
      ads.parseInAppSettings('a/b/c/d') === null,
    JSON.stringify(ads.parseInAppSettings('2/0.1'))
  );

  // Monetag: rewarded-ролик внутри мини-аппа. Сервер выдаёт одноразовую сессию и
  // публичные параметры показа, энергию начисляет claim после просмотра.
  const adReq = await service.requestAdEnergy(store, adConfig, adUser(), adNow);
  check(
    'запрос ушёл в Monetag и выдал сессию',
    adReq.provider === 'monetag' && adReq.mode === 'client' &&
      !!adReq.token && adReq.zoneId === 'zone-test' && !!adReq.sdkUrl,
    JSON.stringify({ provider: adReq.provider, mode: adReq.mode })
  );
  check('до просмотра ролика энергия не начисляется', adUser().energy === 0);
  check('до награды паузы нет', service.adStatus(store, adConfig, adUser(), adNow).readyInMs === 0);

  const adReqRepeat = await service.requestAdEnergy(store, adConfig, adUser(), adNow + 1000);
  check('повторный запрос переиспользует сессию', adReqRepeat.token === adReq.token);

  let adAlien = null;
  try {
    service.claimAdEnergy(
      store,
      adConfig,
      store.userById(invited.user.id),
      { token: adReq.token, done: true },
      adNow + 2000
    );
  } catch (error) {
    adAlien = error;
  }
  check('чужой токен не даёт награду', !!adAlien && adAlien.status === 409, adAlien && adAlien.message);

  // Ролик закрыли раньше конца: награды нет, и паузы тоже — игрок может начать
  // заново, сессия остаётся действующей.
  const adUndone = service.claimAdEnergy(store, adConfig, adUser(), { token: adReq.token, done: false }, adNow + 3000);
  check(
    'недосмотренный ролик: без награды и без паузы',
    adUndone.credited === false && adUndone.restored === 0 &&
      service.adStatus(store, adConfig, adUser(), adNow + 3000).readyInMs === 0,
    JSON.stringify({ credited: adUndone.credited, restored: adUndone.restored })
  );

  const adClaim = service.claimAdEnergy(store, adConfig, adUser(), { token: adReq.token, done: true }, adNow + 5000);
  check(
    'после ролика энергия восстановлена',
    adClaim.credited === true && adClaim.energy === adLimit && adClaim.restored > 0,
    `энергия ${adClaim.energy}, вернули ${adClaim.restored}`
  );
  check('награда включает паузу', service.adStatus(store, adConfig, adUser(), adNow + 5000).readyInMs > 0);

  const adTwiceClaim = service.claimAdEnergy(store, adConfig, adUser(), { token: adReq.token, done: true }, adNow + 6000);
  check(
    'повторный claim не начисляет дважды',
    adTwiceClaim.credited === true && adTwiceClaim.restored === 0 && adUser().energy === adLimit,
    JSON.stringify({ credited: adTwiceClaim.credited, restored: adTwiceClaim.restored })
  );

  let adFull = null;
  try {
    await service.requestAdEnergy(store, adConfig, adUser(), adNow + 6000);
  } catch (error) {
    adFull = error;
  }
  check('при полной энергии реклама не нужна', !!adFull && adFull.status === 409, adFull && adFull.message);

  // Просроченная сессия: ролик не досмотрели вовремя — токен больше не действует.
  store.updateUser(main.user.id, { energy: 0 });
  const adAfterCooldown = adNow + 5000 + adCfg.cooldownMs + 1000;
  const adTtlReq = await service.requestAdEnergy(store, adConfig, adUser(), adAfterCooldown);
  let adExpired = null;
  try {
    service.claimAdEnergy(
      store,
      adConfig,
      adUser(),
      { token: adTtlReq.token, done: true },
      adAfterCooldown + adCfg.sessionTtlMs + 1000
    );
  } catch (error) {
    adExpired = error;
  }
  check('просроченная сессия показа отклонена', !!adExpired && adExpired.status === 409, adExpired && adExpired.message);

  // --- реклама в чате (Chanify): запасная сеть ---
  // Monetag выключен (зоны нет) — запрос обязан уйти следующей сети, а награду
  // выдаём по возвращении игрока из чата.
  const chatConfig = { ...adConfig, MONETAG_ZONE: '' };
  const chatNow = adAfterCooldown + 2000;
  const chatReq = await service.requestAdEnergy(store, chatConfig, adUser(), chatNow);
  check(
    'без зоны Monetag запрос уходит в Chanify',
    chatReq.provider === 'chanify' && chatReq.mode === 'chat' && !!chatReq.token && chatReq.pending === true,
    JSON.stringify({ provider: chatReq.provider, mode: chatReq.mode })
  );
  check('до возвращения энергия не начисляется', adUser().energy === 0);
  const chatStatusWait = service.adStatus(store, chatConfig, adUser(), chatNow);
  check(
    'после запроса в чат включается пауза',
    chatStatusWait.readyInMs > 0 && chatStatusWait.available === false,
    `ждём ${chatStatusWait.readyInMs} мс`
  );

  let chatEarly = null;
  try {
    service.confirmAdEnergy(store, chatConfig, adUser(), chatReq.token, chatNow + 1000);
  } catch (error) {
    chatEarly = error;
  }
  check('подтверждение раньше срока отклонено', !!chatEarly && chatEarly.status === 409, chatEarly && chatEarly.message);

  let chatClaim = null;
  try {
    service.claimAdEnergy(store, chatConfig, adUser(), { token: chatReq.token, done: true }, chatNow + 2000);
  } catch (error) {
    chatClaim = error;
  }
  check('рекламу из чата нельзя подтвердить как ролик', !!chatClaim && chatClaim.status === 409, chatClaim && chatClaim.message);

  const chatDone = service.confirmAdEnergy(store, chatConfig, adUser(), chatReq.token, chatNow + adCfg.confirmDelayMs + 1000);
  check(
    'после возвращения энергия восстановлена',
    chatDone.credited === true && chatDone.energy === adLimit && chatDone.restored > 0,
    `энергия ${chatDone.energy}, вернули ${chatDone.restored}`
  );

  let chatTwice = null;
  try {
    service.confirmAdEnergy(store, chatConfig, adUser(), chatReq.token, chatNow + 600000);
  } catch (error) {
    chatTwice = error;
  }
  check('повторное подтверждение отклонено', !!chatTwice && chatTwice.status === 409);

  // Отказ сети: энергию не начисляем, но паузу ставим — иначе игрок будет молотить
  // кнопку, а сеть отвечать отказами.
  store.updateUser(main.user.id, { energy: 0 });
  const chatFailNow = chatNow + adCfg.cooldownMs + adCfg.confirmDelayMs + 2000;
  let chatNone = null;
  try {
    await service.requestAdEnergy(store, { ...chatConfig, AD_MODE: 'stub-none' }, adUser(), chatFailNow);
  } catch (error) {
    chatNone = error;
  }
  check(
    'без подходящей рекламы энергию не даём',
    !!chatNone && chatNone.status === 409 && adUser().energy === 0,
    chatNone && chatNone.message
  );
  check(
    'неудачная попытка тоже держит паузу',
    service.adStatus(store, chatConfig, adUser(), chatFailNow).readyInMs > 0
  );

  // Дневного лимита нет: следующая попытка после паузы проходит снова.
  const chatSecond = await service.requestAdEnergy(store, chatConfig, adUser(), chatFailNow + adCfg.cooldownMs + 1000);
  check('после паузы рекламу можно смотреть снова (лимита нет)', chatSecond.pending === true);

  // Каскад на клиенте: если ролик не запустился, клиент просит skip — запрос
  // уходит следующей сети, а не в ту же самую.
  const skipNow = chatFailNow + adCfg.cooldownMs * 2 + 5000;
  const adSkipped = await service.requestAdEnergy(store, adConfig, adUser(), skipNow, { skip: ['monetag'] });
  check('skip переводит запрос на запасную сеть', adSkipped.provider === 'chanify', JSON.stringify({ provider: adSkipped.provider }));

  // --- постбеки Monetag ---
  // Сеть подтверждает показ по нашему ymid (= token выдачи). По умолчанию награду
  // выдаёт клиент, а постбек только отмечается в базе; в режиме
  // MONETAG_REQUIRE_POSTBACK энергию начисляет уже сам постбек.
  const pbConfig = { ...adConfig, MONETAG_ZONE: 'zone-postback' };
  const pbNow = skipNow + adCfg.cooldownMs + 10000;
  store.updateUser(main.user.id, { energy: 0 });
  const pbReq = await service.requestAdEnergy(store, pbConfig, adUser(), pbNow);
  const pbMoney = store.adByToken(pbReq.token);
  check(
    'сессия показа сохранена в базе',
    !!pbMoney && pbMoney.status === 'pending' && pbMoney.provider === 'monetag' && pbMoney.postback_at === 0,
    JSON.stringify(pbMoney)
  );

  const pbUnknown = service.recordAdPostback(store, pbConfig, { ymid: 'не-наша-сессия', event: 'impression', value: 'valued' }, pbNow + 1000);
  check('постбек по неизвестной выдаче игнорируется', pbUnknown.ok === true && pbUnknown.ignored === 'unknown_ymid', JSON.stringify(pbUnknown));

  const pbClick = service.recordAdPostback(store, pbConfig, { ymid: pbReq.token, event: 'click', value: 'valued' }, pbNow + 1000);
  check('клик по креативу награду не даёт', pbClick.ok === true && pbClick.ignored === 'click', JSON.stringify(pbClick));

  const pbSoft = service.recordAdPostback(store, pbConfig, { ymid: pbReq.token, event: 'impression', value: 'valued', subId: 4321 }, pbNow + 2000);
  check(
    'без режима «по постбеку» награда остаётся за клиентом',
    pbSoft.ok === true && pbSoft.credited === false && pbSoft.reason === 'not_required' &&
      store.adByToken(pbReq.token).postback_value === 'valued' && store.adByToken(pbReq.token).external_id === '4321',
    JSON.stringify(pbSoft)
  );
  const pbClientClaim = service.claimAdEnergy(store, pbConfig, adUser(), { token: pbReq.token, done: true }, pbNow + 3000);
  check(
    'клиент по-прежнему забирает награду сам',
    pbClientClaim.credited === true && pbClientClaim.energy === adLimit,
    `энергия ${pbClientClaim.energy}`
  );

  // Режим строгой проверки: без постбека награды нет, после постбека — есть.
  const strictConfig = { ...pbConfig, MONETAG_REQUIRE_POSTBACK: true };
  const strictNow = pbNow + 3000 + adCfg.cooldownMs + 1000;
  store.updateUser(main.user.id, { energy: 0 });
  const strictReq = await service.requestAdEnergy(store, strictConfig, adUser(), strictNow);
  const strictWait = service.claimAdEnergy(store, strictConfig, adUser(), { token: strictReq.token, done: true }, strictNow + 1000);
  check(
    'без подтверждения сети награду не выдаём',
    strictWait.credited === false && strictWait.waiting === true && strictWait.retryInMs > 0 && adUser().energy === 0,
    JSON.stringify({ credited: strictWait.credited, waiting: strictWait.waiting })
  );

  const strictUnpaid = service.recordAdPostback(
    store,
    strictConfig,
    { ymid: strictReq.token, event: 'impression', value: 'non_valued' },
    strictNow + 2000
  );
  const strictUnpaidClaim = service.claimAdEnergy(store, strictConfig, adUser(), { token: strictReq.token, done: true }, strictNow + 3000);
  check(
    'неоплаченный показ остаётся без награды',
    strictUnpaid.credited === false && strictUnpaidClaim.credited === false && strictUnpaidClaim.rejected === true &&
      adUser().energy === 0,
    JSON.stringify({ postback: strictUnpaid.reason, claim: strictUnpaidClaim.rejected })
  );

  const strictPaid = service.recordAdPostback(
    store,
    strictConfig,
    { ymid: strictReq.token, event: 'impression', value: 'valued' },
    strictNow + 4000
  );
  check(
    'постбек сети начисляет энергию сам',
    strictPaid.credited === true && adUser().energy === adLimit,
    JSON.stringify({ credited: strictPaid.credited, energy: adUser().energy })
  );
  const strictRepeat = service.recordAdPostback(
    store,
    strictConfig,
    { ymid: strictReq.token, event: 'impression', value: 'valued' },
    strictNow + 5000
  );
  check(
    'повторный постбек ничего не удваивает',
    strictRepeat.credited === false && strictRepeat.reason === 'already' && adUser().energy === adLimit,
    JSON.stringify(strictRepeat)
  );
  const strictClaimAfter = service.claimAdEnergy(store, strictConfig, adUser(), { token: strictReq.token, done: true }, strictNow + 6000);
  check(
    'клиент видит уже выданную награду без второго начисления',
    strictClaimAfter.credited === true && strictClaimAfter.restored === 0,
    JSON.stringify({ credited: strictClaimAfter.credited, restored: strictClaimAfter.restored })
  );

  // Страховка: если постбек не пришёл за окно ожидания, энергию всё равно выдаём —
  // иначе игрок посмотрел ролик и остался ни с чем (настройку в кабинете могли ещё
  // не сохранить). Такие выдачи постбеком не помечаются, их видно по postback_at = 0.
  const graceConfig = { ...pbConfig, MONETAG_REQUIRE_POSTBACK: true, MONETAG_POSTBACK_GRACE_MS: 2000 };
  const graceNow = strictNow + adCfg.cooldownMs + 10000;
  store.updateUser(main.user.id, { energy: 0 });
  const graceReq = await service.requestAdEnergy(store, graceConfig, adUser(), graceNow);
  const graceFirst = service.claimAdEnergy(store, graceConfig, adUser(), { token: graceReq.token, done: true }, graceNow + 1000);
  check(
    'в окне ожидания постбека награда не выдаётся',
    graceFirst.credited === false && graceFirst.waiting === true && graceFirst.graceMs === 2000 && adUser().energy === 0,
    JSON.stringify({ waiting: graceFirst.waiting, graceMs: graceFirst.graceMs })
  );
  check(
    'окно ожидания отсчитывается от подтверждения клиента',
    store.adByToken(graceReq.token).client_done_at === graceNow + 1000,
    String(store.adByToken(graceReq.token).client_done_at)
  );
  const graceCredit = service.claimAdEnergy(
    store,
    graceConfig,
    adUser(),
    { token: graceReq.token, done: true },
    graceNow + 1000 + 2500
  );
  check(
    'по истечении окна награда выдаётся без постбека',
    graceCredit.credited === true && graceCredit.fallback === 'grace' && graceCredit.energy === adLimit &&
      store.adByToken(graceReq.token).postback_at === 0,
    JSON.stringify({ fallback: graceCredit.fallback, postbackAt: store.adByToken(graceReq.token).postback_at })
  );

  // Жёсткий режим: окно 0 — без постбека награды нет вообще, страховку можно снять.
  const hardConfig = { ...pbConfig, MONETAG_REQUIRE_POSTBACK: true, MONETAG_POSTBACK_GRACE_MS: 0 };
  const hardNow = graceNow + 1000 + 2500 + adCfg.cooldownMs + 1000;
  store.updateUser(main.user.id, { energy: 0 });
  const hardReq = await service.requestAdEnergy(store, hardConfig, adUser(), hardNow);
  const hardFirst = service.claimAdEnergy(store, hardConfig, adUser(), { token: hardReq.token, done: true }, hardNow + 1000);
  const hardLater = service.claimAdEnergy(store, hardConfig, adUser(), { token: hardReq.token, done: true }, hardNow + 60000);
  check(
    'с выключенной страховкой награда ждёт постбек',
    hardFirst.waiting === true && hardLater.waiting === true && adUser().energy === 0,
    JSON.stringify({ first: hardFirst.waiting, later: hardLater.waiting })
  );

  // Возвращаем полную энергию: дальше идут проверки, которым нужны тапы.
  store.updateUser(main.user.id, { energy: store.userById(main.user.id).energy_limit });

  // Ежедневный бонус.
  const daily = service.claimDaily(store, store.userById(main.user.id), now);
  check('бонус дня начислен', daily.reward === game.DAILY_REWARDS[0] && daily.streak === 1);
  let dailyAgain = null;
  try {
    service.claimDaily(store, store.userById(main.user.id), now + 1000);
  } catch (error) {
    dailyAgain = error;
  }
  check('повторный бонус дня отклонён', !!dailyAgain && dailyAgain.status === 409);

  // Состояние, лидерборд, друзья.
  const state = service.state(store, store.userById(main.user.id), now + 120000);
  check('состояние содержит 24 карточки', state.cards.length === 24);
  check('в состоянии есть лига, бусты и прокачки', !!state.level.name && !!state.boosts.turbo && !!state.upgrades.tap);
  check('лидерборд отдаёт игроков', service.leaderboard(store, store.userById(main.user.id)).top.length >= 2);

  // Рейтинг считается по текущему балансу монет, а не по доходу в час.
  // Приглашённому выставляем большой доход, но мало монет — он не должен обойти.
  store.updateUser(main.user.id, { coins: 12345 });
  store.updateUser(invited.user.id, { coins: 100, profit_per_hour: 9000000 });
  const rating = service.leaderboard(store, store.userById(main.user.id));
  check('в топе есть поле с монетами', typeof rating.top[0].coins === 'number', `coins=${rating.top[0].coins}`);
  check('первое место у игрока с большим балансом', rating.top[0].id === main.user.id, `наверху id ${rating.top[0].id}`);
  // Счётчик достижений едет вместе со строкой рейтинга: он виден ещё до нажатия.
  check('в топе есть счётчик достижений', typeof rating.top[0].ach === 'number', `ach=${rating.top[0].ach}`);
  check(
    'большой доход в час не поднимает в топе',
    rating.top[0].coins >= rating.top[1].coins && rating.top[1].id === invited.user.id,
    `монеты: ${rating.top.map((r) => r.coins).join(' > ')}`
  );
  check('место игрока считается по монетам', rating.myRank === 1, `место ${rating.myRank}`);
  const friends = service.friends(store, store.userById(main.user.id), 'demo_bot');
  check('друзья видят приглашённого', friends.invited === 1 && friends.link.includes('startapp=ref_5001'));
  // Ключевая проверка: start_param из ссылки обязан разбираться сервером. Иначе
  // приглашение молча не даёт бонуса — именно так ломалось в проде.
  const inviteParam = new URL(friends.link).searchParams.get('startapp');
  check('ссылка-приглашение разбирается сервером', auth.parseReferrer(inviteParam) === 5001, `start_param=${inviteParam}`);
  check('сумма для друга приходит в ответе друзей', friends.friendBonus === game.GAME.referralInvitedBonus);
  // Прогресс наград: друг уже доиграл до порога, поэтому награда выплачена.
  check(
    'прогресс наград приходит в ответе друзей',
    friends.tapsTarget === game.GAME.referralTapsTarget && friends.rewardsPaid === 1 && friends.rewardsWaiting === 0,
    `paid=${friends.rewardsPaid} waiting=${friends.rewardsWaiting}`
  );
  check(
    'в списке друзей виден прогресс',
    friends.list[0].paid === true && friends.list[0].progress === game.GAME.referralTapsTarget,
    JSON.stringify(friends.list[0])
  );

  // --- задания дня ---
  // Прогресс считается по счётчикам дня, поэтому ставим их напрямую, как это
  // сделали бы тапы и покупки (они пишут те же поля тем же UPDATE).
  const day = game.utcDay(now);
  store.updateUser(main.user.id, { day_key: day, taps_today: 500, earned_today: 0, buys_today: 1 });
  let questView = service.questsView(store, store.userById(main.user.id), now);
  check('экран заданий отдаёт восемь пунктов', questView.total === 8, `получено ${questView.total}`);
  const tapQuest = questView.list.find((q) => q.id === 'tap_500');
  check('квест «500 тапов» выполнен', tapQuest && tapQuest.done === true);
  check('прогресс задания не превышает цель', tapQuest.progress === tapQuest.target);
  check('награда задания описана для клиента', tapQuest.reward.coins > 0 && !('cosmetic' in tapQuest.reward && tapQuest.reward.cosmetic === undefined));

  const coinsBeforeQuest = store.userById(main.user.id).coins;
  const questClaim = service.claimQuest(store, store.userById(main.user.id), 'tap_500', now);
  check(
    'награда за задание начислена',
    questClaim.coins > 0 && questClaim.user.coins === coinsBeforeQuest + questClaim.coins
  );

  let questTwice = null;
  try {
    service.claimQuest(store, store.userById(main.user.id), 'tap_500', now);
  } catch (error) {
    questTwice = error;
  }
  check('повторная награда за задание отклонена', !!questTwice && questTwice.status === 409);

  let questUndone = null;
  try {
    // Стрик в этом сценарии равен одному дню, поэтому задание «7 дней» не выполнено.
    service.claimQuest(store, store.userById(main.user.id), 'streak_7', now);
  } catch (error) {
    questUndone = error;
  }
  check('невыполненное задание не сдаётся', !!questUndone && questUndone.status === 409);

  let questUnknown = null;
  try {
    service.claimQuest(store, store.userById(main.user.id), 'nope', now);
  } catch (error) {
    questUnknown = error;
  }
  check('неизвестное задание -> 400', !!questUnknown && questUnknown.status === 400);

  // --- достижения ---
  const unlocked = service.checkAchievements(store, store.userById(main.user.id), now);
  const unlockedIds = unlocked.unlocked.map((item) => item.id);
  check('достижение за первый тап выдано', unlockedIds.includes('first_tap'), unlockedIds.join(', '));
  check('достижение за бизнес выдано', unlockedIds.includes('first_card'), unlockedIds.join(', '));
  check(
    'вместе с достижением выдана косметика',
    unlocked.unlocked.some((item) => item.cosmetic && item.cosmetic.id === 'palette_mint')
  );

  const unlockedAgain = service.checkAchievements(store, store.userById(main.user.id), now);
  check('достижения не выдаются повторно', unlockedAgain.unlocked.length === 0);

  // --- косметика ---
  const cosView = service.cosmeticsView(store, store.userById(main.user.id));
  check('бесплатная косметика открыта сразу', cosView.catalog.filter((i) => i.source === 'free').every((i) => i.owned));
  check('награда за достижение открыта', cosView.catalog.find((i) => i.id === 'palette_mint').owned === true);
  check('закрытая косметика помечена', cosView.catalog.find((i) => i.id === 'hamster_bear').owned === false);

  const equipped = service.equipCosmetic(store, store.userById(main.user.id), 'palette_mint');
  check('открытую палитру можно надеть', equipped.user.palette === 'palette_mint');

  let lockedCos = null;
  try {
    service.equipCosmetic(store, store.userById(main.user.id), 'hamster_bear');
  } catch (error) {
    lockedCos = error;
  }
  check('закрытый предмет надеть нельзя', !!lockedCos && lockedCos.status === 403);

  let unknownCos = null;
  try {
    service.equipCosmetic(store, store.userById(main.user.id), 'nope');
  } catch (error) {
    unknownCos = error;
  }
  check('неизвестный предмет -> 400', !!unknownCos && unknownCos.status === 400);

  // --- профиль игрока ---
  const prof = service.profile(store, store.userById(main.user.id), invited.user.id, now);
  check('профиль отдаёт статистику', prof.cards >= 0 && typeof prof.totalTaps === 'number' && prof.days >= 1);
  check('профиль показывает активную косметику', !!prof.cosmetics && !!prof.cosmetics.hamster);
  check('профиль не раскрывает tg_id', prof.tg_id === undefined && prof.mine === false);
  check(
    'в чужом профиле тоже 12 достижений с флагом открытия',
    prof.achievements.length === 12 && prof.achievements.every((item) => typeof item.done === 'boolean'),
    `достижений: ${prof.achievements.length}`
  );

  const ownProfile = service.profile(store, store.userById(main.user.id), main.user.id, now);
  check('свой профиль помечен как mine', ownProfile.mine === true && ownProfile.achievementsDone >= 2);
  // Раньше присылались только пять последних открытых — теперь видно и оставшиеся.
  check(
    'профиль отдаёт «стену» из 12 достижений',
    ownProfile.achievements.length === 12 &&
      ownProfile.achievements.filter((item) => item.done).length === ownProfile.achievementsDone,
    `получено ${ownProfile.achievements.filter((item) => item.done).length} из ${ownProfile.achievements.length}`
  );
  check(
    'в профиле есть незакрытые достижения и нет наград',
    ownProfile.achievements.some((item) => item.done === false) &&
      ownProfile.achievements.every((item) => !('reward' in item)),
    ownProfile.achievements.map((item) => (item.done ? '+' : '-')).join('')
  );

  let noProfile = null;
  try {
    service.profile(store, store.userById(main.user.id), 999999, now);
  } catch (error) {
    noProfile = error;
  }
  check('неизвестный профиль -> 404', !!noProfile && noProfile.status === 404);

  // --- настройки напоминаний ---
  const prefsOff = service.pushPrefs(store, store.userById(main.user.id), { rank: false, energy: false });
  check('напоминания выключаются', service.notifyPrefs(prefsOff.user).rank === false && prefsOff.user.notify_energy === 0);

  let badPrefs = null;
  try {
    service.pushPrefs(store, store.userById(main.user.id), {});
  } catch (error) {
    badPrefs = error;
  }
  check('пустые настройки -> 400', !!badPrefs && badPrefs.status === 400);

  const stateAfter = service.state(store, store.userById(main.user.id), now, {});
  check('состояние содержит сводку заданий', stateAfter.quests.total === 8 && stateAfter.quests.claimed >= 1);
  check('состояние содержит счётчик достижений', stateAfter.achievements.total === 12 && stateAfter.achievements.done >= 2);
  check('состояние содержит активную косметику', stateAfter.cosmetics.palette.id === 'palette_mint');
  check('состояние содержит настройки напоминаний', stateAfter.notify.energy === false);

  // --- смена дня: прогресс заданий начинается заново ---
  // day_key уводим во «вчера», а счётчики оставляем большими: первое действие нового
  // дня должно обнулить чужие счётчики (иначе вчерашние покупки засчитались бы сегодня).
  store.updateUser(main.user.id, {
    day_key: '2000-01-01',
    taps_today: 999,
    buys_today: 7,
    earned_today: 999999
  });
  const overnight = service.tap(store, store.userById(main.user.id), 5, now + 3 * 60 * 1000);
  check(
    'счётчик тапов начался заново',
    overnight.user.taps_today === overnight.accepted,
    `taps_today=${overnight.user.taps_today}, принято ${overnight.accepted}`
  );
  check('счётчик покупок обнулён при смене дня', overnight.user.buys_today === 0, `buys_today=${overnight.user.buys_today}`);
  check(
    'дневной доход считается только за новый день',
    overnight.user.earned_today === overnight.gained,
    `earned_today=${overnight.user.earned_today}`
  );

  // --- магазин: выдача покупок за звёзды ---
  const beforeCoins = store.userById(main.user.id);
  const buyCoins = service.deliverPurchase(store, beforeCoins, {
    itemId: 'coins_5k',
    chargeId: 'charge_coins_1',
    stars: 25,
    now
  });
  check(
    'покупка монет зачислена',
    buyCoins.user.coins === beforeCoins.coins + 5000,
    `было ${beforeCoins.coins}, стало ${buyCoins.user.coins}`
  );
  check(
    'платёж записан с чеком',
    store.paymentsOf(main.user.id, 5).some((row) => row.chargeId === 'charge_coins_1' && row.stars === 25)
  );

  const duplicate = service.deliverPurchase(store, store.userById(main.user.id), {
    itemId: 'coins_5k',
    chargeId: 'charge_coins_1',
    stars: 25,
    now
  });
  check(
    'повторный чек не выдаёт товар дважды',
    duplicate.duplicate === true && duplicate.user.coins === buyCoins.user.coins,
    `монет ${duplicate.user.coins}`
  );

  const buyBoost = service.deliverPurchase(store, store.userById(main.user.id), {
    itemId: 'tap_x2_hour',
    chargeId: 'charge_boost_1',
    stars: 75,
    now
  });
  check(
    'буст ×2 включён на час',
    buyBoost.user.tap_boost_until - now === 60 * 60 * 1000,
    `осталось ${buyBoost.user.tap_boost_until - now} мс`
  );
  check(
    'буст умножает силу тапа',
    game.tapValue(buyBoost.user, now) === buyBoost.user.tap_power * game.GAME.tapBoostMultiplier,
    `тап ${game.tapValue(buyBoost.user, now)} при силе ${buyBoost.user.tap_power}`
  );

  const boostAgain = service.deliverPurchase(store, store.userById(main.user.id), {
    itemId: 'tap_x2_hour',
    chargeId: 'charge_boost_2',
    stars: 75,
    now: now + 1000
  });
  check(
    'повторная покупка буста продлевает время',
    boostAgain.user.tap_boost_until === now + 2 * 60 * 60 * 1000,
    `до ${boostAgain.user.tap_boost_until - now} мс`
  );

  const buyCosmetic = service.deliverPurchase(store, store.userById(main.user.id), {
    itemId: 'hamster_diamond',
    chargeId: 'charge_skin_1',
    stars: 150,
    now
  });
  check('премиум-косметика выдана', buyCosmetic.delivered.cosmetic.id === 'hamster_diamond');
  check(
    'премиум-предмет открыт в каталоге',
    service.cosmeticsView(store, store.userById(main.user.id)).catalog
      .find((item) => item.id === 'hamster_diamond').owned === true
  );
  const wearPremium = service.equipCosmetic(store, store.userById(main.user.id), 'hamster_diamond');
  check('премиум-предмет можно надеть', wearPremium.user.hamster_skin === 'hamster_diamond');

  const shopAfter = service.shopView(store, store.userById(main.user.id));
  check(
    'витрина магазина отдаёт товары и покупки',
    shopAfter.items.length === 9 && shopAfter.purchases.length >= 3,
    `товаров ${shopAfter.items.length}, покупок ${shopAfter.purchases.length}`
  );

  // --- рубли: каталог и личные ссылки ---
  // Цены двувалютные: звёзды списывает Telegram, рубли берёт внешняя страница.
  const dual = shop.goodsList(cosmeticsMod.COSMETICS);
  check(
    'у каждого товара есть цена в рублях',
    dual.every((good) => Number.isInteger(good.price) && good.price > 0 && good.price % 100 === 0) &&
      dual.every((good) => Number.isInteger(good.stars) && good.stars > 0),
    JSON.stringify(dual.map((good) => `${good.id}: ${good.stars}/${good.price / 100}`))
  );
  // Курс держим около 2 ₽ за звезду: цены каналов должны быть сопоставимы.
  check(
    'рублёвые цены сопоставимы со звёздными',
    dual.every((good) => {
      const perStar = good.price / 100 / good.stars;
      return perStar >= 1.7 && perStar <= 2.4;
    }),
    JSON.stringify(dual.map((good) => (good.price / 100 / good.stars).toFixed(2)))
  );
  check(
    'цены для витрины форматируются',
    shop.priceText({ price: 19900 }) === '199 ₽' && shop.priceText({ price: 59900 }) === '599 ₽' &&
      shop.starsText({ stars: 100 }) === '100 ⭐',
    `${shop.priceText({ price: 19900 })} / ${shop.priceText({ price: 59900 })}`
  );

  // Личные ссылки на внешнюю страницу: подпись проверяем, подделку и просрочку — нет.
  const payConfig = {
    ...config,
    PAYMENTS_PROVIDER: 'mock',
    PAY_PAGE_ORIGIN: 'https://pay.example.test',
    PAY_LINK_SECRET: 'test-pay-link-secret',
    PAY_LINK_TTL_MS: 60000,
    YOOKASSA_WEBHOOK_SECRET: 'yookassa-test-secret'
  };
  const payLink = paylink.linkFor(payConfig, main.user.id, now);
  const payToken = payLink.split('?t=')[1];
  check(
    'личная ссылка на оплату подписана',
    payLink.startsWith('https://pay.example.test/pay.html?t=') &&
      paylink.verify(payConfig, payToken, now).userId === main.user.id,
    payLink
  );
  check(
    'подделанная и просроченная ссылка отклоняются',
    paylink.verify(payConfig, `${payToken}x`, now) === null &&
      paylink.verify(payConfig, payToken, now + 60000) === null &&
      paylink.verify({ ...payConfig, PAY_LINK_SECRET: 'other' }, payToken, now) === null
  );
  // Платёж через внешний канал: пишем pending, выдаём товар по подтверждению.
  const mockProvider = paymentsMod.PROVIDERS.mock;
  mockProvider.reset();
  const coinsBefore = store.userById(main.user.id).coins;
  const created = await service.createShopPayment(store, payConfig, store.userById(main.user.id), 'coins_5k', {
    provider: mockProvider,
    email: 'buyer@example.test',
    now
  });
  check(
    'рублёвый платёж создан и записан как pending',
    created.mode === 'external' && created.currency === 'RUB' && !!created.payUrl &&
      store.paymentByCharge(created.externalId).status === 'pending',
    JSON.stringify({ provider: created.provider, amount: created.amount })
  );
  check(
    'до оплаты товар не выдан',
    store.userById(main.user.id).coins === coinsBefore,
    `монет ${store.userById(main.user.id).coins}`
  );

  await mockProvider.markSucceeded(created.externalId);
  const settled = await service.paymentStatus(store, payConfig, store.userById(main.user.id), created.externalId, now + 1000);
  check(
    'сверка с провайдером выдаёт товар после оплаты',
    settled.status === 'succeeded' && store.userById(main.user.id).coins === coinsBefore + 5000,
    JSON.stringify({ status: settled.status, coins: store.userById(main.user.id).coins })
  );
  const settledAgain = service.settlePayment(store, payConfig, { chargeId: created.externalId, now: now + 2000 });
  check(
    'повторное подтверждение не начисляет дважды',
    settledAgain.delivered === false && settledAgain.reason === 'succeeded' &&
      store.userById(main.user.id).coins === coinsBefore + 5000,
    String(settledAgain.reason)
  );

  // Отмена и возврат: статус в журнале меняется, повторно товар не выдаётся.
  const canceledPay = await service.createShopPayment(store, payConfig, store.userById(main.user.id), 'coins_5k', {
    provider: mockProvider,
    now: now + 3000
  });
  const cancelResult = service.handleYookassaNotification(
    store,
    payConfig,
    { event: 'payment.canceled', object: { id: canceledPay.externalId } },
    now + 4000
  );
  check(
    'отменённый платёж помечается и не выдаёт товар',
    cancelResult.canceled === true && store.paymentByCharge(canceledPay.externalId).status === 'canceled' &&
      store.userById(main.user.id).coins === coinsBefore + 5000,
    JSON.stringify(cancelResult)
  );
  const refundResult = service.handleYookassaNotification(
    store,
    payConfig,
    { event: 'refund.succeeded', object: { id: created.externalId } },
    now + 5000
  );
  check(
    'возврат отмечается в журнале',
    refundResult.refunded === true && store.paymentByCharge(created.externalId).status === 'refunded' &&
      store.paymentByCharge(created.externalId).refunded_at === now + 5000,
    JSON.stringify({ status: store.paymentByCharge(created.externalId).status })
  );
  const paidAfterRefund = service.handleYookassaNotification(
    store,
    payConfig,
    { event: 'payment.succeeded', object: { id: created.externalId } },
    now + 6000
  );
  check(
    'после возврата товар не выдаётся повторно',
    paidAfterRefund.delivered === false && store.userById(main.user.id).coins === coinsBefore + 5000,
    String(paidAfterRefund.reason)
  );

  // Уведомления ЮKassa приходят только с их адресов: проверяем список.
  const yookassaMod = require(path.join(ROOT, 'lib', 'payments', 'yookassa'));
  check(
    'список адресов ЮKassa распознаётся',
    yookassaMod.ipInList('77.75.156.11') === true &&
      yookassaMod.ipInList('185.71.77.20') === true &&
      yookassaMod.ipInList('2a02:5180::5') === true &&
      yookassaMod.ipInList('77.75.156.12') === false &&
      yookassaMod.ipInList('10.0.0.1') === false,
    'ip-фильтр ЮKassa'
  );
  check(
    'чужие события ЮKassa игнорируются',
    service.handleYookassaNotification(
      store, payConfig, { event: 'payment.waiting_for_capture', object: { id: 'x' } }
    ).ignored === 'payment.waiting_for_capture' &&
      service.handleYookassaNotification(store, payConfig, { event: 'payment.succeeded' }).ignored === 'no_id'
  );



  let unknownGood = null;
  try {
    service.invoiceFor(store.userById(main.user.id), 'nope');
  } catch (error) {
    unknownGood = error;
  }
  check('счёт на неизвестный товар -> 400', !!unknownGood && unknownGood.status === 400);

  let unknownDeliver = null;
  try {
    service.deliverPurchase(store, store.userById(main.user.id), { itemId: 'nope', chargeId: 'x', now });
  } catch (error) {
    unknownDeliver = error;
  }
  check('выдача неизвестного товара -> 400', !!unknownDeliver && unknownDeliver.status === 400);

  // --- код дня ---
  const codeMod = require(path.join(ROOT, 'lib', 'dailycode'));
  const todayCode = codeMod.codeFor(game.utcDay(now));

  const codeState = service.codeView(store, store.userById(main.user.id), now);
  check(
    'код дня ждёт ввода и обещает награду',
    codeState.claimed === false && codeState.reward === codeMod.CODE_REWARD,
    JSON.stringify({ claimed: codeState.claimed, reward: codeState.reward })
  );
  check('подсказка объясняет, где взять код', /\/code/.test(codeState.hint), codeState.hint);
  check(
    'код действует до конца суток',
    codeState.expiresInMs > 0 && codeState.expiresInMs <= 24 * 60 * 60 * 1000,
    `осталось ${codeState.expiresInMs} мс`
  );

  let wrongCode = null;
  try {
    service.claimCode(store, store.userById(main.user.id), 'ZZZZZZ', now);
  } catch (error) {
    wrongCode = error;
  }
  check('неверный код отклонён', !!wrongCode && wrongCode.status === 400);

  const coinsBeforeCode = store.userById(main.user.id).coins;
  const codeClaim = service.claimCode(
    store,
    store.userById(main.user.id),
    ` ${todayCode.toLowerCase()} `,
    now
  );
  check(
    'код дня принят и награда начислена',
    codeClaim.coins === codeMod.CODE_REWARD && codeClaim.user.coins === coinsBeforeCode + codeMod.CODE_REWARD,
    `монет ${codeClaim.user.coins}`
  );

  let codeTwice = null;
  try {
    service.claimCode(store, store.userById(main.user.id), todayCode, now);
  } catch (error) {
    codeTwice = error;
  }
  check('повторный ввод кода отклонён', !!codeTwice && codeTwice.status === 409);
  check(
    'состояние помечает код использованным',
    service.codeView(store, store.userById(main.user.id), now).claimed === true
  );

  const tomorrow = service.codeView(store, store.userById(main.user.id), now + 24 * 60 * 60 * 1000);
  check('на следующий день код снова доступен', tomorrow.claimed === false);

  // --- удаление профиля ---
  // Игрок сам просит удалить профиль: данные и сессии пропадают, платежи остаются
  // (по ним оформляются возвраты), а при следующем входе создаётся новый игрок —
  // бонусы за приглашение снова доступны, это осознанное решение (см. README).
  const victimId = invited.user.id;
  store.setCardLevel(victimId, 'memcoin', 1);
  store.addAchievement(victimId, 'first_tap', now);
  store.addCosmetic(victimId, 'hamster_beaver', 'quest', now);
  store.recordPayment({ userId: victimId, itemId: 'coins_5k', stars: 25, chargeId: 'test_charge_delete', now });
  store.boostAdd(victimId, 'turbo', game.utcDay(now));
  // push_log наполняет облачная версия, но таблица общая — проверяем, что и её
  // строки уходят вместе с профилем.
  store.db
    .prepare('INSERT INTO push_log (user_id, kind, day, at) VALUES (?, ?, ?, ?)')
    .run(victimId, 'energy', game.utcDay(now), now);

  const removed = service.deleteProfile(store, store.userById(victimId), now);
  check(
    'удаление профиля вернуло число покупок',
    removed.deleted === true && removed.purchases === 1,
    JSON.stringify(removed)
  );
  check('игрока больше нет в базе', store.userByTgId(5002) === null);
  check('карточки удалённого игрока убраны', store.cardsCount(victimId) === 0);
  check('достижения удалённого игрока убраны', store.achievementsOf(victimId).length === 0);
  check('косметика удалённого игрока убрана', store.cosmeticsOf(victimId).length === 0);
  check(
    'в удалённом профиле не осталось связанных строк',
    store.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM user_cards WHERE user_id = ?) +
           (SELECT COUNT(*) FROM user_quests WHERE user_id = ?) +
           (SELECT COUNT(*) FROM user_achievements WHERE user_id = ?) +
           (SELECT COUNT(*) FROM user_cosmetics WHERE user_id = ?) +
           (SELECT COUNT(*) FROM boost_uses WHERE user_id = ?) +
           (SELECT COUNT(*) FROM sessions WHERE user_id = ?) +
           (SELECT COUNT(*) FROM push_log WHERE user_id = ?) AS n`
      )
      .get(victimId, victimId, victimId, victimId, victimId, victimId, victimId).n === 0
  );
  check('сессия удалённого игрока больше не работает', store.sessionUser(invited.token, now) === null);
  check('платежи удалённого игрока сохранены', store.paymentsCount(victimId) === 1);
  check('соседний игрок не пострадал', store.userByTgId(5001) !== null && store.cardsCount(main.user.id) > 0);

  // Повторный вход: профиль создаётся заново, приглашение снова срабатывает.
  const reborn = auth.login(store, { devId: 5002, startParam: 'ref_5001' }, config, now);
  check(
    'после удаления игрок создаётся заново с бонусом за приглашение',
    !!reborn.token && reborn.referralApplied === true && reborn.user.coins === game.GAME.referralInvitedBonus,
    `монет ${reborn.user.coins}`
  );
  check(
    'новому игроку доступна награда за активность',
    store.userByTgId(5002).referral_paid === 0 && store.userByTgId(5002).referral_taps === 0
  );

  store.close();
}

// -------------------------------------------- D. подпись initData (боевой режим)

// Собираем initData так же, как Telegram: подпись = HMAC_SHA256(secret, data_check_string),
// где secret = HMAC_SHA256("WebAppData", bot_token).
function buildInitData(botToken, fields) {
  const crypto = require('crypto');
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  const dataCheckString = [...pairs].sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  const params = new URLSearchParams(fields);
  params.set('hash', hash);
  return params.toString();
}

function testInitData() {
  const { createStore } = require(path.join(ROOT, 'lib', 'db'));
  const auth = require(path.join(ROOT, 'lib', 'auth'));
  const game = require(path.join(ROOT, 'lib', 'game'));
  const service = require(path.join(ROOT, 'lib', 'service'));
  section('D. Проверка подписи initData (режим Telegram)');

  const botToken = '123456:TEST-TOKEN';
  const now = Date.now();
  const tgUser = { id: 9001, first_name: 'Тест', username: 'tester' };
  const initData = buildInitData(botToken, {
    auth_date: String(Math.floor(now / 1000)),
    query_id: 'AAABBB',
    user: JSON.stringify(tgUser)
  });

  const verdict = auth.validateInitData(initData, botToken, { now, maxAgeMs: 86400000 });
  check('корректная подпись принимается', verdict.ok && verdict.user.id === 9001, verdict.error || '');

  const tampered = new URLSearchParams(initData);
  tampered.set('user', JSON.stringify({ ...tgUser, id: 9002 }));
  check('подмена пользователя отклоняется', auth.validateInitData(tampered.toString(), botToken, { now }).ok === false);

  const stale = buildInitData(botToken, {
    auth_date: String(Math.floor((now - 30 * 3600 * 1000) / 1000)),
    user: JSON.stringify(tgUser)
  });
  check('устаревшая initData отклоняется', auth.validateInitData(stale, botToken, { now, maxAgeMs: 86400000 }).ok === false);
  check('чужой токен не подходит', auth.validateInitData(initData, '999:OTHER-TOKEN', { now }).ok === false);
  check('мусор вместо initData отклоняется', auth.validateInitData('user=abc&hash=zz', botToken, { now }).ok === false);

  const store = createStore(path.join(tmpDir, 'telegram.db'));
  const configTg = { BOT_TOKEN: botToken, ALLOW_DEV: false, AUTH_MAX_AGE_MS: 86400000, SESSION_TTL_MS: 86400000 };
  const login = auth.login(store, { initData }, configTg, now);
  check('вход по Telegram создаёт игрока', !!login.token && login.user.tg_id === 9001, login.error || '');
  check('сессия узнаётся по токену', store.sessionUser(login.token, now).id === login.user.id);

  const badLogin = auth.login(store, { initData: 'user=%7B%22id%22%3A1%7D&hash=deadbeef' }, configTg, now);
  check('поддельная initData -> 401', !!badLogin.error && badLogin.status === 401);
  const devLogin = auth.login(store, { devId: 9001 }, configTg, now);
  check('в режиме Telegram dev-вход запрещён', !!devLogin.error && devLogin.status === 401);

  const invitedData = buildInitData(botToken, {
    auth_date: String(Math.floor(now / 1000)),
    start_param: 'ref_9001',
    user: JSON.stringify({ id: 9002, first_name: 'Друг' })
  });
  const invited = auth.login(store, { initData: invitedData }, configTg, now);
  check('реферальный start_param применяется', invited.referralApplied === true);
  check('приглашённый получил приветственный бонус', store.userByTgId(9002).coins === game.GAME.referralInvitedBonus);
  check('повторный вход не начисляет бонус', auth.login(store, { initData: invitedData }, configTg, now).referralApplied !== true);
  // Награда пригласившему — за активность: без тапов друга она не начисляется.
  check('награда ждёт тапов друга', store.userByTgId(9001).coins === game.GAME.startCoins);
  service.tap(store, store.userByTgId(9002), 40, now + 3000);
  service.tap(store, store.userByTgId(9002), 40, now + 6000);
  const telegramPayout = service.tap(store, store.userByTgId(9002), 40, now + 9000);
  check(
    'после порога награда пришла пригласившему',
    !!telegramPayout.payout && store.userByTgId(9001).coins === game.GAME.referralBonus
  );

  store.close();
}

// -------------------------------------------------------------- C. HTTP API

async function http(pathname, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Auth'] = token;
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        DB_PATH: path.join(tmpDir, 'server.db'),
        BOT_TOKEN: '',
        BOT_USERNAME: 'demo_bot',
        ALLOW_DEV: '1',
        RUN_BOT: '',
        // Реклама в тестах: сеть не дёргаем, показ считаем успешным. Monetag
        // включён тестовой зоной — ролик показывает клиент, автотестам он не нужен.
        AD_MODE: 'stub',
        CHANIFY_API_KEY: 'stub-key',
        AD_PROVIDERS: 'monetag,chanify',
        MONETAG_ZONE: 'zone-http',
        MONETAG_SDK_URL: 'https://example.test/sdk.js',
        MONETAG_POSTBACK_SECRET: 'postback-http-secret',
        // Оплата: внутри Telegram — звёзды, вне — внешняя страница (провайдер-заглушка),
        // поэтому рублёвые платежи можно проверить без сети и реальных списаний.
        PAYMENTS_PROVIDER: 'mock',
        PAY_PAGE_ORIGIN: 'https://pay.example.test',
        PAY_LINK_SECRET: 'smoke-pay-link-secret',
        YOOKASSA_WEBHOOK_SECRET: 'smoke-yookassa-secret'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes(`http://localhost:${PORT}`)) resolve(child);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      // Предупреждение об экспериментальном node:sqlite — ожидаемо, не ошибка.
      if (!text.includes('ExperimentalWarning')) console.error('[server]', text.trim());
    });
    child.on('exit', (code) => reject(new Error(`сервер завершился с кодом ${code}`)));
    setTimeout(() => reject(new Error('сервер не поднялся за 15 секунд')), 15000);
  });
}

async function testHttp() {
  section('C. HTTP API (поднятый сервер)');
  const game = require(path.join(ROOT, 'lib', 'game'));
  const child = await startServer();
  try {
    const health = await http('/api/health');
    check('GET /api/health отвечает', health.status === 200 && health.data.ok === true);

    const index = await fetch(`${BASE}/`);
    const html = await index.text();
    check('статика отдаёт index.html', index.status === 200 && html.includes('Hamster Tap'));

    const noAuth = await http('/api/state');
    check('без токена /api/state -> 401', noAuth.status === 401);

    const auth = await http('/api/auth', { method: 'POST', body: { devId: 777001, devName: 'API Тест' } });
    check('POST /api/auth выдаёт токен', auth.status === 200 && !!auth.data.token, JSON.stringify(auth.data).slice(0, 120));
    const token = auth.data.token;
    check('в состоянии 24 карточки', auth.data.state.cards.length === 24);
    check('есть поле passiveCoins', Object.prototype.hasOwnProperty.call(auth.data.state, 'passiveCoins'));

    // Приглашаем ровно той ссылкой, которую отдаёт сама игра: так тест ловит
    // рассинхрон между сборкой ссылки и её разбором на сервере.
    const invite = await http('/api/friends', { token });
    const inviteParam = new URL(invite.data.link).searchParams.get('startapp');
    check('ссылка-приглашение содержит префикс ref_', /^ref_\d+$/.test(inviteParam), `start_param=${inviteParam}`);
    const friend = await http('/api/auth', { method: 'POST', body: { devId: 777002, startParam: inviteParam } });
    check('вход по ссылке из игры начисляет бонус', friend.data.referralApplied === true);
    check(
      'друг видит свою сумму бонуса',
      friend.data.referralCoins === game.GAME.referralInvitedBonus,
      String(friend.data.referralCoins)
    );
    // Награда пригласившему придёт только после порога тапов друга.
    const waiting = await http('/api/friends', { token });
    check(
      'друг ждёт порога активности',
      waiting.data.rewardsWaiting === 1 && waiting.data.list[0].progress === 0,
      JSON.stringify(waiting.data.list[0])
    );
    check('награда пригласившему ждёт тапов друга', auth.data.state.user.coins === 0, `монеты ${auth.data.state.user.coins}`);
    check('порог награды виден в состоянии', auth.data.state.friends.tapsTarget === game.GAME.referralTapsTarget);

    // Полный цикл: друг тапает до порога, пригласивший получает монеты.
    // Рывок античита — 40 тапов на запрос, между пачками нужно ~2 секунды.
    let rewardsPaid = 0;
    for (let round = 0; round < 4 && !rewardsPaid; round += 1) {
      await http('/api/tap', { method: 'POST', token: friend.data.token, body: { count: 40 } });
      const progress = await http('/api/friends', { token });
      rewardsPaid = progress.data.rewardsPaid;
      if (!rewardsPaid) await new Promise((resolve) => setTimeout(resolve, 2200));
    }
    check('после порога награда выплачена пригласившему', rewardsPaid === 1, `выплат ${rewardsPaid}`);
    // Монеты пригласившего: 100 000 за друга плюс награда достижения «Первый друг»
    // (1 000 монет), которое открывается вместе с приглашением. До выплаты у
    // пригласившего был ноль, поэтому проверка ещё и подтверждает начисление.
    const paidState = await http('/api/state', { token });
    check('пригласивший получил монеты за друга', paidState.data.user.coins >= game.GAME.referralBonus,
      `монеты ${paidState.data.user.coins}`);

    const before = auth.data.state.user;
    const tap = await http('/api/tap', { method: 'POST', token, body: { count: 5 } });
    check('POST /api/tap начисляет монеты', tap.status === 200 && tap.data.accepted > 0 && tap.data.state.user.coins > before.coins);

    const flood = await http('/api/tap', { method: 'POST', token, body: { count: 100 } });
    check('античит ограничивает пачку тапов', flood.data.accepted < 100, `принято ${flood.data.accepted}`);

    const poor = await http('/api/auth', { method: 'POST', body: { devId: 777003, devName: 'Бедный хомяк' } });
    const poorBuy = await http('/api/cards/buy', {
      method: 'POST',
      token: poor.data.token,
      body: { cardId: 'memcoin' }
    });
    check('покупка без монет -> 402', poorBuy.status === 402, `статус ${poorBuy.status}`);

    const poorUpgrade = await http('/api/upgrades/buy', {
      method: 'POST',
      token: poor.data.token,
      body: { kind: 'tap' }
    });
    check('прокачка без монет -> 402', poorUpgrade.status === 402, `статус ${poorUpgrade.status}`);

    const badBoost = await http('/api/boosts/use', { method: 'POST', token, body: { boostId: 'nope' } });
    check('неизвестный буст -> 400', badBoost.status === 400);

    const turbo = await http('/api/boosts/use', { method: 'POST', token, body: { boostId: 'turbo' } });
    check('буст турбо работает', turbo.status === 200 && turbo.data.state.boosts.turbo.active === true);
    check('цена тапа учитывает турбо', turbo.data.state.tapValue === turbo.data.state.user.tapPower * 5);

    const daily = await http('/api/daily/claim', { method: 'POST', token });
    check('ежедневный бонус начисляется', daily.status === 200 && daily.data.reward > 0);

    const top = await http('/api/leaderboard', { token });
    check('лидерборд возвращает игроков', top.status === 200 && top.data.top.length >= 2 && top.data.myRank >= 1);

    const friends = await http('/api/friends', { token });
    check('друзья возвращают ссылку-приглашение', friends.status === 200 && friends.data.link.includes('demo_bot'));
    check(
      'в ответе друзей обе суммы бонуса',
      friends.data.bonus === game.GAME.referralBonus && friends.data.friendBonus === game.GAME.referralInvitedBonus,
      `${friends.data.bonus}/${friends.data.friendBonus}`
    );

    // Задания, достижения, косметика и профиль — новые ручки этапа 1.
    check(
      'достижение «первый тап» приходит в том же ответе',
      (tap.data.state.unlocked || []).some((item) => item.id === 'first_tap')
    );

    const questsHttp = await http('/api/quests', { token });
    check('GET /api/quests отдаёт задания дня', questsHttp.status === 200 && questsHttp.data.total === 8);

    const achHttp = await http('/api/achievements', { token });
    check('GET /api/achievements отдаёт достижения', achHttp.status === 200 && achHttp.data.total === 12);
    check('в достижениях есть выданные', achHttp.data.done >= 1);

    const cosHttp = await http('/api/cosmetics', { token });
    check('GET /api/cosmetics отдаёт каталог', cosHttp.status === 200 && cosHttp.data.catalog.length === 22);

    const equipHttp = await http('/api/cosmetics/equip', {
      method: 'POST',
      token,
      body: { itemId: 'palette_default' }
    });
    check(
      'бесплатную косметику можно надеть',
      equipHttp.status === 200 && equipHttp.data.state.cosmetics.palette.id === 'palette_default'
    );

    const lockedEquip = await http('/api/cosmetics/equip', {
      method: 'POST',
      token,
      body: { itemId: 'hamster_bear' }
    });
    check('закрытую косметику надеть нельзя -> 403', lockedEquip.status === 403);

    // Бонус дня в этом сценарии уже забран, значит задание «забери бонус дня» выполнено.
    const claimHttp = await http('/api/quests/claim', {
      method: 'POST',
      token,
      body: { questId: 'daily_bonus' }
    });
    check('награда за задание забирается', claimHttp.status === 200 && claimHttp.data.coins > 0);

    const claimAgain = await http('/api/quests/claim', {
      method: 'POST',
      token,
      body: { questId: 'daily_bonus' }
    });
    check('повторная награда за задание -> 409', claimAgain.status === 409);

    const meId = auth.data.state.user.id;
    const profileHttp = await http(`/api/profile/${meId}`, { token });
    check('профиль открывается по id', profileHttp.status === 200 && profileHttp.data.mine === true);
    check(
      'в профиле есть статистика и достижения',
      profileHttp.data.totalTaps >= 1 && profileHttp.data.achievementsTotal === 12
    );
    check('в профиле нет tg_id', profileHttp.data.tg_id === undefined);
    check(
      'в профиле «стена» из 12 достижений с флагом открытия',
      profileHttp.data.achievements.length === 12 &&
        profileHttp.data.achievements.every((item) => typeof item.done === 'boolean') &&
        profileHttp.data.achievements.filter((item) => item.done).length === profileHttp.data.achievementsDone,
      `достижений: ${profileHttp.data.achievements.length}`
    );

    const profileMissing = await http('/api/profile/999999', { token });
    check('неизвестный профиль -> 404', profileMissing.status === 404);

    const profileBadId = await http('/api/profile/abc', { token });
    check('некорректный id профиля -> 400', profileBadId.status === 400);

    const pushHttp = await http('/api/push', { method: 'POST', token, body: { energy: false } });
    check('настройки напоминаний сохраняются', pushHttp.status === 200 && pushHttp.data.notify.energy === false);

    const stateHttp = await http('/api/state', { token });
    check('в состоянии есть сводка заданий', !!stateHttp.data.quests && stateHttp.data.quests.total === 8);
    check('в состоянии есть активная косметика', !!stateHttp.data.cosmetics.hamster);
    check('в состоянии есть настройки напоминаний', stateHttp.data.notify.energy === false);
    check('в состоянии есть премиум-буст', !!stateHttp.data.tapBoost && stateHttp.data.tapBoost.multiplier === 2);

    // Магазин за звёзды: список товаров известен, а счёт без BOT_TOKEN создать нельзя.
    const shopHttp = await http('/api/shop', { token });
    check('GET /api/shop отдаёт товары', shopHttp.status === 200 && shopHttp.data.items.length === 9, `HTTP ${shopHttp.status}`);
    check(
      'в магазине есть премиум-косметика',
      (shopHttp.data.items || []).some((item) => item.kind === 'cosmetic' && item.stars > 0)
    );

    const invoiceHttp = await http('/api/shop/invoice', { method: 'POST', token, body: { itemId: 'coins_5k' } });
    check('счёт без BOT_TOKEN недоступен -> 503', invoiceHttp.status === 503, `HTTP ${invoiceHttp.status}`);

    const invoiceBadItem = await http('/api/shop/invoice', { method: 'POST', token, body: { itemId: 'nope' } });
    check('счёт на неизвестный товар -> 400', invoiceBadItem.status === 400, `HTTP ${invoiceBadItem.status}`);

    // Код дня: статус → неверный код → верный код → повтор.
    const codeHttp = await http('/api/code', { token });
    check(
      'GET /api/code отдаёт статус',
      codeHttp.status === 200 && codeHttp.data.claimed === false && codeHttp.data.reward > 0,
      `HTTP ${codeHttp.status}`
    );

    const badCodeHttp = await http('/api/code/claim', { method: 'POST', token, body: { code: 'ZZZZZZ' } });
    check('неверный код дня -> 400', badCodeHttp.status === 400, `HTTP ${badCodeHttp.status}`);

    const codeLib = require(path.join(ROOT, 'lib', 'dailycode'));
    const goodCodeHttp = await http('/api/code/claim', {
      method: 'POST',
      token,
      body: { code: codeLib.codeFor(new Date().toISOString().slice(0, 10)) }
    });
    check('верный код дня принимается', goodCodeHttp.status === 200 && goodCodeHttp.data.coins > 0, `HTTP ${goodCodeHttp.status}`);

    const codeAgainHttp = await http('/api/code/claim', {
      method: 'POST',
      token,
      body: { code: codeLib.codeFor(new Date().toISOString().slice(0, 10)) }
    });
    check('повторный код дня -> 409', codeAgainHttp.status === 409, `HTTP ${codeAgainHttp.status}`);

    // Энергия за рекламу: сервер поднят в тестовом режиме (AD_MODE=stub), поэтому
    // проходим весь путь — запрос, пауза, просмотр, начисление. Энергию обнуляем
    // прямо в базе сервера: тапами до нуля не дойти без ожидания.
    const { DatabaseSync } = require('node:sqlite');
    const serverDb = new DatabaseSync(path.join(tmpDir, 'server.db'));
    serverDb.prepare('UPDATE users SET energy = 0 WHERE tg_id = ?').run(777001);
    serverDb.close();

    const adStatusHttp = await http('/api/energy/ad/status', { token });
    check(
      'статус рекламы отдаётся',
      adStatusHttp.status === 200 && adStatusHttp.data.available === true &&
        adStatusHttp.data.providers[0].id === 'monetag',
      JSON.stringify(adStatusHttp.data)
    );

    // Основной путь: rewarded-ролик внутри мини-аппа. Сервер выдаёт сессию, клиент
    // показывает видео и подтверждает просмотр — энергию начисляет claim.
    const adReq = await http('/api/energy/ad/request', { method: 'POST', token });
    check(
      'POST /api/energy/ad/request выдаёт сессию ролика',
      adReq.status === 200 && adReq.data.pending === true && adReq.data.mode === 'client' && !!adReq.data.token,
      JSON.stringify(adReq.data)
    );
    const adAfterReq = await http('/api/state', { token });
    check('до просмотра энергия не восстановлена', adAfterReq.data.user.energy < 100, `энергия ${adAfterReq.data.user.energy}`);

    const adUndoneHttp = await http('/api/energy/ad/claim', {
      method: 'POST',
      token,
      body: { token: adReq.data.token, done: false }
    });
    check(
      'недосмотренный ролик награду не даёт',
      adUndoneHttp.status === 200 && adUndoneHttp.data.credited === false,
      JSON.stringify(adUndoneHttp.data)
    );
    const adClaimHttp = await http('/api/energy/ad/claim', {
      method: 'POST',
      token,
      body: { token: adReq.data.token, done: true }
    });
    check(
      'после ролика энергия восстановлена',
      adClaimHttp.status === 200 && adClaimHttp.data.credited === true &&
        adClaimHttp.data.energy === adClaimHttp.data.state.user.energyLimit,
      `энергия ${adClaimHttp.data?.energy}, вернули ${adClaimHttp.data?.restored}`
    );
    const adClaimTwice = await http('/api/energy/ad/claim', {
      method: 'POST',
      token,
      body: { token: adReq.data.token, done: true }
    });
    check(
      'повторный claim не начисляет дважды',
      adClaimTwice.status === 200 && adClaimTwice.data.credited === true && adClaimTwice.data.restored === 0,
      `HTTP ${adClaimTwice.status}: ${JSON.stringify({ credited: adClaimTwice.data?.credited, restored: adClaimTwice.data?.restored })}`
    );
    const adWaitHttp = await http('/api/energy/ad/status', { token });
    check('награда включает паузу', adWaitHttp.data.readyInMs > 0, `ждём ${adWaitHttp.data.readyInMs} мс`);

    // Запасной путь: ролик не запустился (skip) — реклама уходит в чат. После
    // награды у первого игрока пауза, поэтому проверяем на втором.
    const chatAuth = await http('/api/auth', { method: 'POST', body: { devId: 777006, devName: 'Чат' } });
    const chatToken = chatAuth.data.token;
    const chatDb = new DatabaseSync(path.join(tmpDir, 'server.db'));
    chatDb.prepare('UPDATE users SET energy = 0 WHERE tg_id = ?').run(777006);
    chatDb.close();

    const chatReqHttp = await http('/api/energy/ad/request', {
      method: 'POST',
      token: chatToken,
      body: { skip: ['monetag'] }
    });
    check(
      'skip переводит рекламу в чат',
      chatReqHttp.status === 200 && chatReqHttp.data.provider === 'chanify' && chatReqHttp.data.mode === 'chat',
      JSON.stringify(chatReqHttp.data)
    );
    const chatWaitHttp = await http('/api/energy/ad/status', { token: chatToken });
    check('после запроса в чат видна пауза', chatWaitHttp.data.readyInMs > 0, `ждём ${chatWaitHttp.data.readyInMs} мс`);
    const chatEarlyHttp = await http('/api/energy/ad/confirm', {
      method: 'POST',
      token: chatToken,
      body: { token: chatReqHttp.data.token }
    });
    check('подтверждение раньше срока -> 409', chatEarlyHttp.status === 409, `HTTP ${chatEarlyHttp.status}`);

    // Ждать 10 секунд в тесте незачем: сдвигаем время выдачи прямо в базе — так
    // же, как если бы игрок провёл в чате дольше обязательной паузы.
    const chatDb2 = new DatabaseSync(path.join(tmpDir, 'server.db'));
    chatDb2
      .prepare('UPDATE ad_rewards SET at = at - ? WHERE token = ?')
      .run(game.GAME.adEnergy.confirmDelayMs + 1000, chatReqHttp.data.token);
    chatDb2.close();

    const chatDoneHttp = await http('/api/energy/ad/confirm', {
      method: 'POST',
      token: chatToken,
      body: { token: chatReqHttp.data.token }
    });
    check(
      'после возвращения из чата энергия восстановлена',
      chatDoneHttp.status === 200 && chatDoneHttp.data.energy === chatDoneHttp.data.state.user.energyLimit,
      `энергия ${chatDoneHttp.data?.energy}, вернули ${chatDoneHttp.data?.restored}`
    );
    const chatRepeatHttp = await http('/api/energy/ad/confirm', {
      method: 'POST',
      token: chatToken,
      body: { token: chatReqHttp.data.token }
    });
    check('повторный confirm отклонён', chatRepeatHttp.status === 409, `HTTP ${chatRepeatHttp.status}`);

    // Второй тестовый игрок больше не нужен — убираем его вместе с данными.
    const chatRemove = await http('/api/profile/delete', { method: 'POST', token: chatToken });
    check('профиль игрока для проверки рекламы удалён', chatRemove.status === 200, `HTTP ${chatRemove.status}`);

    // Постбек Monetag: сеть присылает подтверждение показа по нашему ymid. Проверяем
    // и приём, и защиту адреса — без секрета эндпоинт отвечает 404, как чужой маршрут.
    const pbPlayer = await http('/api/auth', { method: 'POST', body: { devId: 777007, devName: 'Постбек' } });
    const pbToken = pbPlayer.data.token;
    const pbDb = new DatabaseSync(path.join(tmpDir, 'server.db'));
    pbDb.prepare('UPDATE users SET energy = 0 WHERE tg_id = ?').run(777007);
    pbDb.close();

    const pbReqHttp = await http('/api/energy/ad/request', { method: 'POST', token: pbToken });
    check(
      'сессия ролика выдана для постбека',
      pbReqHttp.status === 200 && pbReqHttp.data.mode === 'client' && !!pbReqHttp.data.token,
      `HTTP ${pbReqHttp.status}`
    );
    const pbWrong = await http(`/api/ads/monetag/wrong-secret?ymid=${pbReqHttp.data.token}&event=impression&value=valued`);
    check('чужой секрет постбека -> 404', pbWrong.status === 404, `HTTP ${pbWrong.status}`);
    const pbOk = await http(
      `/api/ads/monetag/postback-http-secret?ymid=${pbReqHttp.data.token}&event=impression&value=valued&sub=999`
    );
    check('постбек принят и отмечен', pbOk.status === 200 && pbOk.data.ok === true, JSON.stringify(pbOk.data));
    const pbClaimHttp = await http('/api/energy/ad/claim', {
      method: 'POST',
      token: pbToken,
      body: { token: pbReqHttp.data.token, done: true }
    });
    check(
      'после постбека клиент получает награду',
      pbClaimHttp.status === 200 && pbClaimHttp.data.credited === true && pbClaimHttp.data.energy > 0,
      JSON.stringify({ credited: pbClaimHttp.data?.credited, energy: pbClaimHttp.data?.energy })
    );
    const pbRemove = await http('/api/profile/delete', { method: 'POST', token: pbToken });
    check('профиль игрока для постбека удалён', pbRemove.status === 200, `HTTP ${pbRemove.status}`);

    // Оплата: витрина отдаёт обе валюты, внешняя страница работает по личной ссылке,
    // а уведомления ЮKassa принимаются только по секретному адресу.
    const shopPayHttp = await http('/api/shop', { token });
    check(
      'витрина отдаёт цены в рублях и звёздах',
      shopPayHttp.status === 200 && shopPayHttp.data.items.every((item) => item.price > 0 && !!item.priceText && !!item.starsText),
      JSON.stringify(shopPayHttp.data.items[0])
    );
    check(
      'в витрине видно каналы оплаты',
      Array.isArray(shopPayHttp.data.payment.providers) && shopPayHttp.data.payment.providers.length === 2 &&
        shopPayHttp.data.payment.payPage === 'https://pay.example.test/pay.html',
      JSON.stringify(shopPayHttp.data.payment)
    );

    const payLinkHttp = await http('/api/pay/link', { token });
    const payUrl = payLinkHttp.data.link || '';
    check(
      'личная ссылка на внешнюю оплату выдаётся',
      payLinkHttp.status === 200 && payUrl.startsWith('https://pay.example.test/pay.html?t='),
      payUrl
    );
    const payToken = payUrl.split('?t=')[1];

    const payInfoBad = await http('/api/pay/info?t=broken');
    check('страница оплаты без валидного токена -> 401', payInfoBad.status === 401, `HTTP ${payInfoBad.status}`);

    const payInfo = await http(`/api/pay/info?t=${payToken}`);
    check(
      'страница оплаты отдаёт товары с ценами в рублях',
      payInfo.status === 200 && payInfo.data.items.length === 9 &&
        payInfo.data.items.every((item) => item.price > 0 && !!item.priceText),
      `HTTP ${payInfo.status}, товаров ${payInfo.data?.items?.length}`
    );

    const payCreate = await http(`/api/pay/create?t=${payToken}`, {
      method: 'POST',
      body: { itemId: 'coins_5k', email: 'smoke@example.test' }
    });
    check(
      'создание рублёвого платежа отдаёт ссылку на оплату',
      payCreate.status === 200 && payCreate.data.mode === 'external' &&
        payCreate.data.currency === 'RUB' && payCreate.data.amount === 4900 && !!payCreate.data.payUrl,
      JSON.stringify({ provider: payCreate.data?.provider, amount: payCreate.data?.amount })
    );

    const hookWrong = await http('/api/payments/yookassa/wrong-secret', {
      method: 'POST',
      body: { event: 'payment.succeeded', object: { id: 'x' } }
    });
    check('чужой секрет уведомления ЮKassa -> 404', hookWrong.status === 404, `HTTP ${hookWrong.status}`);

    const hookUnknown = await http('/api/payments/yookassa/smoke-yookassa-secret', {
      method: 'POST',
      body: { event: 'payment.succeeded', object: { id: 'unknown-payment' } }
    });
    check(
      'уведомление по неизвестному платежу товар не выдаёт',
      hookUnknown.status === 200 && hookUnknown.data.ok === false && hookUnknown.data.reason === 'unknown_payment',
      JSON.stringify(hookUnknown.data)
    );

    const hookCanceled = await http('/api/payments/yookassa/smoke-yookassa-secret', {
      method: 'POST',
      body: { event: 'payment.canceled', object: { id: payCreate.data.externalId } }
    });
    check(
      'уведомление об отмене помечает платёж',
      hookCanceled.status === 200 && hookCanceled.data.canceled === true,
      JSON.stringify(hookCanceled.data)
    );

    const payAfterCancel = await http(`/api/pay/status?t=${payToken}&id=${encodeURIComponent(payCreate.data.externalId)}`);
    check(
      'статус отменённого платежа виден на странице',
      payAfterCancel.status === 200 && payAfterCancel.data.payment.status === 'canceled',
      JSON.stringify(payAfterCancel.data.payment)
    );

    // Удаление профиля по своей сессии: чужой профиль тронуть нельзя, потому что
    // идентификатор в запросе не принимается вообще.
    const bystander = await http('/api/auth', { method: 'POST', body: { devId: 777003, devName: 'Сосед' } });
    const friendState = await http('/api/state', { token: friend.data.token });
    check('приглашённый вошёл в игру', friendState.status === 200, `HTTP ${friendState.status}`);
    const removeSelf = await http('/api/profile/delete', { method: 'POST', token: friend.data.token });
    check(
      'удаление своего профиля -> 200',
      removeSelf.status === 200 && removeSelf.data.deleted === true,
      JSON.stringify(removeSelf.data)
    );
    const afterDelete = await http('/api/state', { token: friend.data.token });
    check('токен удалённого игрока больше не работает (401)', afterDelete.status === 401, `HTTP ${afterDelete.status}`);
    const ghostProfile = await http(`/api/profile/${friend.data.state.user.id}`, { token });
    check('профиль удалённого игрока не открывается (404)', ghostProfile.status === 404, `HTTP ${ghostProfile.status}`);
    const neighbourState = await http('/api/state', { token: bystander.data.token });
    check('соседний игрок не пострадал', neighbourState.status === 200, `HTTP ${neighbourState.status}`);
    // Повторный вход создаёт новый профиль: удаление не блокирует игру заново.
    const reborn = await http('/api/auth', {
      method: 'POST',
      body: { devId: 777002, devName: 'Друг по ссылке' }
    });
    check(
      'после удаления вход создаёт новый профиль',
      reborn.status === 200 && !!reborn.data.token && reborn.data.state.user.coins === 0,
      `монет ${reborn.data.state.user.coins}`
    );

    const unknown = await http('/api/nope');
    check('неизвестный маршрут -> 404', unknown.status === 404);
  } finally {
    child.kill();
  }
}

// ------------------------------------------------------------------ итоги

(async () => {
  console.log('Hamster Tap — smoke-тест');
  try {
    testRules();
    await testService();
    testInitData();
    await testHttp();
  } catch (error) {
    failures.push(`неожиданная ошибка: ${error.message}`);
    console.error(error);
  } finally {
    // На Windows файлы SQLite могут освобождаться с задержкой — чистим аккуратно.
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      console.log(`(временную папку можно удалить вручную: ${tmpDir})`);
    }
  }
  console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
  if (failures.length) {
    console.log('Провалы:');
    for (const failure of failures) console.log(` - ${failure}`);
    process.exit(1);
  }
  console.log('Все проверки прошли.');
})();


