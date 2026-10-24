#!/usr/bin/env node
'use strict';
// Состояние бота: токен, webhook, команды, кнопка меню. Только чтение — ничего не меняет.
//
//   node tools/bot-state.js
//
// Полезно, чтобы понять, куда сейчас ведёт кнопка «🐹 Играть» и установлен ли webhook.
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

const out = [];
const api = (method) => `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;

async function call(method) {
  try {
    const res = await fetch(api(method));
    const json = await res.json();
    return { ok: json.ok, result: json.result, description: json.description };
  } catch (e) {
    return { ok: false, description: String(e) };
  }
}

(async () => {
  if (!env.BOT_TOKEN) {
    console.error('[!] BOT_TOKEN не задан в .env');
    process.exit(1);
  }

  const me = await call('getMe');
  if (me.ok) {
    out.push(`бот:        @${me.result.username} (id ${me.result.id})`);
  } else {
    out.push(`бот:        токен не принят — ${me.description} (проверьте VPN)`);
  }

  const hook = await call('getWebhookInfo');
  if (hook.ok) {
    const info = hook.result || {};
    out.push(`webhook:    ${info.url || '(не задан)'}`);
    out.push(`  ожидает:  ${info.pending_update_count || 0} апдейтов`);
    if (info.last_error_message) out.push(`  ошибка:   ${info.last_error_message}`);
  } else {
    out.push(`webhook:    ${hook.description}`);
  }

  const menu = await call('getChatMenuButton');
  if (menu.ok) {
    const button = menu.result || {};
    const url = button.web_app ? button.web_app.url : '(не web_app)';
    out.push(`меню:       «${button.text || '—'}» → ${url}`);
  } else {
    out.push(`меню:       ${menu.description}`);
  }

  const cmds = await call('getMyCommands');
  out.push(`команды:    ${cmds.ok ? cmds.result.map((c) => '/' + c.command).join(' ') : cmds.description}`);

  console.log(out.join('\n'));
})();
