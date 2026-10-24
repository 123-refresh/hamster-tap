// Игровые операции для Cloudflare Workers: та же логика, что в lib/service.js,
// но все обращения к базе асинхронные, а изменения защищены version-условиями
// (два одновременных запроса не могут дважды списать монеты или уйти в минус).
// Правила баланса берём из общего модуля lib/game.js — код не дублируется.
import game from '../../lib/game.js';
import quests from '../../lib/quests.js';
import achievements from '../../lib/achievements.js';
import cosmetics from '../../lib/cosmetics.js';
import shop from '../../lib/shop.js';
import dailycode from '../../lib/dailycode.js';
import ads from '../../lib/ads.js';
import payments from '../../lib/payments/index.js';
import paylink from '../../lib/paylink.js';
// Токены сессий показа рекламы: криптостойкие, тот же модуль, что в lib/service.js.
import { randomBytes } from 'node:crypto';

const MAX_BATCH_TAPS = 100;   // максимум тапов в одном запросе
const TAP_BURST_SECONDS = 2;  // запас «кредита тапов» на сетевые рывки
// Пауза перед повторным запросом клиента, пока сеть не подтвердила показ постбеком.
const POSTBACK_RETRY_MS = 1500;
// Сколько монет даём вместо косметики, которая уже открыта: повторно предмет
// получить нельзя, а «пустой» награды быть не должно.
const DUPLICATE_COSMETIC_COINS = 5000;

export function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function publicUser(user) {
  return {
    id: user.id,
    name: user.first_name || user.username || `Игрок ${user.id}`,
    username: user.username,
    coins: user.coins,
    energy: user.energy,
    energyLimit: user.energy_limit,
    tapPower: user.tap_power,
    tapLevel: user.tap_level,
    energyLevel: user.energy_level,
    profitPerHour: user.profit_per_hour,
    totalEarned: user.total_earned,
    totalTaps: user.total_taps
  };
}

/**
 * Приводим игрока в актуальное состояние перед действием:
 *  - досчитываем незавершённую покупку карточки (pending_card);
 *  - начисляем офлайн-доход и регенерацию энергии.
 * Запись в базу делаем только если что-то реально изменилось — это экономит
 * дневной лимит D1 на записи.
 */
export async function settle(store, user, now) {
  if (user.pending_card) {
    const levels = await store.cardLevels(user.id);
    const level = levels[user.pending_card] || 0;
    await store.finishCardPurchase({
      userId: user.id,
      cardId: user.pending_card,
      level: level + 1
    });
    user = (await store.userById(user.id)) || user;
  }

  const idle = game.applyIdle(user, now);
  const coinsChanged = idle.patch.coins !== user.coins;
  const energyChanged = idle.patch.energy !== user.energy;
  // Счётчики дня тоже нужно обновить при смене суток — иначе прогресс заданий
  // останется от вчерашнего дня.
  const day = game.utcDay(now);
  const dayChanged = user.day_key !== day;
  if (!coinsChanged && !energyChanged && idle.passiveCoins === 0 && !dayChanged) {
    return { user, passiveCoins: 0 };
  }

  const changed = await store.touch({
    userId: user.id,
    version: user.version,
    coins: idle.patch.coins,
    energy: idle.patch.energy,
    totalEarned: idle.patch.total_earned,
    // Офлайн-доход идёт в счётчик «заработай монеты за день».
    earnedDelta: idle.passiveCoins,
    day,
    now
  });
  const fresh = (await store.userById(user.id)) || user;
  return { user: fresh, passiveCoins: changed ? idle.passiveCoins : 0 };
}

