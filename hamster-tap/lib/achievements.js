'use strict';
// Достижения: каталог и чистые проверки. Проверяются из settle() — то есть один раз
// на обращение к API, по уже загруженной записи игрока, без лишних чтений базы.
// Записываем только сам факт получения (одна строка в user_achievements).
// Награды: монеты и (у крупных достижений) обычная косметика из lib/cosmetics.js.
// Модуль не подключает другие файлы: его импортируют и Node-версия, и воркер.

const ACHIEVEMENTS = [
  {
    id: 'first_tap',
    title: 'Первое касание',
    emoji: '👆',
    hint: 'Сделай первый тап',
    reward: { coins: 200 },
    check: (ctx) => ctx.user.total_taps >= 1
  },
  {
    id: 'tap_1k',
    title: 'Тысяча тапов',
    emoji: '✋',
    hint: 'Сделай 1 000 тапов',
    reward: { coins: 500, cosmetic: 'badge_tap' },
    check: (ctx) => ctx.user.total_taps >= 1000
  },
  {
    id: 'tap_10k',
    title: 'Десять тысяч тапов',
    emoji: '💪',
    hint: 'Сделай 10 000 тапов',
    reward: { coins: 2000, cosmetic: 'hamster_chip' },
    check: (ctx) => ctx.user.total_taps >= 10000
  },
  {
    id: 'tap_100k',
    title: 'Сто тысяч тапов',
    emoji: '🔥',
    hint: 'Сделай 100 000 тапов',
    reward: { coins: 5000, cosmetic: 'palette_ice' },
    check: (ctx) => ctx.user.total_taps >= 100000
  },
  {
    id: 'first_card',
    title: 'Первый бизнес',
    emoji: '🏪',
    hint: 'Купи первую карточку',
    needs: ['cards'],
    reward: { coins: 300, cosmetic: 'palette_mint' },
    check: (ctx) => ctx.cards >= 1
  },
  {
    id: 'cards_5',
    title: 'Пять бизнесов',
    emoji: '🏙️',
    hint: 'Владей пятью карточками',
    needs: ['cards'],
    reward: { coins: 1000, cosmetic: 'bg_grid' },
    check: (ctx) => ctx.cards >= 5
  },
  {
    id: 'cards_10',
    title: 'Десять бизнесов',
    emoji: '🌆',
    hint: 'Владей десятью карточками',
    needs: ['cards'],
    reward: { coins: 3000, cosmetic: 'palette_sunset' },
    check: (ctx) => ctx.cards >= 10
  },
  {
    id: 'first_friend',
    title: 'Первый друг',
    emoji: '🤝',
    hint: 'Пригласи друга в игру',
    needs: ['referrals'],
    reward: { coins: 1000, cosmetic: 'badge_friend' },
    check: (ctx) => ctx.referrals >= 1
  },
  {
    id: 'profit_10k',
    title: '10 000 в час',
    emoji: '📈',
    hint: 'Доведи доход до 10 000 в час',
    reward: { coins: 2000, cosmetic: 'bg_stars' },
    check: (ctx) => ctx.user.profit_per_hour >= 10000
  },
  {
    id: 'profit_100k',
    title: '100 000 в час',
    emoji: '💹',
    hint: 'Доведи доход до 100 000 в час',
    reward: { coins: 10000, cosmetic: 'palette_gold' },
    check: (ctx) => ctx.user.profit_per_hour >= 100000
  },
  {
    id: 'million',
    title: 'Миллион',
    emoji: '💰',
    hint: 'Заработай 1 000 000 монет за всё время',
    reward: { coins: 20000, cosmetic: 'hamster_bear' },
    check: (ctx) => ctx.user.total_earned >= 1000000
  },
  {
    id: 'max_tap',
    title: 'Максимальный мультитап',
    emoji: '🔨',
    hint: 'Прокачай мультитап до предела',
    reward: { coins: 30000, cosmetic: 'badge_hammer' },
    check: (ctx) => ctx.user.tap_level >= ctx.maxTapLevel
  }
];

const ACHIEVEMENTS_BY_ID = new Map(ACHIEVEMENTS.map((item) => [item.id, item]));

// Косметика, которую выдают достижения (для тестов и проверки каталога).
const ACHIEVEMENT_COSMETICS = ACHIEVEMENTS
  .filter((item) => item.reward.cosmetic)
  .map((item) => item.reward.cosmetic);

function achievementById(id) {
  return ACHIEVEMENTS_BY_ID.get(id) || null;
}

/**
 * Какие достижения игрок выполнил, но ещё не получил.
 * ctx: { user, maxTapLevel, cards, referrals } — cards/referrals считаются только
 * если они реально нужны (см. neededMetrics), чтобы не тратить чтения D1.
 */
function pendingAchievements(ctx, ownedIds) {
  const owned = ownedIds instanceof Set ? ownedIds : new Set(ownedIds || []);
  const out = [];
  for (const item of ACHIEVEMENTS) {
    if (owned.has(item.id)) continue;
    let done = false;
    try {
      done = !!item.check(ctx);
    } catch {
      done = false;
    }
    if (done) out.push(item);
  }
  return out;
}

/**
 * Какие дополнительные данные нужны, чтобы проверить оставшиеся достижения.
 * Пустой ответ означает, что можно обойтись записью игрока и не делать запросов.
 */
function neededMetrics(ownedIds) {
  const owned = ownedIds instanceof Set ? ownedIds : new Set(ownedIds || []);
  const needed = new Set();
  for (const item of ACHIEVEMENTS) {
    if (owned.has(item.id) || !item.needs) continue;
    for (const metric of item.needs) needed.add(metric);
  }
  return needed;
}

/**
 * Витрина достижений: полученные отмечаются датой, остальные показывают подсказку.
 */
function achievementsState(ownedRows) {
  const rows = new Map();
  for (const row of ownedRows || []) {
    rows.set(row.achievement_id !== undefined ? row.achievement_id : row.id, row.at || row.achieved_at || 0);
  }
  const list = ACHIEVEMENTS.map((item) => ({
    id: item.id,
    title: item.title,
    emoji: item.emoji,
    hint: item.hint,
    reward: item.reward,
    done: rows.has(item.id) && (rows.get(item.id) || 0) > 0,
    at: rows.get(item.id) || 0
  }));
  return {
    list,
    total: list.length,
    done: list.filter((item) => item.done).length
  };
}

module.exports = {
  ACHIEVEMENTS,
  ACHIEVEMENTS_BY_ID,
  ACHIEVEMENT_COSMETICS,
  achievementById,
  pendingAchievements,
  neededMetrics,
  achievementsState
};
