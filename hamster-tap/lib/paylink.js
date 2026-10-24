'use strict';
// Личные ссылки на внешнюю страницу оплаты: <страница>?t=<подписанный токен>.
//
// Токен = base64url("<userId>.<exp>") + "." + HMAC-SHA256. Подпись проверяется на
// сервере, поэтому ссылку нельзя подделать и нельзя подставить чужой аккаунт;
// срок жизни ограничен (PAY_LINK_TTL_MS), а сам идентификатор игрока в открытом
// виде ничего не даёт без подписи.
const { createHmac, timingSafeEqual } = require('node:crypto');

const DEFAULT_TTL_MS = 30 * 60 * 1000;

/** Секрет подписи: отдельный PAY_LINK_SECRET, иначе BOT_TOKEN (он уже секрет). */
function secretOf(config) {
  const own = String((config && config.PAY_LINK_SECRET) || '').trim();
  if (own) return own;
  const bot = String((config && config.BOT_TOKEN) || '').trim();
  return bot || 'dev-pay-link-secret';
}

function encode(text) {
  const base64 = typeof btoa === 'function'
    ? btoa(text)
    : Buffer.from(text, 'utf8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(text) {
  const base64 = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  if (typeof atob === 'function') return atob(base64);
  return Buffer.from(base64, 'base64').toString('utf8');
}

function hmacOf(config, payload) {
  return createHmac('sha256', secretOf(config)).update(payload).digest('hex').slice(0, 40);
}

function sameSecret(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Токен доступа к внешней странице оплаты для конкретного игрока. */
function sign(config, userId, now = Date.now()) {
  const ttl = Number(config && config.PAY_LINK_TTL_MS) > 0 ? Number(config.PAY_LINK_TTL_MS) : DEFAULT_TTL_MS;
  const payload = `${userId}.${now + ttl}`;
  return `${encode(payload)}.${hmacOf(config, payload)}`;
}

/** Проверка токена: возвращает { userId, exp } либо null. */
function verify(config, token, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const payload = decode(parts[0]);
  const match = /^(\d{1,20})\.(\d{1,20})$/.exec(payload);
  if (!match) return null;
  if (!sameSecret(hmacOf(config, payload), parts[1])) return null;
  const userId = Number(match[1]);
  const exp = Number(match[2]);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  if (!(exp > now)) return null;
  return { userId, exp };
}

/** Адрес внешней страницы оплаты: задаётся PAY_PAGE_URL или собирается из origin. */
function payPageUrl(config) {
  const url = String((config && config.PAY_PAGE_URL) || '').trim();
  if (url) return url;
  const origin = String((config && config.PAY_PAGE_ORIGIN) || '').trim().replace(/\/+$/, '');
  return origin ? `${origin}/pay.html` : '';
}

/** Готовая личная ссылка: пусто, если внешняя страница не настроена. */
function linkFor(config, userId, now = Date.now()) {
  const page = payPageUrl(config);
  if (!page) return '';
  return `${page}?t=${sign(config, userId, now)}`;
}

module.exports = { DEFAULT_TTL_MS, sign, verify, payPageUrl, linkFor, secretOf };