// Полное состояние для интерфейса: игрок, лига, карточки, бусты, прокачки, daily.
export async function state(store, user, now, extras = {}) {
  const levels = await store.cardLevels(user.id);
  const pph = game.profitPerHour(levels);
  if (pph !== user.profit_per_hour) {
    user = await store.updateUser(user.id, { profit_per_hour: pph });
  }

  const level = game.levelInfo(pph);
  const cards = game.CARDS.map((card) => {
    const cardLevel = levels[card.id] || 0;
    const maxed = cardLevel >= card.maxLevel;
    const locked = level.index < card.tier;
    return {
      id: card.id,
      title: card.title,
      emoji: card.emoji,
      category: card.category,
      categoryTitle: game.CATEGORIES[card.category].title,
      tier: card.tier,
      level: cardLevel,
      maxLevel: card.maxLevel,
      locked,
      unlockedAt: game.LEVELS[card.tier].name,
      cost: maxed ? null : game.cardCost(card, cardLevel),
      profit: game.cardProfit(card, cardLevel),
      profitAfter: maxed ? null : game.cardProfit(card, cardLevel + 1),
      maxed
    };
  });

  const day = game.utcDay(now);
  const boosts = {};
  for (const [id, cfg] of Object.entries(game.BOOSTS)) {
    const used = await store.boostUsed(user.id, id, day);
    const limit = game.GAME.boostDaily[id] || 0;
    boosts[id] = {
      id,
      title: cfg.title,
      emoji: cfg.emoji,
      description: cfg.description,
      used,
      limit,
      left: Math.max(0, limit - used)
    };
  }
  boosts.turbo.active = user.turbo_until > now;
  boosts.turbo.secondsLeft = boosts.turbo.active ? Math.ceil((user.turbo_until - now) / 1000) : 0;

  const upgrades = {};
  for (const [kind, cfg] of Object.entries(game.UPGRADES)) {
    const current = kind === 'tap' ? user.tap_level : user.energy_level;
    const maxed = current >= cfg.maxLevel;
    upgrades[kind] = {
      kind,
      title: cfg.title,
      emoji: cfg.emoji,
      level: current,
      maxLevel: cfg.maxLevel,
      step: cfg.step,
      maxed,
      cost: maxed ? null : game.upgradeCost(kind, current)
    };
  }

  const daily = game.dailyStatus(user, now);

  // Сводка заданий для бейджа на вкладке: бусты уже посчитаны выше, поэтому
  // дополнительный запрос нужен только за отметками о забранных наградах.
  const boostTotal = Object.values(boosts).reduce((sum, boost) => sum + (boost.used || 0), 0);
  const questState = quests.questsState(
    await questContext(store, user, day, { boosts: boostTotal, friends: 0 }),
    new Set(await store.questsOfDay(user.id, day))
  );
  const achievementsDone = extras.achievementsDone !== undefined
    ? extras.achievementsDone
    : (await store.achievementsOf(user.id)).length;

  return {
    serverTime: now,
    user: publicUser(user),
    level,
    cards,
    categories: game.CATEGORIES,
    boosts,
    upgrades,
    daily: {
      available: daily.available,
      streak: daily.streak,
      nextStreak: daily.nextStreak,
      reward: daily.reward,
      cooldownLeftMs: daily.cooldownLeftMs,
      rewards: game.DAILY_REWARDS
    },
    turboMultiplier: game.GAME.turboMultiplier,
    tapValue: game.tapValue(user, now),
    friends: {
      invited: await store.referralCount(user.id),
      bonus: game.GAME.referralBonus,
      friendBonus: game.GAME.referralInvitedBonus,
      // Награда пригласившему приходит после referralTapsTarget тапов друга.
      tapsTarget: game.GAME.referralTapsTarget,
      // Префикс ref_ обязателен: сервер разбирает start_param как ref_<tg_id>.
      link: extras.botUsername ? `https://t.me/${extras.botUsername}?startapp=ref_${user.tg_id}` : ''
    },
    rank: extras.rank || null,
    players: extras.players || 0,
    webappUrl: extras.webappUrl || '',
    // Сводка заданий и достижений — для бейджей; полные списки в /api/quests
    // и /api/achievements. Активная косметика нужна каждому экрану.
    quests: {
      day,
      total: questState.total,
      done: questState.done,
      claimed: questState.claimed,
      claimable: questState.claimable
    },
    achievements: { total: achievements.ACHIEVEMENTS.length, done: achievementsDone },
    cosmetics: cosmetics.activeOf(user),
    notify: notifyPrefs(user),
    // Премиум-буст из магазина: клиент показывает отдельный значок рядом с турбо.
    tapBoost: {
      active: (user.tap_boost_until || 0) > now,
      secondsLeft: (user.tap_boost_until || 0) > now
        ? Math.ceil((user.tap_boost_until - now) / 1000)
        : 0,
      multiplier: game.GAME.tapBoostMultiplier
    },
    // Достижения, полученные прямо в этом запросе: клиент покажет их всплывашкой.
    unlocked: extras.unlocked || [],
    maxTapsPerSecond: game.GAME.maxTapsPerSecond,
    energyRegenPerSec: game.GAME.energyRegenPerSec
  };
}

/**
 * Приём тапов. Живая игровая логика та же, что в локальной версии: ограничение
 * частоты, списание энергии, множитель турбо. Изменилось только то, что запись
 * идёт одной защищённой операцией UPDATE ... WHERE version = ? AND energy >= ?.
 */
export async function tap(store, user, count, now) {
  const wanted = Math.max(0, Math.min(MAX_BATCH_TAPS, Math.floor(Number(count) || 0)));
  if (wanted === 0) return { accepted: 0, gained: 0, user };

  const value = game.tapValue(user, now);
  const credit = ((now - (user.last_tap_at || 0)) / 1000) * game.GAME.maxTapsPerSecond;
  const budget = Math.min(credit, game.GAME.maxTapsPerSecond * TAP_BURST_SECONDS);
  const allowedByRate = Math.floor(budget);
  const accepted = Math.max(0, Math.min(wanted, allowedByRate, user.energy));
  if (accepted === 0) return { accepted: 0, gained: 0, user };

  const gained = accepted * value;
  const creditLeftMs = Math.round(((budget - accepted) / game.GAME.maxTapsPerSecond) * 1000);
  const changes = await store.applyTap({
    userId: user.id,
    version: user.version,
    accepted,
    gained,
    now,
    creditLeftMs: Math.max(0, creditLeftMs),
    // Счётчики дня обновляются в том же запросе — прогресс заданий без лишних записей.
    day: game.utcDay(now),
    // Прогресс приглашения считается тем же UPDATE: тапы друга после привязки.
    referralTarget: game.GAME.referralTapsTarget
  });
  const fresh = (await store.userById(user.id)) || user;
  if (!changes) {
    // Запись изменилась параллельным запросом (или энергии не хватило) —
    // считаем от свежих данных без повторов, чтобы не начислить дважды.
    return { accepted: 0, gained: 0, user: fresh };
  }

  // Друг добрал порог активности — награда пригласившему. Флаг выплаты ставится
  // атомарно, поэтому параллельная пачка тапов награду не удвоит (вернётся null).
  const target = game.GAME.referralTapsTarget;
  const payout = fresh.referrer_id && !fresh.referral_paid && (fresh.referral_taps || 0) >= target
    ? await store.claimReferralPayout(fresh.id, { target, bonus: game.GAME.referralBonus, now })
    : null;

  return { accepted, gained, user: fresh, payout };
}

// Покупка следующего уровня карточки: списание монет и запись уровня карточки.
export async function buyCard(store, user, cardId, now) {
  const card = game.CARDS_BY_ID.get(String(cardId || ''));
  if (!card) throw fail(400, 'неизвестная карточка');

  const levels = await store.cardLevels(user.id);
  const current = levels[card.id] || 0;
  if (current >= card.maxLevel) throw fail(409, 'карточка прокачана до максимума');
  if (game.levelIndexFor(user.profit_per_hour) < card.tier) {
    throw fail(403, `карточка откроется в лиге «${game.LEVELS[card.tier].name}»`);
  }

  const cost = game.cardCost(card, current);
  if (user.coins < cost) throw fail(402, 'недостаточно монет');

  const profitPerHour = game.profitPerHour({ ...levels, [card.id]: current + 1 });
  const changes = await store.beginCardPurchase({
    userId: user.id,
    version: user.version,
    cardId: card.id,
    cost,
    profitPerHour,
    now,
    // Счётчик покупок дня — для заданий «купи/прокачай бизнесы».
    day: game.utcDay(now)
  });
  // 0 изменений = не хватило монет или параллельный запрос успел раньше.
  if (!changes) throw fail(409, 'не удалось купить: обновите состояние и попробуйте снова');

  await store.finishCardPurchase({ userId: user.id, cardId: card.id, level: current + 1 });
  const fresh = (await store.userById(user.id)) || user;
  return { user: fresh, card, level: current + 1, cost };
}

