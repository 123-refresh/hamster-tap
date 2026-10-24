'use strict';
// Переключение бота на webhook и настройка мини-аппа — без ручных походов в BotFather.
//
//   node tools/set-webhook.js --url https://hamster-tap.xxx.workers.dev --secret <hex>
//   node tools/set-webhook.js --url https://hamster-tap.xxx.workers.dev --dry-run   # только показать план
//   node tools/set-webhook.js --url https://... --chat 123456789                    # без очереди апдейтов
//
// Что делает:
//   1. снимает старый webhook (и заодно pending-апдейты, чтобы старый long polling не мешал);
//   2. ставит webhook на <url>/webhook/<secret> с проверкой секретного заголовка;
//   3. устанавливает команды бота и кнопку меню «🐹 Играть» — и «по умолчанию», и адресно
//      для чатов, найденных в очереди апдейтов (см. ниже), с проверкой результата;
//   4. печатает результат getWebhookInfo.
//
// Про адресную кнопку: кнопка, заданная «по умолчанию», не всегда видна в чатах, где бот
// уже используется (Bot API отдаёт для них тип default), поэтому id чатов собираются из
// getUpdates ДО снятия webhook и кнопка ставится для каждого чата отдельно.
//
// Токен берётся из .env (BOT_TOKEN), секрет можно не указывать — тогда он сгенерируется.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../lib/config');

const API = 'https://api.telegram.org';
const SECRET_FILE = path.join(config.ROOT, '.webhook-secret');

const MENU_TEXT = '🐹 Играть';
const COMMANDS = [
  { command: 'play', description: 'Открыть игру' },
  { command: 'me', description: 'Мой прогресс' },
  { command: 'top', description: 'Топ игроков' },
  { command: 'code', description: 'Код дня для награды' },
  { command: 'push', description: 'Напоминания о прогрессе' },
  { command: 'buy', description: 'Оплата картой или СБП' },
  { command: 'paysupport', description: 'Помощь с оплатой' },
  { command: 'help', description: 'Что умеет бот' }
];

// Какие апдейты нужны боту: сообщения и кнопки, а также pre_checkout_query —
// без него Telegram не пришлёт запрос подтверждения оплаты звёздами.
const ALLOWED_UPDATES = ['message', 'callback_query', 'pre_checkout_query'];

function parseArgs(argv) {
  const options = { url: '', secret: '', chats: [], noChats: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') options.url = (argv[i + 1] || '').replace(/\/+$/, '');
    if (argv[i] === '--secret') options.secret = argv[i + 1] || '';
    if (argv[i] === '--chat') {
      options.chats = String(argv[i + 1] || '').split(',').map((v) => v.trim()).filter(Boolean);
    }
    if (argv[i] === '--no-chats') options.noChats = true;
    if (argv[i] === '--dry-run') options.dryRun = true;
  }
  return options;
}

function fail(message, hint) {
  console.error(`\n[!] ${message}`);
  if (hint) console.error(`    ${hint}`);
  process.exit(1);
}

