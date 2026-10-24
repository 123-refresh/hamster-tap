#!/usr/bin/env node
'use strict';

/**
 * Возвраты за покупки в звёздах: список чеков и оформление возврата через
 * Bot API (refundStarPayment). Нужен по требованиям Telegram к ботам с
 * цифровыми товарами — покупатель просит возврат, вы оформляете его этим инструментом.
 *
 *   node tools/star-refund.js --list                 # последние 10 покупок (боевая база)
 *   node tools/star-refund.js --list --local         # то же для локальной базы D1
 *   node tools/star-refund.js <charge_id>            # возврат по чеку
 *   node tools/star-refund.js <charge_id> --local    # возврат по чеку из локальной базы
 *
 * Токен берётся из .env (он же лежит в секретах воркера). Возврат в Telegram
 * необратим: звёзды уходят покупателю, а бот теряет сумму.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WRANGLER_BIN = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const DB_NAME = 'hamster-tap';
const LOCAL = process.argv.includes('--local');
const LIST = process.argv.includes('--list');
const chargeId = process.argv.find((arg) => !arg.startsWith('--') && arg !== process.argv[1]) || '';

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

/** Запрос к базе (боевой или локальной) — по одному утверждению за вызов. */
function d1(sql) {
  const env = { ...process.env };
  if (!String(env.NODE_OPTIONS || '').includes('dns-result-order')) {
    env.NODE_OPTIONS = (env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : '') + '--dns-result-order=ipv4first';
  }
  const res = spawnSync(process.execPath, [
    WRANGLER_BIN, 'd1', 'execute', DB_NAME, LOCAL ? '--local' : '--remote',
    '--json', '--command', sql, '-y'
  ], { cwd: ROOT, env, encoding: 'utf8' });
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

async function apiCall(method, payload, token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  return res.json().catch(() => ({}));
}

const escape = (value) => String(value).replace(/'/g, "''");

(async () => {
  const env = readEnv();
  if (!env.BOT_TOKEN) {
    console.error('[!] в .env нет BOT_TOKEN — возврат через Telegram невозможен');
    process.exit(1);
  }

  if (LIST) {
    const { rows, status } = d1(`
      SELECT p.item_id, p.stars, p.charge_id, p.at, u.tg_id
      FROM payments p JOIN users u ON u.id = p.user_id
      ORDER BY p.at DESC LIMIT 10
    `);
    if (status !== 0) {
      console.error('[!] не удалось прочитать базу (см. вывод выше)');
      process.exit(1);
    }
    if (!rows.length) {
      console.log('  ..  покупок пока нет');
      return;
    }
    console.log(`  ok  последние покупки (${LOCAL ? 'локальная' : 'боевая'} база):`);
    for (const row of rows) {
      const date = new Date(row.at).toLocaleString('ru-RU');
      console.log(`      ${date} · ${row.item_id} · ⭐ ${row.stars} · tg ${row.tg_id}`);
      console.log(`      чек: ${row.charge_id}`);
    }
    console.log('\n  Возврат: node tools/star-refund.js <charge_id>');
    return;
  }

  if (!chargeId) {
    console.error('[!] укажите чек: node tools/star-refund.js <charge_id> (или --list)');
    process.exit(1);
  }

  const found = d1(`
    SELECT p.charge_id, p.item_id, p.stars, u.tg_id
    FROM payments p JOIN users u ON u.id = p.user_id
    WHERE p.charge_id = '${escape(chargeId)}' LIMIT 1
  `);
  const row = found.rows && found.rows[0];
  if (!row) {
    console.error(`[!] чек ${chargeId} не найден в ${LOCAL ? 'локальной' : 'боевой'} базе`);
    process.exit(1);
  }

  console.log(`  ..  возврат: ${row.item_id} · ⭐ ${row.stars} · игрок tg ${row.tg_id}`);
  const result = await apiCall('refundStarPayment', {
    user_id: row.tg_id,
    telegram_payment_charge_id: row.charge_id
  }, env.BOT_TOKEN);

  if (result.ok) {
    console.log('  ok  возврат оформлен: звёзды вернулись покупателю');
    console.log('      строку в payments оставляем — она часть истории покупок и чеков');
  } else {
    console.error(`  XX  Telegram отказал: ${result.description || 'нет ответа'}`);
    process.exit(1);
  }
})();