// Прокачки мультитапа и лимита энергии.
export async function buyUpgrade(store, user, kind, now) {
  const cfg = game.UPGRADES[kind];
  if (!cfg) throw fail(400, 'неизвестная прокачка');

  const current = kind === 'tap' ? user.tap_level : user.energy_level;
  if (current >= cfg.maxLevel) throw fail(409, 'прокачка на максимуме');
  const cost = game.upgradeCost(kind, current);
  if (user.coins < cost) throw fail(402, 'недостаточно монет');

  const limit = user.energy_limit + cfg.step;
  const changes = await store.buyUpgrade({
    userId: user.id,
    version: user.version,
    kind,
    cost,
    now,
    tapPower: user.tap_power + cfg.step,
    tapLevel: current + 1,
    energy: Math.min(limit, user.energy + cfg.step),
    energyLimit: limit,
    energyLevel: current + 1
  });
  if (!changes) throw fail(409, 'не удалось улучшить: обновите состояние и попробуйте снова');

  const fresh = (await store.userById(user.id)) || user;
  return { user: fresh, kind, level: current + 1, cost };
}

// Бусты: полная энергия и турбо. Слот на день занимаем условным upsert-ом.
export async function useBoost(store, user, boostId, now) {
  const cfg = game.BOOSTS[boostId];
  if (!cfg) throw fail(400, 'неизвестный буст');

  const day = game.utcDay(now);
  const limit = game.GAME.boostDaily[boostId] || 0;

  if (boostId === 'full_energy' && user.energy >= user.energy_limit) {
    throw fail(409, 'энергия уже полная');
  }
  if (boostId === 'turbo' && user.turbo_until > now) {
    throw fail(409, 'турбо уже активен');
  }

  const slot = await store.claimBoostSlot({ userId: user.id, boostId, day, limit });
  if (!slot) throw fail(409, 'лимит бустов на сегодня исчерпан');

  const changes = await store.applyBoost({
    userId: user.id,
    version: user.version,
    boostId,
    now,
    energy: user.energy_limit,
    energyLimit: user.energy_limit,
    // Турбо — это временное окно, поэтому передаём момент окончания.
    turboUntil: now + game.GAME.turboSeconds * 1000
  });
  const fresh = (await store.userById(user.id)) || user;
  const used = await store.boostUsed(user.id, boostId, day);
  if (!changes) {
    // Условие не выполнилось (например, параллельный буст уже применён) — сообщаем,
    // не выдавая второй эффект.
    throw fail(409, 'буст не применился: обновите состояние');
  }
  return { user: fresh, boostId, used, limit };
}

// --- энергия за рекламу (Monetag, Chanify) ---
// Сети перечислены в config.AD_PROVIDERS по приоритету. Monetag — rewarded видео
// внутри мини-аппа: показ идёт через клиентский SDK, поэтому сервер выдаёт
// одноразовую сессию (token), а энергию начисляет claimAdEnergy по факту
// досмотра. Chanify — реклама приходит сообщением в чат, проверить показ нельзя,
// поэтому энергию начисляем по возвращении игрока (confirmAdEnergy).
// Дневного лимита нет — только общая для всех сетей пауза между попытками.

/**
 * Время, от которого считается пауза. Клиентский формат — от награды
 * (credited_at): пока ролик не досмотрен, пауза не нужна, иначе неудачный показ
 * или переход к следующей сети упирался бы в таймер. Реклама в чате и неудачные
 * попытки — от времени выдачи (at), как было и раньше.
 */
function adCooldownAt(config, row) {
  if (!row) return 0;
  const provider = ads.providerInfo(config, row.provider || '');
  if (provider.mode === 'client') return row.credited_at || 0;
  return Math.max(row.at || 0, row.credited_at || 0);
}

/** Сколько миллисекунд осталось до следующей попытки. */
async function adWaitMs(store, config, user, now) {
  const cfg = game.GAME.adEnergy;
  const last = adCooldownAt(config, await store.adLastAttempt(user.id, 'energy'));
  return last ? Math.max(0, last + cfg.cooldownMs - now) : 0;
}

/** Публичные параметры сетей: по ним клиент понимает, как показать рекламу. */
function adProviders(config) {
  return ads.providerList(config).map((provider) => ({
    id: provider.id,
    mode: provider.mode,
    enabled: provider.enabled,
    zoneId: provider.zoneId || null,
    sdkUrl: provider.sdkUrl || null,
    // Настройки пассивного формата Monetag (если включён в конфиге).
    inApp: provider.inApp || null
  }));
}

/** Состояние кнопки «энергия за рекламу»: доступна ли, сколько ждать и где искать. */
export async function adStatus(store, config, user, now) {
  const cfg = game.GAME.adEnergy;
  const waitMs = await adWaitMs(store, config, user, now);
  return {
    percent: cfg.percent,
    cooldownMs: cfg.cooldownMs,
    confirmDelayMs: cfg.confirmDelayMs,
    confirmOnReturn: !!cfg.confirmOnReturn,
    readyInMs: waitMs,
    available: user.energy < user.energy_limit && waitMs === 0,
    providers: adProviders(config)
  };
}

