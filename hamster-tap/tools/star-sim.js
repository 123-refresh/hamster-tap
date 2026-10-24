#!/usr/bin/env node
'use strict';

/**
 * Проверка пути оплаты звёздами БЕЗ реальных денег: входим тестовым игроком,
 * отправляем в webhook синтетические pre_checkout_query и successful_payment и
 * убеждаемся, что товар выдан ровно один раз, а чек попал в журнал покупок.
 *
 *   node tools/star-sim.js                                  # боевой воркер (initData из .env)
 *   node tools/star-sim.js http://127.0.0.1:8787 --local     # локальный `wrangler dev` (dev-вход)
 *   node tools/star-sim.js --secret <SECRET>                 # если секрет не в файле
 *
 * Секрет берётся из `.webhook-secret` (прод) или из `.dev.vars` (локально).
 * Тестовый игрок (id 777000555) и его платежи удаляются из базы в конце запуска.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEFAULT_BASE = 'https://hamster-tap.hamstercombat1.workers.dev';
const URL_ARG = process.argv.slice(2).find((arg) => /^https?:\/\//.test(arg));
const BASE = (URL_ARG || DEFAULT_BASE).replace(/\/+$/, '');
const LOCAL = process.argv.includes('--local') || /127\.0\.0\.1|localhost/.test(BASE);
const WRANGLER_BIN = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const DB_NAME = 'hamster-tap';
const TEST_TG_ID = 777000555;
const ITEM = 'coins_5k';
const STARS = 25;

let passed = 0;
const failures = [];

function check(name, condition, details = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}${details ? ` — ${details}` : ''}`);
  } else {
    failures.push(`${name}${details ? ` — ${details}` : ''}`);
    console.log(`  FAIL ${name}${details ? ` — ${details}` : ''}`);
  }
}

function readEnvFile(file) {
  const map = {};
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) map[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return map;
}

function webhookSecret() {
  const argIndex = process.argv.indexOf('--secret');
  if (argIndex > 0 && process.argv[argIndex + 1]) return process.argv[argIndex + 1];
  const file = path.join(ROOT, '.webhook-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return readEnvFile(path.join(ROOT, '.dev.vars')).BOT_WEBHOOK_SECRET || '';
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
  const match = String(res.stdout || '').match(/\[[\s\S]*\]/);
  let rows = [];
  if (match) {
    try {
      rows = JSON.parse(match[0])[0].results || [];
    } catch {
      rows = [];
    }
  }
  return { status: res.status, rows };
}

/** initData с настоящей подписью — как её вычислил бы Telegram. */
function signInitData(botToken, user) {
  const params = {
    user: JSON.stringify(user),
    auth_date: String(Math.floor(Date.now() / 1000)),
    query_id: 'AA' + crypto.randomBytes(8).toString('hex')
  };
  const dataCheckString = Object.keys(params).sort().map((key) => `${key}=${params[key]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

async function api(p, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Auth'] = token;
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


(async () => {
  const env = readEnvFile(path.join(ROOT, '.env'));
  const secret = webhookSecret();
  console.log(`Hamster Tap — синтетическая проверка оплаты: ${BASE}`);
  if (!secret) {
    console.error('[!] не найден секрет webhook (.webhook-secret или BOT_WEBHOOK_SECRET в .dev.vars)');
    process.exit(1);
  }

  // Вход: на проде — подписанный initData, локально — dev-игрок (ALLOW_DEV=1).
  const auth = LOCAL
    ? await api('/api/auth', { method: 'POST', body: { devId: TEST_TG_ID, devName: 'Оплата-тест' } })
    : await api('/api/auth', {
      method: 'POST',
      body: { initData: signInitData(env.BOT_TOKEN, { id: TEST_TG_ID, first_name: 'Оплата-тест', username: 'paytest' }) }
    });
  check('вход тестовым игроком', auth.status === 200 && !!auth.data?.token, `HTTP ${auth.status}`);
  const token = auth.data?.token;
  const userId = auth.data?.state?.user?.id;
  const coinsBefore = auth.data?.state?.user?.coins;
  if (!token || !userId) {
    console.log('\nПройдено: 0, провалено: 1');
    console.log(' - дальше идти некуда: нет токена или игрока');
    process.exit(1);
  }

  const sendUpdate = async (update) => {
    const res = await fetch(`${BASE}/webhook/${secret}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify(update)
    });
    return res.status;
  };

  // 1. Подтверждение заказа: бот обязан ответить Telegram и не упасть.
  const preStatus = await sendUpdate({
    update_id: 990001,
    pre_checkout_query: {
      id: 'sim_pre_checkout',
      from: { id: TEST_TG_ID, first_name: 'Оплата-тест', is_bot: false },
      currency: 'XTR',
      total_amount: STARS,
      invoice_payload: `${userId}:${ITEM}`,
      chat_type: 'private'
    }
  });
  check('webhook принимает pre_checkout_query', preStatus === 200, `HTTP ${preStatus}`);

  // 2. Оплата прошла: товар зачисляется, чек попадает в журнал покупок.
  const chargeId = `sim_charge_${Date.now()}`;
  const paymentUpdate = {
    update_id: 990002,
    message: {
      message_id: 1,
      from: { id: TEST_TG_ID, first_name: 'Оплата-тест', is_bot: false },
      chat: { id: TEST_TG_ID, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      successful_payment: {
        currency: 'XTR',
        total_amount: STARS,
        invoice_payload: `${userId}:${ITEM}`,
        telegram_payment_charge_id: chargeId,
        provider_payment_charge_id: `sim_provider_${Date.now()}`
      }
    }
  };
  const payStatus = await sendUpdate(paymentUpdate);
  check('webhook принимает successful_payment', payStatus === 200, `HTTP ${payStatus}`);

  await sleep(1500);
  const after = await api('/api/state', { token });
  const coinsAfter = after.data?.user?.coins;
  check(
    'монеты зачислены за покупку',
    typeof coinsAfter === 'number' && coinsAfter === coinsBefore + 5000,
    `${coinsBefore} -> ${coinsAfter}`
  );

  const shop = await api('/api/shop', { token });
  const purchase = (shop.data?.purchases || []).find((row) => row.chargeId === chargeId);
  check('покупка видна в истории с чеком', !!purchase && purchase.stars === STARS, JSON.stringify(purchase));

  // 3. Повторный апдейт с тем же чеком не должен выдать товар второй раз.
  await sendUpdate({ ...paymentUpdate, update_id: 990003 });
  await sleep(1500);
  const again = await api('/api/state', { token });
  check(
    'повторный апдейт не дублирует товар',
    typeof again.data?.user?.coins === 'number' && again.data?.user?.coins === coinsAfter,
    `монет ${again.data?.user?.coins}`
  );

  const rows = d1(`SELECT COUNT(*) AS n FROM payments WHERE charge_id = '${chargeId}'`);
  check('в базе ровно один платёж по чеку', Number(rows.rows?.[0]?.n) === 1, `строк ${rows.rows?.[0]?.n}`);

  // 4. Уборка тестовых данных: профиль удаляем тем же способом, что доступен
  // игроку в интерфейсе, а строку тестового платежа убираем отдельно — в проде
  // платежи сохраняются (по ним оформляются возвраты).
  console.log('\n  ..  уборка тестового игрока и платежей');
  const meState = await api('/api/state', { token });
  const testUserId = Number(meState.data?.user?.id) || 0;
  const removed = await api('/api/profile/delete', { method: 'POST', token });
  check(
    'удаление профиля -> 200',
    removed.status === 200 && removed.data?.deleted === true,
    `HTTP ${removed.status}`
  );
  for (const sql of [
    `DELETE FROM payments WHERE user_id = ${testUserId}`,
    `DELETE FROM pending_refs WHERE tg_id = ${TEST_TG_ID}`
  ]) {
    const done = d1(sql);
    if (done.status !== 0) check('уборка строки', false, sql.slice(0, 40));
  }
  const left = d1(`SELECT COUNT(*) AS n FROM users WHERE tg_id = ${TEST_TG_ID}`);
  check('тестовый игрок удалён из базы', Number(left.rows?.[0]?.n) === 0);

  console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
  if (failures.length) {
    for (const failure of failures) console.log(` - ${failure}`);
    process.exit(1);
  }
  console.log('Путь оплаты работает: подтверждение, выдача, журнал покупок и защита от повторов.');
})();
