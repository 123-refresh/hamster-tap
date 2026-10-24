'use strict';
// Тестовый провайдер оплаты: платежи не уходят в сеть, объекты живут в памяти
// процесса. Нужен автотестам (PAYMENTS_PROVIDER=mock) — в проде не используется.
// Поведение повторяет реальные: создаётся платёж со статусом pending, «оплату»
// подтверждает тест (markSucceeded), после чего сервис выдаёт товар.
const payments = new Map();

function amountOf(good) {
  return { value: (Number(good.price) / 100).toFixed(2), currency: 'RUB' };
}

async function createPayment(config, { good, userId, paymentId, returnUrl, email }) {
  const externalId = `mock_${paymentId}`;
  payments.set(externalId, {
    id: externalId,
    status: 'pending',
    paid: false,
    amount: amountOf(good),
    metadata: { userId: String(userId), itemId: good.id, paymentId: String(paymentId || '') },
    confirmation: { confirmation_url: `${returnUrl || 'https://example.test/pay'}#${externalId}` },
    email: email || null
  });
  return {
    provider: 'mock',
    externalId,
    payUrl: payments.get(externalId).confirmation.confirmation_url,
    status: 'pending',
    amount: good.price,
    currency: 'RUB'
  };
}

async function fetchPayment(config, externalId) {
  return payments.get(externalId) || null;
}

/** Тестовое «оплата прошла»: дальше вебхук можно отправить вручную. */
async function markSucceeded(externalId) {
  const payment = payments.get(externalId);
  if (!payment) return null;
  payment.status = 'succeeded';
  payment.paid = true;
  return payment;
}

async function markCanceled(externalId) {
  const payment = payments.get(externalId);
  if (!payment) return null;
  payment.status = 'canceled';
  return payment;
}

async function refundPayment(config, { externalId }) {
  const payment = payments.get(externalId);
  if (!payment) return null;
  payment.status = 'refunded';
  return { id: `refund_${externalId}`, status: 'succeeded', payment_id: externalId };
}

function reset() {
  payments.clear();
}

module.exports = {
  id: 'mock',
  mode: 'test',
  createPayment,
  fetchPayment,
  refundPayment,
  markSucceeded,
  markCanceled,
  reset
};