/** Одноразовый токен сессии показа: игрок вернёт его при подтверждении. */
function adToken(prefix) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(12).toString('hex')}`;
}

/**
 * Просит рекламу у первого доступного провайдера. skip — сети, которые уже не
 * сработали на клиенте (ролик не запустился), — тогда запрос уходит следующей.
 */
export async function requestAdEnergy(store, config, user, now, options = {}) {
  const skip = Array.isArray(options.skip) ? options.skip : [];
  if (user.energy >= user.energy_limit) throw fail(409, 'энергия уже полная');
  const waitMs = await adWaitMs(store, config, user, now);
  if (waitMs > 0) throw fail(409, `восстановление будет доступно через ${Math.ceil(waitMs / 1000)} с`);

  const provider = ads.pickProvider(config, skip);
  if (!provider) throw fail(409, ads.reasonText('disabled'));

  const session = provider.mode === 'client'
    ? await issueClientAd(store, provider, user, now)
    : await deliverChatAd(store, config, provider, user, now);

  return {
    ...session,
    provider: provider.id,
    mode: provider.mode,
    status: await adStatus(store, config, user, now)
  };
}

/**
 * Клиентский формат (Monetag): энергии пока нет — выдаём сессию и публичные
 * данные показа. Незакрытая сессия переиспользуется, чтобы частые тапы не
 * плодили записи; истёкшая заменяется новой.
 */
async function issueClientAd(store, provider, user, now) {
  const cfg = game.GAME.adEnergy;
  const pending = await store.adPendingFor(user.id, 'energy', provider.id);
  const token = pending && pending.at + cfg.sessionTtlMs > now ? pending.token : adToken(provider.id);
  if (!pending || pending.token !== token) {
    await store.adLog({ token, userId: user.id, kind: 'energy', status: 'pending', provider: provider.id, now });
  }
  return {
    pending: true,
    token,
    zoneId: provider.zoneId,
    sdkUrl: provider.sdkUrl,
    // Ролик показывается внутри мини-аппа: ждать возвращения из чата не нужно.
    confirmDelayMs: 0,
    confirmOnReturn: false
  };
}
/** Реклама в чате (Chanify): просим сеть доставить её сообщением от бота. */
async function deliverChatAd(store, config, provider, user, now) {
  const cfg = game.GAME.adEnergy;
  const ad = await ads.showChatAd(config, {
    chatId: user.tg_id,
    userId: user.tg_id,
    userMeta: { languageCode: user.language_code, isPremium: !!user.is_premium }
  });

  if (!ad.shown) {
    // Реклама не пришла (cooldown сети, нет кампаний, ошибка доставки): пишем
    // попытку — она включает паузу, — но энергию не начисляем.
    await store.adLog({
      token: adToken(`failed_${provider.id}`),
      userId: user.id,
      kind: 'energy',
      status: 'failed',
      provider: provider.id,
      now
    });
    throw fail(409, ads.reasonText(ad.reason));
  }

  await store.adLog({
    token: ad.impressionId,
    userId: user.id,
    kind: 'energy',
    status: 'pending',
    provider: provider.id,
    impressionId: ad.impressionId,
    now
  });
  return {
    pending: true,
    token: ad.impressionId,
    confirmDelayMs: cfg.confirmDelayMs,
    confirmOnReturn: !!cfg.confirmOnReturn
  };
}



/**
 * Выдаёт награду за состоявшийся показ. Переход pending -> credited делает ровно
 * один запрос, поэтому параллельные подтверждения не начислят энергию дважды.
 */
async function creditAdRow(store, config, user, token, row, now) {
  const cfg = game.GAME.adEnergy;
  const energy = Math.min(user.energy_limit, user.energy + Math.round((user.energy_limit * cfg.percent) / 100));
  if (!(await store.adCredit({ token, userId: user.id, energy, now }))) {
    throw fail(409, 'этот показ уже учтён');
  }
  const updated = await store.updateUser(user.id, { energy, last_seen: now });
  return {
    credited: true,
    user: updated,
    energy,
    restored: energy - user.energy,
    provider: row.provider || null,
    status: await adStatus(store, config, updated, now)
  };
}

/**
 * Награда за клиентский показ (Monetag): клиент сообщает, что ролик досмотрен.
 * Токен одноразовый — чужой, просроченный и повторный запрос ничего не начислят.
 * done=false (ролик закрыли раньше) награду не даёт и паузу не включает: игрок
 * может попробовать снова, сессия остаётся действующей.
 */
export async function claimAdEnergy(store, config, user, payload = {}, now) {
  const cfg = game.GAME.adEnergy;
  const token = payload.token;
  if (!token) throw fail(400, 'не найден показ рекламы');
  const row = await store.adByToken(token);
  if (!row || row.user_id !== user.id) throw fail(409, 'этот показ уже учтён');
  if (ads.providerInfo(config, row.provider || '').mode !== 'client') {
    throw fail(409, 'этот показ подтверждается по возвращении из чата');
  }

  // Награда уже выдана (например, постбеком сети): повторный запрос клиента после
  // опроса просто возвращает состояние — энергию не удваиваем.
  if (row.status === 'credited') {
    return {
      credited: true,
      restored: 0,
      energy: user.energy,
      provider: row.provider || null,
      status: await adStatus(store, config, user, now)
    };
  }
  if (row.status !== 'pending') throw fail(409, 'этот показ уже учтён');
  if (row.at + cfg.sessionTtlMs < now) throw fail(409, 'сессия показа устарела — попробуйте снова');

  if (!payload.done) {
    return {
      credited: false,
      energy: user.energy,
      restored: 0,
      provider: row.provider || null,
      status: await adStatus(store, config, user, now)
    };
  }

  // Режим «награда только по постбеку»: пока сеть не подтвердила показ, энергию не
  // выдаём — клиент подождёт и спросит снова. Источник правды — серверный постбек.
  if (postbackRequired(config)) {
    if (!(row.postback_at > 0)) {
      // Момент подтверждения клиентом фиксируем один раз: окно ожидания постбека
      // считается от него, а не от выдачи сессии — ролик идёт десятки секунд.
      if (!(row.client_done_at > 0)) {
        await store.adMarkClientDone(token, now);
        row.client_done_at = now;
      }
      const graceMs = postbackGraceMs(config);
      if (graceMs > 0 && now - row.client_done_at >= graceMs) {
        // Страховка: окно истекло, а постбека нет (например, в кабинете ещё не
        // сохранили Postback URL). Игрок ролик посмотрел — награду выдаём, но строку
        // постбеком не помечаем: такие выдачи видно по postback_at = 0.
        const credited = await creditAdRow(store, config, user, token, row, now);
        return { ...credited, fallback: 'grace' };
      }
      return {
        credited: false,
        waiting: true,
        retryInMs: POSTBACK_RETRY_MS,
        graceMs,
        provider: row.provider || null,
        status: await adStatus(store, config, user, now)
      };
    }
    if (row.postback_value !== 'valued') {
      return {
        credited: false,
        rejected: true,
        provider: row.provider || null,
        status: await adStatus(store, config, user, now)
      };
    }
  }
  return creditAdRow(store, config, user, token, row, now);
}

/** Включён ли режим, когда награду выдаёт только постбек сети. */
function postbackRequired(config) {
  return !!(config && config.MONETAG_REQUIRE_POSTBACK);
}

/** Окно ожидания постбека после подтверждения клиента (0 — не ждать и не выдавать). */
function postbackGraceMs(config) {
  const value = Number(config && config.MONETAG_POSTBACK_GRACE_MS);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Постбек Monetag: сеть подтверждает показ по нашему ymid (он же token выдачи).
 * Событие impression приходит в начале показа, click — по клику; награду выдаём
 * только по impression со значением valued и только в режиме «награда по постбеку»
 * (по умолчанию постбек лишь записывается рядом с выдачей для сверки).
 * Повторный постбек ничего не удвоит: переход pending -> credited делает ровно
 * один запрос. Ответ всегда ok — иначе сеть будет повторять запрос снова и снова.
 */
export async function recordAdPostback(store, config, payload = {}, now) {
  const cfg = game.GAME.adEnergy;
  const token = String(payload.ymid || '').trim();
  const event = String(payload.event || 'impression').trim().toLowerCase();
  const value = String(payload.value || '').trim().toLowerCase() || null;
  if (!token) return { ok: true, ignored: 'no_ymid' };

  const row = await store.adByToken(token);
  if (!row) {
    // Постбек по неизвестной выдаче (тест из кабинета, чужая сессия) — просто логируем.
    return { ok: true, ignored: 'unknown_ymid' };
  }
  if (event && event !== 'impression') {
    // Клик подтверждает интерес к креативу, но не просмотр: награду за него не даём.
    return { ok: true, ignored: event };
  }

  await store.adMarkPostback({
    token,
    value,
    externalId: payload.subId ? String(payload.subId) : null,
    now
  });
  if (value !== 'valued') return { ok: true, credited: false, reason: value || 'unvalued' };
  if (!postbackRequired(config)) return { ok: true, credited: false, reason: 'not_required' };
  if (row.status === 'credited') return { ok: true, credited: false, reason: 'already' };
  if (row.status !== 'pending') return { ok: true, credited: false, reason: row.status };
  if (row.at + cfg.sessionTtlMs < now) return { ok: true, credited: false, reason: 'expired' };

  const user = await store.userById(row.user_id);
  if (!user) return { ok: true, credited: false, reason: 'no_user' };
  try {
    await creditAdRow(store, config, user, token, row, now);
  } catch {
    // Параллельный постбек уже выдал награду: отвечаем ok, повторять не нужно.
    return { ok: true, credited: false, reason: 'race' };
  }
  return { ok: true, credited: true };
}

/** Подтверждает показ рекламы в чате: игрок ушёл в чат и вернулся в игру. */
export async function confirmAdEnergy(store, config, user, token, now) {
  const cfg = game.GAME.adEnergy;
  if (!token) throw fail(400, 'не найден показ рекламы');
  const row = await store.adGet(token, user.id);
  if (!row || row.status !== 'pending') throw fail(409, 'этот показ уже учтён');
  if (ads.providerInfo(config, row.provider || '').mode === 'client') {
    throw fail(409, 'этот показ подтверждается сразу после видео');
  }

  if (cfg.confirmOnReturn) {
    const leftMs = row.at + cfg.confirmDelayMs - now;
    if (leftMs > 0) throw fail(409, `посмотрите рекламу в чате и вернитесь через ${Math.ceil(leftMs / 1000)} с`);
  }
  return creditAdRow(store, config, user, token, row, now);
}

// Ежедневный бонус: кулдаун проверяется в самом SQL, поэтому два запроса
// подряд не могут выдать награду дважды.
export async function claimDaily(store, user, now) {
  const status = game.dailyStatus(user, now);
  if (!status.available) throw fail(409, 'бонус пока недоступен');

  const changes = await store.claimDaily({
    userId: user.id,
    version: user.version,
    reward: status.reward,
    streak: status.nextStreak,
    now,
    cooldownMs: game.DAILY_COOLDOWN_MS,
    day: game.utcDay(now)
  });
  if (!changes) throw fail(409, 'бонус уже получен');

  const fresh = (await store.userById(user.id)) || user;

  return { user: fresh, reward: status.reward, streak: status.nextStreak };
}

// --- задания, достижения и косметика ---

// Контекст дня для расчёта прогресса заданий. Часть значений можно передать
// снаружи (в состоянии экрана бусты уже посчитаны) — тогда лишних запросов нет.
async function questContext(store, user, day, extra = {}) {
  return quests.contextFrom({
    user,
    day,
    boosts: extra.boosts !== undefined ? extra.boosts : await store.boostsUsedToday(user.id, day),
    friends: extra.friends !== undefined
      ? extra.friends
      : await store.referralsToday(user.id, quests.dayStart(day))
  });
}

// Награда за задание или достижение: монеты и — если предмета ещё нет — косметика.
// Монеты попадают и в дневной счётчик «заработай монеты». Запись одна: UPDATE users
// (косметика и достижение занимают по строке в своих таблицах).
async function grantReward(store, user, reward, source, now, day) {
  let coins = reward.coins || 0;
  let cosmetic = null;
  if (reward.cosmetic) {
    if (await store.addCosmetic(user.id, reward.cosmetic, source, now)) {
      cosmetic = cosmetics.itemById(reward.cosmetic);
    } else {
      coins += DUPLICATE_COSMETIC_COINS;
    }
  }

  const updated = await store.addCoins({
    userId: user.id,
    coins,
    day,
    now
  });
  return { user: updated || user, coins, cosmetic };
}

/**
 * Проверка достижений: вызывается один раз за запрос, после действия игрока.
 * Читаем список полученных достижений, а counts по карточкам и друзьям — только
 * если они нужны оставшимся достижениям (см. neededMetrics): обычно это 0–1 запрос.
 */
export async function checkAchievements(store, user, now) {
  const owned = new Set((await store.achievementsOf(user.id)).map((row) => row.achievement_id));
  const result = { user, unlocked: [], owned };
  if (owned.size >= achievements.ACHIEVEMENTS.length) return result;

  const needed = achievements.neededMetrics(owned);
  const ctx = { user, maxTapLevel: game.UPGRADES.tap.maxLevel, cards: 0, referrals: 0 };
  if (needed.has('cards')) ctx.cards = await store.cardsCount(user.id);
  if (needed.has('referrals')) ctx.referrals = await store.referralCount(user.id);

  const day = game.utcDay(now);
  for (const item of achievements.pendingAchievements(ctx, owned)) {
    if (!(await store.addAchievement(user.id, item.id, now))) continue;
    const granted = await grantReward(store, user, item.reward, 'achievement', now, day);
    user = granted.user;
    ctx.user = user;
    owned.add(item.id);
    result.unlocked.push({
      id: item.id,
      title: item.title,
      emoji: item.emoji,
      reward: item.reward,
      coins: granted.coins,
      cosmetic: granted.cosmetic
    });
  }
  result.user = user;
  return result;
}

// --- магазин: товары за звёзды и за рубли ---

// Витрина магазина: цены в двух валютах (звёзды — что списывает Telegram, рубли —
// для внешней страницы), флаг «уже куплено» у косметики, последние покупки игрока
// и подсказка о том, какой канал оплаты настроен.
export async function shopView(store, user, config = {}) {
  const rows = await store.cosmeticsOf(user.id);
  const owned = new Set(rows.map((row) => row.item_id));
  return {
    items: shop.goodsList(cosmetics.COSMETICS).map((good) => ({
      ...good,
      owned: good.kind === 'cosmetic' ? owned.has(good.itemId) : false,
      priceText: shop.priceText(good),
      starsText: shop.starsText(good)
    })),
    purchases: await store.paymentsOf(user.id, 5),
    payment: {
      provider: payments.providerId(config),
      providers: payments.providerList(config),
      payPage: paylink.payPageUrl(config)
    }
  };
}

// Поля счёта для товара. Сам вызов Bot API живёт в api-слое (lib/invoice.js),
// поэтому сервис остаётся игровой логикой без сети.
export function invoiceFor(user, itemId) {
  const good = shop.goodById(itemId, cosmetics.COSMETICS);
  if (!good) throw fail(400, 'неизвестный товар');
  return { good, invoice: shop.invoiceFor(good, user.id) };
}

/**
 * Создание платежа.
 *   stars    — внутри Telegram: отдаём ссылку на счёт Telegram, товар выдаст вебхук
 *              бота после successful_payment (мини-апп платит звёздами по правилам
 *              платформы);
 *   yookassa — вне Telegram: создаём платёж на внешней странице, пишем его в журнал
 *              со статусом pending и отдаём ссылку на оплату; товар выдаст вебхук
 *              или сверка (см. settlePayment).
 */
export async function createShopPayment(store, config, user, itemId, options = {}) {
  const good = shop.goodById(itemId, cosmetics.COSMETICS);
  if (!good) throw fail(400, 'неизвестный товар');
  const now = options.now || Date.now();
  const provider = options.provider || payments.provider(config);

  if (provider.mode === 'telegram') {
    const created = await provider.createPayment(config, { good, userId: user.id });
    return {
      provider: 'stars',
      mode: 'telegram',
      item: good.id,
      stars: good.stars,
      amount: good.price,
      currency: shop.CURRENCY,
      link: created.payUrl || created.invoiceLink
    };
  }

  const page = paylink.payPageUrl(config);
  if (!page) throw fail(503, 'внешняя страница оплаты не настроена');
  const returnUrl = String(config.YOOKASSA_RETURN_URL || '').trim() || page;
  const paymentId = payments.newPaymentId();
  const created = await provider.createPayment(config, {
    good,
    userId: user.id,
    paymentId,
    returnUrl,
    email: options.email
  });
  await store.recordPayment({
    userId: user.id,
    itemId: good.id,
    stars: 0,
    chargeId: created.externalId,
    provider: created.provider,
    amount: created.amount,
    currency: created.currency,
    status: 'pending',
    now
  });
  return {
    provider: created.provider,
    mode: 'external',
    item: good.id,
    paymentId,
    externalId: created.externalId,
    amount: created.amount,
    currency: created.currency,
    payUrl: created.payUrl,
    returnUrl
  };
}

/** Представление платежа для клиента и внешней страницы. */
export function paymentView(row) {
  if (!row) return null;
  const good = shop.goodById(row.item_id, cosmetics.COSMETICS);
  return {
    id: row.id,
    item: row.item_id,
    title: good ? `${good.emoji || ''} ${good.title}`.trim() : row.item_id,
    provider: row.provider || 'stars',
    status: row.status,
    amount: row.amount,
    currency: row.currency,
    stars: row.stars,
    refundedAt: row.refunded_at || 0,
    at: row.at
  };
}

/**
 * Выдача оплаченного товара (вызывается из бота после successful_payment).
 * Сначала пишем платёж: charge_id уникален, поэтому повторный апдейт Telegram
 * (или повторный вызов) товар второй раз не выдаст.
 */
export async function deliverPurchase(store, user, { itemId, chargeId, stars, item, now }) {
  const good = shop.goodById(itemId, cosmetics.COSMETICS);
  if (!good) throw fail(400, 'неизвестный товар');
  const amount = Number(item && item.total_amount) || Number(stars) || good.stars;
  const charge = chargeId || `manual_${user.id}_${good.id}_${now}`;

  const recorded = await store.recordPayment({
    userId: user.id,
    itemId: good.id,
    stars: amount,
    chargeId: charge,
    provider: 'stars',
    amount,
    currency: 'XTR',
    status: 'succeeded',
    now
  });
  if (!recorded) return { user, good, duplicate: true, delivered: null };

  const granted = await grantGood(store, user, good, now);
  return { user: granted.user, good, duplicate: false, delivered: granted.delivered };
}

// Выдача товара без записи платежа: один и тот же код обслуживает звёзды (платёж
// пишет вебхук бота) и рублёвый канал (платёж пишем при создании, выдаём по вебхуку).
async function grantGood(store, user, good, now) {
  const day = game.utcDay(now);
  if (good.kind === 'coins') {
    const updated = await store.addCoins({ userId: user.id, coins: good.coins, day, now });
    return { user: updated || user, delivered: { coins: good.coins } };
  }

  if (good.kind === 'boost') {
    const updated = await store.extendTapBoost({
      userId: user.id,
      ms: good.boostMinutes * 60 * 1000,
      now
    });
    return { user: updated || user, delivered: { boostUntil: (updated || user).tap_boost_until } };
  }

  // Косметика: источник 'stars', поэтому её нельзя получить иначе.
  await store.addCosmetic(user.id, good.itemId, 'stars', now);
  return {
    user: (await store.userById(user.id)) || user,
    delivered: { cosmetic: cosmetics.itemById(good.itemId) }
  };
}
/**
 * Подтверждение оплаты и выдача товара. Вызывается из вебхука провайдера и из
 * сверки: переход pending -> succeeded делает ровно один запрос, поэтому повторные
 * уведомления не выдадут товар дважды.
 */
export async function settlePayment(store, config, { chargeId, now }) {
  const row = await store.paymentByCharge(chargeId);
  if (!row) return { ok: false, reason: 'unknown_payment' };
  if (row.status !== 'pending') {
    // Уже выдано (succeeded), возвращено (refunded) или отменено — ничего не делаем.
    return { ok: true, delivered: false, reason: row.status, payment: paymentView(row) };
  }
  if (!(await store.markPaymentStatus(chargeId, 'pending', 'succeeded'))) {
    return { ok: true, delivered: false, reason: 'race', payment: paymentView(row) };
  }
  const good = shop.goodById(row.item_id, cosmetics.COSMETICS);
  const user = await store.userById(row.user_id);
  if (!good || !user) return { ok: true, delivered: false, reason: 'no_target' };
  const granted = await grantGood(store, user, good, now);
  return {
    ok: true,
    delivered: true,
    good,
    user: granted.user,
    granted: granted.delivered,
    payment: paymentView(await store.paymentByCharge(chargeId))
  };
}

/**
 * Статус платежа. Если платёж ещё pending, дополнительно спрашиваем провайдера — так
 * оплата не теряется, даже если уведомление не дошло (у ЮKassa нет подписи, а повторы
 * могут задержаться до суток).
 */
export async function paymentStatus(store, config, user, chargeId, now = Date.now()) {
  const row = await store.paymentByCharge(String(chargeId || ''));
  if (!row || (user && row.user_id !== user.id)) throw fail(404, 'платёж не найден');
  if (row.status === 'pending') {
    const provider = payments.PROVIDERS[row.provider] || payments.provider(config);
    const remote = await provider.fetchPayment(config, row.charge_id).catch(() => null);
    if (remote && remote.status === 'succeeded') {
      return (await settlePayment(store, config, { chargeId: row.charge_id, now })).payment;
    }
    if (remote && (remote.status === 'canceled' || remote.status === 'refunded')) {
      await store.markPaymentStatus(row.charge_id, 'pending', remote.status);
      return paymentView(await store.paymentByCharge(row.charge_id));
    }
  }
  return paymentView(await store.paymentByCharge(row.charge_id));
}

/**
 * Вебхук ЮKassa. Тело уведомления — не доказательство: api-слой проверяет секрет
 * адреса, адрес отправителя и повторно запрашивает статус платежа, а сервис только
 * применяет событие к журналу и идемпотентно выдаёт товар.
 */
export async function handleYookassaNotification(store, config, notification, now = Date.now()) {
  const event = String((notification && notification.event) || '');
  const object = (notification && notification.object) || {};
  const chargeId = String(object.id || '');
  if (!chargeId) return { ok: true, ignored: 'no_id' };

  if (event === 'payment.canceled') {
    await store.markPaymentStatus(chargeId, 'pending', 'canceled');
    return { ok: true, canceled: true };
  }
  if (event === 'refund.succeeded') {
    await store.markPaymentRefunded(chargeId, now);
    return { ok: true, refunded: true };
  }
  if (event !== 'payment.succeeded') return { ok: true, ignored: event || 'unknown' };
  return settlePayment(store, config, { chargeId, now });
}



// Награда в витрине: идентификатор косметики превращаем в предмет каталога.
function withRewardView(item) {
  return { ...item, reward: cosmetics.rewardView(item.reward) };
}

// --- код дня («шифр») ---

// Состояние кода дня. Сам код тут не отдаём: его выдаёт бот командой /code.
export async function codeView(store, user, now) {
  const day = game.utcDay(now);
  const claimed = (await store.questsOfDay(user.id, day)).includes(dailycode.CODE_QUEST_ID);
  return {
    day,
    claimed,
    reward: dailycode.CODE_REWARD,
    hint: dailycode.hint(),
    // Код «живёт» до конца суток UTC — клиент показывает обратный отсчёт.
    expiresInMs: dailycode.msUntilDayEnd(day, now)
  };
}

/**
 * Приём кода дня. Сначала занимаем отметку в user_quests (повторно не получится),
 * и только потом начисляем монеты — как и у ежедневных заданий.
 */
export async function claimCode(store, user, code, now) {
  const day = game.utcDay(now);
  if (!dailycode.check(code, day)) throw fail(400, 'код не подходит к сегодняшнему дню');
  if (!(await store.claimQuest(user.id, dailycode.CODE_QUEST_ID, day, now))) {
    throw fail(409, 'код за сегодня уже использован');
  }

  const granted = await grantReward(store, user, { coins: dailycode.CODE_REWARD }, 'code', now, day);
  return { day, coins: granted.coins, user: granted.user };
}

// --- витрины: задания, достижения, косметика, профиль ---

export async function questsView(store, user, now) {
  const day = game.utcDay(now);
  const claimed = new Set(await store.questsOfDay(user.id, day));
  const view = quests.questsState(await questContext(store, user, day), claimed);
  return { day, ...view, list: view.list.map(withRewardView) };
}

// Забираем награду за задание: сначала занимаем отметку в user_quests (первичный
// ключ не даст забрать дважды), и только потом начисляем — при повторе будет 409.
export async function claimQuest(store, user, questId, now) {
  const quest = quests.QUESTS_BY_ID.get(String(questId || ''));
  if (!quest) throw fail(400, 'неизвестное задание');

  const day = game.utcDay(now);
  const status = quests.questStatus(quest, await questContext(store, user, day), false);
  if (!status.done) throw fail(409, 'задание ещё не выполнено');
  if (!(await store.claimQuest(user.id, quest.id, day, now))) {
    throw fail(409, 'награда за задание уже получена');
  }

  const granted = await grantReward(store, user, quest.reward, 'quest', now, day);
  return { quest: status, coins: granted.coins, cosmetic: granted.cosmetic, user: granted.user };
}

export async function achievementsView(store, user) {
  const view = achievements.achievementsState(await store.achievementsOf(user.id));
  return { ...view, list: view.list.map(withRewardView) };
}

export async function cosmeticsView(store, user) {
  const rows = await store.cosmeticsOf(user.id);
  return cosmetics.cosmeticState(user, rows.map((row) => row.item_id));
}

// Надеть предмет можно только из открытых: бесплатные открыты всем с начала игры,
// остальные — за задания, достижения (позже — за Stars).
export async function equipCosmetic(store, user, itemId) {
  const item = cosmetics.itemById(String(itemId || ''));
  if (!item) throw fail(400, 'неизвестный предмет');

  const rows = await store.cosmeticsOf(user.id);
  const owned = new Set(rows.map((row) => row.item_id));
  if (item.source !== 'free' && !owned.has(item.id)) throw fail(403, 'предмет ещё не открыт');

  const updated = await store.updateUser(user.id, { [cosmetics.COLUMNS[item.type]]: item.id });
  return { user: updated || user, item };
}

export function notifyPrefs(user) {
  return {
    energy: !!user.notify_energy,
    daily: !!user.notify_daily,
    rank: !!user.notify_rank
  };
}

// Переключатели напоминаний бота: их читает рассылка по расписанию (push.js).
export async function pushPrefs(store, user, patch) {
  const next = {};
  for (const kind of Object.keys(notifyPrefs(user))) {
    const value = (patch || {})[kind];
    if (value === undefined) continue;
    next[`notify_${kind}`] = value ? 1 : 0;
  }
  if (!Object.keys(next).length) throw fail(400, 'нечего менять');
  return { user: await store.updateUser(user.id, next) };
}

/**
 * Удаление профиля игрока по его же запросу: данные пропадают, при следующем
 * входе создаётся новый игрок (бонусы за приглашение снова доступны — так решили
 * сознательно). Платежи за звёзды остаются в базе: по ним оформляются возвраты
 * через /paysupport, персональных данных в них нет.
 */
export async function deleteProfile(store, user, now) {
  const purchases = await store.paymentsCount(user.id);
  await store.deleteUser(user.id, { tgId: user.tg_id, keepPayments: true });
  return { deleted: true, purchases, at: now };
}

/**
 * Публичный профиль игрока (без tg_id): статистика и активная косметика.
 * extras.rank/players приходят из кэшированного снимка рейтинга, чтобы не сканировать
 * таблицу на каждый просмотр профиля.
 */
export async function profile(store, viewer, id, now, extras = {}) {
  const target = await store.userById(id);
  if (!target) throw fail(404, 'игрок не найден');

  const level = game.levelInfo(target.profit_per_hour);
  const granted = achievements.achievementsState(await store.achievementsOf(target.id));
  return {
    id: target.id,
    name: target.first_name || target.username || `Игрок ${target.id}`,
    username: target.username,
    mine: !!(viewer && viewer.id === target.id),
    level: { index: level.index, name: level.name, emoji: level.emoji },
    coins: target.coins,
    profitPerHour: target.profit_per_hour,
    totalEarned: target.total_earned,
    totalTaps: target.total_taps,
    tapPower: target.tap_power,
    energyLimit: target.energy_limit,
    cards: await store.cardsCount(target.id),
    friends: await store.referralCount(target.id),
    days: Math.max(1, Math.floor((now - target.created_at) / 86400000) + 1),
    rank: extras.rank || null,
    players: extras.players || 0,
    // Отдаём весь список (и полученные, и оставшиеся): в карточке игрока видно,
    // что он уже открыл. Награды не передаём — в чужом профиле они не нужны.
    achievements: granted.list.map((item) => ({
      id: item.id,
      emoji: item.emoji,
      title: item.title,
      hint: item.hint,
      done: item.done,
      at: item.at
    })),
    achievementsDone: granted.done,
    achievementsTotal: granted.total,
    cosmetics: cosmetics.activeOf(target)
  };
}

