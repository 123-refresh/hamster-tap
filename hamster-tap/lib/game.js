'use strict';
// Игровой баланс и чистые правила. Модуль не знает ни о БД, ни о сети:
// все функции считаются от переданных аргументов, поэтому его удобно
// проверять в тестах и подключать на клиенте для расчёта прогнозов.

const GAME = {
  startCoins: 0,
  startEnergyLimit: 1000,
  startTapPower: 1,
  // Античит: сколько тапов в секунду готов принять сервер. Клиент отправляет
  // пачки тапов, сервер обрезает их по прошедшему времени.
  maxTapsPerSecond: 20,
  // Энергия восстанавливается на 1 единицу в секунду (полный лимит ~17 мин).
  energyRegenPerSec: 1,
  // Офлайн-доход начисляется не более чем за 3 часа отсутствия.
  passiveCapHours: 3,
  turboSeconds: 20,
  turboMultiplier: 5,
  // Премиум-буст из магазина (за звёзды): ×2 к тапу, время продлевается покупками.
  // С турбо множители перемножаются (×5 × ×2 = ×10) — так покупка ощутимее.
  tapBoostMultiplier: 2,
  // Сколько раз в сутки (по UTC) можно пользоваться бустом.
  boostDaily: { full_energy: 6, turbo: 3 },
  // Восстановление энергии за рекламу (сеть Chanify). Дневного лимита нет, но
  // между попытками держим паузу: у сети свой cooldown на пользователя
  // (по умолчанию минута) и частотные лимиты кампаний, поэтому чаще реклама
  // всё равно не придёт — пауза лишь превращает отказ в понятный таймер.
  adEnergy: {
    percent: 100,               // сколько процентов лимита восстанавливаем (100 = до максимума)
    cooldownMs: 60 * 1000,      // пауза между попытками (общая для всех провайдеров)
    confirmDelayMs: 10 * 1000,  // сколько игрок должен пробыть в чате с рекламой (Chanify)
    confirmOnReturn: true,      // начисляем по возвращении в игру, а не по факту доставки
    sessionTtlMs: 10 * 60 * 1000 // сколько живёт выданная сессия показа
  },
  // Приглашение друга: другу приветственный бонус начисляется сразу при входе,
  // а пригласившему крупная награда — только когда друг реально поиграет
  // (referralTapsTarget тапов). Так «пустые» приглашения не оплачиваются.
  referralBonus: 100000,
  referralInvitedBonus: 25000,
  referralTapsTarget: 100
};

// Магазины разблокируются по мере роста дохода (лиги от Бронзы до Легенды).
const LEVELS = [
  { name: 'Бронза', emoji: '🥉', min: 0 },
  { name: 'Серебро', emoji: '🥈', min: 5000 },
  { name: 'Золото', emoji: '🥇', min: 25000 },
  { name: 'Платина', emoji: '💎', min: 100000 },
  { name: 'Алмаз', emoji: '💠', min: 500000 },
  { name: 'Мастер', emoji: '🏆', min: 2000000 },
  { name: 'Грандмастер', emoji: '👑', min: 10000000 },
  { name: 'Легенда', emoji: '🌌', min: 50000000 }
];

// Цена/доход карточки растут ступенями по "тирам" (tier = индекс лиги, в которой
// карточка открывается), внутри тира открывается 10 уровней прокачки.
const TIER_COST_BASE = 2000;
const TIER_COST_STEP = 8;
const TIER_PROFIT_BASE = 150;
const TIER_PROFIT_STEP = 8;

const CATEGORIES = {
  crypto: { title: 'Крипта', emoji: '🪙' },
  sport: { title: 'Спорт', emoji: '🏟️' },
  meme: { title: 'Мемы', emoji: '😹' },
  business: { title: 'Бизнес', emoji: '💼' }
};

