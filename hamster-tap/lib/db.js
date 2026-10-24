'use strict';
// Слой данных: SQLite из стандартной библиотеки Node (node:sqlite, Node >= 22.5).
// Храним только состояние игрока; сам баланс (карточки, цены) описан в lib/game.js,
// поэтому править экономику можно без миграций.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id          INTEGER NOT NULL UNIQUE,
  username       TEXT,
  first_name     TEXT,
  last_name      TEXT,
  coins          INTEGER NOT NULL DEFAULT 0,
  energy         INTEGER NOT NULL DEFAULT 1000,
  energy_limit   INTEGER NOT NULL DEFAULT 1000,
  tap_power      INTEGER NOT NULL DEFAULT 1,
  tap_level      INTEGER NOT NULL DEFAULT 1,
  energy_level   INTEGER NOT NULL DEFAULT 1,
  profit_per_hour INTEGER NOT NULL DEFAULT 0,
  total_earned   INTEGER NOT NULL DEFAULT 0,
  total_taps     INTEGER NOT NULL DEFAULT 0,
  referrer_id    INTEGER,
  -- Приглашение: когда привязан пригласивший, сколько тапов набрал приглашённый
  -- после этого и выплачена ли награда пригласившему (см. lib/service.tap).
  referred_at    INTEGER NOT NULL DEFAULT 0,
  referral_taps  INTEGER NOT NULL DEFAULT 0,
  referral_paid  INTEGER NOT NULL DEFAULT 0,
  daily_streak   INTEGER NOT NULL DEFAULT 0,
  daily_last     INTEGER NOT NULL DEFAULT 0,
  turbo_until    INTEGER NOT NULL DEFAULT 0,
  last_tap_at    INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_cards (
  user_id  INTEGER NOT NULL,
  card_id  TEXT    NOT NULL,
  level    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, card_id)
);

CREATE TABLE IF NOT EXISTS boost_uses (
  user_id  INTEGER NOT NULL,
  boost_id TEXT    NOT NULL,
  day      TEXT    NOT NULL,
  used     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, boost_id, day)
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Приглашение, пришедшее через бота (/start ref_123): игрок ещё не открывал
-- мини-апп, поэтому бонус применяется при первом входе в игру.
CREATE TABLE IF NOT EXISTS pending_refs (
  tg_id            INTEGER PRIMARY KEY,
  referrer_tg_id   INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);

-- Индекс по доходу больше не нужен: рейтинг считается по текущему балансу монет.
-- (Индекс по coins сознательно не создаём — см. комментарий в lib/db.js.)
DROP INDEX IF EXISTS idx_users_profit;
CREATE INDEX IF NOT EXISTS idx_users_referrer ON users (referrer_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

-- Ежедневные задания: строка появляется только когда награда реально забрана,
-- прогресс считается по счётчикам дня в users и другим уже имеющимся данным.
CREATE TABLE IF NOT EXISTS user_quests (
  user_id    INTEGER NOT NULL,
  quest_id   TEXT    NOT NULL,
  day        TEXT    NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, quest_id, day)
);

CREATE TABLE IF NOT EXISTS user_achievements (
  user_id        INTEGER NOT NULL,
  achievement_id TEXT    NOT NULL,
  at             INTEGER NOT NULL,
  PRIMARY KEY (user_id, achievement_id)
);

-- Открытая косметика: обычная — за квесты и достижения, премиум — за Stars (позже).
CREATE TABLE IF NOT EXISTS user_cosmetics (
  user_id INTEGER NOT NULL,
  item_id TEXT    NOT NULL,
  source  TEXT    NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

-- Журнал напоминаний: PK не даёт отправить одно и то же напоминание дважды в день.
CREATE TABLE IF NOT EXISTS push_log (
  user_id INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  day     TEXT    NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, day)
);

-- Покупки: charge_id — идентификатор платежа у провайдера (telegram_payment_charge_id
-- у звёзд, id платежа у ЮKassa), он уникален, поэтому повторный апдейт/вебхук не выдаст
-- товар второй раз. provider различает каналы, amount — сумма в минорных единицах
-- (звёзды или копейки), status проходит путь pending -> succeeded / canceled,
-- refunded_at отмечает возврат.
CREATE TABLE IF NOT EXISTS payments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  item_id     TEXT    NOT NULL,
  stars       INTEGER NOT NULL DEFAULT 0,
  charge_id   TEXT    NOT NULL UNIQUE,
  provider    TEXT,
  amount      INTEGER NOT NULL DEFAULT 0,
  currency    TEXT    NOT NULL DEFAULT 'XTR',
  status      TEXT    NOT NULL DEFAULT 'succeeded',
  refunded_at INTEGER NOT NULL DEFAULT 0,
  at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments (user_id);

