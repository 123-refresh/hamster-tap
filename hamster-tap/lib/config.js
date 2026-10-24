'use strict';
// Конфигурация сервера: читаем .env (свой мини-загрузчик, без зависимостей),
// затем process.env. Значения по умолчанию рассчитаны на локальный запуск.
const fs = require('fs');
const path = require('path');
const dns = require('dns');

// На VPN без маршрутизации IPv6 Node может выбрать AAAA-адрес и упасть в таймаут
// (так происходит, например, с api.telegram.org и *.trycloudflare.com).
// Просим resolver сначала отдавать IPv4 — это безопаснее в домашних сетях.
dns.setDefaultResultOrder('ipv4first');

const ROOT = path.join(__dirname, '..');

// --- мини-загрузчик .env: KEY=VALUE, строки с # — комментарии ---
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile(path.join(ROOT, '.env'));

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const args = process.argv.slice(2);
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();

module.exports = {
  ROOT,
  PORT: num(process.env.PORT, 8020),
  // Пустая строка => работаем без бота (dev-режим).
  BOT_TOKEN,
  BOT_USERNAME: (process.env.BOT_USERNAME || '').trim().replace(/^@/, ''),
  WEBAPP_URL: (process.env.WEBAPP_URL || '').trim().replace(/\/+$/, ''),
  // Разрешить вход "без Telegram" (тест в браузере).
  ALLOW_DEV: process.env.ALLOW_DEV === '1' || !BOT_TOKEN,
  // Реклама за энергию (Chanify): ключ издателя — секрет, режим live | stub.
  // AD_MODE=stub включают автотесты: сеть не дёргается, показ считается успешным.
  CHANIFY_API_KEY: (process.env.CHANIFY_API_KEY || '').trim(),
  AD_MODE: (process.env.AD_MODE || 'live').trim(),
  // Реклама после ответов бота — по умолчанию выключена, включается AD_BOT_ADS=1.
  AD_BOT_ADS: (process.env.AD_BOT_ADS || '').trim(),
  // Провайдеры рекламы за энергию в порядке приоритета: первый доступный показывает
  // рекламу, следующий подхватывает, если у первого нет кампании.
  //   monetag — rewarded-ролик внутри мини-аппа (нужны зона SDK и адрес скрипта)
  //   chanify — реклама приходит сообщением в чат с ботом (запасной вариант)
  AD_PROVIDERS: (process.env.AD_PROVIDERS || 'monetag,chanify').trim(),
  // Monetag: главная зона SDK (одна на мини-апп, из тега в кабинете) и адрес
  // SDK-скрипта. Оба значения публичные — в клиент уходят как есть; сеть включена
  // только когда заполнены оба.
  MONETAG_ZONE: (process.env.MONETAG_ZONE || '').trim(),
  MONETAG_SDK_URL: (process.env.MONETAG_SDK_URL || '').trim(),
  // Пассивный In-App Interstitial: «частота/окно_в_часах/интервал_с/задержка_с/сброс»
  // (например 2/0.1/30/5/0). Пусто — формат выключен.
  MONETAG_INAPP_SETTINGS: (process.env.MONETAG_INAPP_SETTINGS || '').trim(),
  // Постбеки Monetag: секрет в адресе эндпоинта (пусто — приём выключен) и режим
  // «награда только после подтверждения сети» (по умолчанию кредит по колбэку клиента).
  MONETAG_POSTBACK_SECRET: (process.env.MONETAG_POSTBACK_SECRET || '').trim(),
  MONETAG_REQUIRE_POSTBACK: process.env.MONETAG_REQUIRE_POSTBACK === '1',
  // Сколько ждём постбек после подтверждения клиента, прежде чем выдать награду без
  // подтверждения сети (страховка на случай незаполненной настройки в кабинете).
  // 0 — не ждать и не выдавать (жёсткая проверка).
  MONETAG_POSTBACK_GRACE_MS: num(process.env.MONETAG_POSTBACK_GRACE_MS, 20000),
  // Оплата: в Telegram продаём за звёзды (правила платформы), рублёвые платежи идут
  // на внешнюю страницу через ЮKassa. Провайдер выбирается осознанно: по умолчанию
  // stars, чтобы рублёвый канал не включился случайно.
  PAYMENTS_PROVIDER: (process.env.PAYMENTS_PROVIDER || 'stars').trim(),
  // Внешняя страница оплаты: origin нужен для CORS (другой домен), url — для ссылки в боте.
  PAY_PAGE_ORIGIN: (process.env.PAY_PAGE_ORIGIN || '').trim().replace(/\/+$/, ''),
  PAY_PAGE_URL: (process.env.PAY_PAGE_URL || '').trim(),
  // Секрет подписи личных ссылок на оплату (?t=...): пусто — берём BOT_TOKEN.
  PAY_LINK_SECRET: (process.env.PAY_LINK_SECRET || '').trim(),
  PAY_LINK_TTL_MS: num(process.env.PAY_LINK_TTL_MS, 30 * 60 * 1000),
  // ЮKassa: shopId и секретный ключ живут только на сервере, уведомления проверяем
  // по IP и повторным запросом статуса; секрет вебхука — часть адреса приёма.
  YOOKASSA_SHOP_ID: (process.env.YOOKASSA_SHOP_ID || '').trim(),
  YOOKASSA_SECRET_KEY: (process.env.YOOKASSA_SECRET_KEY || '').trim(),
  YOOKASSA_WEBHOOK_SECRET: (process.env.YOOKASSA_WEBHOOK_SECRET || '').trim(),
  YOOKASSA_RETURN_URL: (process.env.YOOKASSA_RETURN_URL || '').trim(),
  YOOKASSA_RECEIPTS: process.env.YOOKASSA_RECEIPTS === '1',
  RUN_BOT: process.env.RUN_BOT === '1' || args.includes('--bot'),
  DB_PATH: process.env.DB_PATH
    ? path.resolve(ROOT, process.env.DB_PATH)
    : path.join(ROOT, 'data', 'app.db'),

  // Время жизни серверной сессии (клиент хранит токен в localStorage).
  SESSION_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  // Свежесть initData при первом входе (Telegram отдаёт её при каждом открытии).
  AUTH_MAX_AGE_MS: 24 * 60 * 60 * 1000,
  // Максимальный размер тела JSON-запроса.
  MAX_BODY_BYTES: 64 * 1024
};
