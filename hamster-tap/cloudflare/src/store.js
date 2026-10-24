// D1-слой: те же операции, что в lib/db.js, но асинхронные и с атомарными
// условными UPDATE. Игровые правила живут в lib/game.js (общий код с локальной
// версией), поэтому здесь только доступ к данным.

// D1 может вернуть результат в двух формах — берём число изменённых строк надёжно.
function changesOf(result) {
  if (!result) return 0;
  if (result.meta && typeof result.meta.changes === 'number') return result.meta.changes;
  if (typeof result.changes === 'number') return result.changes;
  return 0;
}

const UPDATABLE = new Set([
  'username', 'first_name', 'last_name', 'coins', 'energy', 'energy_limit',
  'tap_power', 'tap_level', 'energy_level', 'profit_per_hour', 'total_earned',
  'total_taps', 'referrer_id', 'referred_at', 'referral_taps', 'referral_paid',
  'daily_streak', 'daily_last', 'turbo_until', 'last_tap_at', 'last_seen', 'pending_card',
  // Счётчики текущего дня (прогресс ежедневных заданий) и день, к которому относятся.
  'day_key', 'taps_today', 'buys_today', 'earned_today',
  // Надетая косметика, премиум-буст и подписки на напоминания бота.
  'hamster_skin', 'palette', 'background', 'badge', 'tap_boost_until',
  'notify_energy', 'notify_daily', 'notify_rank',
  // Профиль Telegram: нужен для таргетинга рекламы (userMeta у Chanify).
  'language_code', 'is_premium'
]);