// [id, название, эмодзи, категория, tier]
const CARD_SPEC = [
  ['memcoin', 'MemCoin', '🪙', 'crypto', 0],
  ['nft_shop', 'NFT-лавка', '🖼️', 'crypto', 1],
  ['defi_farm', 'DeFi-ферма', '🏦', 'crypto', 2],
  ['mining_farm', 'Майнинг-ферма', '⛏️', 'crypto', 3],
  ['exchange', 'Своя биржа', '📈', 'crypto', 5],
  ['web3_bank', 'Web3-банк', '🏛️', 'crypto', 7],

  ['football_club', 'Футбольный клуб', '⚽', 'sport', 0],
  ['boxing_gym', 'Зал бокса', '🥊', 'sport', 1],
  ['basketball', 'Баскетбол', '🏀', 'sport', 2],
  ['racing_team', 'Гоночная команда', '🏎️', 'sport', 3],
  ['stadium', 'Стадион', '🏟️', 'sport', 5],
  ['olympics', 'Олимпиада', '🏅', 'sport', 7],

  ['meme_factory', 'Фабрика мемов', '😹', 'meme', 0],
  ['streamer_house', 'Дом стримеров', '📹', 'meme', 1],
  ['influencers', 'Агентство инфлюенсеров', '🤳', 'meme', 2],
  ['viral_studio', 'Вирусная студия', '🎬', 'meme', 3],
  ['meme_planet', 'Планета мемов', '🪐', 'meme', 5],
  ['hype_agency', 'Хайп-агентство', '🚀', 'meme', 7],

  ['coffee_shop', 'Кофейня', '☕', 'business', 0],
  ['delivery', 'Доставка', '🛵', 'business', 1],
  ['game_studio', 'Гейм-студия', '🎮', 'business', 2],
  ['data_center', 'Дата-центр', '🖥️', 'business', 3],
  ['airline', 'Авиакомпания', '✈️', 'business', 5],
  ['space_corp', 'Космокорпорация', '🛰️', 'business', 7]
];

const CARDS = CARD_SPEC.map(([id, title, emoji, category, tier]) => ({
  id,
  title,
  emoji,
  category,
  tier,
  baseCost: TIER_COST_BASE * Math.pow(TIER_COST_STEP, tier),
  baseProfit: TIER_PROFIT_BASE * Math.pow(TIER_PROFIT_STEP, tier),
  costGrowth: 1.6,
  profitGrowth: 1.35,
  maxLevel: 10
}));

const CARDS_BY_ID = new Map(CARDS.map((c) => [c.id, c]));

// Прокачки за монеты: мультитап (+1 к тапу) и лимит энергии (+500).
const UPGRADES = {
  tap: { title: 'Мультитап', emoji: '👆', startCost: 1000, growth: 2, step: 1, maxLevel: 25 },
  energy: { title: 'Лимит энергии', emoji: '🔋', startCost: 1000, growth: 2, step: 500, maxLevel: 25 }
};

// Награда за ежедневный вход: растёт со стриком, дальше — по последнему значению.
const DAILY_REWARDS = [500, 1000, 2500, 5000, 15000, 25000, 100000, 250000, 500000, 1000000];
// Бонус доступен раз в 20 часов; пропуск больше 48 часов сбрасывает стрик.
const DAILY_COOLDOWN_MS = 20 * 60 * 60 * 1000;
const DAILY_RESET_MS = 48 * 60 * 60 * 1000;

const BOOSTS = {
  full_energy: {
    title: 'Полная энергия',
    emoji: '⚡',
    description: 'Мгновенно восстанавливает энергию до максимума'
  },
  turbo: {
    title: 'Турбо',
    emoji: '🚀',
    description: `Тап приносит x${GAME.turboMultiplier} монет в течение ${GAME.turboSeconds} секунд`
  }
};

// --- производные величины ---

// Цена перехода с уровня level на level + 1 (level — текущий уровень карточки).
function cardCost(card, level) {
  return Math.round(card.baseCost * Math.pow(card.costGrowth, level));
}

