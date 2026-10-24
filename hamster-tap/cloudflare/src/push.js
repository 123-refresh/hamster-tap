// Напоминания в боте: запускаются по расписанию воркера ([triggers] в wrangler.toml).
// Правила:
//   • не больше одного напоминания каждого вида в сутки — первичный ключ push_log
//     не даёт дубликатов, поэтому повторные запуски крона ничего не продублируют;
//   • пачки ограничены, чтобы не устраивать всплеск сообщений в Telegram;
//   • ошибка доставки (игрок заблокировал бота) не ломает остальную рассылку.
import game from '../../lib/game.js';
import { createStore } from './store.js';

const API = 'https://api.telegram.org';
const BATCH_LIMIT = 100;
// «Энергия восстановилась» пишем только тем, кто не тапал два часа — иначе это спам.
const IDLE_BEFORE_ENERGY_MS = 2 * 60 * 60 * 1000;

function fmt(value) {
  return new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

async function call(env, method, payload) {
  const res = await fetch(`${API}/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  return res.json().catch(() => ({}));
}

function playButton(env) {
  const url = (env.WEBAPP_URL || '').replace(/\/+$/, '');
  return url ? { text: '🐹 Открыть игру', web_app: { url } } : null;
}

// В каждом напоминании есть кнопка отписки: обработчик живёт в bot.js.
function keyboardWithToggle(env, kind) {
  const rows = [];
  const play = playButton(env);
  if (play) rows.push([play]);
  rows.push([{ text: '🔕 Выключить напоминания', callback_data: `push_off_${kind}` }]);
  return { inline_keyboard: rows };
}

async function send(env, chatId, text, extra = {}) {
  return call(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra
  });
}

export async function runPush(env, now = Date.now()) {
  if (!env.BOT_TOKEN) return { sent: 0, skipped: 'нет BOT_TOKEN' };

  const store = createStore(env.DB);
  const day = game.utcDay(now);
  const stats = { energy: 0, daily: 0, rank: 0, failed: 0 };

  // 1. Энергия восстановилась.
  const energyRows = await store.notifyEnergyCandidates({
    idleBefore: now - IDLE_BEFORE_ENERGY_MS,
    limit: BATCH_LIMIT
  });
  for (const row of energyRows) {
    if (!(await store.claimPushSlot(row.id, 'energy', day, now))) continue;
    const result = await send(env, row.tg_id, [
      `⚡ <b>${row.first_name || 'Хомяк'}</b>, энергия восстановилась!`,
      `🔋 ${fmt(row.energy)} из ${fmt(row.energy_limit)} — самое время потапать.`
    ].join('\n'), { reply_markup: keyboardWithToggle(env, 'energy') });
    if (result && result.ok) stats.energy += 1;
    else stats.failed += 1;
  }

  // 2. Бонус дня готов.
  const dailyRows = await store.notifyDailyCandidates({
    readyBefore: now - game.DAILY_COOLDOWN_MS,
    limit: BATCH_LIMIT
  });
  for (const row of dailyRows) {
    if (!(await store.claimPushSlot(row.id, 'daily', day, now))) continue;
    const next = Math.min((row.daily_streak || 0) + 1, game.DAILY_REWARDS.length);
    const result = await send(env, row.tg_id, [
      `🎁 <b>${row.first_name || 'Хомяк'}</b>, бонус дня снова готов!`,
      `День ${next} из ${game.DAILY_REWARDS.length} · награда: 🪙 ${fmt(game.DAILY_REWARDS[next - 1])}`
    ].join('\n'), { reply_markup: keyboardWithToggle(env, 'daily') });
    if (result && result.ok) stats.daily += 1;
    else stats.failed += 1;
  }

  // 3. Рейтинг: сообщаем тем, кто входит в топ-20, сколько монет не хватает до соседа.
  const rankRows = await store.notifyRankCandidates(20);
  for (let index = 1; index < rankRows.length; index += 1) {
    const row = rankRows[index];
    const ahead = rankRows[index - 1];
    if (!(await store.claimPushSlot(row.id, 'rank', day, now))) continue;
    const gap = Math.max(1, ahead.coins - row.coins + 1);
    const result = await send(env, row.tg_id, [
      `🏆 <b>${row.first_name || 'Хомяк'}</b>, ты на ${index + 1}-м месте в топе!`,
      `До ${index}-го места не хватает 🪙 ${fmt(gap)} монет.`
    ].join('\n'), { reply_markup: keyboardWithToggle(env, 'rank') });
    if (result && result.ok) stats.rank += 1;
    else stats.failed += 1;
  }

  return { sent: stats.energy + stats.daily + stats.rank, ...stats };
}
