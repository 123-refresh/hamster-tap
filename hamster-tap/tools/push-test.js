#!/usr/bin/env node
'use strict';
// Проверка напоминаний «по-настоящему»: отправляет такое же сообщение, какое
// рассылает воркер по расписанию, — с кнопкой отписки. По нему видно, что доставка
// работает и что кнопка «выключить напоминания» приходит в бота.
//
//   node tools/push-test.js                 # кому: ADMIN_CHAT_ID из .env
//   node tools/push-test.js 123456789       # конкретный chat_id
//   node tools/push-test.js 123456789 daily # вид напоминания: energy | daily | rank
//
// Настоящая рассылка идёт сама: [triggers] в wrangler.toml (раз в 20 минут),
// уникальность сообщений обеспечивает таблица push_log (не чаще раза в сутки).
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
const env = {};
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i > 0) env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
}

const KINDS = {
  energy: {
    title: (name) => `⚡ <b>${name}</b>, энергия восстановилась!`,
    text: '🔋 1 000 из 1 000 — самое время потапать.',
    kind: 'energy'
  },
  daily: {
    title: (name) => `🎁 <b>${name}</b>, бонус дня снова готов!`,
    text: 'День 1 из 10 · награда: 🪙 500',
    kind: 'daily'
  },
  rank: {
    title: (name) => `🏆 <b>${name}</b>, ты на 5-м месте в топе!`,
    text: 'До 4-го места не хватает 🪙 12,3 тыс. монет.',
    kind: 'rank'
  }
};

async function call(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  return res.json().catch(() => ({}));
}

(async () => {
  if (!env.BOT_TOKEN) {
    console.error('[!] BOT_TOKEN не задан в .env');
    process.exit(1);
  }

  const chatId = process.argv[2] || env.ADMIN_CHAT_ID || '';
  const kindKey = (process.argv[3] || 'energy').toLowerCase();
  const kind = KINDS[kindKey];
  if (!chatId) {
    console.error('[!] Не задан chat_id. Укажите аргументом или добавьте ADMIN_CHAT_ID в .env.');
    process.exit(1);
  }
  if (!kind) {
    console.error(`[!] Неизвестный вид напоминания «${kindKey}». Доступны: ${Object.keys(KINDS).join(', ')}`);
    process.exit(1);
  }

  const name = process.argv[4] || 'Хомяк';
  const rows = [];
  if (env.WEBAPP_URL) rows.push([{ text: '🐹 Открыть игру', web_app: { url: env.WEBAPP_URL } }]);
  rows.push([{ text: '🔕 Выключить напоминания', callback_data: `push_off_${kind.kind}` }]);

  const result = await call('sendMessage', {
    chat_id: chatId,
    text: [kind.title(name), kind.text].join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: rows }
  });

  if (result.ok) {
    console.log(`  ok  напоминание «${kindKey}» отправлено в чат ${chatId}`);
    console.log('      нажмите в Telegram «🔕 Выключить напоминания» — бот ответит подтверждением');
  } else {
    console.log(`  XX  не отправлено: ${result.description || 'нет ответа'}`);
    process.exit(1);
  }
})();