-- Выдачи рекламы за энергию (Monetag и Chanify): token уникален, поэтому награда
-- за один показ начисляется ровно один раз. status хранит путь pending (показ
-- выдан, ждём подтверждения) -> credited; неудачные попытки пишем как failed —
-- они нужны только для паузы между попытками. provider различает клиентские
-- форматы (Monetag: видео внутри мини-аппа) и рекламу в чате (Chanify).
CREATE TABLE IF NOT EXISTS ad_rewards (
  token         TEXT    PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  kind          TEXT    NOT NULL,
  status        TEXT    NOT NULL,
  energy        INTEGER NOT NULL DEFAULT 0,
  impression_id TEXT,
  provider      TEXT,
  external_id   TEXT,
  postback_at   INTEGER NOT NULL DEFAULT 0,
  postback_value TEXT,
  client_done_at INTEGER NOT NULL DEFAULT 0,
  at            INTEGER NOT NULL,
  credited_at   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_ad_rewards_user ON ad_rewards (user_id);
`;

// Поля, которые разрешено обновлять через store.updateUser (защита от опечаток
// и от подстановки произвольных колонок в SQL).
const UPDATABLE = new Set([
  'username', 'first_name', 'last_name', 'coins', 'energy', 'energy_limit',
  'tap_power', 'tap_level', 'energy_level', 'profit_per_hour', 'total_earned',
  'total_taps', 'referrer_id', 'referred_at', 'referral_taps', 'referral_paid',
  'daily_streak', 'daily_last', 'turbo_until', 'last_tap_at', 'last_seen',
  // Счётчики текущего дня (прогресс ежедневных заданий) и день, к которому они относятся.
  'day_key', 'taps_today', 'buys_today', 'earned_today',
  // Надетая косметика, премиум-буст и подписки на напоминания бота.
  'hamster_skin', 'palette', 'background', 'badge', 'tap_boost_until',
  'notify_energy', 'notify_daily', 'notify_rank',
  // Профиль Telegram: нужен для таргетинга рекламы (userMeta у Chanify).
  'language_code', 'is_premium'
]);

// Колонки, добавленные после первого релиза. Существующие базы обновляются
// точечно (SQLite не умеет ADD COLUMN IF NOT EXISTS), повторный запуск безопасен.
const USER_COLUMNS = [
  ['day_key', "TEXT NOT NULL DEFAULT ''"],
  ['taps_today', 'INTEGER NOT NULL DEFAULT 0'],
  ['buys_today', 'INTEGER NOT NULL DEFAULT 0'],
  ['earned_today', 'INTEGER NOT NULL DEFAULT 0'],
  ['hamster_skin', 'TEXT'],
  ['palette', 'TEXT'],
  ['background', 'TEXT'],
  ['badge', 'TEXT'],
  ['tap_boost_until', 'INTEGER NOT NULL DEFAULT 0'],
  ['referred_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['referral_taps', 'INTEGER NOT NULL DEFAULT 0'],
  ['referral_paid', 'INTEGER NOT NULL DEFAULT 0'],
  ['notify_energy', 'INTEGER NOT NULL DEFAULT 1'],
  ['language_code', 'TEXT'],
  ['is_premium', 'INTEGER NOT NULL DEFAULT 0'],
  ['notify_daily', 'INTEGER NOT NULL DEFAULT 1'],
  ['notify_rank', 'INTEGER NOT NULL DEFAULT 1']
];

/** Добавляет недостающие колонки users (миграция для уже существующих баз). */
function ensureColumns(db) {
  const have = new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name));
  for (const [name, ddl] of USER_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${ddl}`);
  }
  // Миграция данных: приглашения, созданные до появления referred_at, получили
  // награду сразу при входе друга (старые правила), поэтому помечаем их
  // выплаченными — иначе награда начислилась бы второй раз. Выполняется ровно
  // один раз: при первом обновлении схемы (пока колонки ещё не было).
  if (!have.has('referral_paid')) {
    db.exec(`
      UPDATE users SET referral_paid = 1 WHERE referrer_id IS NOT NULL AND referred_at = 0;
      UPDATE users SET referred_at = created_at WHERE referrer_id IS NOT NULL AND referred_at = 0;
    `);
  }
}

