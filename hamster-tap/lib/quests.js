'use strict';
// Ежедневные задания: каталог и чистые правила. Прогресс считается только по данным,
// которые игра и так обновляет, поэтому отдельного «журнала событий» и лишних
// записей в базу не нужно:
//   taps/buys/earned — счётчики текущего дня в users (обновляются тем же UPDATE,
//                      что и тапы/покупки, без дополнительных запросов);
//   boosts           — сумма использованных бустов за сегодня (таблица boost_uses);
//   daily            — забран ли бонус дня (users.daily_last);
//   streak           — стрик ежедневного бонуса (users.daily_streak);
//   friends          — друзья, пришедшие сегодня (users.referrer_id + created_at).
// Модуль намеренно не подключает другие файлы: его импортируют и Node-версия,
// и воркер Cloudflare.

const QUESTS = [
  {
    id: 'tap_500',
    title: 'Сделай 500 тапов',
    emoji: '👆',
    metric: 'taps',
    target: 500,
    reward: { coins: 3000 }
  },
  {
    id: 'earn_10000',
    title: 'Заработай 10 000 монет',
    emoji: '🪙',
    metric: 'earned',
    target: 10000,
    reward: { coins: 4000 }
  },
  {
    id: 'buy_1',
    title: 'Купи первый бизнес',
    emoji: '🏦',
    metric: 'buys',
    target: 1,
    reward: { coins: 2500 }
  },
  {
    id: 'buy_3',
    title: 'Прокачай бизнесы 3 раза',
    emoji: '📈',
    metric: 'buys',
    target: 3,
    reward: { coins: 5000 }
  },
  {
    id: 'boost_2',
    title: 'Используй 2 буста',
    emoji: '🚀',
    metric: 'boosts',
    target: 2,
    reward: { coins: 2000 }
  },
  {
    id: 'daily_bonus',
    title: 'Забери бонус дня',
    emoji: '🎁',
    metric: 'daily',
    target: 1,
    reward: { coins: 1500 }
  },
  {
    // Стрик копится между днями, поэтому задание «дороже» обычных и даёт косметику.
    id: 'streak_7',
    title: 'Заходи 7 дней подряд',
    emoji: '🔥',
    metric: 'streak',
    target: 7,
    reward: { coins: 5000, cosmetic: 'hamster_beaver' }
  },
  {
    id: 'invite_1',
    title: 'Пригласи друга сегодня',
    emoji: '👥',
    metric: 'friends',
    target: 1,
    reward: { coins: 3000, cosmetic: 'bg_rainbow' }
  }
];

const QUESTS_BY_ID = new Map(QUESTS.map((quest) => [quest.id, quest]));

// Сколько всего заданий и какие из них дают косметику — пригодится витрине и тестам.
const QUEST_COSMETICS = QUESTS.filter((quest) => quest.reward.cosmetic).map((quest) => quest.reward.cosmetic);

// Начало календарного дня UTC — так же, как считаются бусты и счётчики дня.
function dayStart(day) {
  return Date.parse(`${day}T00:00:00Z`);
}

/**
 * Собирает «контекст дня» из записи игрока и посчитанных отдельно значений.
 * Если игрок не заходил сегодня (day_key от другого дня), счётчики считаются нулевыми:
 * сбрасывать их в базе не нужно — их перезапишет первое же действие нового дня.
 */
function contextFrom({ user, day, boosts = 0, friends = 0 }) {
  const sameDay = user.day_key === day;
  return {
    taps: sameDay ? user.taps_today || 0 : 0,
    buys: sameDay ? user.buys_today || 0 : 0,
    earned: sameDay ? user.earned_today || 0 : 0,
    boosts,
    daily: (user.daily_last || 0) >= dayStart(day),
    streak: user.daily_streak || 0,
    friends
  };
}

function progressOf(quest, ctx) {
  const raw = quest.metric === 'daily' ? (ctx.daily ? 1 : 0) : ctx[quest.metric] || 0;
  return Math.max(0, Math.min(raw, quest.target));
}

function questStatus(quest, ctx, claimed) {
  const progress = progressOf(quest, ctx);
  return {
    id: quest.id,
    title: quest.title,
    emoji: quest.emoji,
    metric: quest.metric,
    target: quest.target,
    progress,
    done: progress >= quest.target,
    claimed: !!claimed,
    reward: quest.reward
  };
}

/**
 * Состояние всех заданий дня. claimedIds — Set идентификаторов, по которым награда
 * уже забрана сегодня (одна строка в user_quests на задание).
 */
function questsState(ctx, claimedIds) {
  const claimed = claimedIds instanceof Set ? claimedIds : new Set(claimedIds || []);
  const list = QUESTS.map((quest) => questStatus(quest, ctx, claimed.has(quest.id)));
  return {
    list,
    total: list.length,
    done: list.filter((quest) => quest.done).length,
    claimed: list.filter((quest) => quest.claimed).length,
    claimable: list.filter((quest) => quest.done && !quest.claimed).length
  };
}

module.exports = {
  QUESTS,
  QUESTS_BY_ID,
  QUEST_COSMETICS,
  dayStart,
  contextFrom,
  progressOf,
  questStatus,
  questsState
};