export function createStore(db) {
  const prep = (sql) => db.prepare(sql);

  async function userByTgId(tgId) {
    return (await prep('SELECT * FROM users WHERE tg_id = ?').bind(tgId).first()) || null;
  }

  async function userById(id) {
    return (await prep('SELECT * FROM users WHERE id = ?').bind(id).first()) || null;
  }

  async function createUser({ tgId, username, firstName, lastName, referrerId, now, defaults }) {
    await prep(`
      INSERT INTO users (tg_id, username, first_name, last_name, coins, energy,
                         energy_limit, tap_power, referrer_id, referred_at, created_at, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      tgId, username, firstName, lastName,
      defaults.startCoins, defaults.startEnergyLimit, defaults.startEnergyLimit,
      defaults.startTapPower, referrerId,
      // referred_at — только у приглашённых: по нему считается задание дня,
      // а created_at у поздно привязанного игрока для этого не подходит.
      referrerId ? now : 0,
      now, now
    ).run();
    return userByTgId(tgId);
  }

  async function updateUser(id, patch) {
    const keys = Object.keys(patch).filter((key) => UPDATABLE.has(key));
    if (keys.length) {
      const sql = `UPDATE users SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`;
      await prep(sql).bind(...keys.map((key) => patch[key]), id).run();
    }
    return userById(id);
  }

  async function cardLevels(userId) {
    const rows = await prep('SELECT card_id, level FROM user_cards WHERE user_id = ?').bind(userId).all();
    const out = {};
    for (const row of (rows.results || [])) out[row.card_id] = row.level;
    return out;
  }

  // --- атомарные игровые операции ---
  // Каждая проверяет version и условие (энергия/монеты) прямо в SQL, поэтому два
  // одновременных запроса не могут ни уйти в минус, ни дважды списать монеты.

  // Счётчики дня (taps_today, earned_today) едут в том же UPDATE, что и тапы:
  // лишних записей в D1 не появляется. Смена дня видна по day_key — тогда счётчик
  // начинается заново прямо в этом запросе. Там же копится прогресс приглашения:
  // тапы друга после привязки, пока награда пригласившему не выплачена.
  async function applyTap({ userId, version, accepted, gained, now, creditLeftMs, day, referralTarget }) {
    const result = await prep(`
      UPDATE users
         SET coins = coins + ?,
             energy = energy - ?,
             total_earned = total_earned + ?,
             total_taps = total_taps + ?,
             taps_today = CASE WHEN day_key = ? THEN taps_today + ? ELSE ? END,
             earned_today = CASE WHEN day_key = ? THEN earned_today + ? ELSE ? END,
             buys_today = CASE WHEN day_key = ? THEN buys_today ELSE 0 END,
             referral_taps = CASE WHEN referrer_id IS NOT NULL AND referral_paid = 0
                                  THEN MIN(referral_taps + ?, ?) ELSE referral_taps END,
             day_key = ?,
             last_tap_at = ?,
             last_seen = ?,
             version = version + 1
       WHERE id = ? AND version = ? AND energy >= ?
    `).bind(
      gained, accepted, gained, accepted,
      day, accepted, accepted,
      day, gained, gained,
      day,
      accepted, referralTarget,
      day, now - creditLeftMs, now,
      userId, version, accepted
    ).run();
    return changesOf(result);
  }

  // Шаг 1 покупки карточки: списываем монеты и запоминаем намерение.
  async function beginCardPurchase({ userId, version, cardId, cost, profitPerHour, now, day }) {
    const result = await prep(`
      UPDATE users
         SET coins = coins - ?,
             profit_per_hour = ?,
             pending_card = ?,
             buys_today = CASE WHEN day_key = ? THEN buys_today + 1 ELSE 1 END,
             day_key = ?,
             last_seen = ?,
             version = version + 1
       WHERE id = ? AND version = ? AND coins >= ?
    `).bind(cost, profitPerHour, cardId, day, day, now, userId, version, cost).run();
    return changesOf(result);
  }

  // Шаг 2: записываем уровень карточки и снимаем намерение. Вызывается также при
  // самовосстановлении, если предыдущий шаг оборвался (см. service.settle).
  async function finishCardPurchase({ userId, cardId, level }) {
    await db.batch([
      prep(`
        INSERT INTO user_cards (user_id, card_id, level) VALUES (?, ?, ?)
        ON CONFLICT (user_id, card_id) DO UPDATE SET level = excluded.level
      `).bind(userId, cardId, level),
      prep('UPDATE users SET pending_card = NULL WHERE id = ? AND pending_card = ?').bind(userId, cardId)
    ]);
  }

  async function buyUpgrade({ userId, version, kind, cost, now, tapPower, tapLevel, energy, energyLimit, energyLevel }) {
    const isTap = kind === 'tap';
    const sql = isTap
      ? `UPDATE users SET coins = coins - ?, tap_power = ?, tap_level = ?, last_seen = ?, version = version + 1
           WHERE id = ? AND version = ? AND coins >= ?`
      : `UPDATE users SET coins = coins - ?, energy_limit = ?, energy_level = ?, energy = ?, last_seen = ?, version = version + 1
           WHERE id = ? AND version = ? AND coins >= ?`;
    const args = isTap
      ? [cost, tapPower, tapLevel, now, userId, version, cost]
      : [cost, energyLimit, energyLevel, energy, now, userId, version, cost];
    const result = await prep(sql).bind(...args).run();
    return changesOf(result);
  }

  // Буст: сначала занимаем слот на день (условный upsert), затем применяем эффект.
  async function claimBoostSlot({ userId, boostId, day, limit }) {
    const result = await prep(`
      INSERT INTO boost_uses (user_id, boost_id, day, used) VALUES (?, ?, ?, 1)
      ON CONFLICT (user_id, boost_id, day) DO UPDATE SET used = used + 1 WHERE used < ?
    `).bind(userId, boostId, day, limit).run();
    return changesOf(result);
  }

  async function applyBoost({ userId, version, boostId, now, energy, energyLimit, turboUntil }) {
    const isTurbo = boostId === 'turbo';
    const sql = isTurbo
      ? `UPDATE users SET turbo_until = ?, last_seen = ?, version = version + 1
           WHERE id = ? AND version = ? AND turbo_until <= ?`
      : `UPDATE users SET energy = ?, last_seen = ?, version = version + 1
           WHERE id = ? AND version = ? AND energy < ?`;
    const args = isTurbo
      ? [turboUntil, now, userId, version, now]
      : [energy, now, userId, version, energyLimit];
    const result = await prep(sql).bind(...args).run();
    return changesOf(result);
  }

  async function claimDaily({ userId, version, reward, streak, now, cooldownMs, day }) {
    const result = await prep(`
      UPDATE users
         SET coins = coins + ?,
             total_earned = total_earned + ?,
             earned_today = CASE WHEN day_key = ? THEN earned_today + ? ELSE ? END,
             day_key = ?,
             daily_streak = ?,
             daily_last = ?,
             last_seen = ?,
             version = version + 1
       WHERE id = ? AND version = ? AND (? - daily_last) >= ?
    `).bind(
      reward, reward, day, reward, reward, day,
      streak, now, now, userId, version, now, cooldownMs
    ).run();
    return changesOf(result);
  }

  // Обновление после начисления офлайн-дохода (монеты/энергия пересчитаны в JS).
  // Здесь же происходит «переворот» счётчиков при смене суток: settle вызывается
  // первым делом в каждом запросе, поэтому к первому действию нового дня счётчики
  // уже чистые. earnedDelta попадает в дневной счётчик задания «заработай монеты».
  async function touch({ userId, version, coins, energy, totalEarned, earnedDelta = 0, day, now }) {
    const result = await prep(`
      UPDATE users
         SET coins = ?,
             energy = ?,
             total_earned = ?,
             taps_today = CASE WHEN day_key = ? THEN taps_today ELSE 0 END,
             buys_today = CASE WHEN day_key = ? THEN buys_today ELSE 0 END,
             earned_today = CASE WHEN day_key = ? THEN earned_today + ? ELSE ? END,
             day_key = ?,
             last_seen = ?,
             version = version + 1
       WHERE id = ? AND version = ?
    `).bind(
      coins, energy, totalEarned,
      day, day,
      day, earnedDelta, earnedDelta,
      day, now,
      userId, version
    ).run();
    return changesOf(result);
  }

  async function boostUsed(userId, boostId, day) {
    const row = await prep('SELECT used FROM boost_uses WHERE user_id = ? AND boost_id = ? AND day = ?')
      .bind(userId, boostId, day).first();
    return row ? row.used : 0;
  }

  // --- задания, достижения и косметика ---
  // Прогресс заданий считается по счётчикам дня, поэтому здесь только отметки:
  // одна строка на забранную награду, одна — на полученное достижение.

  async function questsOfDay(userId, day) {
    const rows = await prep('SELECT quest_id FROM user_quests WHERE user_id = ? AND day = ?')
      .bind(userId, day).all();
    return (rows.results || []).map((row) => row.quest_id);
  }

  async function claimQuest(userId, questId, day, now) {
    const result = await prep(`
      INSERT OR IGNORE INTO user_quests (user_id, quest_id, day, claimed_at) VALUES (?, ?, ?, ?)
    `).bind(userId, questId, day, now).run();
    return changesOf(result) > 0;
  }

  async function achievementsOf(userId) {
    const rows = await prep(
      'SELECT achievement_id, at FROM user_achievements WHERE user_id = ? ORDER BY at ASC'
    ).bind(userId).all();
    return rows.results || [];
  }

  async function addAchievement(userId, achievementId, now) {
    const result = await prep(`
      INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, at) VALUES (?, ?, ?)
    `).bind(userId, achievementId, now).run();
    return changesOf(result) > 0;
  }

  async function cosmeticsOf(userId) {
    const rows = await prep('SELECT item_id, source, at FROM user_cosmetics WHERE user_id = ?')
      .bind(userId).all();
    return rows.results || [];
  }

  async function addCosmetic(userId, itemId, source, now) {
    const result = await prep(`
      INSERT OR IGNORE INTO user_cosmetics (user_id, item_id, source, at) VALUES (?, ?, ?, ?)
    `).bind(userId, itemId, source, now).run();
    return changesOf(result) > 0;
  }

  // Друзья, пришедшие сегодня (задание «Пригласи друга»). Считаем по времени
  // привязки, а не создания игрока: приглашение может прийти и позже.
  async function referralsToday(userId, since) {
    const row = await prep('SELECT COUNT(*) AS n FROM users WHERE referrer_id = ? AND referred_at >= ?')
      .bind(userId, since).first();
    return row ? row.n : 0;
  }

  // Бусты за день: счётчик уже ведёт таблица boost_uses — отдельная колонка не нужна.
  async function boostsUsedToday(userId, day) {
    const row = await prep('SELECT COALESCE(SUM(used), 0) AS n FROM boost_uses WHERE user_id = ? AND day = ?')
      .bind(userId, day).first();
    return row ? row.n : 0;
  }

  // Сколько карточек куплено: нужно достижениям и профилю игрока.
  async function cardsCount(userId) {
    const row = await prep('SELECT COUNT(*) AS n FROM user_cards WHERE user_id = ?')
      .bind(userId).first();
    return row ? row.n : 0;
  }

  // Начисление награды (задание/достижение) атомарным инкрементом: параллельный
  // тап не потеряет свои монеты, потому что здесь нет абсолютных значений.
  async function addCoins({ userId, coins, day, now }) {
    await prep(`
      UPDATE users
         SET coins = coins + ?,
             total_earned = total_earned + ?,
             earned_today = CASE WHEN day_key = ? THEN earned_today + ? ELSE ? END,
             day_key = ?,
             last_seen = ?
       WHERE id = ?
    `).bind(coins, coins, day, coins, coins, day, now, userId).run();
    return userById(userId);
  }

  // --- покупки (звёзды и рубли) ---

  // false означает «такой идентификатор платежа уже записан»: повторный апдейт
  // Telegram (или повторный вебхук) не выдаст товар второй раз. Статус по умолчанию
  // succeeded (звёзды узнаём уже оплаченными), у рублёвого канала сначала pending.
  async function recordPayment({
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
    const result = await prep(`
      INSERT OR IGNORE INTO payments
        (user_id, item_id, stars, charge_id, provider, amount, currency, status, at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(userId, itemId, Number(stars) || 0, chargeId, provider, total, currency, status, now).run();
    return changesOf(result) > 0;
  }

  /** Платёж по внешнему идентификатору (charge_id у звёзд, id платежа у ЮKassa). */
  async function paymentByCharge(chargeId) {
    const row = await prep(`
      SELECT id, user_id, item_id, stars, charge_id, provider, amount, currency, status, refunded_at, at
        FROM payments WHERE charge_id = ?
    `).bind(chargeId).first();
    return row || null;
  }

  async function paymentById(id, userId) {
    const row = await prep(`
      SELECT id, user_id, item_id, stars, charge_id, provider, amount, currency, status, refunded_at, at
        FROM payments WHERE id = ? AND user_id = ?
    `).bind(id, userId).first();
    return row || null;
  }

  /** Смена статуса с условием: pending -> succeeded выполняет ровно один запрос. */
  async function markPaymentStatus(chargeId, from, to) {
    const result = await prep('UPDATE payments SET status = ? WHERE charge_id = ? AND status = ?')
      .bind(to, chargeId, from).run();
    return changesOf(result) > 0;
  }

  async function markPaymentRefunded(chargeId, now) {
    const result = await prep("UPDATE payments SET status = 'refunded', refunded_at = ? WHERE charge_id = ?")
      .bind(now, chargeId).run();
    return changesOf(result) > 0;
  }

  async function paymentsOf(userId, limit = 20) {
    const rows = await prep(`
      SELECT id, item_id, stars, charge_id, provider, amount, currency, status, refunded_at, at
        FROM payments WHERE user_id = ? ORDER BY at DESC LIMIT ?
    `).bind(userId, limit).all();
    return (rows.results || []).map((row) => ({
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

  async function paymentsSummary() {
    const row = await prep(`
      SELECT COUNT(*) AS n, COALESCE(SUM(stars), 0) AS stars,
             COALESCE(SUM(CASE WHEN currency = 'RUB' THEN amount ELSE 0 END), 0) AS kopecks
        FROM payments WHERE status <> 'canceled'
    `).first();
    return {
      count: row ? row.n : 0,
      stars: row ? row.stars : 0,
      rubles: row ? Math.round((row.kopecks || 0) / 100) : 0
    };
  }

  async function paymentsCount(userId) {
    const row = await prep('SELECT COUNT(*) AS n FROM payments WHERE user_id = ?').bind(userId).first();
    return row ? row.n : 0;
  }

  // --- реклама за энергию (Monetag и Chanify) ---
  // token уникален: INSERT OR IGNORE не даст записать один показ дважды, а
  // adCredit переводит выдачу pending -> credited ровно один раз.
  async function adLog({ token, userId, kind, status, provider = null, impressionId = null, now }) {
    await prep(`
      INSERT OR IGNORE INTO ad_rewards (token, user_id, kind, status, impression_id, provider, at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(token, userId, kind, status, impressionId, provider, now).run();
  }

  async function adCredit({ token, userId, energy, now }) {
    const result = await prep(`
      UPDATE ad_rewards SET status = 'credited', energy = ?, credited_at = ?
       WHERE token = ? AND user_id = ? AND status = 'pending'
    `).bind(energy, now, token, userId).run();
    return changesOf(result) > 0;
  }

  async function adGet(token, userId) {
    const row = await prep('SELECT status, provider, at, credited_at FROM ad_rewards WHERE token = ? AND user_id = ?')
      .bind(token, userId).first();
    return row || null;
  }

  /** Выдача по токену без привязки к игроку: так постбек сети находит сессию показа. */
  async function adByToken(token) {
    const row = await prep(`
      SELECT token, user_id, kind, status, provider, external_id, at, credited_at,
             postback_at, postback_value, client_done_at
        FROM ad_rewards WHERE token = ?
    `).bind(token).first();
    return row || null;
  }

  /** Отметка о постбеке сети: подтверждение показа и идентификатор на её стороне. */
  async function adMarkPostback({ token, value = null, externalId = null, now }) {
    await prep(`
      UPDATE ad_rewards SET postback_at = ?, postback_value = ?, external_id = COALESCE(?, external_id)
       WHERE token = ?
    `).bind(now, value, externalId, token).run();
  }

  /** Первое подтверждение клиента «ролик досмотрен»: начало окна ожидания постбека. */
  async function adMarkClientDone(token, now) {
    await prep('UPDATE ad_rewards SET client_done_at = ? WHERE token = ? AND client_done_at = 0')
      .bind(now, token).run();
  }

  /** Незакрытая выдача клиентского показа (Monetag): переиспользуем её. */
  async function adPendingFor(userId, kind, provider) {
    const row = await prep(`
      SELECT token, at FROM ad_rewards
       WHERE user_id = ? AND kind = ? AND provider = ? AND status = 'pending'
       ORDER BY at DESC LIMIT 1
    `).bind(userId, kind, provider).first();
    return row || null;
  }

  /** Последняя выдача игрока — от неё считается пауза между восстановлениями. */
  async function adLastAttempt(userId, kind) {
    const row = await prep(`
      SELECT provider, status, at, credited_at FROM ad_rewards
       WHERE user_id = ? AND kind = ?
       ORDER BY MAX(at, credited_at) DESC LIMIT 1
    `).bind(userId, kind).first();
    return row || null;
  }

  /**
   * Полное удаление профиля игрока: все записи и сессии убираем одним
   * db.batch (это транзакция D1), поэтому строк-сирот не останется. Платежи за
   * звёзды по умолчанию сохраняем — по ним оформляются возвраты (/paysupport).
   */
  async function deleteUser(userId, { tgId, keepPayments = true } = {}) {
    const statements = [
      prep('DELETE FROM user_cards WHERE user_id = ?').bind(userId),
      prep('DELETE FROM user_quests WHERE user_id = ?').bind(userId),
      prep('DELETE FROM user_achievements WHERE user_id = ?').bind(userId),
      prep('DELETE FROM user_cosmetics WHERE user_id = ?').bind(userId),
      prep('DELETE FROM boost_uses WHERE user_id = ?').bind(userId),
      prep('DELETE FROM sessions WHERE user_id = ?').bind(userId),
      prep('DELETE FROM push_log WHERE user_id = ?').bind(userId),
      // Историю показов рекламы тоже убираем: она привязана к игроку, а постбек сети
      // по удалённому профилю всё равно не найдёт, кому начислять (вернёт no_user).
      prep('DELETE FROM ad_rewards WHERE user_id = ?').bind(userId)
    ];
    if (tgId) statements.push(prep('DELETE FROM pending_refs WHERE tg_id = ?').bind(tgId));
    if (!keepPayments) statements.push(prep('DELETE FROM payments WHERE user_id = ?').bind(userId));
    // Строку игрока удаляем последней — по ней считаются остальные выборки.
    statements.push(prep('DELETE FROM users WHERE id = ?').bind(userId));
    await db.batch(statements);
  }

  // Продлеваем премиум-буст: если он ещё активен — время добавляется сверху,
  // поэтому повторная покупка не «сгорает».
  async function extendTapBoost({ userId, ms, now }) {
    await prep(`
      UPDATE users SET tap_boost_until = MAX(tap_boost_until, ?) + ?, last_seen = ? WHERE id = ?
    `).bind(now, ms, now, userId).run();
    return userById(userId);
  }

  // --- напоминания (запускаются по расписанию воркера) ---
  // Первичный ключ push_log не даёт отправить одно напоминание дважды в день.

  async function claimPushSlot(userId, kind, day, now) {
    const result = await prep(`
      INSERT OR IGNORE INTO push_log (user_id, kind, day, at) VALUES (?, ?, ?, ?)
    `).bind(userId, kind, day, now).run();
    return changesOf(result) > 0;
  }

  // Энергия восстановилась: игрок не тапал дольше idleBefore, но заходил раньше.
  async function notifyEnergyCandidates({ idleBefore, limit }) {
    const rows = await prep(`
      SELECT id, tg_id, first_name, energy, energy_limit
      FROM users
      WHERE notify_energy = 1 AND daily_last > 0 AND energy >= energy_limit AND last_tap_at <= ?
      ORDER BY last_tap_at ASC
      LIMIT ?
    `).bind(idleBefore, limit).all();
    return rows.results || [];
  }

  // Бонус дня готов: кулдаун прошёл.
  async function notifyDailyCandidates({ readyBefore, limit }) {
    const rows = await prep(`
      SELECT id, tg_id, first_name, daily_streak
      FROM users
      WHERE notify_daily = 1 AND daily_last > 0 AND daily_last <= ?
      ORDER BY daily_last ASC
      LIMIT ?
    `).bind(readyBefore, limit).all();
    return rows.results || [];
  }

  // Кого обошли: берём топ рейтинга — им сообщаем, сколько не хватает до соседа.
  async function notifyRankCandidates(limit) {
    const rows = await prep(`
      SELECT id, tg_id, first_name, coins
      FROM users
      WHERE notify_rank = 1
      ORDER BY coins DESC, id ASC
      LIMIT ?
    `).bind(limit).all();
    return rows.results || [];
  }

  // --- сессии ---

  async function createSession(token, userId, now, ttlMs) {
    await db.batch([
      prep('DELETE FROM sessions WHERE expires_at < ?').bind(now),
      prep('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .bind(token, userId, now, now + ttlMs)
    ]);
    return token;
  }

  async function sessionUser(token, now) {
    const row = await prep('SELECT user_id, expires_at FROM sessions WHERE token = ?').bind(token).first();
    if (!row || row.expires_at < now) return null;
    return userById(row.user_id);
  }

  // --- выборки для витрин ---

  async function referrals(userId) {
    const rows = await prep(`
      SELECT id, tg_id, username, first_name, coins, profit_per_hour, total_earned,
             referral_taps, referral_paid
      FROM users WHERE referrer_id = ? ORDER BY coins DESC, id ASC LIMIT 50
    `).bind(userId).all();
    return (rows.results || []).map((row) => ({
      id: row.id,
      name: row.first_name || row.username || `Игрок ${row.tg_id}`,
      username: row.username,
      coins: row.coins,
      profitPerHour: row.profit_per_hour,
      totalEarned: row.total_earned,
      // Прогресс друга: сколько тапов он сделал и получена ли награда.
      taps: row.referral_taps || 0,
      paid: !!row.referral_paid
    }));
  }

  async function referralCount(userId) {
    const row = await prep('SELECT COUNT(*) AS n FROM users WHERE referrer_id = ?').bind(userId).first();
    return row ? row.n : 0;
  }

  // Бонус пригласившему: атомарный инкремент, чтобы параллельный тап не затёр монеты.
  async function addReferralBonus(userId, bonus, now) {
    await prep(`
      UPDATE users SET coins = coins + ?, total_earned = total_earned + ?, last_seen = ? WHERE id = ?
    `).bind(bonus, bonus, now, userId).run();
    return userById(userId);
  }

  /**
   * Выплата награды пригласившему ровно один раз. Сначала условно ставим флаг
   * referral_paid — его сменит только один запрос, поэтому награду начислит
   * именно он; параллельные пачки тапов вернут null.
   */
  async function claimReferralPayout(userId, { target, bonus, now }) {
    const result = await prep(`
      UPDATE users SET referral_paid = 1, last_seen = ?
       WHERE id = ? AND referral_paid = 0 AND referral_taps >= ?
    `).bind(now, userId, target).run();
    if (changesOf(result) === 0) return null;
    const row = await prep(`
      SELECT u.tg_id AS invited_tg_id, u.first_name AS invited_name,
             r.id AS referrer_id, r.tg_id AS referrer_tg_id, r.first_name AS referrer_name
      FROM users u LEFT JOIN users r ON r.id = u.referrer_id WHERE u.id = ?
    `).bind(userId).first();
    if (!row || !row.referrer_id) return null;
    await addReferralBonus(row.referrer_id, bonus, now);
    return {
      referrerTgId: row.referrer_tg_id,
      referrerName: row.referrer_name,
      invitedTgId: row.invited_tg_id,
      invitedName: row.invited_name,
      bonus,
      taps: target
    };
  }

  async function leaderboard(limit = 20) {
    const rows = await prep(`
      SELECT id, tg_id, username, first_name, coins, badge, hamster_skin,
             (SELECT COUNT(*) FROM user_achievements WHERE user_id = users.id) AS ach
      FROM users ORDER BY coins DESC, id ASC LIMIT ?
    `).bind(limit).all();
    return (rows.results || []).map((row, index) => ({
      rank: index + 1,
      id: row.id,
      tgId: row.tg_id,
      name: row.first_name || row.username || `Игрок ${row.tg_id}`,
      username: row.username,
      coins: row.coins,
      badge: row.badge,
      skin: row.hamster_skin,
      ach: row.ach || 0
    }));
  }

  // Снимок рейтинга: один проход по таблице, из него же берём место игрока и топ-20.
  // Сортировка — по текущему балансу монет (ничьи разрешаются по id: кто раньше в игре).
  // Индекс по coins намеренно не создаём: монеты меняются на каждой пачке тапов, и
  // индекс удвоил бы расход записей D1, а сам снимок считается раз в 2 минуты (см. api.js).
  async function rankSnapshot() {
    const rows = await prep(`
      SELECT id, tg_id, username, first_name, coins, badge, hamster_skin,
             (SELECT COUNT(*) FROM user_achievements WHERE user_id = users.id) AS ach
      FROM users ORDER BY coins DESC, id ASC
    `).all();
    const list = rows.results || [];
    const ranks = new Map();
    list.forEach((row, index) => ranks.set(row.id, index + 1));
    const top = list.slice(0, 20).map((row, index) => ({
      rank: index + 1,
      id: row.id,
      tgId: row.tg_id,
      name: row.first_name || row.username || `Игрок ${row.tg_id}`,
      username: row.username,
      coins: row.coins,
      badge: row.badge,
      skin: row.hamster_skin,
      ach: row.ach || 0
    }));
    return { players: list.length, ranks, top };
  }

  async function setPendingRef(tgId, referrerTgId, now) {
    await prep(`
      INSERT INTO pending_refs (tg_id, referrer_tg_id, created_at) VALUES (?, ?, ?)
      ON CONFLICT (tg_id) DO UPDATE SET referrer_tg_id = excluded.referrer_tg_id,
                                        created_at = excluded.created_at
    `).bind(tgId, referrerTgId, now).run();
  }

  async function takePendingRef(tgId) {
    const row = await prep('SELECT referrer_tg_id FROM pending_refs WHERE tg_id = ?').bind(tgId).first();
    if (!row) return null;
    await prep('DELETE FROM pending_refs WHERE tg_id = ?').bind(tgId).run();
    return row.referrer_tg_id;
  }

  return {
    userByTgId,
    userById,
    createUser,
    updateUser,
    cardLevels,
    applyTap,
    beginCardPurchase,
    finishCardPurchase,
    buyUpgrade,
    claimBoostSlot,
    applyBoost,
    claimDaily,
    touch,
    boostUsed,
    createSession,
    sessionUser,
    referrals,
    referralCount,
    addReferralBonus,
    claimReferralPayout,
    leaderboard,
    rankSnapshot,
    setPendingRef,
    takePendingRef,
    questsOfDay,
    claimQuest,
    achievementsOf,
    addAchievement,
    cosmeticsOf,
    addCosmetic,
    referralsToday,
    boostsUsedToday,
    cardsCount,
    addCoins,
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
    claimPushSlot,
    notifyEnergyCandidates,
    notifyDailyCandidates,
    notifyRankCandidates
  };
}
