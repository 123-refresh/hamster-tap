'use strict';
// Магазин: товары за Telegram Stars, разбор payload и поля счёта.
// Модуль не подключает другие файлы (кроме косметики через переданный список),
// чтобы оставаться одинаково пригодным для Node-версии и для воркера.
//
// Товары трёх видов:
//   coins   — сразу начисляются монеты;
//   boost   — временный множитель к тапу (продлевается, если уже активен);
//   cosmetic— премиум-предмет из каталога косметики (source === 'stars').
//
// Цены двувалютные: stars — что списывает Telegram внутри мини-аппа, price — цена в
// КОПЕЙКАХ для рублёвого канала (внешняя страница с ЮKassa). Курс держим явно
// (примерно 2 ₽ за звезду), чтобы обе витрины показывали одно и то же предложение.
const SHOP_GOODS = [
  {
    id: 'coins_5k',
    kind: 'coins',
    title: 'Горсть монет',
    emoji: '🪙',
    stars: 25,
    price: 4900,
    coins: 5000,
    description: '5 000 монет сразу на баланс'
  },
  {
    id: 'coins_25k',
    kind: 'coins',
    title: 'Мешок монет',
    emoji: '💰',
    stars: 100,
    price: 19900,
    coins: 25000,
    description: '25 000 монет — хватит на пару бизнесов'
  },
  {
    id: 'coins_100k',
    kind: 'coins',
    title: 'Сейф монет',
    emoji: '🏦',
    stars: 300,
    price: 59900,
    coins: 100000,
    description: '100 000 монет и заметный скачок в доходе'
  },
  {
    id: 'tap_x2_hour',
    kind: 'boost',
    title: '×2 к тапу на час',
    emoji: '⚡',
    stars: 75,
    price: 14900,
    boostMinutes: 60,
    description: 'Двойные монеты за каждый тап в течение часа'
  }
];

// Косметические товары собираются из каталога: цена живёт рядом с предметом,
// поэтому «магазин» и «стиль» не могут разойтись.
function cosmeticGoods(cosmeticCatalog) {
  return (cosmeticCatalog || [])
    .filter((item) => item.source === 'stars')
    .map((item) => ({
      id: item.id,
      kind: 'cosmetic',
      itemId: item.id,
      type: item.type,
      source: 'stars',
      title: item.title,
      emoji: item.emoji,
      stars: item.stars || 0,
      price: item.price || 0,
      description: item.hint
    }));
}

// Валюта рублёвого канала: цены в каталоге заданы в копейках, чтобы не ловить
// ошибки округления при пересчётах.
const CURRENCY = 'RUB';

/** Цена для витрины: копейки -> «1 299 ₽» (копейки в товарах всегда .00). */
function priceText(good) {
  const rubles = Math.round((Number(good && good.price) || 0) / 100);
  return `${String(rubles).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} ₽`;
}

/** Что списывает Telegram: «100 ⭐». */
function starsText(good) {
  return `${Number(good && good.stars) || 0} ⭐`;
}

function goodsList(cosmeticCatalog) {
  return [...SHOP_GOODS, ...cosmeticGoods(cosmeticCatalog)];
}

function goodById(id, cosmeticCatalog) {
  return goodsList(cosmeticCatalog).find((good) => good.id === String(id || '')) || null;
}

// Payload счёта: по нему бот понимает, что именно оплачено и кому выдать товар.
// Формат простой и проверяемый: "<user_id>:<item_id>".
function payloadFor(userId, itemId) {
  return `${userId}:${itemId}`;
}

function parsePayload(payload) {
  const match = /^(\d{1,20}):([a-z0-9_]{1,40})$/.exec(String(payload || ''));
  if (!match) return null;
  const userId = Number(match[1]);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  return { userId, itemId: match[2] };
}

/**
 * Поля счёта Telegram для товара: валюта XTR (звёзды), одна позиция, payload
 * с идентификатором игрока и товара. Счёт создаётся на сервере, ссылку отдаём клиенту.
 */
function invoiceFor(good, userId) {
  return {
    title: `${good.emoji} ${good.title}`,
    description: good.description || 'Покупка в Hamster Tap',
    payload: payloadFor(userId, good.id),
    currency: 'XTR',
    prices: [{ label: good.title, amount: good.stars }]
  };
}

// Краткое описание товара для сообщения после оплаты.
function deliveredText(good, extra = {}) {
  if (good.kind === 'coins') return `🪙 +${good.coins} монет на баланс`;
  if (good.kind === 'boost') return `⚡ ×2 к тапу на ${good.boostMinutes} мин`;
  if (good.kind === 'cosmetic') return `🎨 ${good.title} — можно надеть в профиле`;
  return extra.text || 'Товар зачислен';
}

module.exports = {
  SHOP_GOODS,
  CURRENCY,
  cosmeticGoods,
  goodsList,
  goodById,
  payloadFor,
  parsePayload,
  invoiceFor,
  deliveredText,
  priceText,
  starsText
};
