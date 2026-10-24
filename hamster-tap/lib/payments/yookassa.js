'use strict';
// Провайдер ЮKassa: оплата картой/СБП на внешней странице (вне Telegram).
//
// Особенности, которые учтены:
//   * авторизация — Basic shopId:secretKey, ключи живут только на сервере;
//   * идемпотентность — заголовок Idempotence-Key (у нас это внутренний id платежа),
//     поэтому повторный запрос не создаст второй платёж;
//   * подписи у уведомлений нет: подлинность проверяем по IP из списка ЮKassa и
//     повторным запросом статуса платежа (см. service.settlePayment);
//   * чеки по 54-ФЗ передаются в receipt, если в кабинете включены «Чеки от ЮKassa».
const API = 'https://api.yookassa.ru/v3';

// Официальный список IP, с которых ЮKassa присылает уведомления.
const WEBHOOK_IPS = [
  '185.71.76.0/27',
  '185.71.77.0/27',
  '77.75.153.0/25',
  '77.75.156.11',
  '77.75.156.35',
  '77.75.154.128/25',
  '2a02:5180::/32'
];

function enabled(config) {
  return !!(config && config.YOOKASSA_SHOP_ID && config.YOOKASSA_SECRET_KEY);
}

function toBase64(text) {
  if (typeof btoa === 'function') return btoa(text);
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Разбор IPv4 в целое: 77.75.156.11 -> number. */
function ipv4ToInt(ip) {
  const parts = String(ip || '').split('.');
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    out = out * 256 + value;
  }
  return out;
}

/** Разбор IPv6 в BigInt (поддерживает «::» и IPv4-хвост). */
function ipv6ToBig(ip) {
  let text = String(ip || '').trim();
  if (!text.includes(':')) return null;
  const v4Tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4Tail) {
    const asInt = ipv4ToInt(v4Tail[1]);
    if (asInt === null) return null;
    const high = Math.floor(asInt / 65536).toString(16);
    const low = (asInt % 65536).toString(16);
    text = `${text.slice(0, v4Tail.index)}${high}:${low}`;
  }
  const hasGap = text.includes('::');
  const [head, tail] = text.split('::');
  const headParts = head ? head.split(':').filter(Boolean) : [];
  const tailParts = tail ? tail.split(':').filter(Boolean) : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  const parts = [...headParts, ...new Array(hasGap ? missing : 0).fill('0'), ...tailParts];
  let out = 0n;
  for (const part of parts) {
    const value = parseInt(part || '0', 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) return null;
    out = (out << 16n) + BigInt(value);
  }
  return out;
}

/** Нормализация адреса: IPv4-mapped IPv6 приводим к IPv4. */
function normalizeIp(ip) {
  const text = String(ip || '').trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  return mapped ? mapped[1] : text;
}

/**
 * Проверка адреса отправителя по официальному списку ЮKassa. Уведомления не
 * подписаны, поэтому это первый рубеж (второй — повторный запрос статуса платежа).
 */
function ipInList(ip, list = WEBHOOK_IPS) {
  const address = normalizeIp(ip);
  if (!address) return false;
  const v4 = ipv4ToInt(address);
  const v6 = v4 === null ? ipv6ToBig(address) : null;
  if (v4 === null && v6 === null) return false;

  for (const entry of list) {
    const [range, bitsRaw] = String(entry).split('/');
    const bits = Number(bitsRaw);
    const rangeV4 = ipv4ToInt(range);
    if (rangeV4 !== null) {
      if (v4 === null) continue;
      const shift = 32 - bits;
      const mask = shift <= 0 ? 0xffffffff : (0xffffffff << shift) >>> 0;
      if (((v4 & mask) >>> 0) === ((rangeV4 & mask) >>> 0)) return true;
      continue;
    }
    const rangeV6 = ipv6ToBig(range);
    if (rangeV6 === null || v6 === null) continue;
    const shift = 128 - bits;
    if (shift <= 0) return v6 === rangeV6;
    if ((v6 >> BigInt(shift)) === (rangeV6 >> BigInt(shift))) return true;
  }
  return false;
}

function authHeader(config) {
  return `Basic ${toBase64(`${config.YOOKASSA_SHOP_ID}:${config.YOOKASSA_SECRET_KEY}`)}`;
}

function amountOf(good) {
  return { value: (Number(good.price) / 100).toFixed(2), currency: 'RUB' };
}

/** Позиция чека: для цифровых товаров — работа/услуга, полный расчёт, без НДС. */
function receiptFor(good, email) {
  return {
    customer: { email },
    items: [
      {
        description: `Hamster Tap: ${good.title}`.slice(0, 128),
        quantity: '1.00',
        amount: amountOf(good),
        vat_code: 1,
        payment_subject: 'service',
        payment_mode: 'full_payment'
      }
    ]
  };
}

async function request(config, method, path, body, idempotenceKey) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: authHeader(config),
      'Content-Type': 'application/json',
      'Idempotence-Key': idempotenceKey || `hamster-${Date.now()}`
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.description || `ЮKassa: HTTP ${res.status}`);
    error.status = res.status;
    error.code = data.code || null;
    throw error;
  }
  return data;
}

/** Создаёт платёж и возвращает ссылку на оплату (redirect-сценарий). */
async function createPayment(config, { good, userId, paymentId, returnUrl, email }) {
  const body = {
    amount: amountOf(good),
    capture: true,
    description: `Hamster Tap: ${good.title}`.slice(0, 128),
    confirmation: { type: 'redirect', return_url: returnUrl },
    metadata: { userId: String(userId), itemId: good.id, paymentId: String(paymentId || '') }
  };
  if (email && config.YOOKASSA_RECEIPTS) body.receipt = receiptFor(good, email);
  const data = await request(config, 'POST', '/payments', body, paymentId);
  return {
    provider: 'yookassa',
    externalId: data.id,
    payUrl: (data.confirmation && data.confirmation.confirmation_url) || null,
    status: data.status || 'pending',
    amount: good.price,
    currency: 'RUB'
  };
}

/** Информация о платеже: используется для сверки, если уведомление не дошло. */
async function fetchPayment(config, externalId) {
  if (!externalId) return null;
  return request(config, 'GET', `/payments/${encodeURIComponent(externalId)}`);
}

/** Возврат: ЮKassa принимает возврат по идентификатору успешного платежа. */
async function refundPayment(config, { externalId, amount }) {
  const body = { payment_id: externalId };
  if (amount) body.amount = { value: (Number(amount) / 100).toFixed(2), currency: 'RUB' };
  return request(config, 'POST', '/refunds', body, `refund-${externalId}`);
}

module.exports = {
  id: 'yookassa',
  mode: 'external',
  API,
  WEBHOOK_IPS,
  enabled,
  createPayment,
  fetchPayment,
  refundPayment,
  receiptFor,
  amountOf,
  ipInList,
  normalizeIp
};