// Доход в час, который даёт карточка при текущем уровне (0 -> ещё не куплена).
function cardProfit(card, level) {
  if (level <= 0) return 0;
  return Math.round(card.baseProfit * Math.pow(card.profitGrowth, level - 1));
}

// Суммарный доход в час по набору уровней {cardId: level}.
function profitPerHour(levels) {
  let total = 0;
  for (const card of CARDS) total += cardProfit(card, levels[card.id] || 0);
  return total;
}

// Индекс лиги по доходу в час.
function levelIndexFor(profit) {
  let index = 0;
  for (let i = 0; i < LEVELS.length; i += 1) if (profit >= LEVELS[i].min) index = i;
  return index;
}

// Описание лиги + прогресс до следующей (для прогресс-бара в интерфейсе).
function levelInfo(profit) {
  const index = levelIndexFor(profit);
  const current = LEVELS[index];
  const next = LEVELS[index + 1] || null;
  const progress = next
    ? Math.min(1, (profit - current.min) / (next.min - current.min))
    : 1;
  return {
    index,
    name: current.name,
    emoji: current.emoji,
    min: current.min,
    nextMin: next ? next.min : null,
    nextName: next ? next.name : null,
    progress
  };
}

// Цена прокачки (kind: 'tap' | 'energy') для текущего уровня.
function upgradeCost(kind, level) {
  const cfg = UPGRADES[kind];
  return Math.round(cfg.startCost * Math.pow(cfg.growth, level - 1));
}

// Доступен ли ежедневный бонус и какая награда ждёт игрока.
function dailyStatus(user, now) {
  const elapsed = now - (user.daily_last || 0);
  const available = elapsed >= DAILY_COOLDOWN_MS;
  const streak = elapsed > DAILY_RESET_MS ? 0 : user.daily_streak || 0;
  const nextStreak = Math.min(streak + 1, DAILY_REWARDS.length);
  return {
    available,
    streak,
    nextStreak,
    reward: DAILY_REWARDS[nextStreak - 1],
    cooldownLeftMs: available ? 0 : DAILY_COOLDOWN_MS - elapsed
  };
}

// Номер дня по UTC — ключ для учёта использованных бустов.
function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

// Множитель тапа с учётом активного турбо и премиум-буста из магазина.
function tapMultiplier(user, now) {
  const turbo = user.turbo_until > now ? GAME.turboMultiplier : 1;
  const premium = user.tap_boost_until > now ? GAME.tapBoostMultiplier : 1;
  return turbo * premium;
}

// Сколько монет приносит один тап прямо сейчас.
function tapValue(user, now) {
  return user.tap_power * tapMultiplier(user, now);
}

// Начисление "жизни в офлайне": пассивный доход (с капом) и регенерация энергии.
// Возвращает патч для users и то, сколько именно накапало (для показа игроку).
function applyIdle(user, now) {
  const elapsedSec = Math.max(0, (now - (user.last_seen || now)) / 1000);
  const idleSec = Math.min(elapsedSec, GAME.passiveCapHours * 3600);
  const passiveCoins = Math.floor((user.profit_per_hour || 0) * (idleSec / 3600));
  const energy = Math.min(
    user.energy_limit,
    user.energy + Math.floor(elapsedSec * GAME.energyRegenPerSec)
  );
  return {
    patch: {
      coins: user.coins + passiveCoins,
      energy,
      total_earned: user.total_earned + passiveCoins,
      last_seen: now
    },
    passiveCoins,
    idleSec
  };
}

module.exports = {
  GAME,
  LEVELS,
  CARDS,
  CARDS_BY_ID,
  CATEGORIES,
  UPGRADES,
  BOOSTS,
  DAILY_REWARDS,
  DAILY_COOLDOWN_MS,
  DAILY_RESET_MS,
  cardCost,
  cardProfit,
  profitPerHour,
  levelIndexFor,
  levelInfo,
  upgradeCost,
  dailyStatus,
  utcDay,
  tapMultiplier,
  tapValue,
  applyIdle
};
