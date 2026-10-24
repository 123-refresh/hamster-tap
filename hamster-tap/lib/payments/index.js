'use strict';
// Провайдеры оплаты. Внутри Telegram мини-апп продаёт за звёзды (так требуют правила
// платформы), рублёвые платежи идут на внешнюю страницу через ЮKassa. Оба канала
// выдают товар одним и тем же кодом (service.settlePayment), поэтому «двух выдач»
// быть не может: платёж в журнале уникален по внешнему идентификатору.
//
// Выбор провайдера — конфиг PAYMENTS_PROVIDER (по умолчанию stars, чтобы включение
// рублёвого канала было осознанным шагом). mock — только автотесты.
const { randomUUID } = require('node:crypto');
const stars = require('./stars');
const yookassa = require('./yookassa');
const mock = require('./mock');

const PROVIDERS = { stars, yookassa, mock };
const DEFAULT_PROVIDER = 'stars';

function providerId(config) {
  const raw = String((config && config.PAYMENTS_PROVIDER) || DEFAULT_PROVIDER).trim().toLowerCase();
  return PROVIDERS[raw] ? raw : DEFAULT_PROVIDER;
}

function provider(config) {
  return PROVIDERS[providerId(config)];
}

/** Диагностика для статуса: какие каналы настроены. */
function providerList(config) {
  const id = providerId(config);
  return [
    {
      id: 'stars',
      mode: stars.mode,
      enabled: !!(config && config.BOT_TOKEN),
      active: id === 'stars'
    },
    {
      id: 'yookassa',
      mode: yookassa.mode,
      enabled: yookassa.enabled(config) && !!(config && config.PAY_PAGE_ORIGIN),
      active: id === 'yookassa'
    }
  ];
}

/** Внутренний идентификатор платежа: он же Idempotence-Key у ЮKassa. */
function newPaymentId() {
  return randomUUID();
}

module.exports = { PROVIDERS, provider, providerId, providerList, newPaymentId, DEFAULT_PROVIDER };
