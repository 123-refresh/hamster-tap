#!/usr/bin/env node
'use strict';

/**
 * Проверяет, есть ли у аккаунта Cloudflare workers.dev-поддомен, и создаёт его,
 * если нет. Нужен потому, что wrangler в неинтерактивном режиме на вопрос
 * «Would you like to register a workers.dev subdomain now?» отвечает «no»
 * и деплой падает, пока поддомен не зарегистрирован.
 *
 * В обычном режиме поддомен создаётся сам при первом открытии страницы
 * Workers & Pages в браузере. Здесь то же самое делается через API:
 *   GET  /accounts/{account_id}/workers/subdomain   — узнать текущий
 *   PUT  /accounts/{account_id}/workers/subdomain   — создать {"subdomain": "..."}
 * (POST для OAuth-аутентификации не поддерживается: 405 / code 10405.)
 *
 * Запуск:
 *   node tools/ensure-subdomain.js                      # проверить/создать
 *   node tools/ensure-subdomain.js --name myname        # предпочитаемое имя
 *   node tools/ensure-subdomain.js --check              # только проверить, не создавать
 *
 * Токен берётся из локального конфига wrangler (OAuth). Перед чтением токена
 * вызывается `wrangler whoami` — он обновляет истёкший токен.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WRANGLER_BIN = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const WRANGLER_CONFIG = path.join(os.homedir(), 'AppData', 'Roaming', 'xdg.config', '.wrangler', 'config', 'default.toml');

function ok(text) { console.log('  ok  ' + text); }
function warn(text) { console.log('  !!  ' + text); }
function fail(text, hint) {
  console.log('  XX  ' + text);
  if (hint) console.log('      ' + hint);
  process.exit(1);
}

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

/** Имя воркера из wrangler.toml — из него собирается публичный адрес. */
function workerName() {
  const file = path.join(ROOT, 'wrangler.toml');
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^\s*name\s*=\s*"([^"]+)"/m);
  return m ? m[1] : '';
}

/** Имя поддомена: только a-z, 0-9 и дефис, не длиннее 63 символов. */
function sanitize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 63);
}

(async () => {
  const argv = process.argv.slice(2);
  const nameIndex = argv.indexOf('--name');
  const checkOnly = argv.includes('--check');

  if (!fs.existsSync(WRANGLER_BIN)) fail('wrangler не установлен', 'Выполните: npm install --save-dev wrangler');
  if (!fs.existsSync(WRANGLER_CONFIG)) {
    fail('нет конфига wrangler с токеном доступа', 'Выполните в отдельном окне: npx wrangler login');
  }

  // whoami заодно обновляет истёкший OAuth-токен и даёт id аккаунта.
  const who = spawnSync(process.execPath, [WRANGLER_BIN, 'whoami', '--json'], { cwd: ROOT, encoding: 'utf8' });
  let accountId = '';
  if (who.status === 0) {
    try {
      const parsed = JSON.parse(who.stdout);
      accountId = parsed.accounts && parsed.accounts[0] ? parsed.accounts[0].id : '';
    } catch {
      accountId = '';
    }
  }
  if (!accountId) fail('не удалось определить аккаунт Cloudflare', 'Выполните: npx wrangler login');

  const token = (fs.readFileSync(WRANGLER_CONFIG, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/) || [])[1];
  if (!token) fail('в конфиге wrangler нет токена доступа', 'Выполните: npx wrangler login');

  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`;

  async function api(method, body) {
    const res = await fetch(base, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = {};
    try {
      json = await res.json();
    } catch {
      json = {};
    }
    return { status: res.status, json };
  }

  const current = await api('GET');
  let subdomain = current.json && current.json.result ? current.json.result.subdomain : '';

  if (!subdomain && (current.status === 401 || current.status === 403)) {
    fail('Cloudflare отклонил токен', 'Выполните: npx wrangler login, затем запустите скрипт снова.');
  }

  if (!subdomain && !checkOnly) {
    const env = readEnv();
    const candidates = [
      sanitize(nameIndex >= 0 ? argv[nameIndex + 1] : ''),
      sanitize(env.BOT_USERNAME),
      sanitize(env.BOT_USERNAME) + 'bot',
      'hamster-tap-' + crypto.randomBytes(3).toString('hex'),
    ].filter(Boolean);

    for (const candidate of [...new Set(candidates)]) {
      const created = await api('PUT', { subdomain: candidate });
      if (created.status === 200 && created.json.result && created.json.result.subdomain) {
        subdomain = created.json.result.subdomain;
        ok(`workers.dev-поддомен создан: ${subdomain}`);
        break;
      }
      warn(`имя ${candidate} не подошло (${created.status}${created.json.errors ? ': ' + created.json.errors.map((e) => e.code + ' ' + e.message).join('; ') : ''})`);
    }
  }

  if (!subdomain) {
    const hint = current.json.errors ? current.json.errors.map((e) => e.message).join(' ') : '';
    fail('у аккаунта нет workers.dev-поддомена', hint || 'Создайте его в браузере: https://dash.cloudflare.com/?to=/:account/workers/workers-and-pages');
  }

  const worker = workerName();
  ok(`поддомен: ${subdomain}`);
  if (worker) ok(`адрес воркера: https://${worker}.${subdomain}.workers.dev`);
})();
