'use strict';
// Создание счёта Telegram для цифрового товара: валюта XTR (звёзды), одна позиция,
// payload с идентификатором игрока и товара. Отдельный модуль без зависимостей —
// одинаково работает в Node-версии и в воркере (глобальный fetch).
//
// Оплата проходит так:
//   1) сервер создаёт ссылку (createInvoiceLink) и отдаёт её клиенту;
//   2) клиент открывает её через WebApp.openInvoice;
//   3) Telegram присылает боту pre_checkout_query — надо ответить за 10 секунд;
//   4) после оплаты приходит message.successful_payment с telegram_payment_charge_id.
const API = 'https://api.telegram.org';

async function call(method, botToken, payload) {
  const res = await fetch(`${API}/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const error = new Error(data.description || `${method}: HTTP ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data.result;
}

async function createInvoiceLink({ botToken, invoice }) {
  if (!botToken) {
    const error = new Error('оплата недоступна: не задан BOT_TOKEN');
    error.status = 503;
    throw error;
  }
  return call('createInvoiceLink', botToken, invoice);
}

module.exports = { createInvoiceLink, call };
