'use strict';
// Провайдер Telegram Stars: счёт создаёт Bot API, товар выдаём после
// successful_payment (вебхук бота), а сверку «оплатил, но товар не пришёл» можно
// сделать методом getStarTransactions — его идентификатор транзакции совпадает с
// telegram_payment_charge_id.
const shop = require('../shop');
const invoice = require('../invoice');

// Курс для справки: 1 ⭐ примерно 2 ₽ у покупателя. Используется только в текстах,
// фактическая цена товара задаётся в каталоге.
const RUB_PER_STAR = 2;

/** Ссылка на счёт для мини-аппа: клиент открывает её через WebApp.openInvoice. */
async function createPayment(config, { good, userId }) {
  const link = await invoice.createInvoiceLink({
    botToken: config.BOT_TOKEN,
    invoice: shop.invoiceFor(good, userId)
  });
  return {
    provider: 'stars',
    // externalId появится позже: у звёзд идентификатор платежа приходит в вебхуке.
    externalId: null,
    payUrl: link,
    invoiceLink: link,
    status: 'pending',
    amount: good.stars,
    currency: 'XTR'
  };
}

/**
 * Сверка платежа по getStarTransactions. Метод отдаёт транзакции бота; id транзакции
 * совпадает с charge_id платежа, а payload виден во вложенном source.invoice_payload.
 * Возвращает null, если транзакции с таким идентификатором ещё нет.
 */
async function fetchPayment(config, externalId) {
  if (!config.BOT_TOKEN || !externalId) return null;
  const data = await invoice.call('getStarTransactions', config.BOT_TOKEN, { limit: 100 }).catch(() => null);
  const list = (data && data.transactions) || [];
  const found = list.find((tx) => tx && tx.id === externalId);
  if (!found) return null;
  const source = found.source || {};
  return {
    id: found.id,
    status: 'succeeded',
    paid: true,
    amount: { value: String(found.amount || 0), currency: 'XTR' },
    metadata: { payload: source.invoice_payload || null },
    raw: found
  };
}

/** Возврат звёзд покупателю (требование Telegram к ботам с цифровыми товарами). */
async function refundPayment(config, { externalId, tgId }) {
  return invoice.call('refundStarPayment', config.BOT_TOKEN, {
    user_id: tgId,
    telegram_payment_charge_id: externalId
  });
}

module.exports = { id: 'stars', mode: 'telegram', RUB_PER_STAR, createPayment, fetchPayment, refundPayment };