// Колонки выдач рекламы, добавленные вместе с Monetag: provider хранит сеть
// показа (у старых строк NULL — считаем их рекламой в чате), external_id —
// идентификатор показа на стороне сети, postback_at/postback_value — отметку о
// серверном подтверждении показа (постбек сети знает наш ymid = token),
// client_done_at — когда клиент сообщил, что ролик досмотрен (от неё считается
// окно ожидания постбека).
const AD_REWARD_COLUMNS = [
  ['provider', 'TEXT'],
  ['external_id', 'TEXT'],
  ['postback_at', 'INTEGER NOT NULL DEFAULT 0'],
  ['postback_value', 'TEXT'],
  ['client_done_at', 'INTEGER NOT NULL DEFAULT 0']
];

/** Добавляет недостающие колонки ad_rewards (миграция для существующих баз). */
function ensureAdRewardColumns(db) {
  const have = new Set(db.prepare('PRAGMA table_info(ad_rewards)').all().map((row) => row.name));
  for (const [name, ddl] of AD_REWARD_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE ad_rewards ADD COLUMN ${name} ${ddl}`);
  }
}

// Колонки журнала покупок, добавленные вместе с рублёвым каналом: провайдер
// (звёзды/ЮKassa), сумма в минорных единицах, валюта, статус и отметка возврата.
const PAYMENT_COLUMNS = [
  ['provider', 'TEXT'],
  ['amount', 'INTEGER NOT NULL DEFAULT 0'],
  ['currency', "TEXT NOT NULL DEFAULT 'XTR'"],
  ['status', "TEXT NOT NULL DEFAULT 'succeeded'"],
  ['refunded_at', 'INTEGER NOT NULL DEFAULT 0']
];

/** Добавляет недостающие колонки payments и переносит старые звёздные покупки. */
function ensurePaymentColumns(db) {
  const have = new Set(db.prepare('PRAGMA table_info(payments)').all().map((row) => row.name));
  for (const [name, ddl] of PAYMENT_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE payments ADD COLUMN ${name} ${ddl}`);
  }
  // Покупки, сделанные до появления рублёвого канала, — звёздные: у них нет
  // провайдера и суммы в новой колонке. Выполняется при первом обновлении схемы.
  if (!have.has('provider')) {
    db.exec("UPDATE payments SET provider = 'stars', currency = 'XTR', amount = stars, status = 'succeeded'");
  }
}


/**
 * Открывает (при необходимости создаёт) базу и возвращает набор методов доступа.
 * Отдельная фабрика нужна тестам: можно поднять изолированную базу во временной папке.
 */
function createStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  ensureColumns(db);
  ensureAdRewardColumns(db);
  ensurePaymentColumns(db);

  const stmt = {
    insertUser: db.prepare(`
      INSERT INTO users (tg_id, username, first_name, last_name, coins, energy,
                         energy_limit, tap_power, referrer_id, referred_at, created_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    userByTgId: db.prepare('SELECT * FROM users WHERE tg_id = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    cardsOfUser: db.prepare('SELECT card_id, level FROM user_cards WHERE user_id = ?'),
    cardOfUser: db.prepare('SELECT level FROM user_cards WHERE user_id = ? AND card_id = ?'),
    upsertCard: db.prepare(`
      INSERT INTO user_cards (user_id, card_id, level) VALUES (?, ?, ?)
      ON CONFLICT (user_id, card_id) DO UPDATE SET level = excluded.level
    `),
    sessionInsert: db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
    sessionGet: db.prepare('SELECT * FROM sessions WHERE token = ?'),
    sessionPurge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    boostGet: db.prepare('SELECT used FROM boost_uses WHERE user_id = ? AND boost_id = ? AND day = ?'),
    boostAdd: db.prepare(`
      INSERT INTO boost_uses (user_id, boost_id, day, used) VALUES (?, ?, ?, 1)
      ON CONFLICT (user_id, boost_id, day) DO UPDATE SET used = used + 1
    `),
    referrals: db.prepare(`
      SELECT id, tg_id, username, first_name, coins, profit_per_hour, total_earned,
             referral_taps, referral_paid
      FROM users WHERE referrer_id = ? ORDER BY coins DESC, id ASC LIMIT 50
    `),
    referralCount: db.prepare('SELECT COUNT(*) AS n FROM users WHERE referrer_id = ?'),
    // Награда пригласившему: флаг выплаты ставится условно — это единственная точка
    // синхронизации, поэтому параллельные пачки тапов не начислят бонус дважды.
    referralClaim: db.prepare(`
      UPDATE users SET referral_paid = 1, last_seen = ?
       WHERE id = ? AND referral_paid = 0 AND referral_taps >= ?
    `),
    referralPayoutInfo: db.prepare(`
      SELECT u.tg_id AS invited_tg_id, u.first_name AS invited_name,
             r.id AS referrer_id, r.tg_id AS referrer_tg_id, r.first_name AS referrer_name
      FROM users u LEFT JOIN users r ON r.id = u.referrer_id WHERE u.id = ?
    `),
    referralBonusAdd: db.prepare(
      'UPDATE users SET coins = coins + ?, total_earned = total_earned + ?, last_seen = ? WHERE id = ?'
    ),
    // Рейтинг — по текущему балансу монет. Ничьи разрешаются по id: выше тот,
    // кто раньше в игре (у новичков монет ноль, поэтому тайбрейк обязателен).
    // Индекс по coins не создаём: монеты меняются на каждой пачке тапов, и индекс
    // удвоил бы расход записей (в облаке D1 это прямо ограничивает число игроков),
    // а полный проход по таблице нужен только для снимка рейтинга раз в 2 минуты.
    leaderboard: db.prepare(`
      SELECT id, tg_id, username, first_name, coins, total_earned,
             (SELECT COUNT(*) FROM user_achievements WHERE user_id = users.id) AS ach
      FROM users ORDER BY coins DESC, id ASC LIMIT ?
    `),
    rank: db.prepare(`
      SELECT COUNT(*) + 1 AS rank FROM users
      WHERE coins > ? OR (coins = ? AND id < ?)
    `),
    playersCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
    pendingRefSet: db.prepare(`
      INSERT INTO pending_refs (tg_id, referrer_tg_id, created_at) VALUES (?, ?, ?)
      ON CONFLICT (tg_id) DO UPDATE SET referrer_tg_id = excluded.referrer_tg_id,
                                        created_at = excluded.created_at
    `),
    pendingRefGet: db.prepare('SELECT referrer_tg_id FROM pending_refs WHERE tg_id = ?'),
    pendingRefDelete: db.prepare('DELETE FROM pending_refs WHERE tg_id = ?'),

    // --- задания, достижения и косметика ---
    questClaim: db.prepare(`
      INSERT OR IGNORE INTO user_quests (user_id, quest_id, day, claimed_at) VALUES (?, ?, ?, ?)
    `),
    questsOfDay: db.prepare('SELECT quest_id FROM user_quests WHERE user_id = ? AND day = ?'),
    achievementAdd: db.prepare(`
      INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, at) VALUES (?, ?, ?)
    `),
    achievementsOf: db.prepare(
      'SELECT achievement_id, at FROM user_achievements WHERE user_id = ? ORDER BY at ASC'
    ),
    cosmeticAdd: db.prepare(`
      INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, source, at) VALUES (?, ?, ?, ?)
    `),
    cosmeticsOf: db.prepare('SELECT item_id, source, at FROM user_cosmetics WHERE user_id = ?'),
    // Друзья, пришедшие сегодня (для задания «Пригласи друга»). Считаем по времени
    // привязки, а не создания игрока: приглашение может прийти и позже.
    referralsToday: db.prepare('SELECT COUNT(*) AS n FROM users WHERE referrer_id = ? AND referred_at >= ?'),
    // Бусты за день: счётчик уже ведётся таблицей boost_uses, отдельный не нужен.
    boostsUsedToday: db.prepare(
      'SELECT COALESCE(SUM(used), 0) AS n FROM boost_uses WHERE user_id = ? AND day = ?'
    ),
    // Сколько карточек куплено — нужно достижениям и профилю игрока.
    cardsCount: db.prepare('SELECT COUNT(*) AS n FROM user_cards WHERE user_id = ?'),

    // --- покупки (звёзды и рубли) ---
    // charge_id уникален: повторный апдейт successful_payment или повторный вебхук
    // ничего не изменит, поэтому товар не выдадут дважды.
    paymentAdd: db.prepare(`
      INSERT OR IGNORE INTO payments
        (user_id, item_id, stars, charge_id, provider, amount, currency, status, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    paymentByCharge: db.prepare(`
      SELECT id, user_id, item_id, stars, charge_id, provider, amount, currency, status, refunded_at, at
        FROM payments WHERE charge_id = ?
    `),
    paymentById: db.prepare(`
      SELECT id, user_id, item_id, stars, charge_id, provider, amount, currency, status, refunded_at, at
        FROM payments WHERE id = ? AND user_id = ?
    `),
    // Переход статуса: pending -> succeeded делает ровно один запрос, поэтому
    // параллельные вебхуки не выдадут товар дважды.
    paymentStatus: db.prepare('UPDATE payments SET status = ? WHERE charge_id = ? AND status = ?'),
    paymentRefund: db.prepare('UPDATE payments SET status = ?, refunded_at = ? WHERE charge_id = ?'),
    paymentsOf: db.prepare(`
      SELECT id, item_id, stars, charge_id, provider, amount, currency, status, refunded_at, at
        FROM payments WHERE user_id = ? ORDER BY at DESC LIMIT ?
    `),
    paymentsSummary: db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(stars), 0) AS stars,
             COALESCE(SUM(CASE WHEN currency = 'RUB' THEN amount ELSE 0 END), 0) AS kopecks
        FROM payments WHERE status <> 'canceled'
    `),
    paymentsCount: db.prepare('SELECT COUNT(*) AS n FROM payments WHERE user_id = ?'),

    // --- удаление профиля ---
    // Внешних ключей в схеме нет, поэтому чистим таблицы вручную, но одной
    // транзакцией (см. deleteUser): иначе при обрыве остались бы строки-сироты.
    // Платежи по умолчанию остаются — по ним оформляются возвраты (/paysupport).
    purgeCards: db.prepare('DELETE FROM user_cards WHERE user_id = ?'),
    purgeQuests: db.prepare('DELETE FROM user_quests WHERE user_id = ?'),
    purgeAchievements: db.prepare('DELETE FROM user_achievements WHERE user_id = ?'),
    purgeCosmetics: db.prepare('DELETE FROM user_cosmetics WHERE user_id = ?'),
    purgeBoosts: db.prepare('DELETE FROM boost_uses WHERE user_id = ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    purgePushLog: db.prepare('DELETE FROM push_log WHERE user_id = ?'),
    purgeAdRewards: db.prepare('DELETE FROM ad_rewards WHERE user_id = ?'),
    purgePendingRef: db.prepare('DELETE FROM pending_refs WHERE tg_id = ?'),
    purgePayments: db.prepare('DELETE FROM payments WHERE user_id = ?'),
    purgeUser: db.prepare('DELETE FROM users WHERE id = ?'),

    // --- реклама за энергию (Monetag и Chanify) ---
    // token уникален: INSERT OR IGNORE не даст записать один показ дважды, а
    // adCredit переводит выдачу pending -> credited ровно один раз.
    adLog: db.prepare(`
      INSERT OR IGNORE INTO ad_rewards (token, user_id, kind, status, impression_id, provider, at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    adCredit: db.prepare(`
      UPDATE ad_rewards SET status = 'credited', energy = ?, credited_at = ?
       WHERE token = ? AND user_id = ? AND status = 'pending'
    `),
    adGet: db.prepare('SELECT status, provider, at, credited_at FROM ad_rewards WHERE token = ? AND user_id = ?'),
    // Постбек сети приходит без сессии игрока: находим выдачу по нашему ymid = token.
    adByToken: db.prepare(`
      SELECT token, user_id, kind, status, provider, external_id, at, credited_at,
             postback_at, postback_value, client_done_at
        FROM ad_rewards WHERE token = ?
    `),
    adMarkPostback: db.prepare(`
      UPDATE ad_rewards SET postback_at = ?, postback_value = ?, external_id = COALESCE(?, external_id)
       WHERE token = ?
    `),
    // Отметка «клиент сообщил, что ролик досмотрен»: от неё считаем окно ожидания
    // постбека, поэтому выставляем её только один раз (первое подтверждение).
    adMarkClientDone: db.prepare(`
      UPDATE ad_rewards SET client_done_at = ? WHERE token = ? AND client_done_at = 0
    `),
    // Незакрытая выдача клиентского показа: её переиспользуем, чтобы быстрые
    // повторные тапы не создавали десятки сессий.
    adPendingFor: db.prepare(`
      SELECT token, at FROM ad_rewards
       WHERE user_id = ? AND kind = ? AND provider = ? AND status = 'pending'
       ORDER BY at DESC LIMIT 1
    `),
    // Последняя выдача: пауза считается по credited_at (награда) либо по at
    // (доставка рекламы в чат / неудачная попытка) — см. service.adWaitMs.
    adLastAttempt: db.prepare(`
      SELECT provider, status, at, credited_at FROM ad_rewards
       WHERE user_id = ? AND kind = ?
       ORDER BY MAX(at, credited_at) DESC LIMIT 1
    `),
    // Премиум-буст: если он уже активен, время покупки добавляется сверху.
    extendBoost: db.prepare(`
      UPDATE users SET tap_boost_until = MAX(tap_boost_until, ?) + ?, last_seen = ? WHERE id = ?
    `)
  };

  function userByTgId(tgId) {
    return stmt.userByTgId.get(tgId) || null;
  }

  function userById(id) {
    return stmt.userById.get(id) || null;
  }

  function createUser({ tgId, username = null, firstName = null, lastName = null, referrerId = null, now }) {
    const { GAME } = require('./game');
    stmt.insertUser.run(
      tgId, username, firstName, lastName,
      GAME.startCoins, GAME.startEnergyLimit, GAME.startEnergyLimit,
      GAME.startTapPower, referrerId,
      // referred_at заполняем только у приглашённых: по нему считается задание
      // дня «Пригласи друга», а created_at у позднего приглашения не подходит.
      referrerId ? now : 0,
      now, now
    );
    return userByTgId(tgId);
  }

  // Частичное обновление игрока. Возвращает актуальную запись.
  function updateUser(id, patch) {
    const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
    if (keys.length) {
      const sql = `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
      db.prepare(sql).run(...keys.map((k) => patch[k]), id);
    }
    return userById(id);
  }

  // Уровни всех карточек игрока в виде { cardId: level }.
  function cardLevels(userId) {
    const out = {};
    for (const row of stmt.cardsOfUser.all(userId)) out[row.card_id] = row.level;
    return out;
  }

  function cardLevel(userId, cardId) {
    const row = stmt.cardOfUser.get(userId, cardId);
    return row ? row.level : 0;
  }

  function setCardLevel(userId, cardId, level) {
    stmt.upsertCard.run(userId, cardId, level);
    return level;
  }

  function createSession(token, userId, now, ttlMs) {
    stmt.sessionPurge.run(now);
    stmt.sessionInsert.run(token, userId, now, now + ttlMs);
    return token;
  }

  function sessionUser(token, now) {
    const row = stmt.sessionGet.get(token);
    if (!row || row.expires_at < now) return null;
    return userById(row.user_id);
  }

  function boostUsed(userId, boostId, day) {
    const row = stmt.boostGet.get(userId, boostId, day);
    return row ? row.used : 0;
  }

  function boostAdd(userId, boostId, day) {
    stmt.boostAdd.run(userId, boostId, day);
    return boostUsed(userId, boostId, day);
  }

  function referrals(userId) {
    return stmt.referrals.all(userId).map((r) => ({
      id: r.id,
      name: r.first_name || r.username || `Игрок ${r.tg_id}`,
      username: r.username,
      coins: r.coins,
      profitPerHour: r.profit_per_hour,
      totalEarned: r.total_earned,
      // Прогресс друга: сколько тапов он уже сделал и получена ли награда.
      taps: r.referral_taps || 0,
      paid: !!r.referral_paid
    }));
  }

  function referralCount(userId) {
    return stmt.referralCount.get(userId).n;
  }

  // Бонус пригласившему: атомарный инкремент, чтобы параллельный тап не затёр монеты.
  function addReferralBonus(userId, bonus, now) {
    stmt.referralBonusAdd.run(bonus, bonus, now, userId);
    return userById(userId);
  }

  /**
   * Выплата награды пригласившему ровно один раз. Сначала условно ставим флаг
   * referral_paid — его сменит только один запрос, поэтому награду начислит
   * именно он; остальные параллельные пачки тапов вернут null.
   */
  function claimReferralPayout(userId, { target, bonus, now }) {
    if (stmt.referralClaim.run(now, userId, target).changes === 0) return null;
    const row = stmt.referralPayoutInfo.get(userId);
    if (!row || !row.referrer_id) return null;
    addReferralBonus(row.referrer_id, bonus, now);
    return {
      referrerTgId: row.referrer_tg_id,
      referrerName: row.referrer_name,
      invitedTgId: row.invited_tg_id,
      invitedName: row.invited_name,
      bonus,
      taps: target
    };
  }

  function leaderboard(limit = 20) {
    return stmt.leaderboard.all(limit).map((r, i) => ({
      rank: i + 1,
      id: r.id,
      tgId: r.tg_id,
      name: r.first_name || r.username || `Игрок ${r.tg_id}`,
      username: r.username,
      coins: r.coins,
      totalEarned: r.total_earned,
      ach: r.ach || 0
    }));
  }

  function rankOf(user) {
    return stmt.rank.get(user.coins, user.coins, user.id).rank;
  }

  function playersCount() {
    return stmt.playersCount.get().n;
  }

  // --- задания, достижения и косметика ---
  // Прогресс квестов считается по счётчикам дня, поэтому здесь только отметки
  // о забранной награде: одна строка на задание в сутки.

  function questsOfDay(userId, day) {
    return stmt.questsOfDay.all(userId, day).map((row) => row.quest_id);
  }

  function claimQuest(userId, questId, day, now) {
    return stmt.questClaim.run(userId, questId, day, now).changes > 0;
  }

  function achievementsOf(userId) {
    return stmt.achievementsOf.all(userId).map((row) => ({
      achievement_id: row.achievement_id,
      at: row.at
    }));
  }

  function addAchievement(userId, achievementId, now) {
    return stmt.achievementAdd.run(userId, achievementId, now).changes > 0;
  }

  function cosmeticsOf(userId) {
    return stmt.cosmeticsOf.all(userId).map((row) => ({
      item_id: row.item_id,
      source: row.source,
      at: row.at
    }));
  }

  function addCosmetic(userId, itemId, source, now) {
    return stmt.cosmeticAdd.run(userId, itemId, source, now).changes > 0;
  }

  function referralsToday(userId, since) {
    return stmt.referralsToday.get(userId, since).n;
  }

  function boostsUsedToday(userId, day) {
    return stmt.boostsUsedToday.get(userId, day).n;
  }

  function cardsCount(userId) {
    return stmt.cardsCount.get(userId).n;
  }

  // --- покупки за звёзды ---

  // false означает «такой charge_id уже записан»: товар повторно не выдаём.
  // Запись покупки. false означает «такой идентификатор платежа уже записан»:
  // товар повторно не выдаём. Статус по умолчанию succeeded (звёзды узнаём уже
  // оплаченными), для рублёвого канала сначала пишем pending.
  function recordPayment({
    userId,
    itemId,
    stars = 0,
    chargeId,
    provider = 'stars',
    amount = null,
    currency = 'XTR',
    status = 'succeeded',
    now
  }) {
    const total = amount === null ? (currency === 'XTR' ? Number(stars) || 0 : 0) : Number(amount);
    return stmt.paymentAdd.run(userId, itemId, Number(stars) || 0, chargeId, provider, total, currency, status, now).changes > 0;
  }

  /** Платёж по внешнему идентификатору (charge_id у звёзд, id платежа у ЮKassa). */
  function paymentByCharge(chargeId) {
    return stmt.paymentByCharge.get(chargeId) || null;
  }

  function paymentById(id, userId) {
    return stmt.paymentById.get(id, userId) || null;
  }

  /** Смена статуса с условием: pending -> succeeded выполняет ровно один запрос. */
  function markPaymentStatus(chargeId, from, to) {
    return stmt.paymentStatus.run(to, chargeId, from).changes > 0;
  }

  function markPaymentRefunded(chargeId, now) {
    return stmt.paymentRefund.run('refunded', now, chargeId).changes > 0;
  }

  function paymentsOf(userId, limit = 20) {
    return stmt.paymentsOf.all(userId, limit).map((row) => ({
      id: row.id,
      itemId: row.item_id,
      stars: row.stars,
      chargeId: row.charge_id,
      provider: row.provider || 'stars',
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      refundedAt: row.refunded_at,
      at: row.at
    }));
  }

  function paymentsSummary() {
    const row = stmt.paymentsSummary.get();
    return { count: row.n, stars: row.stars, rubles: Math.round((row.kopecks || 0) / 100) };
  }

  function paymentsCount(userId) {
    return stmt.paymentsCount.get(userId).n;
  }

  // Запись выдачи рекламы: pending — показ выдан и ждём подтверждения,
  // credited — энергия начислена, failed — реклама не пришла (нужна для паузы).
  function adLog({ token, userId, kind, status, provider = null, impressionId = null, now }) {
    stmt.adLog.run(token, userId, kind, status, impressionId, provider, now);
  }

  function adCredit({ token, userId, energy, now }) {
    return stmt.adCredit.run(energy, now, token, userId).changes > 0;
  }

  function adGet(token, userId) {
    return stmt.adGet.get(token, userId) || null;
  }

  /** Незакрытая выдача клиентского показа (Monetag): переиспользуем её. */
  function adPendingFor(userId, kind, provider) {
    return stmt.adPendingFor.get(userId, kind, provider) || null;
  }

  /** Последняя выдача игрока — от неё считается пауза между восстановлениями. */
  function adLastAttempt(userId, kind) {
    return stmt.adLastAttempt.get(userId, kind) || null;
  }

  /** Выдача по токену без привязки к игроку: так постбек сети находит сессию показа. */
  function adByToken(token) {
    return stmt.adByToken.get(token) || null;
  }

  /** Отметка о постбеке сети: подтверждение показа и идентификатор на её стороне. */
  function adMarkPostback({ token, value = null, externalId = null, now }) {
    stmt.adMarkPostback.run(now, value, externalId, token);
  }

  /** Первое подтверждение клиента «ролик досмотрен»: начало окна ожидания постбека. */
  function adMarkClientDone(token, now) {
    stmt.adMarkClientDone.run(now, token);
  }

  /**
   * Полное удаление профиля игрока. Все связанные записи (карточки, задания,
   * достижения, косметика, бусты, напоминания) и сессии убираем одной
   * транзакцией, иначе при обрыве остались бы строки-сироты. Платежи за звёзды
   * по умолчанию сохраняем: по ним оформляются возвраты (/paysupport).
   */
  function deleteUser(userId, { tgId, keepPayments = true } = {}) {
    db.exec('BEGIN');
    try {
      stmt.purgeCards.run(userId);
      stmt.purgeQuests.run(userId);
      stmt.purgeAchievements.run(userId);
      stmt.purgeCosmetics.run(userId);
      stmt.purgeBoosts.run(userId);
      stmt.purgeSessions.run(userId);
      stmt.purgePushLog.run(userId);
      // История показов рекламы тоже относится к игроку: постбек сети по удалённому
      // профилю всё равно не найдёт, кому начислять (вернёт no_user).
      stmt.purgeAdRewards.run(userId);
      if (tgId) stmt.purgePendingRef.run(tgId);
      if (!keepPayments) stmt.purgePayments.run(userId);
      stmt.purgeUser.run(userId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // Продлеваем премиум-буст: если он активен — добавляем время сверху.
  function extendTapBoost(userId, ms, now) {
    stmt.extendBoost.run(now, ms, now, userId);
    return userById(userId);
  }

  // Приглашение, полученное ботом: применим при первом входе игрока.
  function setPendingRef(tgId, referrerTgId, now) {
    stmt.pendingRefSet.run(tgId, referrerTgId, now);
  }

  function takePendingRef(tgId) {
    const row = stmt.pendingRefGet.get(tgId);
    if (!row) return null;
    stmt.pendingRefDelete.run(tgId);
    return row.referrer_tg_id;
  }

  return {
    db,
    close: () => db.close(),
    setPendingRef,
    takePendingRef,
    userByTgId,
    userById,
    createUser,
    updateUser,
    cardLevels,
    cardLevel,
    setCardLevel,
    createSession,
    sessionUser,
    boostUsed,
    boostAdd,
    questsOfDay,
    claimQuest,
    achievementsOf,
    addAchievement,
    cosmeticsOf,
    addCosmetic,
    referralsToday,
    boostsUsedToday,
    cardsCount,
    recordPayment,
    paymentByCharge,
    paymentById,
    markPaymentStatus,
    markPaymentRefunded,
    paymentsOf,
    paymentsSummary,
    paymentsCount,
    deleteUser,
    adLog,
    adCredit,
    adGet,
    adPendingFor,
    adLastAttempt,
    adByToken,
    adMarkPostback,
    adMarkClientDone,
    extendTapBoost,
    referrals,
    referralCount,
    addReferralBonus,
    claimReferralPayout,
    leaderboard,
    rankOf,
    playersCount
  };
}

module.exports = {
  createStore,
  SCHEMA,
  UPDATABLE,
  USER_COLUMNS,
  AD_REWARD_COLUMNS,
  PAYMENT_COLUMNS,
  ensureColumns,
  ensureAdRewardColumns,
  ensurePaymentColumns
};
