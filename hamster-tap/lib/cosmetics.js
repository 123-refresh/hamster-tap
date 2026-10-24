'use strict';
// Косметика: каталог и правила применения. Своих картинок в проекте нет — вся
// графика эмодзи, поэтому предметы тоже эмодзи и цвета:
//   hamster    — эмодзи на кнопке-хомяке;
//   palette    — акцентные цвета интерфейса (CSS-переменные на клиенте);
//   background — фон экрана (класс оформления);
//   badge      — значок рядом с ником в рейтинге и профиле.
// Источники: free (есть у всех), achievement и quest (награда за прогресс),
// stars (премиум за Telegram Stars — появится отдельным этапом).
// Модуль не подключает другие файлы: его импортируют и Node-версия, и воркер.

const TYPES = {
  hamster: { title: 'Хомяк', order: 1 },
  palette: { title: 'Палитра', order: 2 },
  background: { title: 'Фон', order: 3 },
  badge: { title: 'Значок', order: 4 }
};

const COSMETICS = [
  // Хомяки
  {
    id: 'hamster_classic',
    type: 'hamster',
    title: 'Классический',
    emoji: '🐹',
    source: 'free',
    hint: 'Есть у всех с самого начала'
  },
  {
    id: 'hamster_chip',
    type: 'hamster',
    title: 'Бурундук',
    emoji: '🐿️',
    source: 'achievement',
    hint: 'Награда за достижение «Десять тысяч тапов»'
  },
  {
    id: 'hamster_beaver',
    type: 'hamster',
    title: 'Бобр',
    emoji: '🦫',
    source: 'quest',
    hint: 'Награда за задание «Заходи 7 дней подряд»'
  },
  {
    id: 'hamster_bear',
    type: 'hamster',
    title: 'Хозяин тайги',
    emoji: '🐻',
    source: 'achievement',
    hint: 'Награда за достижение «Миллион»'
  },

  // Палитры: vars — CSS-переменные, которые клиент ставит на контейнер игры.
  {
    id: 'palette_default',
    type: 'palette',
    title: 'Тема Telegram',
    emoji: '🎨',
    source: 'free',
    hint: 'Цвета из настроек Telegram'
  },
  {
    id: 'palette_mint',
    type: 'palette',
    title: 'Мята',
    emoji: '🟢',
    source: 'achievement',
    hint: 'Награда за достижение «Первый бизнес»',
    vars: { accent: '#35c46a', soft: 'rgba(53, 196, 106, 0.18)' }
  },
  {
    id: 'palette_ice',
    type: 'palette',
    title: 'Лёд',
    emoji: '🔵',
    source: 'achievement',
    hint: 'Награда за достижение «Сто тысяч»',
    vars: { accent: '#4c7dff', soft: 'rgba(76, 125, 255, 0.18)' }
  },
  {
    id: 'palette_sunset',
    type: 'palette',
    title: 'Закат',
    emoji: '🟠',
    source: 'achievement',
    hint: 'Награда за достижение «Десять бизнесов»',
    vars: { accent: '#ff8a3d', soft: 'rgba(255, 138, 61, 0.18)' }
  },
  {
    id: 'palette_gold',
    type: 'palette',
    title: 'Золото',
    emoji: '🟡',
    source: 'achievement',
    hint: 'Награда за достижение «100 000 в час»',
    vars: { accent: '#ffcf4d', soft: 'rgba(255, 207, 77, 0.18)' }
  },

  // Фоны: css — класс оформления (описан в web/styles.css).
  {
    id: 'bg_default',
    type: 'background',
    title: 'Классический',
    emoji: '⬛',
    source: 'free',
    hint: 'Фон по умолчанию'
  },
  {
    id: 'bg_grid',
    type: 'background',
    title: 'Сетка',
    emoji: '▦',
    source: 'achievement',
    hint: 'Награда за достижение «Пять бизнесов»',
    css: 'bg-grid'
  },
  {
    id: 'bg_stars',
    type: 'background',
    title: 'Звёзды',
    emoji: '✨',
    source: 'achievement',
    hint: 'Награда за достижение «10 000 в час»',
    css: 'bg-stars'
  },
  {
    id: 'bg_rainbow',
    type: 'background',
    title: 'Радуга',
    emoji: '🌈',
    source: 'quest',
    hint: 'Награда за задание «Пригласи друга сегодня»',
    css: 'bg-rainbow'
  },

  // Значки рядом с ником
  {
    id: 'badge_none',
    type: 'badge',
    title: 'Без значка',
    emoji: '',
    source: 'free',
    hint: 'Ничего не показывать'
  },
  {
    id: 'badge_tap',
    type: 'badge',
    title: 'Тапальщик',
    emoji: '👆',
    source: 'achievement',
    hint: 'Награда за достижение «Тысяча тапов»'
  },
  {
    id: 'badge_friend',
    type: 'badge',
    title: 'Друг',
    emoji: '🤝',
    source: 'achievement',
    hint: 'Награда за достижение «Первый друг»'
  },
  {
    id: 'badge_hammer',
    type: 'badge',
    title: 'Мастер тапа',
    emoji: '🔨',
    source: 'achievement',
    hint: 'Награда за достижение «Максимальный мультитап»'
  },

  // Премиум-предметы: продаются за звёзды в Telegram, а на внешней странице (ЮKassa) —
  // за рубли. stars — что списывает Telegram, price — цена в копейках для рублёвого
  // канала; держим оба поля у одного предмета, чтобы каналы не разъезжались.
  {
    id: 'hamster_diamond',
    type: 'hamster',
    title: 'Алмазный хомяк',
    emoji: '💎',
    source: 'stars',
    stars: 150,
    price: 29900,
    hint: 'Премиум: хомяк из чистого алмаза'
  },
  {
    id: 'palette_neon',
    type: 'palette',
    title: 'Неон',
    emoji: '🟣',
    source: 'stars',
    stars: 75,
    price: 14900,
    hint: 'Премиум: неоновая палитра интерфейса',
    vars: { accent: '#b64cff', soft: 'rgba(182, 76, 255, 0.2)' }
  },
  {
    id: 'bg_cosmos',
    type: 'background',
    title: 'Космос',
    emoji: '🌌',
    source: 'stars',
    stars: 100,
    price: 19900,
    hint: 'Премиум: звёздный фон с туманностью',
    css: 'bg-cosmos'
  },
  {
    id: 'badge_star',
    type: 'badge',
    title: 'Звезда',
    emoji: '⭐',
    source: 'stars',
    stars: 50,
    price: 9900,
    hint: 'Премиум: значок ⭐ рядом с ником в топе'
  },
  {
    id: 'badge_crown',
    type: 'badge',
    title: 'Корона',
    emoji: '👑',
    source: 'stars',
    stars: 120,
    price: 24900,
    hint: 'Премиум: корона рядом с ником в топе'
  }
];



