'use strict';
// Настройка бота для мини-аппа через Bot API: кнопка меню (WebApp), команды,
// проверка доступности адреса. В BotFather ходить не нужно.
//
// Запуск:
//   node tools/set-menu-button.js                     # адрес берётся из WEBAPP_URL в .env
//   node tools/set-menu-button.js https://xxx.tld     # адрес передан аргументом
//   node tools/set-menu-button.js --check             # только показать текущее состояние
//   node tools/set-menu-button.js --clear             # убрать кнопку меню
//   node tools/set-menu-button.js --force             # не проверять доступность адреса
//
// Утилита идемпотентна: её можно запускать повторно после смены адреса туннеля.
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');

const ENV_FILE = path.join(config.ROOT, '.env');
const API = 'https://api.telegram.org';
const MENU_TEXT = '🐹 Играть';

const COMMANDS = [
  { command: 'play', description: 'Открыть игру' },
  { command: 'me', description: 'Мой прогресс' },
  { command: 'top', description: 'Топ игроков' },
  { command: 'help', description: 'Что умеет бот' }
];

function die(message, hint) {
  console.error(`\n[!] ${message}`);
  if (hint) console.error(`    ${hint}`);
  process.exit(1);
}

function info(message) {
  console.log(`- ${message}`);
}

// Аккуратно обновляем одно поле в .env, не трогая комментарии и остальные строки.
function setEnvValue(key, value) {
  const line = `${key}=${value}`;
  if (!fs.existsSync(ENV_FILE)) {
    fs.writeFileSync(ENV_FILE, `${line}\n`, 'utf8');
    return;
  }
  const text = fs.readFileSync(ENV_FILE, 'utf8');
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  const next = pattern.test(text)
    ? text.replace(pattern, line)
    : `${text.replace(/\s*$/, '')}\n${line}\n`;
  fs.writeFileSync(ENV_FILE, next, 'utf8');
}

async function call(method, payload) {
  const res = await fetch(`${API}/bot${config.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  return res.json().catch(() => ({}));
}

// Проверяем, что по публичному адресу действительно отвечает наш мини-апп.
async function checkUrlReachable(url) {
  try {
    const health = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10000) });
    if (!health.ok) return { ok: false, reason: `HTTP ${health.status}` };
    const data = await health.json().catch(() => ({}));
    const page = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const html = await page.text();
    if (!html.includes('telegram-web-app')) {
      return { ok: false, reason: 'страница не похожа на мини-апп' };
    }
    return { ok: true, players: data.players };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

function parseArgs(argv) {
  const options = { url: '', check: false, clear: false, force: false };
  for (const arg of argv) {
    if (arg === '--check') options.check = true;
    else if (arg === '--clear') options.clear = true;
    else if (arg === '--force') options.force = true;
    else if (!arg.startsWith('--')) options.url = arg.replace(/\/+$/, '');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!config.BOT_TOKEN) {
    die(
      'BOT_TOKEN не задан.',
      `Впишите токен от @BotFather в ${ENV_FILE} (строка BOT_TOKEN=) и запустите снова.`
    );
  }

  // 1. Проверяем токен и узнаём юзернейм бота.
  const me = await call('getMe');
  if (!me.ok) {
    die(
      `Bot API не принял токен: ${me.description || 'нет ответа'}`,
      'Проверьте токен и доступность api.telegram.org (в РФ нужен VPN/прокси).'
    );
  }
  const username = me.result.username;
  info(`бот найден: @${username} (id ${me.result.id})`);

  if (username && !config.BOT_USERNAME) {
    setEnvValue('BOT_USERNAME', username);
    info(`BOT_USERNAME записан в .env: ${username}`);
  }

  if (options.check) {
    const menu = await call('getChatMenuButton');
    console.log('\nТекущее состояние:');
    console.log(`  кнопка меню: ${menu.ok ? JSON.stringify(menu.result) : 'нет данных'}`);
    console.log(`  ссылка:      https://t.me/${username}`);
    return;
  }

  if (options.clear) {
    // В Bot API нет метода deleteChatMenuButton: сброс делается через
    // setChatMenuButton с типом 'default' (для личных чатов это стандартная кнопка «Меню»).
    const cleared = await call('setChatMenuButton', { menu_button: { type: 'default' } });
    if (!cleared.ok) die(`Не удалось убрать кнопку: ${cleared.description || 'ошибка'}`);
    const now = await call('getChatMenuButton');
    const kind = now.ok && now.result ? now.result.type || 'default' : 'default';
    info(`кнопка меню сброшена к стандартной (тип: ${kind})`);
    return;
  }

  // 2. Определяем адрес мини-аппа и проверяем, что он живой.
  const url = (options.url || config.WEBAPP_URL).replace(/\/+$/, '');
  if (!url) {
    die(
      'Не известен публичный адрес мини-аппа (WEBAPP_URL пуст).',
      'Запустите start-telegram.ps1 — он поднимает туннель и заполняет адрес автоматически. ' +
        'Либо передайте адрес аргументом: node tools/set-menu-button.js https://xxx.trycloudflare.com'
    );
  }
  if (!url.startsWith('https://')) {
    die(`Telegram принимает только https-адреса, получено: ${url}`);
  }

  const reachable = await checkUrlReachable(url);
  if (reachable.ok) {
    info(`адрес отвечает: ${url} (игроков в базе: ${reachable.players})`);
  } else if (options.force) {
    info(`предупреждение: адрес не отвечает (${reachable.reason}), продолжаю из-за --force`);
  } else {
    die(
      `Адрес ${url} не отвечает: ${reachable.reason}`,
      'Проверьте, что запущены сервер (node server.js) и туннель, либо запустите с флагом --force.'
    );
  }

  // 3. Кнопка меню запускает мини-апп прямо из чата.
  const menu = await call('setChatMenuButton', {
    menu_button: { type: 'web_app', text: MENU_TEXT, web_app: { url } }
  });
  if (!menu.ok) die(`setChatMenuButton: ${menu.description || 'ошибка'}`);
  info(`кнопка меню «${MENU_TEXT}» установлена`);

  // 4. Команды в меню бота.
  const commands = await call('setMyCommands', { commands: COMMANDS });
  if (commands.ok) info('команды /play, /me, /top, /help установлены');
  else info(`команды не установлены: ${commands.description || 'ошибка'}`);

  // 5. Запоминаем адрес в .env, чтобы сервер и бот отдавали ссылки с ним.
  if (url !== config.WEBAPP_URL) {
    setEnvValue('WEBAPP_URL', url);
    info('WEBAPP_URL записан в .env');
  }

  const verified = await call('getChatMenuButton');
  console.log('\nГотово. Итог:');
  console.log(`  бот:      @${username}`);
  console.log(`  мини-апп: ${url}`);
  console.log(`  кнопка:   ${verified.ok ? JSON.stringify(verified.result) : 'проверьте вручную'}`);
  console.log(`  открыть:  https://t.me/${username}`);
  console.log('\nВ Telegram: /start у бота -> кнопка «🐹 Играть» слева от поля ввода.');
}

if (require.main === module) {
  main().catch((error) => die(error.message, 'Проверьте доступность api.telegram.org.'));
}

module.exports = { call, setEnvValue, checkUrlReachable, main };

