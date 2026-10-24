-- Схема D1 для Hamster Tap (совместима с локальной SQLite-версией).
-- Применяется так:  npx wrangler d1 execute hamster-tap --local --file=cloudflare/schema.sql
--                   npx wrangler d1 execute hamster-tap --remote --file=cloudflare/schema.sql
--
-- Отличия от локальной версии:
--   version      — счётчик для атомарных условных UPDATE (защита от двойного списания);
--   pending_card — «намерение» покупки: если процесс оборвался между двумя запросами,
--                  покупка досчитывается при следующем обращении игрока.

CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id           INTEGER NOT NULL UNIQUE,
  username        TEXT,
  first_name      TEXT,
  last_name       TEXT,
  coins           INTEGER NOT NULL DEFAULT 0,
  energy          INTEGER NOT NULL DEFAULT 1000,
  energy_limit    INTEGER NOT NULL DEFAULT 1000,
  tap_power       INTEGER NOT NULL DEFAULT 1,
  tap_level       INTEGER NOT NULL DEFAULT 1,
  energy_level    INTEGER NOT NULL DEFAULT 1,
  profit_per_hour INTEGER NOT NULL DEFAULT 0,
  total_earned    INTEGER NOT NULL DEFAULT 0,
  total_taps      INTEGER NOT NULL DEFAULT 0,
  referrer_id     INTEGER,
  -- Приглашение: когда привязан пригласивший, сколько тапов набрал приглашённый
  -- после этого и выплачена ли награда пригласившему (см. service.tap).
  referred_at     INTEGER NOT NULL DEFAULT 0,
  referral_taps   INTEGER NOT NULL DEFAULT 0,
  referral_paid   INTEGER NOT NULL DEFAULT 0,
  daily_streak    INTEGER NOT NULL DEFAULT 0,
  daily_last      INTEGER NOT NULL DEFAULT 0,
  turbo_until     INTEGER NOT NULL DEFAULT 0,
  last_tap_at     INTEGER NOT NULL DEFAULT 0,
  version         INTEGER NOT NULL DEFAULT 0,
  pending_card    TEXT,
  created_at      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL
);

-- Рейтинг считается по текущему балансу монет, поэтому индекс по доходу не нужен.
-- Индекс по coins сознательно не создаём: монеты меняются на каждой пачке тапов,
-- и индекс удвоил бы расход записей D1 (а снимок рейтинга делается раз в 2 минуты).
DROP INDEX IF EXISTS idx_users_profit;
CREATE INDEX IF NOT EXISTS idx_users_referrer ON users (referrer_id);

-- Ежедневные задания, достижения и косметика.
--   user_quests      — отметка о забранной награде (прогресс считается по счётчикам дня);
--   user_achievements— выданные достижения (награда начисляется один раз за игру);
--   user_cosmetics   — открытая косметика (quest/achievement, для Stars — source='stars');
--   push_log         — PK не даёт отправить одно напоминание дважды в день.
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

