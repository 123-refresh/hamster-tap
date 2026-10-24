'use strict';
// Клиент мини-аппа. Вся экономика приходит с сервера: здесь только отрисовка,
// оптимистичные тапы (для отзывчивости) и отправка намерений игрока.
(() => {
  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const TOKEN_KEY = 'hamster-tap-token';
  const DEV_KEY = 'hamster-tap-dev-id';
  // Запомненный реферальный параметр: ссылку-приглашение надо отдать серверу
  // ровно один раз, даже если вход открылся не сразу (например, не было сети).
  const REF_KEY = 'hamster-tap-ref';

  const app = {
    token: null,
    state: null,        // последнее состояние с сервера
    tab: 'tap',
    category: 'all',
    friends: null,
    top: null,
    quests: null,
    achievements: null,
    code: null,
    cosmetics: null,
    shop: null,
    profile: null,
    sheetLoading: false,
    shownUnlocked: new Set(),
    passiveShown: false,
    // оптимистичный слой поверх серверного состояния
    view: { coins: 0, energy: 0 },
    pending: 0,         // тапов накоплено локально, но ещё не отправлено
    turboEndsAt: 0,
    boostEndsAt: 0,
    flushTimer: null,
    // Реклама за энергию: ad — текущая выдача (ждём возвращения из чата),
    // adStatus/adReadyAt — состояние кнопки и время до следующей попытки.
    ad: null,
    adStatus: null,
    adReadyAt: 0,
    adBusy: false,
    adStatusLoading: false,
    // Игрок удалил профиль: приложение закрывается, поэтому ни таймеры, ни ответы
    // 401 не должны запускать повторный вход (иначе молча создался бы новый игрок).
    closed: false,
    timers: []
  };

  const $ = (id) => document.getElementById(id);

  // --- форматирование и мелкие утилиты ---

  const compact = new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 2 });
  const full = new Intl.NumberFormat('ru-RU');

  function fmt(value) {
    const num = Number(value) || 0;
    return num < 10000 ? full.format(num) : compact.format(num);
  }

  function fmtShort(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h} ч ${m} мин` : m > 0 ? `${m} мин ${s} с` : `${s} с`;
  }

  function haptic(type) {
    if (!tg || !tg.HapticFeedback) return;
    try {
      if (type === 'error') tg.HapticFeedback.notificationOccurred('error');
      else if (type === 'success') tg.HapticFeedback.notificationOccurred('success');
      else tg.HapticFeedback.impactOccurred('light');
    } catch {
      /* хаптика недоступна — не критично */
    }
  }

  // Экранирование подставляемых в разметку строк (имена игроков приходят из Telegram).
  function escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, (ch) => map[ch]);
  }

  // Награда в читаемом виде: «🪙 5 тыс. + 🐿️ Бурундук».
  function rewardText(reward) {
    if (!reward) return '—';
    const parts = [];
    if (reward.coins) parts.push(`🪙 ${fmt(reward.coins)}`);
    if (reward.cosmetic) parts.push(`${reward.cosmetic.emoji} ${reward.cosmetic.title}`);
    return parts.join(' + ') || '—';
  }

  /**
   * Косметика применяется сразу после получения состояния: хомяк, акцентные цвета,
   * фон экрана. Значок рядом с ником рисуется в рейтинге и профиле.
   */
  function applyCosmetics(cos) {
    const root = $('app');
    if (!root || !cos) return;
    root.classList.remove('bg-grid', 'bg-stars', 'bg-rainbow', 'bg-cosmos');
    if (cos.background && cos.background.css) root.classList.add(cos.background.css);

    const vars = cos.palette && cos.palette.vars;
    if (vars) {
      root.style.setProperty('--accent', vars.accent);
      root.style.setProperty('--accent-soft', vars.soft);
    } else {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-soft');
    }

    const hamster = document.querySelector('.hamster-emoji');
    if (hamster) hamster.textContent = (cos.hamster && cos.hamster.emoji) || '🐹';
  }

  function badgeOf(cos) {
    return (cos && cos.badge && cos.badge.emoji) || '';
  }

  // Достижение показываем всплывашкой ровно один раз, даже если состояние придёт повторно.
  function showUnlocked(unlocked) {
    for (const item of unlocked || []) {
      if (!item || app.shownUnlocked.has(item.id)) continue;
      app.shownUnlocked.add(item.id);
      const extra = item.cosmetic ? ` + ${item.cosmetic.emoji} ${item.cosmetic.title}` : '';
      toast(`${item.emoji} Достижение «${item.title}»: +${fmt(item.coins)}${extra}`, 'success', {
        key: `ach-${item.id}`,
        ttlMs: 3200
      });
      haptic('success');
    }
  }

  // --- уведомления ---
  // Одинаковые сообщения не дублируются: пока такое уведомление на экране, повтор лишь
  // продлевает его жизнь и увеличивает счётчик («Энергия на нуле ×5»). Для частых ошибок
  // есть кулдаун — тот же текст в этом окне вообще не показывается. У каждого уведомления
  // свой таймер (раньше был общий, из-за чего старые сообщения висели вечно).
  const TOAST_LIMIT = 3;
  const TOAST_TTL = { error: 2800, other: 2000 };
  const TOAST_COOLDOWN = { error: 3000, other: 0 };
  const activeToasts = new Map();   // key -> { el, timer, count }
  const toastLastShown = new Map(); // key -> когда показывали
  let lastEnergyWarningAt = 0;

  function removeToast(key, immediate = false) {
    const entry = activeToasts.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    activeToasts.delete(key);
    if (immediate) {
      entry.el.remove();
      return;
    }
    entry.el.classList.add('is-out');
    setTimeout(() => entry.el.remove(), 160);
  }

  function toast(text, kind = '', options = {}) {
    const key = options.key || `${kind}|${text}`;
    const now = Date.now();
    const ttl = options.ttlMs || (kind === 'error' ? TOAST_TTL.error : TOAST_TTL.other);
    const cooldown = options.cooldownMs !== undefined
      ? options.cooldownMs
      : (kind === 'error' ? TOAST_COOLDOWN.error : TOAST_COOLDOWN.other);

    const existing = activeToasts.get(key);
    if (existing) {
      // То же сообщение уже на экране: обновляем счётчик и продлеваем показ.
      existing.count += 1;
      existing.el.textContent = `${text} ×${existing.count}`;
      existing.el.classList.remove('is-bump');
      void existing.el.offsetWidth; // перезапуск анимации
      existing.el.classList.add('is-bump');
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => removeToast(key), ttl);
      toastLastShown.set(key, now);
      return;
    }

    if (cooldown > 0 && now - (toastLastShown.get(key) || 0) < cooldown) return;

    // Держим не больше трёх уведомлений: самое старое уходит первым.
    while (activeToasts.size >= TOAST_LIMIT) {
      removeToast(activeToasts.keys().next().value, true);
    }

    const node = document.createElement('div');
    node.className = `toast ${kind ? `is-${kind}` : ''}`;
    node.textContent = text;
    node.title = 'Нажмите, чтобы скрыть';
    node.addEventListener('click', () => removeToast(key));
    $('toasts').appendChild(node);
    activeToasts.set(key, {
      el: node,
      timer: setTimeout(() => removeToast(key), ttl),
      count: 1
    });
    toastLastShown.set(key, now);
  }

  // Полоса энергии дрожит и краснеет, когда тапать уже нечем: причина видна без текста.
  function shakeEnergyBar() {
    const bar = document.querySelector('.energy-bar');
    if (!bar) return;
    bar.classList.remove('is-empty');
    void bar.offsetWidth;
    bar.classList.add('is-empty');
    setTimeout(() => bar.classList.remove('is-empty'), 420);
  }

  function overlay(title, text, buttonLabel) {
    const overlayEl = $('overlay');
    $('overlayTitle').textContent = title;
    $('overlayText').textContent = text || '';
    const btn = $('overlayBtn');
    if (buttonLabel) {
      btn.textContent = buttonLabel;
      btn.hidden = false;
    } else {
      btn.hidden = true;
    }
    overlayEl.classList.add('is-active');
  }

  function hideOverlay() {
    $('overlay').classList.remove('is-active');
  }

  // --- сетевое взаимодействие ---

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (app.token) headers['X-Auth'] = app.token;
    const res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.error || `ошибка ${res.status}`);
      error.status = res.status;
      throw error;
    }
    return data;
  }

  // --- вход ---

  function devId() {
    let id = Number(localStorage.getItem(DEV_KEY));
    if (!Number.isSafeInteger(id) || id === 0) {
      id = Math.floor(Math.random() * 9_000_000) + 1_000_000;
      localStorage.setItem(DEV_KEY, String(id));
    }
    return id;
  }

  /**
   * Реферальный параметр приглашения (ref_<tg_id>). Telegram отдаёт его в
   * initData, но при открытии по прямой ссылке на мини-апп или кнопкой бота он
   * приходит только в адресе страницы — поэтому смотрим оба места и запоминаем
   * найденное, чтобы приглашение не потерялось.
   */
  function refParam() {
    const fromTg = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || '';
    const query = new URLSearchParams(location.search);
    const candidate = String(
      fromTg || query.get('startapp') || query.get('start_param') || query.get('start') || ''
    ).trim();
    if (/^ref_\d{1,20}$/.test(candidate)) {
      localStorage.setItem(REF_KEY, candidate);
      return candidate;
    }
    return localStorage.getItem(REF_KEY) || '';
  }

  async function authenticate() {
    const payload = {};
    // Считаем один раз: значение решает, можно ли идти быстрым путём, и уходит на сервер.
    const ref = refParam();
    if (tg && tg.initData) {
      payload.initData = tg.initData;
      payload.startParam = ref;
    } else {
      // Открыто в обычном браузере: сервер разрешит dev-вход (см. ALLOW_DEV в .env).
      payload.devId = devId();
      payload.devName = 'Локальный игрок';
      // В локальном режиме start_param из Telegram не приходит — берём из адреса.
      payload.startParam = ref;
    }
    const saved = localStorage.getItem(TOKEN_KEY);
    // Приглашение обязательно должно дойти до сервера, а быстрый путь (проверка
    // сохранённой сессии) его потеряет: он не вызывает /auth. Поэтому при наличии
    // реферального параметра всегда выполняем полный вход.
    if (saved && !ref) {
      // Пробуем переиспользовать сессию, чтобы не тратить initData впустую.
      app.token = saved;
      try {
        const state = await api('/state');
        return { state, token: saved, reused: true };
      } catch (error) {
        if (error.status !== 401) throw error;
        app.token = null;
        localStorage.removeItem(TOKEN_KEY);
      }
    }
    const result = await api('/auth', { method: 'POST', body: payload });
    // Важно: сохраняем токен и в localStorage, и в памяти — иначе все
    // последующие запросы (тапы, покупки) уйдут без заголовка X-Auth.
    app.token = result.token;
    localStorage.setItem(TOKEN_KEY, result.token);
    // Параметр доставлен (сервер применил его или уже знает игрока) — забываем.
    if (ref) localStorage.removeItem(REF_KEY);
    return { ...result, reused: false };
  }

  // --- отправка тапов пачкой ---
  // Частота отправки подобрана под бесплатные лимиты Cloudflare: одна пачка
  // примерно раз в 1,5 секунды (или сразу при 10 нажатиях). Баланс при этом
  // обновляется на экране мгновенно — оптимистично, до ответа сервера.
  const FLUSH_MS = 1500;
  const FLUSH_TAPS = 10;

  function queueFlush(immediate = false) {
    if (immediate) {
      if (app.flushTimer) {
        clearTimeout(app.flushTimer);
        app.flushTimer = null;
      }
      flushTaps();
      return;
    }
    if (app.flushTimer) return;
    app.flushTimer = setTimeout(flushTaps, FLUSH_MS);
  }

  async function flushTaps() {
    app.flushTimer = null;
    const count = app.pending;
    if (!count) return;
    app.pending = 0;
    try {
      const result = await api('/tap', { method: 'POST', body: { count } });
      applyState(result.state);
      if (!result.accepted && count > 0) {
        // Сервер не принял тапы (энергия кончилась или сработал античит).
        haptic('error');
      }
    } catch (error) {
      if (error.status === 401) return restart();
      toast(error.message, 'error');
    }
  }

  // --- состояние и отрисовка ---

  // Применяем серверное состояние; локальные (ещё не отправленные) тапы
  // учитываем оптимистично, чтобы счётчик не "прыгал" назад.
  function applyState(next) {
    app.state = next;
    app.view.coins = next.user.coins;
    app.view.energy = next.user.energy;
    if (app.pending > 0) {
      app.view.coins += app.pending * next.tapValue;
      app.view.energy = Math.max(0, app.view.energy - app.pending);
    }
    const turbo = next.boosts.turbo;
    app.turboEndsAt = turbo.active ? Date.now() + turbo.secondsLeft * 1000 : 0;
    const boost = next.tapBoost || {};
    app.boostEndsAt = boost.active ? Date.now() + boost.secondsLeft * 1000 : 0;
    applyCosmetics(next.cosmetics);
    render();
    showUnlocked(next.unlocked);
  }

  // Бейдж на вкладке «Задания»: сколько наград уже можно забрать.
  function renderQuestBadge() {
    const badge = $('questsBadge');
    if (!badge) return;
    const claimable = app.state && app.state.quests ? app.state.quests.claimable : 0;
    badge.hidden = !claimable;
    badge.textContent = String(claimable);
  }

  function turboActive() {
    return app.turboEndsAt > Date.now();
  }

  function boostActive() {
    return app.boostEndsAt > Date.now();
  }

  function render() {
    if (!app.state) return;
    renderHeader();
    renderTapScreen();
    renderCards();
    renderBoosts();
    renderUpgrades();
    renderQuestBadge();
    if (app.tab === 'quests' && app.quests) renderQuests();
    if (app.tab === 'quests' && app.code) renderCode();
    if (app.tab === 'friends') renderFriends();
    if (app.tab === 'top') renderTop();
  }

  // Быстрое обновление счётчиков (вызывается на каждый тап).
  function renderCounters() {
    $('coins').textContent = fmt(app.view.coins);
    $('energy').textContent = fmt(app.view.energy);
  }

  function renderHeader() {
    const { user, level, rank, players } = app.state;
    $('levelEmoji').textContent = level.emoji;
    $('levelName').textContent = level.name;
    $('levelNext').textContent = level.nextName
      ? `${fmt(level.min)} → ${fmt(level.nextMin)}/ч`
      : 'максимум';
    $('levelBar').style.width = `${Math.round(level.progress * 100)}%`;
    $('coins').textContent = fmt(app.view.coins);
    $('profit').textContent = fmt(user.profitPerHour);
    $('rankChip').textContent = `🏆 #${rank} из ${players}`;
  }

  function renderTapScreen() {
    const { user, boosts } = app.state;
    $('tapValue').textContent = fmt(app.state.tapValue);
    $('energy').textContent = fmt(app.view.energy);
    $('energyLimit').textContent = fmt(user.energyLimit);
    const percent = user.energyLimit ? (app.view.energy / user.energyLimit) * 100 : 0;
    $('energyBar').style.width = `${Math.max(0, Math.min(100, percent))}%`;

    const left = turboActive() ? Math.ceil((app.turboEndsAt - Date.now()) / 1000) : 0;
    $('turboBadge').hidden = left <= 0;
    $('turboLeft').textContent = String(Math.max(0, left));
    $('hamster').classList.toggle('is-turbo', left > 0);

    // Премиум-буст из магазина: свой значок, чтобы было видно, что покупка работает.
    const boostLeft = boostActive() ? Math.ceil((app.boostEndsAt - Date.now()) / 1000) : 0;
    $('boostBadge').hidden = boostLeft <= 0;
    $('boostLeft').textContent = String(Math.max(0, boostLeft));

    $('quickTurboNote').textContent = left > 0 ? `активно ${left} с` : `${boosts.turbo.left}/${boosts.turbo.limit} в день`;
    $('quickTurbo').disabled = boosts.turbo.left <= 0 || left > 0;
    renderEnergyButton();

    const daily = app.state.daily;
    $('dailyCard').hidden = !daily.available;
    $('dailyHint').textContent = `День ${daily.nextStreak} · 🪙 ${fmt(daily.reward)}`;
  }

  function renderCards() {
    const chips = $('categoryChips');
    const categories = [
      { id: 'all', title: 'Все', emoji: '✨' },
      ...Object.entries(app.state.categories).map(([id, c]) => ({ id, ...c }))
    ];
    chips.innerHTML = '';
    for (const category of categories) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip${app.category === category.id ? ' is-active' : ''}`;
      chip.textContent = `${category.emoji} ${category.title}`;
      chip.addEventListener('click', () => {
        app.category = category.id;
        renderCards();
      });
      chips.appendChild(chip);
    }

    const list = $('cardsList');
    list.innerHTML = '';
    const cards = app.state.cards.filter(
      (card) => app.category === 'all' || card.category === app.category
    );
    // Сначала то, что можно купить сейчас, затем закрытые лигой.
    const open = cards.filter((c) => !c.locked).sort((a, b) => a.tier - b.tier || a.cost - b.cost);
    const locked = cards.filter((c) => c.locked);
    const visible = [...open, ...locked].slice(0, 60);

    if (!visible.length) {
      list.innerHTML = '<div class="empty">Карточек в этой категории пока нет</div>';
      return;
    }

    for (const card of visible) {
      const row = document.createElement('div');
      row.className = `item${card.locked ? ' is-locked' : ''}`;
      const levelTag = card.level > 0 ? `<span class="item-level">ур. ${card.level}</span>` : '';
      const profit = card.profit > 0 ? `+${fmt(card.profit)}/ч` : 'доход появится после покупки';
      const after = card.profitAfter !== null ? ` → +${fmt(card.profitAfter)}/ч` : '';
      const price = card.maxed
        ? '<span class="item-price is-locked">максимум</span>'
        : card.locked
          ? `<span class="item-price is-locked">лига «${card.unlockedAt}»</span>`
          : `<span class="item-price">🪙 ${fmt(card.cost)}</span>`;
      // Кнопка активна только при достаточном балансе, а подсказка объясняет, сколько
      // не хватает (сервер всё равно перепроверяет монеты и отвечает 402).
      const miss = !card.locked && !card.maxed ? card.cost - app.view.coins : 0;
      const missing = miss > 0 ? `<span class="miss">не хватает 🪙 ${fmt(miss)}</span>` : '';
      const buyButton =
        card.locked || card.maxed
          ? ''
          : `<button class="btn btn-primary btn-small" type="button" data-card="${card.id}"${missing ? ' disabled' : ''}>Купить</button>`;
      row.innerHTML = `
        <div class="item-emoji">${card.emoji}</div>
        <div class="item-body">
          <div class="item-title">${card.title} ${levelTag}</div>
          <div class="item-sub">${card.categoryTitle} · ${profit}${after}${missing ? ` · ${missing}` : ''}</div>
        </div>
        <div class="item-action">${price}${buyButton}</div>`;
      list.appendChild(row);
    }

    list.querySelectorAll('[data-card]').forEach((button) => {
      button.addEventListener('click', () => buyCard(button.dataset.card));
    });
  }

  function renderBoosts() {
    const list = $('boostsList');
    list.innerHTML = '';
    for (const boost of Object.values(app.state.boosts)) {
      const row = document.createElement('div');
      row.className = 'item';
      const note = boost.left > 0 ? `Осталось ${boost.left} из ${boost.limit}` : 'На сегодня всё';
      const active = boost.id === 'turbo' && turboActive();
      row.innerHTML = `
        <div class="item-emoji">${boost.emoji}</div>
        <div class="item-body">
          <div class="item-title">${boost.title}</div>
          <div class="item-sub">${boost.description} · ${note}</div>
        </div>
        <div class="item-action">
          <button class="btn btn-gold btn-small" type="button" data-boost="${boost.id}"
            ${boost.left <= 0 || active ? 'disabled' : ''}>${active ? 'Активно' : 'Использовать'}</button>
        </div>`;
      list.appendChild(row);
    }
    list.querySelectorAll('[data-boost]').forEach((button) => {
      button.addEventListener('click', () => useBoost(button.dataset.boost));
    });
  }

  function renderUpgrades() {
    const list = $('upgradesList');
    list.innerHTML = '';
    for (const upgrade of Object.values(app.state.upgrades)) {
      const row = document.createElement('div');
      row.className = 'item';
      const effect =
        upgrade.kind === 'tap'
          ? `+${upgrade.step} к силе тапа`
          : `+${fmt(upgrade.step)} к лимиту энергии`;
      const price = upgrade.maxed ? '<span class="item-price is-locked">максимум</span>' : `<span class="item-price">🪙 ${fmt(upgrade.cost)}</span>`;
      // То же, что у карточек: без нужной суммы кнопка неактивна и видно нехватку.
      const miss = upgrade.maxed ? 0 : upgrade.cost - app.view.coins;
      const missing = miss > 0 ? `<span class="miss">не хватает 🪙 ${fmt(miss)}</span>` : '';
      const button = upgrade.maxed
        ? ''
        : `<button class="btn btn-primary btn-small" type="button" data-upgrade="${upgrade.kind}"${missing ? ' disabled' : ''}>Улучшить</button>`;
      row.innerHTML = `
        <div class="item-emoji">${upgrade.emoji}</div>
        <div class="item-body">
          <div class="item-title">${upgrade.title} <span class="item-level">ур. ${upgrade.level}</span></div>
          <div class="item-sub">${effect} · максимум ${upgrade.maxLevel} уровней${missing ? ` · ${missing}` : ''}</div>
        </div>
        <div class="item-action">${price}${button}</div>`;
      list.appendChild(row);
    }
    list.querySelectorAll('[data-upgrade]').forEach((button) => {
      button.addEventListener('click', () => buyUpgrade(button.dataset.upgrade));
    });
  }

  function renderFriends() {
    const friends = app.friends || { invited: 0, list: [], link: '' };
    // Условия разные: другу приветственный бонус сразу, пригласившему — крупная
    // награда только после того, как друг сделает tapsTarget тапов.
    const friendBonus = friends.friendBonus || 0;
    const target = friends.tapsTarget || 0;
    const waiting = friends.rewardsWaiting || 0;
    $('friendsBadge').textContent =
      `Приглашено: ${friends.invited} · в пути: ${waiting} · тебе 🪙 ${fmt(friends.bonus)} после ${fmt(target)} тапов друга, другу 🪙 ${fmt(friendBonus)} сразу`;
    $('inviteLink').textContent = friends.link || 'ссылка появится после настройки бота (BOT_USERNAME)';

    const list = $('friendsList');
    list.innerHTML = '';
    if (!friends.list.length) {
      list.innerHTML =
        '<div class="empty">Пока никого. Позови друзей: им бонус сразу, а тебе награда — как только они поиграют.</div>';
      return;
    }
    for (const friend of friends.list) {
      const row = document.createElement('div');
      row.className = 'rank-row is-clickable';
      // Прогресс награды: сколько тапов осталось другу, либо она уже выплачена.
      const progress = friend.paid
        ? '<span class="friend-hint is-done">✅ награда получена</span>'
        : `<span class="friend-hint">⏳ ${fmt(friend.progress || 0)}/${fmt(target)} тапов до награды</span>`;
      row.innerHTML = `
        <div class="rank-num">👤</div>
        <div class="rank-name">${escapeHtml(friend.name)}${friend.username ? ` · @${escapeHtml(friend.username)}` : ''}${progress}</div>
        <div class="rank-coins">🪙 ${fmt(friend.coins)}</div>`;
      row.addEventListener('click', () => openProfile(friend.id));
      list.appendChild(row);
    }
  }

  function renderTop() {
    const data = app.top;
    const list = $('topList');
    if (!data) {
      list.innerHTML = '<div class="empty">Загружаем лидерборд…</div>';
      return;
    }
    $('topBadge').textContent = `Игроков: ${data.players} · твоё место: #${data.myRank} · нажми на игрока`;
    const medals = ['🥇', '🥈', '🥉'];
    const rows = data.top.slice();
    list.innerHTML = '';
    for (const row of rows) {
      const isMe = row.id === app.state.user.id;
      const node = document.createElement('div');
      node.className = `rank-row is-clickable${isMe ? ' is-me' : ''}`;
      node.innerHTML = `
        <div class="rank-num">${medals[row.rank - 1] || row.rank}</div>
        <div class="rank-name">${row.badge ? `${row.badge} ` : ''}${escapeHtml(isMe ? 'Ты' : row.name)}</div>
        <div class="rank-coins">🪙 ${fmt(row.coins)}</div>
        <div class="rank-ach" title="Открытых достижений">🏅 ${row.ach || 0}</div>`;
      node.addEventListener('click', () => openProfile(row.id));
      list.appendChild(node);
    }
  }

  // --- задания и достижения ---

  async function loadQuests() {
    if (!app.quests) $('questsList').innerHTML = '<div class="empty">Загружаем задания…</div>';
    try {
      const [questsData, achData, codeData] = await Promise.all([
        api('/quests'),
        api('/achievements'),
        api('/code')
      ]);
      app.quests = questsData;
      app.achievements = achData;
      app.code = codeData;
      renderCode();
      renderQuests();
    } catch (error) {
      if (error.status === 401) return restart();
      $('questsList').innerHTML = '<div class="empty">Не удалось загрузить задания</div>';
      toast(error.message, 'error');
    }
  }

  /**
   * Код дня: сам код выдаёт бот (/code), здесь только статус, поле ввода и награда.
   * Пока код не забран — показываем обратный отсчёт до конца суток UTC.
   */
  function renderCode() {
    const card = $('codeCard');
    if (!card || !app.code) return;
    const status = $('codeStatus');
    const input = $('codeInput');
    const button = $('codeBtn');

    if (app.code.claimed) {
      card.classList.add('is-claimed');
      status.textContent = `Код использован · новый через ${fmtShort(app.code.expiresInMs)}`;
      if (input) input.disabled = true;
      if (button) {
        button.disabled = true;
        button.textContent = 'Получено';
      }
      return;
    }

    card.classList.remove('is-claimed');
    status.textContent = `/code в боте · осталось ${fmtShort(app.code.expiresInMs)}`;
    if (input) input.disabled = false;
    if (button) {
      button.disabled = false;
      button.textContent = `Ввести (+${fmt(app.code.reward)})`;
    }
  }

  async function submitCode() {
    const input = $('codeInput');
    const code = input ? input.value.trim() : '';
    if (!code) {
      toast('Введите код дня — его выдаёт бот командой /code', 'error');
      return;
    }

    try {
      const result = await api('/code/claim', { method: 'POST', body: { code } });
      applyState(result.state);
      haptic('success');
      toast(`🔐 Код принят: +${fmt(result.coins)} монет`, 'success');
      if (input) input.value = '';
      await loadQuests();
    } catch (error) {
      if (error.status === 401) return restart();
      haptic('error');
      toast(error.message, 'error');
    }
  }

  function renderQuests() {
    const data = app.quests;
    const box = $('questsList');
    if (!data || !box) return;

    $('questsHint').textContent =
      `Выполнено ${data.done} из ${data.total} · наград забрано: ${data.claimed}`;
    box.innerHTML = '';
    for (const quest of data.list) {
      const row = document.createElement('div');
      row.className = `quest${quest.done ? ' is-done' : ''}${quest.claimed ? ' is-claimed' : ''}`;

      const percent = Math.round((quest.progress / quest.target) * 100);
      const status = quest.claimed
        ? 'Награда получена'
        : quest.done
          ? 'Готово — забирай награду'
          : `${fmt(quest.progress)} / ${fmt(quest.target)}`;
      row.innerHTML = `
        <div class="quest-emoji">${quest.emoji}</div>
        <div class="quest-body">
          <div class="quest-title">${escapeHtml(quest.title)}</div>
          <div class="quest-bar">
            <div class="quest-bar-fill${quest.done ? ' is-gold' : ''}" style="width:${percent}%"></div>
          </div>
          <div class="quest-sub">${status} · награда: ${rewardText(quest.reward)}</div>
        </div>
        <div class="quest-action"></div>`;

      const action = row.querySelector('.quest-action');
      if (quest.claimed) {
        action.innerHTML = '<span class="item-price">✓</span>';
      } else if (quest.done) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-gold btn-small';
        button.dataset.quest = quest.id;
        button.textContent = 'Забрать';
        button.addEventListener('click', () => claimQuest(quest.id));
        action.appendChild(button);
      }
      box.appendChild(row);
    }

    const ach = app.achievements;
    const achBox = $('achList');
    if (!ach || !achBox) return;
    $('achBadge').textContent = `Получено ${ach.done} из ${ach.total}`;
    achBox.innerHTML = '';
    for (const item of ach.list) {
      const row = document.createElement('div');
      row.className = `item${item.done ? '' : ' is-locked'}`;
      row.innerHTML = `
        <div class="item-emoji">${item.emoji}</div>
        <div class="item-body">
          <div class="item-title">${escapeHtml(item.title)}</div>
          <div class="item-sub">${item.done ? 'Получено' : escapeHtml(item.hint)} · награда: ${rewardText(item.reward)}</div>
        </div>
        <div class="item-action">${item.done ? '<span class="item-price">✓</span>' : ''}</div>`;
      achBox.appendChild(row);
    }
  }

  async function claimQuest(questId) {
    try {
      const result = await api('/quests/claim', { method: 'POST', body: { questId } });
      applyState(result.state);
      haptic('success');
      const extra = result.cosmetic ? ` + ${result.cosmetic.emoji} ${result.cosmetic.title}` : '';
      toast(`🎯 Награда: +${fmt(result.coins)} монет${extra}`, 'success');
      await loadQuests();
    } catch (error) {
      if (error.status === 401) return restart();
      haptic('error');
      toast(error.message, 'error');
    }
  }

  // --- карточка игрока ---

  function openSheet(html) {
    $('sheetBody').innerHTML = html;
    $('sheet').hidden = false;
  }

  function closeSheet() {
    $('sheet').hidden = true;
  }

  async function openProfile(id) {
    if (app.sheetLoading) return;
    app.sheetLoading = true;
    openSheet('<div class="empty">Загружаем профиль…</div>');
    try {
      const data = await api(`/profile/${id}`);
      app.profile = data;
      renderProfile(data);
    } catch (error) {
      if (error.status === 401) return restart();
      closeSheet();
      toast(error.message, 'error');
    } finally {
      app.sheetLoading = false;
    }
  }

  function renderProfile(data) {
    const cos = data.cosmetics || {};
    const hamster = (cos.hamster && cos.hamster.emoji) || '🐹';
    const badge = badgeOf(cos);
    const stats = [
      ['Монеты', `🪙 ${fmt(data.coins)}`],
      ['Доход в час', `+${fmt(data.profitPerHour)}`],
      ['Всего тапов', fmt(data.totalTaps)],
      ['Заработано всего', fmt(data.totalEarned)],
      ['Бизнесов куплено', fmt(data.cards)],
      ['Друзей приглашено', fmt(data.friends)],
      ['Дней в игре', fmt(data.days)],
      ['Место в топе', data.rank ? `#${data.rank} из ${data.players}` : '—']
    ];
    // «Стена» достижений: полученные — ярко, оставшиеся — приглушённо с подсказкой.
    const achList = Array.isArray(data.achievements) ? data.achievements : [];
    const achDone = achList.filter((item) => item.done).length;
    const chips = achList.length
      ? achList
        .map(
          (item) =>
            `<span class="ach-chip ${item.done ? 'is-done' : 'is-locked'}" title="${escapeHtml(item.hint)}">${item.emoji} ${escapeHtml(item.title)}</span>`
        )
        .join('')
      : '<span class="ach-chip is-locked">Достижений пока нет</span>';

    const body = document.createElement('div');
    body.className = 'sheet-body';
    body.innerHTML = `
      <div class="profile-head">
        <div class="profile-avatar">${hamster}</div>
        <div class="profile-lines">
          <div class="profile-name">${badge ? `${badge} ` : ''}${escapeHtml(data.name)}</div>
          <div class="profile-sub">${data.username ? `@${escapeHtml(data.username)} · ` : ''}${data.level.emoji} ${escapeHtml(data.level.name)}</div>
          <div class="profile-sub">Достижения: ${data.achievementsDone} из ${data.achievementsTotal}</div>
        </div>
      </div>
      <div class="cos-type" id="achBox">
        <h4>Достижения · открыто ${achDone} из ${data.achievementsTotal}</h4>
        <div class="ach-chips">${chips}</div>
      </div>
      <div class="stats">
        ${stats.map(([label, value]) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`).join('')}
      </div>
      <div class="cos-type" id="cosBox"${data.mine ? '' : ' hidden'}>
        <h4>Стиль (задания, достижения и звёзды ⭐)</h4>
        <div class="cos-grid" id="cosGrid"><div class="empty">Загружаем косметику…</div></div>
      </div>
      <div class="cos-type" id="shopBox"${data.mine ? '' : ' hidden'}>
        <h4>Магазин за звёзды ⭐</h4>
        <div class="list" id="shopList"><div class="empty">Загружаем товары…</div></div>
        <h4>Мои покупки</h4>
        <div id="purchasesBox"></div>
      </div>
      <div id="notifyBox"${data.mine ? '' : ' hidden'}></div>
      <div class="sheet-actions" id="sheetActions"></div>`;
    $('sheetBody').innerHTML = '';
    $('sheetBody').appendChild(body);

    if (data.mine) {
      renderNotify(app.state && app.state.notify);
      loadCosmetics();
      loadShop();
      const share = document.createElement('button');
      share.type = 'button';
      share.className = 'btn btn-ghost';
      share.textContent = '📤 Поделиться результатом';
      share.addEventListener('click', shareSelf);
      $('sheetActions').appendChild(share);

      // Опасная зона: удаление профиля. Операция необратимая, поэтому кнопка
      // требует отдельного подтверждения (см. confirmDeleteProfile).
      const danger = document.createElement('div');
      danger.className = 'danger-zone';
      danger.innerHTML = `
        <h4>Опасная зона</h4>
        <div class="danger-hint">Профиль удаляется навсегда: монеты, бизнесы, достижения
          и косметика пропадут. Покупки за звёзды ⭐ не возвращаются автоматически —
          напишите /paysupport.</div>`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-danger';
      remove.textContent = '🗑 Удалить профиль';
      remove.addEventListener('click', confirmDeleteProfile);
      danger.appendChild(remove);
      $('sheetActions').appendChild(danger);
    }
  }

  // Второй шаг удаления профиля: подтверждение в том же листе, чтобы случайный
  // тап не снёс прогресс.
  function confirmDeleteProfile() {
    openSheet(`
      <div class="danger-zone">
        <h3>Удалить профиль навсегда?</h3>
        <div class="danger-hint">Монеты, бизнесы, достижения и косметика пропадут.
          При следующем входе профиль создастся с нуля. Покупки за звёзды ⭐ не
          возвращаются автоматически — напишите /paysupport.</div>
        <div class="sheet-actions" id="deleteActions"></div>
      </div>`);
    const actions = $('deleteActions');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost';
    cancel.textContent = 'Отмена';
    cancel.addEventListener('click', () => openProfile(app.state.user.id));
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-danger';
    confirm.textContent = '🗑 Удалить навсегда';
    confirm.addEventListener('click', deleteProfileNow);
    actions.append(cancel, confirm);
  }

  // Третий шаг: сам запрос. Профиль и сессии удалены на сервере, поэтому гасим
  // таймеры, чистим локальные следы и закрываем мини-апп: без этого первый же
  // запрос получил бы 401 и приложение молча создало нового игрока.
  async function deleteProfileNow() {
    try {
      await api('/profile/delete', { method: 'POST' });
    } catch (error) {
      if (error.status === 401) return restart();
      toast(error.message, 'error');
      return;
    }
    shutdownAfterDelete();
    haptic('success');
    // Сначала показываем прощание: если клиент не поддержит закрытие, игрок увидит
    // понятный текст вместо пустого экрана.
    overlay('Профиль удалён', 'Данные стёрты. Откройте игру заново — профиль создастся с нуля.');
    if (tg && typeof tg.close === 'function') tg.close();
  }

  // Останавливает всё, что могло бы заново авторизовать игрока после удаления
  // профиля: таймеры тикера и синхронизации, отложенную отправку тапов, токен.
  function shutdownAfterDelete() {
    app.closed = true;
    app.timers.forEach((id) => clearInterval(id));
    app.timers = [];
    if (app.flushTimer) {
      clearTimeout(app.flushTimer);
      app.flushTimer = null;
    }
    // Накопленные тапы не отправляем: токен уже недействителен.
    app.pending = 0;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REF_KEY);
    app.token = null;
    app.state = null;
    app.friends = null;
    app.top = null;
    closeSheet();
  }

  // --- магазин за звёзды (Telegram Stars) ---

  async function loadShop() {
    try {
      app.shop = await api('/shop');
    } catch (error) {
      if (error.status === 401) return restart();
      toast(error.message, 'error');
      return;
    }
    renderShop();
  }

  function renderShop() {
    const box = $('shopList');
    if (!box || !app.shop) return;
    const names = new Map(app.shop.items.map((item) => [item.id, item]));

    box.innerHTML = '';
    // Косметика за звёзды продаётся во вкладке «Стиль», поэтому здесь только
    // наборы монет и буст — их негде надеть, их надо просто купить.
    for (const good of app.shop.items.filter((item) => item.kind !== 'cosmetic')) {
      const row = document.createElement('div');
      row.className = 'item';
      row.innerHTML = `
        <div class="item-emoji">${good.emoji}</div>
        <div class="item-body">
          <div class="item-title">${escapeHtml(good.title)}</div>
          <div class="item-sub">${escapeHtml(good.description || '')}</div>
        </div>
        <div class="item-action">
          <button class="btn btn-gold btn-small" type="button" data-good="${good.id}">⭐ ${good.stars}</button>
        </div>`;
      box.appendChild(row);
    }
    box.querySelectorAll('[data-good]').forEach((button) => {
      button.addEventListener('click', () => buyItem(button.dataset.good));
    });

    const history = $('purchasesBox');
    if (history) {
      const purchases = app.shop.purchases || [];
      history.innerHTML = purchases.length
        ? purchases
          .map((row) => {
            const good = names.get(row.itemId);
            const title = good ? `${good.emoji} ${good.title}` : row.itemId;
            const date = new Date(row.at).toLocaleDateString('ru-RU');
            return `<div class="switch-row"><span>${escapeHtml(title)}</span><span>⭐ ${row.stars} · ${date}</span></div>`;
          })
          .join('')
        : '<div class="switch-row"><span>Покупок пока нет</span><span>—</span></div>';
    }
  }

  /**
   * Покупка за звёзды: сервер создаёт счёт (Telegram, валюта XTR), клиент открывает
   * его через WebApp.openInvoice. Товар зачисляет бот после successful_payment,
   * поэтому после оплаты несколько раз обновляем состояние.
   */
  async function buyItem(itemId) {
    if (!tg || !tg.openInvoice) {
      toast('Оплата звёздами доступна только внутри Telegram', 'error');
      return;
    }
    let link;
    try {
      const result = await api('/shop/invoice', { method: 'POST', body: { itemId } });
      link = result.link;
    } catch (error) {
      if (error.status === 401) return restart();
      toast(error.message, 'error');
      return;
    }

    haptic('light');
    tg.openInvoice(link, (status) => {
      if (status === 'paid') {
        toast('⭐ Оплата прошла — зачисляем покупку…', 'success');
        refreshAfterPurchase(itemId);
      } else if (status === 'cancelled') {
        toast('Оплата отменена');
      } else {
        toast(`Оплата не завершена (${status})`, 'error');
      }
    });
  }

  // Ждём, пока бот обработает successful_payment: признак — новая запись в покупках.
  async function refreshAfterPurchase(itemId) {
    const before = ((app.shop && app.shop.purchases) || []).filter((row) => row.itemId === itemId).length;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await refreshState();
      await loadShop();
      const rows = ((app.shop && app.shop.purchases) || []).filter((row) => row.itemId === itemId);
      if (rows.length > before) {
        haptic('success');
        const good = (app.shop.items || []).find((item) => item.id === itemId);
        toast(`✅ ${good ? `${good.emoji} ${good.title}` : 'Покупка'} зачислено`, 'success');
        app.cosmetics = null;
        await loadCosmetics();
        return;
      }
    }
    toast('Оплата прошла, но зачисление задерживается — откройте магазин через минуту', 'error');
  }

  // --- косметика и напоминания ---

  async function loadCosmetics() {
    if (!app.cosmetics) {
      try {
        app.cosmetics = await api('/cosmetics');
      } catch (error) {
        if (error.status === 401) return restart();
        toast(error.message, 'error');
        return;
      }
    }
    renderCosmetics();
  }

  function renderCosmetics() {
    const grid = $('cosGrid');
    if (!grid || !app.cosmetics) return;
    grid.innerHTML = '';
    for (const item of app.cosmetics.catalog) {
      const active = app.cosmetics.active[item.type] === item.id;
      const premium = item.source === 'stars';
      const forSale = premium && !item.owned;
      const node = document.createElement('button');
      node.type = 'button';
      node.className = `cos-item${active ? ' is-active' : ''}${item.owned || forSale ? '' : ' is-locked'}`;
      node.dataset.item = item.id;
      node.title = item.owned ? `${item.title} — ${item.hint}` : `${item.title}: ${item.hint}`;
      const note = forSale ? `⭐ ${item.stars}` : (item.owned ? item.typeTitle : 'закрыто');
      node.innerHTML = `
        <span class="cos-emoji">${item.emoji || '🚫'}</span>
        <b>${escapeHtml(item.title)}</b>
        <span>${escapeHtml(note)}</span>`;
      // Закрытые наградами предметы нажимать некуда, а премиум-предметы — покупка.
      node.disabled = item.owned && active;
      node.addEventListener('click', () => (forSale ? buyItem(item.id) : equipCosmetic(item.id)));
      grid.appendChild(node);
    }
  }

  async function equipCosmetic(itemId) {
    try {
      const result = await api('/cosmetics/equip', { method: 'POST', body: { itemId } });
      applyState(result.state);
      app.cosmetics = null;
      await loadCosmetics();
      haptic('success');
    } catch (error) {
      if (error.status === 401) return restart();
      toast(error.message, 'error');
    }
  }

  const NOTIFY_LABELS = {
    energy: '⚡ Энергия восстановилась',
    daily: '🎁 Бонус дня готов',
    rank: '🏆 Соперники в топе'
  };

  function renderNotify(notify) {
    const box = $('notifyBox');
    if (!box) return;
    const prefs = notify || { energy: true, daily: true, rank: true };
    box.innerHTML = '<div class="cos-type"><h4>Напоминания в боте</h4></div>';
    const wrap = document.createElement('div');
    wrap.className = 'cos-type';
    for (const [kind, label] of Object.entries(NOTIFY_LABELS)) {
      const row = document.createElement('div');
      row.className = 'switch-row';
      const text = document.createElement('span');
      text.textContent = label;
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = `switch${prefs[kind] ? ' is-on' : ''}`;
      toggle.setAttribute('aria-label', label);
      toggle.addEventListener('click', () => setNotify(kind, !toggle.classList.contains('is-on')));
      row.append(text, toggle);
      wrap.appendChild(row);
    }
    box.appendChild(wrap);
  }

  async function setNotify(kind, value) {
    try {
      const body = {};
      body[kind] = value;
      const result = await api('/push', { method: 'POST', body });
      if (app.state) app.state.notify = result.notify;
      renderNotify(result.notify);
      toast(value ? 'Напоминание включено' : 'Напоминание выключено', 'success');
    } catch (error) {
      if (error.status === 401) return restart();
      toast(error.message, 'error');
    }
  }

  function shareSelf() {
    if (!app.state) return;
    const user = app.state.user;
    const link = (app.state.friends && app.state.friends.link) || '';
    const text = `Я в Hamster Tap: ${fmt(user.coins)} монет и +${fmt(user.profitPerHour)} в час! 🐹`;
    const target = link || location.href;
    const url = `https://t.me/share/url?url=${encodeURIComponent(target)}&text=${encodeURIComponent(text)}`;
    if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
    else window.open(url, '_blank');
  }

  // --- действия игрока ---

  async function buyCard(cardId) {
    try {
      const result = await api('/cards/buy', { method: 'POST', body: { cardId } });
      applyState(result.state);
      haptic('success');
      toast(`Карточка прокачана до ур. ${result.level}`, 'success');
    } catch (error) {
      if (error.status === 401) return restart();
      haptic('error');
      toast(error.message, 'error');
    }
  }

  async function buyUpgrade(kind) {
    try {
      const result = await api('/upgrades/buy', { method: 'POST', body: { kind } });
      applyState(result.state);
      haptic('success');
      toast(`Улучшено до ур. ${result.level}`, 'success');
    } catch (error) {
      if (error.status === 401) return restart();
      haptic('error');
      toast(error.message, 'error');
    }
  }

  // --- энергия за рекламу (Monetag, Chanify) ---
  // Сети перечислены на сервере по приоритету: Monetag — rewarded видео внутри
  // мини-аппа (награда сразу после досмотра), Chanify — реклама приходит в чат,
  // поэтому энергию начисляем по возвращении игрока. Если ролик не запустился,
  // просим следующую сеть: обычно это реклама в чате.
  // Дневного лимита нет — только пауза между попытками, её показывает таймер.

  // SDK сети подключаем один раз на зону: тег Monetag создаёт глобальную функцию
  // show_<зона> по атрибутам data-zone и data-sdk, поэтому без них функция не
  // появится. Неудачная загрузка не запоминается — следующая попытка повторит её.
  // (Несколько тегов на одну зону SDK не поддерживает, поэтому ключ — адрес + зона.)
  const adScripts = new Map();
  function loadAdScript(session) {
    const key = `${session.sdkUrl}#${session.zoneId}`;
    if (!adScripts.has(key)) {
      adScripts.set(key, new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = session.sdkUrl;
        el.async = true;
        el.setAttribute('data-zone', session.zoneId);
        el.setAttribute('data-sdk', `show_${session.zoneId}`);
        el.onload = () => resolve();
        el.onerror = () => {
          adScripts.delete(key);
          reject(new Error('SDK рекламы не загрузился'));
        };
        document.head.appendChild(el);
      }));
    }
    return adScripts.get(key);
  }

  // Если тег SDK уже стоит в разметке, функция показа есть сразу — тогда скрипт
  // повторно не подключаем.
  async function rewardedShow(session) {
    const name = `show_${session.zoneId}`;
    if (typeof window[name] !== 'function' && session.sdkUrl && session.zoneId) {
      try {
        await loadAdScript(session);
      } catch {
        return null;
      }
    }
    return typeof window[name] === 'function' ? window[name] : null;
  }

  // Активная сеть из состояния кнопки: по ней берём зону, адрес SDK и настройки
  // пассивного формата.
  function monetagProvider() {
    const list = (app.adStatus && app.adStatus.providers) || [];
    return list.find((provider) => provider.id === 'monetag' && provider.enabled) || null;
  }

  // Награду подтверждает поле reward_event_type: valued — показ оплачен сетью,
  // non_valued — ролик был, но выплаты нет (fallback, отфильтрованный трафик).
  function rewardedValued(result) {
    return !!result && typeof result === 'object' && result.reward_event_type === 'valued';
  }

  // Предзагрузка ролика: без неё показ начинается с заметной паузы, и сеть прямо
  // просит грузить заранее. Делаем это один раз на зону, когда кнопка превратилась
  // в «За рекламу»; ymid подставляем в момент показа.
  let adPreloadedZone = '';
  async function preloadRewardedAd() {
    const provider = monetagProvider();
    if (!provider || !provider.zoneId || !provider.sdkUrl || adPreloadedZone === provider.zoneId) return;
    try {
      const show = await rewardedShow(provider);
      // SDK ещё не загружен — ничего страшного, попробуем при следующей синхронизации.
      if (!show) return;
      await show({ type: 'preload', requestVar: 'energy_button' });
      adPreloadedZone = provider.zoneId;
    } catch {
      // Предзагрузка не обязательна: показ просто начнётся позже.
    }
  }

  // Пассивная реклама Monetag (In-App Interstitial): формат показывает себя сам по
  // настройкам из кабинета, награды не даёт и постбеков не шлёт — это доход за CPM.
  // Вызываем ровно один раз: повторный вызов сбивает внутренний таймер сети.
  let inAppStarted = false;
  async function startInAppAds() {
    if (inAppStarted) return;
    const provider = monetagProvider();
    if (!provider || !provider.zoneId || !provider.sdkUrl || !provider.inApp) return;
    try {
      const show = await rewardedShow(provider);
      if (!show) return;
      await show({ type: 'inApp', inAppSettings: provider.inApp });
      inAppStarted = true;
    } catch {
      // Настройки — не критичный шаг: попробуем на следующей синхронизации.
    }
  }

  async function showRewardedAd(session) {
    const show = await rewardedShow(session);
    if (!show) return false;
    try {
      // type: 'end' — rewarded-ролик, который должен дойти до конца; ymid — наш
      // одноразовый токен (он же придёт в постбеке сети). catchIfNoFeed обязателен:
      // без него SDK при отсутствии рекламы молча резолвит промис, и награду выдать
      // было бы не за что.
      const result = await show({
        type: 'end',
        ymid: session.token,
        requestVar: 'energy_button',
        catchIfNoFeed: true
      });
      return rewardedValued(result);
    } catch {
      // «Ad feed is empty», «Zone misconfigured», «Network error», «Timeout exceeded» —
      // это не ошибка игры: просто пробуем следующую сеть.
      return false;
    }
  }

  // Ролик досмотрен: сервер начислит энергию — токен одноразовый, повторный запрос
  // ничего не добавит. В режиме «награда по постбеку» решает серверная отметка сети,
  // поэтому переспрашиваем с растущими паузами: суммарно ~35 секунд — этого хватает
  // и на быстрый постбек, и на серверную страховку (окно ожидания MONETAG_POSTBACK_GRACE_MS).
  const CLAIM_RETRY_MS = [1500, 1500, 1500, 1500, 3000, 3000, 3000, 3000, 5000, 5000];
  async function claimRewardedAd(session) {
    for (let attempt = 0; attempt <= CLAIM_RETRY_MS.length; attempt += 1) {
      const result = await api('/energy/ad/claim', {
        method: 'POST',
        body: { token: session.token, done: true }
      });
      applyAdStatus(result.status);
      if (result.credited) {
        if (result.state) applyState(result.state);
        else await refreshState();
        adPreloadedZone = '';
        haptic('success');
        toast(
          result.restored > 0 ? `⚡ Энергия восстановлена: +${fmt(result.restored)}` : '⚡ Энергия уже восстановлена',
          'success'
        );
        return;
      }
      if (result.rejected) {
        toast('Сеть не зачла показ — попробуйте позже', 'error');
        return;
      }
      if (!result.waiting) {
        toast('Ролик не был досмотрен до конца', 'error');
        return;
      }
      if (!attempt) toast('Проверяем показ…', 'info');
      if (attempt === CLAIM_RETRY_MS.length) break;
      await new Promise((resolve) => setTimeout(resolve, CLAIM_RETRY_MS[attempt]));
    }
    // Сеть ещё не подтвердила показ: энергию выдаст постбек (или серверная страховка,
    // когда истечёт её окно) — она появится при следующей синхронизации состояния.
    toast('Показ подтверждается — энергия придёт чуть позже', 'info');
  }

  function adWaitLeftMs() {
    return Math.max(0, (app.adReadyAt || 0) - Date.now());
  }

  // Энергия «на исходе» — не только ровно ноль: регенерация добавляет по 1 в
  // секунду, поэтому с точным нулём кнопка мигала бы и возвращалась к бусту.
  // Порог в 10% лимита даёт игроку понятное «пора восполнить».
  function energyIsLow() {
    if (!app.state) return false;
    const limit = app.state.user.energyLimit || 0;
    return app.view.energy <= Math.max(0, limit * 0.1);
  }

  function applyAdStatus(status) {
    app.adStatus = status || null;
    app.adReadyAt = status && status.readyInMs > 0 ? Date.now() + status.readyInMs : 0;
  }

  async function refreshAdStatus() {
    if (app.adStatusLoading) return;
    app.adStatusLoading = true;
    try {
      applyAdStatus(await api('/energy/ad/status'));
    } catch (error) {
      // Подсказка не критична: сервер всё равно проверит паузу и вернёт понятный
      // текст, поэтому молча оставляем кнопку в обычном виде.
      if (error.status === 401) restart();
    } finally {
      app.adStatusLoading = false;
    }
  }

  // Кнопка «⚡ Энергия» превращается в «📺 За рекламу», когда энергия на нуле.
  function renderEnergyButton() {
    const button = $('quickEnergy');
    const note = $('quickEnergyNote');
    const emoji = $('quickEnergyEmoji');
    const title = $('quickEnergyTitle');
    if (!button || !app.state) return;
    const { user, boosts } = app.state;

    // Энергия есть — работает обычный буст «Полная энергия» с дневным лимитом.
    if (!energyIsLow()) {
      if (emoji) emoji.textContent = '⚡';
      if (title) title.textContent = 'Энергия';
      note.textContent = `${boosts.full_energy.left}/${boosts.full_energy.limit} в день`;
      button.disabled = boosts.full_energy.left <= 0 || app.view.energy >= user.energyLimit;
      return;
    }

    // Энергия пуста — предлагаем восстановить её за рекламу (без дневного лимита).
    if (emoji) emoji.textContent = '📺';
    if (title) title.textContent = 'За рекламу';
    // Состояние кнопки нужно сразу: как только оно придёт, начинаем грузить ролик —
    // тогда показ по тапу начнётся без заметной паузы.
    if (!app.adStatus && !app.adStatusLoading) refreshAdStatus().then(() => preloadRewardedAd());
    else if (app.adStatus) preloadRewardedAd();
    const waitLeft = adWaitLeftMs();
    const canConfirm = !!app.ad && Date.now() >= app.ad.readyAt;
    button.disabled = app.adBusy || waitLeft > 0;
    if (waitLeft > 0) note.textContent = `через ${Math.ceil(waitLeft / 1000)} с`;
    else if (canConfirm) note.textContent = 'подтвердить просмотр';
    else if (app.ad) note.textContent = 'посмотрите рекламу';
    else note.textContent = 'без лимита';
  }

  // Реклама в чате: показываем подсказку, игрок уходит в чат и возвращается —
  // энергию выдаём по возвращении (confirm).
  function startChatAd(session) {
    app.ad = {
      token: session.token,
      readyAt: Date.now() + (session.confirmDelayMs || 0),
      leftApp: false
    };
    haptic('success');
    overlay(
      'Реклама в чате с ботом 📺',
      'Откройте чат с ботом, посмотрите рекламу и вернитесь в игру — энергия придёт сразу после возвращения.',
      'Продолжить'
    );
    $('overlayBtn').onclick = hideOverlay;
  }

  async function requestAdEnergy() {
    if (app.adBusy || adWaitLeftMs() > 0) return;
    app.adBusy = true;
    renderEnergyButton();
    const tried = [];
    try {
      // Сети идут по приоритету: если ролик не запустился, просим следующую —
      // обычно это реклама в чате, поэтому попыток заведомо немного.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await api('/energy/ad/request', { method: 'POST', body: { skip: tried } });
        applyAdStatus(result.status);
        if (result.mode !== 'client') {
          startChatAd(result);
          return;
        }
        if (await showRewardedAd(result)) {
          await claimRewardedAd(result);
          return;
        }
        tried.push(result.provider);
      }
      toast('Реклама сейчас недоступна — попробуйте позже', 'error');
    } catch (error) {
      if (error.status === 401) return restart();
      toast(error.message, 'error');
      await refreshAdStatus();
    } finally {
      app.adBusy = false;
      renderEnergyButton();
    }
  }

  async function confirmAdEnergy() {
    const ad = app.ad;
    if (!ad || app.adBusy) return;
    if (Date.now() < ad.readyAt) {
      toast(`Посмотрите рекламу в чате — осталось ${Math.ceil((ad.readyAt - Date.now()) / 1000)} с`, 'error');
      return;
    }
    app.adBusy = true;
    try {
      const result = await api('/energy/ad/confirm', { method: 'POST', body: { token: ad.token } });
      app.ad = null;
      applyAdStatus(result.status);
      applyState(result.state);
      hideOverlay();
      haptic('success');
      toast(`⚡ Энергия восстановлена: +${fmt(result.restored)}`, 'success');
    } catch (error) {
      if (error.status === 401) return restart();
      toast(error.message, 'error');
      if (/уже учтён/.test(error.message)) app.ad = null;
    } finally {
      app.adBusy = false;
      renderEnergyButton();
    }
  }

  async function useBoost(boostId) {
    try {
      const result = await api('/boosts/use', { method: 'POST', body: { boostId } });
      applyState(result.state);
      haptic('success');
      toast(boostId === 'turbo' ? '🚀 Турбо: тап ×5' : '⚡ Энергия восстановлена', 'success');
    } catch (error) {
      if (error.status === 401) return restart();
      haptic('error');
      toast(error.message, 'error');
    }
  }

  async function claimDaily() {
    try {
      const result = await api('/daily/claim', { method: 'POST' });
      applyState(result.state);
      haptic('success');
      toast(`🎁 Бонус дня ${result.streak}: +${fmt(result.reward)} монет`, 'success');
    } catch (error) {
      if (error.status === 401) return restart();
      toast(error.message, 'error');
    }
  }

  // --- тапы ---

  function spawnFloat(x, y, text) {
    const box = $('floats');
    const rect = box.getBoundingClientRect();
    const node = document.createElement('span');
    node.className = 'float';
    node.textContent = text;
    node.style.left = `${x - rect.left}px`;
    node.style.top = `${y - rect.top}px`;
    box.appendChild(node);
    setTimeout(() => node.remove(), 900);
  }

  function onTap(event) {
    if (!app.state) return;
    if (app.view.energy <= 0) {
      // Текст показываем один раз на 10 секунд (кулдаун внутри toast), а хаптику и
      // дрожание полосы — не чаще раза в секунду, иначе тапание превращается в спам.
      const now = Date.now();
      if (now - lastEnergyWarningAt > 1000) {
        lastEnergyWarningAt = now;
        haptic('error');
        shakeEnergyBar();
      }
      toast('Энергия на нуле — жди восстановления или бери буст', 'error', {
        key: 'energy-empty',
        cooldownMs: 10000,
        ttlMs: 2400
      });
      return;
    }
    app.pending += 1;
    app.view.energy = Math.max(0, app.view.energy - 1);
    app.view.coins += app.state.tapValue;
    renderCounters();
    const x = event && event.clientX ? event.clientX : window.innerWidth / 2;
    const y = event && event.clientY ? event.clientY : window.innerHeight / 2;
    spawnFloat(x, y - 20, `+${fmt(app.state.tapValue)}`);
    haptic('light');
    queueFlush(app.pending >= FLUSH_TAPS);
    if (navigator.vibrate) navigator.vibrate(8);
  }

  // --- вкладки и подгрузка данных ---

  function switchTab(name) {
    app.tab = name;
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.screen === name);
    });
    document.querySelectorAll('.screen').forEach((screen) => {
      screen.classList.toggle('is-active', screen.id === `screen-${name}`);
    });
    if (name === 'quests') loadQuests();
    if (name === 'friends') loadFriends();
    if (name === 'top') loadTop();
  }

  async function loadFriends() {
    try {
      app.friends = await api('/friends');
      renderFriends();
    } catch (error) {
      if (error.status === 401) return restart();
      toast(error.message, 'error');
    }
  }

  async function loadTop() {
    try {
      app.top = await api('/leaderboard');
      renderTop();
    } catch (error) {
      if (error.status === 401) return restart();
      toast(error.message, 'error');
    }
  }

  async function refreshState() {
    // Профиль удалён или вход ещё не выполнен — новых запросов не делаем.
    if (app.closed || !app.state) return;
    try {
      const state = await api('/state');
      if (app.pending === 0) applyState(state);
    } catch (error) {
      if (error.status === 401) return restart();
    }
  }

  async function restart() {
    // После удаления профиля повторный вход не запускаем: приложение закрыто.
    if (app.closed) return;
    // Защита от лавины перезапусков, если сервер отвечает 401 на все запросы.
    if (app.restarting) return;
    app.restarting = true;
    localStorage.removeItem(TOKEN_KEY);
    app.token = null;
    app.pending = 0;
    overlay('Переподключаемся…', 'Обновляем сессию');
    try {
      await boot();
    } finally {
      app.restarting = false;
    }
  }

  async function copyInvite() {
    const link = app.friends && app.friends.link;
    if (!link) {
      toast('Ссылка недоступна: на сервере не задан BOT_USERNAME', 'error');
      return;
    }
    try {
      await navigator.clipboard.writeText(link);
      toast('Ссылка скопирована', 'success');
    } catch {
      toast(link);
    }
  }

  function shareInvite() {
    const link = app.friends && app.friends.link;
    if (!link) {
      toast('Ссылка недоступна: на сервере не задан BOT_USERNAME', 'error');
      return;
    }
    const text = 'Заходи в Hamster Tap — тапаем хомяка вместе!';
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
    if (tg && tg.openTelegramLink) tg.openTelegramLink(shareUrl);
    else window.open(shareUrl, '_blank');
  }

  // --- секундный тикер: регенерация энергии и отсчёт турбо ---

  function tick() {
    if (app.closed || !app.state) return;
    const { user } = app.state;
    if (app.view.energy < user.energyLimit) {
      // Оптимистично показываем регенерацию; сервер подтвердит её при синхронизации.
      app.view.energy = Math.min(user.energyLimit, app.view.energy + app.state.energyRegenPerSec);
      renderCounters();
      const percent = (app.view.energy / user.energyLimit) * 100;
      $('energyBar').style.width = `${Math.max(0, Math.min(100, percent))}%`;
      renderEnergyButton();
    }
    const active = turboActive();
    const left = active ? Math.ceil((app.turboEndsAt - Date.now()) / 1000) : 0;
    $('turboBadge').hidden = left <= 0;
    $('turboLeft').textContent = String(Math.max(0, left));
    $('hamster').classList.toggle('is-turbo', left > 0);

    const boostLeft = boostActive() ? Math.ceil((app.boostEndsAt - Date.now()) / 1000) : 0;
    $('boostBadge').hidden = boostLeft <= 0;
    $('boostLeft').textContent = String(Math.max(0, boostLeft));

    const boostWasActive = !!(app.state.tapBoost && app.state.tapBoost.active);
    if ((!active && app.state.boosts.turbo.active) || (!boostActive() && boostWasActive)) {
      // Турбо или премиум-буст закончились — берём актуальную цену тапа с сервера.
      refreshState();
    }

    // Обратный отсчёт кода дня (пока открыта вкладка «Задания»).
    if (app.tab === 'quests' && app.code) {
      app.code.expiresInMs = Math.max(0, app.code.expiresInMs - 1000);
      renderCode();
    }
  }

  // --- запуск ---

  async function boot() {
    if (tg) {
      try {
        tg.ready();
        tg.expand();
        if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
        if (tg.setHeaderColor) tg.setHeaderColor('#0f1220');
        if (tg.setBackgroundColor) tg.setBackgroundColor('#0f1220');
      } catch {
        /* старые клиенты не поддерживают часть методов */
      }
    }
    overlay('Подключаемся к игре…', 'Проверяем данные Telegram');
    try {
      const result = await authenticate();
      applyState(result.state);
      hideOverlay();
      // Состояние кнопки рекламы нужно сразу: по нему включаем пассивную рекламу
      // Monetag и предзагрузку ролика (обе операции необязательные и молчаливые).
      refreshAdStatus().then(() => startInAppAds());
      if (!result.reused && result.referralApplied) {
        toast(`🎁 Приветственный бонус: +${fmt(result.referralCoins)} монет`, 'success');
      }
      if (result.devMode) toast('Локальный режим: играем без Telegram');
      if (result.state.passiveCoins > 0) {
        overlay(
          'С возвращением! 👋',
          `Пока тебя не было: +${fmt(result.state.passiveCoins)} монет`,
          'Продолжить'
        );
        $('overlayBtn').onclick = hideOverlay;
      }
    } catch (error) {
      overlay('Не удалось войти', error.message || 'проверьте сервер', 'Повторить');
      $('overlayBtn').onclick = () => boot();
    }
  }

  // --- обработчики интерфейса ---

  $('hamster').addEventListener('pointerdown', onTap);
  $('hamster').addEventListener('contextmenu', (event) => event.preventDefault());
  $('dailyBtn').addEventListener('click', claimDaily);
  $('quickTurbo').addEventListener('click', () => useBoost('turbo'));
  $('quickEnergy').addEventListener('click', () => {
    // Энергия на исходе — предлагаем посмотреть рекламу (или подтвердить показ,
    // если игрок уже уходил в чат и вернулся).
    if (energyIsLow()) {
      if (app.ad) confirmAdEnergy();
      else requestAdEnergy();
      return;
    }
    useBoost('full_energy');
  });
  $('inviteBtn').addEventListener('click', shareInvite);
  $('copyBtn').addEventListener('click', copyInvite);
  // Свой профиль — по тапу на место в топе в шапке; карточка закрывается тапом мимо неё.
  $('rankChip').addEventListener('click', () => {
    if (app.state) openProfile(app.state.user.id);
  });
  $('sheetClose').addEventListener('click', closeSheet);
  $('sheetBackdrop').addEventListener('click', closeSheet);
  // Код дня: кнопка и Enter в поле ввода.
  $('codeBtn').addEventListener('click', submitCode);
  $('codeInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitCode();
    }
  });
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchTab(tab.dataset.screen));
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // Игрок ушёл из мини-аппа — скорее всего, читать рекламу в чате.
      if (app.ad) app.ad.leftApp = true;
      return;
    }
    // Вернулся: если ждём подтверждения показа — начисляем энергию, иначе просто
    // синхронизируем состояние.
    if (app.ad && app.ad.leftApp) confirmAdEnergy();
    else refreshState();
  });
  // В Telegram событие activated срабатывает при возврате в мини-апп — держим его
  // вместе с visibilitychange, чтобы подтверждение показа не потерялось.
  if (tg && tg.onEvent) {
    try {
      tg.onEvent('deactivated', () => {
        if (app.ad) app.ad.leftApp = true;
      });
      tg.onEvent('activated', () => {
        if (app.ad && app.ad.leftApp) confirmAdEnergy();
      });
    } catch {
      /* старые клиенты не поддерживают эти события */
    }
  }
  window.addEventListener('beforeunload', () => {
    // Досылаем накопленные тапы перед закрытием мини-аппа.
    if (!app.pending || !app.token) return;
    fetch('/api/tap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth': app.token },
      body: JSON.stringify({ count: app.pending }),
      keepalive: true
    }).catch(() => {});
  });

  // Точка доступа для автотестов (включается только при ?debug=1 в адресе):
  // браузерная проверка вызывает уведомления и считает их количество.
  if (new URLSearchParams(location.search).has('debug')) {
    window.__hamsterTap = {
      app,
      toast,
      render,
      shakeEnergyBar,
      openProfile,
      closeSheet,
      hideOverlay,
      loadQuests,
      claimQuest,
      submitCode,
      equipCosmetic,
      setNotify,
      buyItem,
      loadShop,
      requestAdEnergy,
      confirmAdEnergy,
      refreshAdStatus,
      preloadRewardedAd,
      startInAppAds,
      renderEnergyButton,
      toastCount: () => document.querySelectorAll('#toasts .toast').length,
      toastTexts: () => Array.from(document.querySelectorAll('#toasts .toast')).map((n) => n.textContent)
    };
  }

  // Идентификаторы таймеров храним: после удаления профиля их обязательно
  // остановить (см. shutdownAfterDelete), иначе приложение тихо авторизуется заново.
  app.timers.push(
    setInterval(tick, 1000),
    // Состояние синхронизируем раз в минуту: чаще не нужно (баланс обновляют
    // ответы действий), а лимиты бесплатного тарифа так расходуются экономно.
    setInterval(refreshState, 60000)
  );
  boot();
})();




