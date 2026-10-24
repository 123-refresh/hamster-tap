'use strict';
// Логика внешней страницы оплаты: забирает личный токен из адреса (?t=...), просит
// сервер создать платёж и ведёт игрока к оплате ЮKassa. Ключей провайдера тут нет.
//
// Адрес API: тот же домен, что у страницы, либо data-api / ?api= (если страница
// лежит на своём домене, а API — на воркере).
(function () {
  const params = new URLSearchParams(location.search);
  const script = document.currentScript;
  const API = (params.get('api') || (script && script.dataset.api) || location.origin).replace(/\/+$/, '');
  const TOKEN = params.get('t') || '';
  const statusEl = document.getElementById('status');
  const itemsEl = document.getElementById('items');
  const playerEl = document.getElementById('player');
  const emailEl = document.getElementById('email');
  const receiptBox = document.getElementById('receiptBox');
  const hintEl = document.getElementById('hint');
  let email = '';

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = `status${kind ? ` ${kind}` : ''}`;
  }

  async function api(path, options = {}) {
    const url = `${API}/api/pay/${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(TOKEN)}`;
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function renderItems(items) {
    itemsEl.innerHTML = '';
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'item';

      const emoji = document.createElement('span');
      emoji.className = 'emoji';
      emoji.textContent = item.emoji || '🎁';

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = item.title;

      const price = document.createElement('span');
      price.className = 'price';
      price.textContent = item.priceText;

      row.append(emoji, title, price);
      if (item.owned) {
        const owned = document.createElement('span');
        owned.className = 'owned';
        owned.textContent = 'уже есть';
        row.append(owned);
      } else {
        const buy = document.createElement('button');
        buy.type = 'button';
        buy.textContent = 'Оплатить';
        buy.addEventListener('click', () => buyItem(item, buy));
        row.append(buy);
      }
      itemsEl.append(row);
    }
  }

  async function buyItem(item, button) {
    button.disabled = true;
    setStatus('Создаём платёж…');
    try {
      const created = await api('create', { method: 'POST', body: { itemId: item.id, email } });
      setStatus('Переходим к оплате…');
      // Ссылку даёт ЮKassa: игрок платит на её странице, а товар выдаст уведомление.
      location.href = created.payUrl;
    } catch (error) {
      button.disabled = false;
      setStatus(`Не удалось создать платёж: ${error.message}`, 'err');
    }
  }

  // Пока страница открыта, проверяем статус последнего платежа: товар выдаётся
  // уведомлением, но клиенту приятнее увидеть подтверждение самому.
  async function watch(paymentId) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        const { payment } = await api(`status?id=${encodeURIComponent(paymentId)}`);
        if (payment && payment.status === 'succeeded') {
          setStatus(`Готово: «${payment.title}» зачислен в игру 🎉`, 'ok');
          return;
        }
        if (payment && payment.status !== 'pending') {
          setStatus(`Платёж в статусе «${payment.status}»`, 'err');
          return;
        }
        setStatus('Ждём подтверждение оплаты…', 'wait');
      } catch (error) {
        setStatus(`Не удалось узнать статус: ${error.message}`, 'err');
        return;
      }
    }
    setStatus('Оплата ещё не подтверждена. Если деньги списались — напишите в /paysupport.', 'wait');
  }

  async function boot() {
    if (!TOKEN) {
      setStatus('Откройте эту страницу по ссылке из бота — команда /buy.', 'err');
      playerEl.textContent = 'Ссылка не указана';
      return;
    }
    try {
      const info = await api('info');
      playerEl.textContent = `Игрок: ${info.player}`;
      emailEl.addEventListener('change', () => { email = emailEl.value.trim(); });
      // Поле для чека показываем только там, где чеки действительно нужны.
      receiptBox.classList.toggle('hidden', !info.receipts);
      renderItems(info.items);
      const minutes = Math.max(1, Math.round((info.expiresAt - Date.now()) / 60000));
      hintEl.textContent = `Ссылка личная. Действует ещё ~${minutes} мин: после этого обновите её командой /buy в боте.`;
      setStatus('Выберите товар — оплата картой или СБП.', '');
    } catch (error) {
      setStatus(`Ссылка не работает: ${error.message}`, 'err');
      playerEl.textContent = 'Откройте новую ссылку в боте (/buy)';
    }
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