CREATE TABLE IF NOT EXISTS user_cosmetics (
  user_id INTEGER NOT NULL,
  item_id TEXT    NOT NULL,
  source  TEXT    NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

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
-- (звёзды или копейки), status: pending -> succeeded / canceled, refunded_at — возврат.
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
-- за один показ начисляется ровно один раз. status: pending (показ выдан, ждём
-- подтверждения) -> credited; неудачные попытки пишем как failed — они нужны
-- только для паузы между попытками. provider различает сети, external_id —
-- идентификатор показа на стороне сети (пригодится для серверных постбеков).
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

-- Счётчики текущего дня нужны для прогресса заданий. Они обновляются тем же
-- UPDATE, что и тапы/покупки, поэтому лишних записей в D1 не появляется.
-- Колонки добавлены после первого релиза, а SQLite не умеет
-- ADD COLUMN IF NOT EXISTS — поэтому директивами: tools/cf-d1-apply.js
-- добавляет их только в базы, где колонки ещё нет (повторный запуск безопасен).
-- @add-column: users.day_key TEXT NOT NULL DEFAULT ''
-- @add-column: users.taps_today INTEGER NOT NULL DEFAULT 0
-- @add-column: users.buys_today INTEGER NOT NULL DEFAULT 0
-- @add-column: users.earned_today INTEGER NOT NULL DEFAULT 0
-- @add-column: users.hamster_skin TEXT
-- @add-column: users.palette TEXT
-- @add-column: users.background TEXT
-- @add-column: users.badge TEXT
-- @add-column: users.tap_boost_until INTEGER NOT NULL DEFAULT 0
-- @add-column: users.referred_at INTEGER NOT NULL DEFAULT 0
-- @add-column: users.referral_taps INTEGER NOT NULL DEFAULT 0
-- @add-column: users.referral_paid INTEGER NOT NULL DEFAULT 0
-- @add-column: users.language_code TEXT
-- @add-column: users.is_premium INTEGER NOT NULL DEFAULT 0
-- @add-column: users.notify_energy INTEGER NOT NULL DEFAULT 1
-- @add-column: users.notify_daily INTEGER NOT NULL DEFAULT 1
-- @add-column: users.notify_rank INTEGER NOT NULL DEFAULT 1
-- Выдачи рекламы: провайдер показа, идентификатор на стороне сети, отметка
-- о серверном постбеке (ymid постбека = token выдачи) и время подтверждения
-- досмотра клиентом (от него считается окно ожидания постбека).
-- @add-column: ad_rewards.provider TEXT
-- @add-column: ad_rewards.external_id TEXT
-- @add-column: ad_rewards.postback_at INTEGER NOT NULL DEFAULT 0
-- @add-column: ad_rewards.postback_value TEXT
-- @add-column: ad_rewards.client_done_at INTEGER NOT NULL DEFAULT 0
-- Журнал покупок: рублёвый канал (ЮKassa) добавил провайдера, сумму в минорных
-- единицах, валюту, статус и отметку возврата.
-- @add-column: payments.provider TEXT
-- @add-column: payments.amount INTEGER NOT NULL DEFAULT 0
-- @add-column: payments.currency TEXT NOT NULL DEFAULT 'XTR'
-- @add-column: payments.status TEXT NOT NULL DEFAULT 'succeeded'
-- @add-column: payments.refunded_at INTEGER NOT NULL DEFAULT 0
-- Покупки, сделанные до появления рублёвого канала, — звёздные; заполняем новые
-- поля только в тот запуск, когда колонки действительно добавлялись.
-- @on-add: payments.provider: UPDATE payments SET provider = 'stars' WHERE provider IS NULL
-- @on-add: payments.currency: UPDATE payments SET currency = 'XTR' WHERE currency = ''
-- @on-add: payments.amount: UPDATE payments SET amount = stars WHERE amount = 0
-- @on-add: payments.status: UPDATE payments SET status = 'succeeded' WHERE status = ''

-- Разовая миграция данных: приглашения, созданные до появления referred_at,
-- получили награду сразу при входе друга (старые правила), поэтому помечаем их
-- выплаченными — иначе награда начислилась бы второй раз. Директивы @on-add
-- выполняются только в тот запуск, когда колонки действительно добавлялись,
-- поэтому позже они уже не задевают новых игроков.
-- @on-add: users.referral_paid: UPDATE users SET referral_paid = 1 WHERE referrer_id IS NOT NULL AND referred_at = 0
-- @on-add: users.referral_paid: UPDATE users SET referred_at = created_at WHERE referrer_id IS NOT NULL AND referred_at = 0

CREATE TABLE IF NOT EXISTS user_cards (
  user_id INTEGER NOT NULL,
  card_id TEXT    NOT NULL,
  level   INTEGER NOT NULL DEFAULT 0,
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

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- Приглашение из бота (/start ref_123): применяется при первом входе в игру.
CREATE TABLE IF NOT EXISTS pending_refs (
  tg_id          INTEGER PRIMARY KEY,
  referrer_tg_id INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);