async function call(method, payload) {
  const res = await fetch(`${API}/bot${config.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  return res.json().catch(() => ({}));
}

(async () => {
  const options = parseArgs(process.argv.slice(2));
  if (!config.BOT_TOKEN) {
    fail('BOT_TOKEN не задан в .env', 'Впишите токен от @BotFather и запустите снова.');
  }
  if (!options.url) {
    fail('нужен публичный адрес воркера', 'Пример: node tools/set-webhook.js --url https://hamster-tap.xxx.workers.dev');
  }
  if (!options.url.startsWith('https://')) {
    fail(`Telegram принимает только https, получено: ${options.url}`);
  }

  // Секрет проверяет воркер: он должен совпадать с BOT_WEBHOOK_SECRET в его окружении.
  const secret = options.secret || config.BOT_WEBHOOK_SECRET || crypto.randomBytes(24).toString('hex');

  const me = await call('getMe');
  if (!me.ok) fail(`Bot API не принял токен: ${me.description || 'нет ответа'}`, 'Проверьте VPN и токен.');
  console.log(`- бот: @${me.result.username}`);

  // Кнопка-миниапп, заданная «по умолчанию», не всегда показывается в уже
  // существующих чатах (Bot API возвращает для них тип default). Поэтому
  // собираем id чатов, пока ещё доступна очередь апдейтов, и ставим кнопку
  // адресно для каждого из них.
  const chatIds = new Set(
    (options.chats || []).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v !== 0)
  );
  if (!options.noChats) {
    const updates = await call('getUpdates', { limit: 100, allowed_updates: ALLOWED_UPDATES });
    if (updates.ok) {
      let added = 0;
      for (const item of updates.result || []) {
        const message = item.message || item.edited_message || (item.callback_query && item.callback_query.message);
        if (message && message.chat && (message.chat.type === 'private' || !message.chat.type)) {
          if (!chatIds.has(message.chat.id)) added += 1;
          chatIds.add(message.chat.id);
        }
      }
      if (added) console.log(`- найдено чатов для адресной кнопки: ${added}`);
    } else {
      console.log(`- очередь апдейтов недоступна (${updates.description || 'нет ответа'}), кнопку ставим только по умолчанию`);
    }
  }

  const url = `${options.url}/webhook/${secret}`;

  if (options.dryRun) {
    console.log('\n[dry-run] ничего не меняю. Было бы сделано:');
    console.log(`  deleteWebhook + setWebhook на ${url}`);
    console.log(`  setMyCommands: ${COMMANDS.map((c) => '/' + c.command).join(' ')}`);
    console.log(`  кнопка меню по умолчанию и адресно для чатов: ${[...chatIds].join(', ') || '(нет)'} -> ${options.url}`);
    return;
  }

  fs.writeFileSync(SECRET_FILE, secret, 'utf8');

  const dropped = await call('deleteWebhook', { drop_pending_updates: true });
  console.log(dropped.ok ? '- старый webhook (и очередь апдейтов) снят' : `- deleteWebhook: ${dropped.description}`);

  const set = await call('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: true
  });
  if (!set.ok) {
    fail(
      `не удалось поставить webhook: ${set.description || 'ошибка'}`,
      'Проверьте, что адрес отвечает и что в воркере задан BOT_WEBHOOK_SECRET с тем же значением.'
    );
  }
  console.log(`- webhook установлен: ${url}`);

  const commands = await call('setMyCommands', { commands: COMMANDS });
  console.log(commands.ok ? '- команды установлены' : `- команды не установлены: ${commands.description}`);

  const menu = await call('setChatMenuButton', {
    menu_button: { type: 'web_app', text: MENU_TEXT, web_app: { url: options.url } }
  });
  console.log(menu.ok ? `- кнопка меню «${MENU_TEXT}» ведёт на ${options.url}` : `- кнопка меню: ${menu.description}`);

  // Адресно для уже известных чатов — чтобы кнопка появилась и там, где
  // значение «по умолчанию» не подхватилось.
  let perChat = 0;
  for (const chatId of chatIds) {
    const one = await call('setChatMenuButton', {
      chat_id: chatId,
      menu_button: { type: 'web_app', text: MENU_TEXT, web_app: { url: options.url } }
    });
    if (one.ok) perChat += 1;
    else console.log(`- кнопка для чата ${chatId}: ${one.description || 'ошибка'}`);
  }
  if (perChat) console.log(`- кнопка установлена адресно в ${perChat} чат(ах)`);

  // Проверяем, что адресная кнопка действительно сохранилась.
  for (const chatId of chatIds) {
    const check = await call('getChatMenuButton', { chat_id: chatId });
    const value = check.ok && check.result ? check.result : {};
    const target = value.web_app ? value.web_app.url : '(тип: ' + (value.type || 'нет данных') + ')';
    console.log(`- проверка чата ${chatId}: ${target}`);
  }

  const info = await call('getWebhookInfo');
  if (info.ok) {
    const data = info.result || {};
    console.log('\nСостояние webhook:');
    console.log(`  url:               ${data.url || '(нет)'}`);
    console.log(`  pending_updates:   ${data.pending_update_count ?? 0}`);
    console.log(`  last_error:        ${data.last_error_message || 'нет'}`);
  }
  console.log(`\nСекрет webhook сохранён локально: ${SECRET_FILE}`);
  console.log('Этот же секрет должен лежать в воркере как BOT_WEBHOOK_SECRET (его ставит tools/cf-deploy.ps1).');
})();