const COSMETICS_BY_ID = new Map(COSMETICS.map((item) => [item.id, item]));

// Что надето у игрока по умолчанию (и как называются колонки в users).
const DEFAULTS = {
  hamster: 'hamster_classic',
  palette: 'palette_default',
  background: 'bg_default',
  badge: 'badge_none'
};

// Колонки users, в которых хранится выбранный предмет каждого типа.
const COLUMNS = {
  hamster: 'hamster_skin',
  palette: 'palette',
  background: 'background',
  badge: 'badge'
};

function itemById(id) {
  return COSMETICS_BY_ID.get(id) || null;
}

function itemsByType(type) {
  return COSMETICS.filter((item) => item.type === type);
}

// Предметы, которые есть у игрока без наград: их можно надеть сразу.
const FREE_IDS = new Set(COSMETICS.filter((item) => item.source === 'free').map((item) => item.id));

/**
 * Состояние косметики игрока: каталог с отметками «открыто» и что надето сейчас.
 * ownedIds — идентификаторы из user_cosmetics (строка на предмет и источник награды).
 */
function cosmeticState(user, ownedIds) {
  const owned = new Set(ownedIds || []);
  const catalog = COSMETICS.map((item) => ({
    id: item.id,
    type: item.type,
    typeTitle: TYPES[item.type].title,
    title: item.title,
    emoji: item.emoji,
    source: item.source,
    // Цена в звёздах: у премиум-предметов она есть, у остальных 0.
    stars: item.stars || 0,
    hint: item.hint,
    vars: item.vars || null,
    css: item.css || null,
    owned: item.source === 'free' || owned.has(item.id)
  }));

  const active = {};
  for (const [type, column] of Object.entries(COLUMNS)) {
    const chosen = itemById(user[column]) ? user[column] : DEFAULTS[type];
    active[type] = chosen;
  }

  return {
    types: TYPES,
    catalog,
    owned: catalog.filter((item) => item.owned).length,
    total: catalog.length,
    active,
    // Значок и хомяк нужны витринам (топ, профиль) — отдаём их сразу.
    badge: active.badge,
    hamster: active.hamster
  };
}

// Надетые предметы в компактном виде: id + эмодзи/класс. Нужно рейтингу и профилю,
// где полный каталог не требуется.
function activeOf(user) {
  const out = {};
  for (const [type, column] of Object.entries(COLUMNS)) {
    const id = itemById(user[column]) ? user[column] : DEFAULTS[type];
    const item = itemById(id);
    out[type] = item ? { id, emoji: item.emoji, css: item.css || null, vars: item.vars || null } : null;
  }
  return out;
}

// Эмодзи предмета для витрин (топ, профиль): неизвестный id или «без значка» -> ''.
function emojiOf(id) {
  const item = itemById(id);
  return item ? item.emoji : '';
}

// Награда в удобном для витрины виде: идентификатор косметики превращаем в предмет,
// чтобы клиент показал «🪙 5 тыс. + 🐿️ Бурундук» без загрузки всего каталога.
function rewardView(reward) {
  return {
    coins: (reward && reward.coins) || 0,
    cosmetic: reward && reward.cosmetic ? itemById(reward.cosmetic) : null
  };
}

module.exports = {
  TYPES,
  COSMETICS,
  COSMETICS_BY_ID,
  DEFAULTS,
  COLUMNS,
  FREE_IDS,
  itemById,
  itemsByType,
  cosmeticState,
  activeOf,
  emojiOf,
  rewardView
};
