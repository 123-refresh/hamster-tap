'use strict';
// Браузерная проверка мини-аппа в headless Chrome (puppeteer-core из соседней
// папки m3test, как в других проектах на этой машине).
//   node tools/browser-check.js
// Проверяет: загрузку страницы без ошибок в консоли, авторизацию в локальном
// режиме, реакцию счётчика на тапы, отрисовку биржи, бустов и топ-листа,
// подсказку при покупке без монет. Скриншот — tools/shot-hamster.png.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8022;
const BASE = `http://localhost:${PORT}`;
// Если задан BASE_URL, тест работает против внешнего адреса (например, локального
// `wrangler dev` или облачного воркера) и свой сервер не поднимает.
const EXTERNAL_BASE = (process.env.BASE_URL || '').replace(/\/+$/, '');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-tap-browser-'));
const SHOT = path.join(__dirname, 'shot-hamster.png');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

let passed = 0;
const failures = [];

function check(name, condition, details = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${details ? ` — ${details}` : ''}`);
    console.log(`  FAIL ${name}${details ? ` — ${details}` : ''}`);
  }
}

// puppeteer-core лежит в соседнем проекте m3test (в этом проекте зависимостей нет).
function loadPuppeteer() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'puppeteer-core'),
    'c:\\Users\\user\\m3test\\node_modules\\puppeteer-core'
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  return require('puppeteer-core');
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        DB_PATH: path.join(tmpDir, 'browser.db'),
        BOT_TOKEN: '',
        BOT_USERNAME: 'demo_bot',
        ALLOW_DEV: '1',
        RUN_BOT: '',
        // Реклама в тестах: сеть не дёргаем, показ считаем успешным (Chanify), а
        // Monetag включён тестовой зоной — клиентский SDK подменяет заглушка.
        // Настройки In-App нужны, чтобы проверить включение пассивного формата.
        AD_MODE: 'stub',
        CHANIFY_API_KEY: 'stub-key',
        AD_PROVIDERS: 'monetag,chanify',
        MONETAG_ZONE: 'zonebrowser',
        MONETAG_SDK_URL: 'https://example.test/sdk.js',
        MONETAG_INAPP_SETTINGS: '2/0.1/30/5/0'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes(`http://localhost:${PORT}`)) resolve(child);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (!text.includes('ExperimentalWarning')) console.error('[server]', text.trim());
    });
    child.on('exit', (code) => reject(new Error(`сервер завершился с кодом ${code}`)));
    setTimeout(() => reject(new Error('сервер не поднялся за 15 секунд')), 15000);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Тапаем как игрок: синтетический pointerdown по кнопке-хомяку.
async function tapHamster(page, times) {
  const box = await page.$eval('#hamster', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  for (let i = 0; i < times; i += 1) {
    await page.evaluate(({ x, y }) => {
      document.getElementById('hamster').dispatchEvent(
        new PointerEvent('pointerdown', { clientX: x, clientY: y, bubbles: true })
      );
    }, box);
    await sleep(60);
  }
}

(async () => {
  console.log('Hamster Tap — браузерная проверка');
  const puppeteer = loadPuppeteer();
  const executablePath = CHROME_CANDIDATES.find((file) => fs.existsSync(file));
  if (!executablePath) {
    console.log('Chrome/Edge не найден — проверка пропущена.');
    process.exit(0);
  }

  const base = EXTERNAL_BASE || BASE;
  if (EXTERNAL_BASE) console.log(`  проверяем внешний адрес: ${base}`);
  const server = EXTERNAL_BASE ? null : await startServer();
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=420,880']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 880, deviceScaleFactor: 2 });
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(String(error)));
    page.on('console', (message) => {
      // Внешний скрипт telegram-web-app.js и favicon в офлайн-проверке недоступны —
      // это ожидаемо и не считается ошибкой приложения.
      const text = message.text();
      const ignorable = text.includes('telegram-web-app') || text.includes('favicon') ||
        text.includes('ERR_CONNECTION_TIMED_OUT') || text.includes('ERR_INTERNET_DISCONNECTED');
      if (message.type() === 'error' && !ignorable) consoleErrors.push(text);
    });

    await page.goto(`${base}/?debug=1`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(
      () => document.getElementById('levelName').textContent.length > 0,
      { timeout: 8000 }
    );
    // ?debug=1 открывает внутренние функции приложения (window.__hamsterTap):
    // они нужны проверкам кнопок покупки и карточки игрока.
    await page.waitForFunction(() => !!window.__hamsterTap, { timeout: 8000 });

    check('страница загрузилась без ошибок JS', consoleErrors.length === 0, consoleErrors.join(' | '));
    check(
      'авторизация прошла (лига показана)',
      (await page.$eval('#levelName', (el) => el.textContent)) === 'Бронза'
    );
    check('оверлей загрузки скрыт', await page.$eval('#overlay', (el) => !el.classList.contains('is-active')));

    await tapHamster(page, 12);
    await sleep(900);
    const coinsAfter = await page.$eval('#coins', (el) => el.textContent);
    const energyAfter = await page.$eval('#energy', (el) => Number(el.textContent.replace(/\s/g, '')));
    check('тапы увеличили счётчик монет', coinsAfter !== '0', `монеты: ${coinsAfter}`);
    check('тапы списали энергию', energyAfter < 1000, `энергия: ${energyAfter}`);

    const serverCoins = await page.evaluate(async () => {
      const token = localStorage.getItem('hamster-tap-token');
      const res = await fetch('/api/state', { headers: { 'X-Auth': token } });
      const data = await res.json();
      return data.user.coins;
    });
    check('сервер подтвердил начисление монет', serverCoins > 0, `на сервере ${serverCoins}`);

    // Достижение «первое касание» выдаётся вместе с ответом на тапы и показывается
    // всплывашкой — проверяем, пока уведомление ещё живо.
    const unlockToast = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.toast')).map((n) => n.textContent).join(' | ')
    );
    check('полученное достижение показано уведомлением', /Достижение/.test(unlockToast), unlockToast);

    await page.click('.tab[data-screen="cards"]');
    await page.waitForSelector('#cardsList .item', { timeout: 5000 });
    const cardsCount = await page.$$eval('#cardsList .item', (nodes) => nodes.length);
    check('биржа отрисовала карточки', cardsCount >= 6, `карточек: ${cardsCount}`);
    check('есть кнопки покупки', (await page.$$('#cardsList [data-card]')).length > 0);

    // Без монет кнопки покупки неактивны, и рядом видно, сколько именно не хватает.
    const buyState = await page.$$eval('#cardsList [data-card]', (nodes) =>
      nodes.map((node) => ({ disabled: node.disabled, text: node.closest('.item').textContent }))
    );
    check(
      'кнопки покупки неактивны без монет',
      buyState.length > 0 && buyState.every((entry) => entry.disabled === true),
      `кнопок: ${buyState.length}, активных: ${buyState.filter((entry) => !entry.disabled).length}`
    );
    check('рядом видно, сколько монет не хватает', buyState.some((entry) => /не хватает/.test(entry.text)), buyState[0]?.text);

    // Серверная проверка остаётся: прямой запрос без монет получает 402.
    const serverBuy = await page.evaluate(async () => {
      const token = localStorage.getItem('hamster-tap-token');
      const res = await fetch('/api/cards/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth': token },
        body: JSON.stringify({ cardId: 'memcoin' })
      });
      return res.status;
    });
    check('сервер отклоняет покупку без монет (402)', serverBuy === 402, `HTTP ${serverBuy}`);

    // Когда монет хватает, кнопка включается и подсказка у этой карточки исчезает.
    const richCards = await page.evaluate(() => {
      window.__hamsterTap.app.view.coins = 5000;
      window.__hamsterTap.render();
      const buttons = Array.from(document.querySelectorAll('#cardsList [data-card]'));
      return {
        enabled: buttons.filter((node) => !node.disabled).length,
        firstText: buttons[0] ? buttons[0].closest('.item').textContent : ''
      };
    });
    check('при достатке монет кнопки включаются', richCards.enabled >= 1, `активных: ${richCards.enabled}`);
    check('подсказка исчезает у доступной карточки', !/не хватает/.test(richCards.firstText), richCards.firstText);

    await page.click('.tab[data-screen="boosts"]');
    await page.waitForSelector('#boostsList .item', { timeout: 5000 });
    const boosts = await page.$$eval('#boostsList .item', (nodes) => nodes.length);
    check('бусты отрисованы (турбо + энергия)', boosts === 2, `блоков: ${boosts}`);

    // Прокачки ведут себя так же: без монет кнопка неактивна и объясняет нехватку
    // (баланс выставляем нулевой прямо перед чтением DOM — тапы его меняют).
    const upgState = await page.evaluate(() => {
      window.__hamsterTap.app.view.coins = 0;
      window.__hamsterTap.render();
      return Array.from(document.querySelectorAll('#upgradesList [data-upgrade]')).map((node) => ({
        disabled: node.disabled,
        text: node.closest('.item').textContent
      }));
    });
    check(
      'кнопки прокачек неактивны без монет',
      upgState.length === 2 && upgState.every((entry) => entry.disabled === true),
      `кнопок: ${upgState.length}, активных: ${upgState.filter((entry) => !entry.disabled).length}`
    );
    check(
      'прокачки объясняют нехватку монет',
      upgState.every((entry) => /не хватает/.test(entry.text)),
      upgState[0]?.text
    );

    await page.click('#boostsList [data-boost="full_energy"]');
    await sleep(900);
    const energyFull = await page.$eval('#energy', (el) => Number(el.textContent.replace(/\s/g, '')));
    // Буст доливает энергию до лимита; остаток в пару единиц возможен, если после
    // буста успела уйти пачка тапов — это нормальное поведение, а не ошибка.
    check(
      'буст энергии восстановил энергию',
      energyFull >= 980 && energyFull <= 1000,
      `энергия: ${energyFull}`
    );

    await page.click('.tab[data-screen="top"]');
    await page.waitForSelector('#topList .rank-row', { timeout: 5000 });
    const topRows = await page.$$eval('#topList .rank-row', (nodes) => nodes.length);
    check('лидерборд отрисован', topRows >= 1, `строк: ${topRows}`);
    // Счётчик достижений виден в списке ещё до нажатия на игрока.
    const rankAch = await page.$$eval('#topList .rank-row .rank-ach', (nodes) =>
      nodes.map((node) => node.textContent.trim())
    );
    check(
      'в топе виден счётчик достижений',
      rankAch.length === topRows && rankAch.every((text) => /^🏅 \d+$/.test(text)),
      rankAch.join(' | ')
    );

    await page.click('.tab[data-screen="friends"]');
    await page.waitForSelector('#friendsBadge', { timeout: 5000 });
    // Ссылку подгружает /api/friends — ждём ответ, а не читаем заглушку.
    await page
      .waitForFunction(
        () => /t\.me\//.test(document.getElementById('inviteLink').textContent),
        { timeout: 8000 }
      )
      .catch(() => {});
    const inviteLink = await page.$eval('#inviteLink', (el) => el.textContent);
    check('вкладка друзей показывает ссылку', inviteLink.includes('t.me/'), inviteLink);
    // Ссылка обязана содержать префикс ref_: без него сервер не начислит бонус.
    check('ссылка-приглашение содержит ref_', inviteLink.includes('startapp=ref_'), inviteLink);

    // Друг по ссылке: приветственный бонус сразу, а награда пригласившему — после
    // 100 тапов друга, поэтому в списке друзей видно прогресс.
    const inviterId = await page.evaluate(() => localStorage.getItem('hamster-tap-dev-id'));
    const friend = await page.evaluate(async (id) => {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          devId: 660000 + Math.floor(Math.random() * 100000),
          devName: 'Друг по ссылке',
          startParam: `ref_${id}`
        })
      });
      return res.json();
    }, inviterId);
    check(
      'друг по ссылке получил приветственный бонус',
      friend.referralApplied === true && friend.referralCoins === 25000,
      JSON.stringify({ applied: friend.referralApplied, coins: friend.referralCoins })
    );

    // Переоткрываем вкладку: список друзей тянется заново с сервера.
    await page.click('.tab[data-screen="tap"]');
    await page.click('.tab[data-screen="friends"]');
    await page
      .waitForFunction(() => /тапов до награды/.test(document.getElementById('friendsList').textContent), { timeout: 8000 })
      .catch(() => {});
    const pendingRows = await page.$$eval('#friendsList .rank-row', (nodes) => nodes.map((node) => node.textContent));
    check(
      'друг виден с прогрессом награды',
      pendingRows.some((text) => /0\/100 тапов до награды/.test(text)),
      pendingRows.join(' | ')
    );
    const friendsBadge = await page.$eval('#friendsBadge', (el) => el.textContent);
    check('бейдж друзей объясняет условие награды', /в пути:/.test(friendsBadge) && /100/.test(friendsBadge), friendsBadge);

    // Друг тапает до порога: награда пригласившему выплачивается и строка меняется
    // на «награда получена». Рывок античита — 40 тапов на запрос, между пачками ~2 с.
    for (let round = 0; round < 3; round += 1) {
      await page.evaluate(async (token) => {
        await fetch('/api/tap', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Auth': token },
          body: JSON.stringify({ count: 40 })
        });
        return true;
      }, friend.token);
      await sleep(2200);
    }
    await page.click('.tab[data-screen="tap"]');
    await page.click('.tab[data-screen="friends"]');
    await page
      .waitForFunction(() => /награда получена/.test(document.getElementById('friendsList').textContent), { timeout: 8000 })
      .catch(() => {});
    const paidRows = await page.$$eval('#friendsList .rank-row', (nodes) => nodes.map((node) => node.textContent));
    check(
      'друг доиграл — награда отмечена полученной',
      paidRows.some((text) => /награда получена/.test(text)),
      paidRows.join(' | ')
    );

    // Карточка другого игрока: «стена» достижений видна сразу под шапкой, а не за
    // прокруткой (раньше блок стоял после восьми плиток статистики и терялся).
    const otherPlayer = await page.evaluate(async () => {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devId: 880000 + Math.floor(Math.random() * 100000), devName: 'Сосед по топу' })
      });
      const data = await res.json();
      // Три тапа — и у соседа открыто достижение «Первое касание».
      await fetch('/api/tap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Auth': data.token },
        body: JSON.stringify({ count: 3 })
      });
      return data.state.user.id;
    });
    await page.evaluate((id) => window.__hamsterTap.openProfile(id), otherPlayer);
    await page.waitForSelector('#achBox .ach-chip', { timeout: 8000 });
    const wall = await page.evaluate(() => {
      const box = document.getElementById('achBox');
      const body = document.querySelector('#sheetBody .sheet-body');
      return {
        chips: box.querySelectorAll('.ach-chip').length,
        done: box.querySelectorAll('.ach-chip.is-done').length,
        locked: box.querySelectorAll('.ach-chip.is-locked').length,
        head: box.querySelector('h4').textContent,
        offset: Math.round(box.getBoundingClientRect().top - body.getBoundingClientRect().top),
        name: document.querySelector('#sheetBody .profile-name').textContent
      };
    });
    check('в чужой карточке «стена» из 12 достижений', wall.chips === 12, `чипов: ${wall.chips} (${wall.name})`);
    check(
      'открытые достижения ярко, остальные приглушены',
      wall.done >= 1 && wall.locked === 12 - wall.done,
      `открыто ${wall.done}, закрыто ${wall.locked}`
    );
    check('блок достижений виден без прокрутки', wall.offset < 260, `отступ от верха карточки: ${wall.offset}px`);
    check('в заголовке блока счётчик открытых', /открыто \d+ из 12/.test(wall.head), wall.head);
    // Удалять можно только свой профиль: в чужой карточке кнопки быть не должно.
    const foreignDanger = await page.$$eval('#sheetActions .btn-danger', (nodes) => nodes.length);
    check('в чужом профиле нет кнопки удаления', foreignDanger === 0, `кнопок: ${foreignDanger}`);

    // Игрок без достижений: стена рисуется, но все отметки приглушены.
    const newcomer = await page.evaluate(async () => {
      const res = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devId: 780000 + Math.floor(Math.random() * 100000), devName: 'Новичок' })
      });
      const data = await res.json();
      return data.state.user.id;
    });
    await page.evaluate((id) => window.__hamsterTap.openProfile(id), newcomer);
    await page.waitForSelector('#achBox .ach-chip', { timeout: 8000 });
    const emptyWall = await page.evaluate(() => ({
      chips: document.querySelectorAll('#achBox .ach-chip').length,
      done: document.querySelectorAll('#achBox .ach-chip.is-done').length,
      head: document.querySelector('#achBox h4').textContent
    }));
    check(
      'у новичка все 12 достижений приглушены',
      emptyWall.chips === 12 && emptyWall.done === 0,
      `чипов: ${emptyWall.chips}, открыто: ${emptyWall.done}`
    );
    check('счётчик показывает ноль', /открыто 0 из 12/.test(emptyWall.head), emptyWall.head);
    await page.evaluate(() => window.__hamsterTap.closeSheet());

    // --- задания, достижения, профиль и косметика ---
    // Сначала бонус дня: он делает задание «забери бонус дня» выполненным,
    // и его награду можно сдать кнопкой в списке заданий.
    await page.click('.tab[data-screen="tap"]');
    const dailyVisible = await page.$eval('#dailyCard', (el) => !el.hidden);
    check('карточка бонуса дня видна новому игроку', dailyVisible === true);
    await page.click('#dailyBtn');
    await sleep(1000);

    await page.click('.tab[data-screen="quests"]');
    await page.waitForSelector('#questsList .quest', { timeout: 8000 });
    const questRows = await page.$$eval('#questsList .quest', (nodes) => nodes.length);
    check('экран заданий отрисовал восемь пунктов', questRows === 8, `пунктов: ${questRows}`);

    const questProgress = await page.$$eval('#questsList .quest-bar-fill', (nodes) =>
      nodes.map((node) => node.style.width)
    );
    check('у заданий показан прогресс', questProgress.some((width) => width !== '0%'), questProgress.join(', '));

    const achRows = await page.$$eval('#achList .item', (nodes) => nodes.length);
    check('список достижений отрисован (12)', achRows === 12, `строк: ${achRows}`);
    const achDone = await page.$$eval('#achList .item:not(.is-locked)', (nodes) => nodes.length);
    check('есть уже полученные достижения', achDone >= 1, `получено: ${achDone}`);

    // Код дня: неверный код объясняет ошибку, верный — начисляет награду и закрывает карточку.
    const codeLib = require(path.join(ROOT, 'lib', 'dailycode'));
    const dayCode = codeLib.codeFor(new Date().toISOString().slice(0, 10));
    check('карточка кода дня показана', await page.$eval('#codeCard', (el) => !el.hidden));

    await page.$eval('#codeInput', (el, value) => { el.value = value; }, 'ZZZZZZ');
    await page.click('#codeBtn');
    await sleep(1000);
    const badCodeToast = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.toast')).map((node) => node.textContent).join(' | ')
    );
    check('неверный код дня объясняет ошибку', /код не подходит/i.test(badCodeToast), badCodeToast);

    await page.$eval('#codeInput', (el, value) => { el.value = value; }, dayCode);
    await page.click('#codeBtn');
    await sleep(1400);
    const codeToast = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.toast')).map((node) => node.textContent).join(' | ')
    );
    check('верный код дня принимается клиентом', /Код принят/i.test(codeToast), codeToast);
    const codeCardState = await page.evaluate(() => ({
      claimed: document.getElementById('codeCard').classList.contains('is-claimed'),
      inputDisabled: document.getElementById('codeInput').disabled === true,
      status: document.getElementById('codeStatus').textContent
    }));
    check(
      'после кода карточка помечена использованной',
      codeCardState.claimed === true && codeCardState.inputDisabled === true,
      JSON.stringify(codeCardState)
    );

    const claimButton = await page.$('#questsList [data-quest="daily_bonus"]');
    check('задание «забери бонус дня» готово к сдаче', !!claimButton);
    if (claimButton) {
      const coinsBeforeQuest = await page.$eval('#coins', (el) => el.textContent);
      await claimButton.click();
      await sleep(1200);
      const coinsAfterQuest = await page.$eval('#coins', (el) => el.textContent);
      check('награда за задание начислена', coinsAfterQuest !== coinsBeforeQuest, `${coinsBeforeQuest} -> ${coinsAfterQuest}`);
      const questToast = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.toast')).map((node) => node.textContent).join(' | ')
      );
      check('показано уведомление о награде', /Награда/i.test(questToast), questToast);
    }

    // Приглашение друга (блок друзей выше) закрывает задание дня: метрика считается
    // по времени привязки, поэтому «Пригласи друга сегодня» готово к сдаче.
    const inviteQuest = await page.$('#questsList [data-quest="invite_1"]');
    check('задание «пригласи друга» готово к сдаче', !!inviteQuest);
    if (inviteQuest) {
      await inviteQuest.click();
      await sleep(1200);
      const inviteToast = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.toast')).map((node) => node.textContent).join(' | ')
      );
      check('награда за приглашённого друга начислена', /Награда/i.test(inviteToast), inviteToast);
    }

    // Значок вкладки прячется, когда забирать больше нечего. Награды за друзей
    // подтягивают другие задания (например, «заработай сегодня»), поэтому забираем
    // все доступные награды, а не только первую.
    for (let round = 0; round < 6; round += 1) {
      const ids = await page.$$eval('#questsList [data-quest]', (nodes) => nodes.map((node) => node.dataset.quest));
      if (!ids.length) break;
      for (const id of ids) {
        await page.click(`#questsList [data-quest="${id}"]`).catch(() => {});
        await sleep(800);
      }
    }
    const badgeAfterAll = await page.$eval('#questsBadge', (el) => el.hidden);
    const badgeText = await page.$eval('#questsBadge', (el) => el.textContent);
    check('значок вкладки скрыт, когда наград нет', badgeAfterAll === true, badgeText);

    const claimedRows = await page.$$eval('#questsList .quest.is-claimed', (nodes) => nodes.length);
    check('сданное задание отмечено как полученное', claimedRows >= 1, `сдано: ${claimedRows}`);

    // Карточка игрока: чужая (из топа) и своя (по чипу места в шапке).
    await page.click('.tab[data-screen="top"]');
    await page.waitForSelector('#topList .rank-row', { timeout: 8000 });
    // Прокручиваем страницу наверх и кликаем по строке через JS: кнопки-уведомления
    // могут перекрывать строку, а нам нужен именно обработчик клика.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.$eval('#topList .rank-row', (el) => el.click());
    await page.waitForSelector('#sheet .profile-head', { timeout: 8000 });
    const sheetStats = await page.$$eval('#sheet .stat', (nodes) => nodes.length);
    check('карточка игрока показывает восемь показателей', sheetStats === 8, `блоков: ${sheetStats}`);
    const sheetText = await page.$eval('#sheetBody', (el) => el.textContent);
    check('в карточке есть монеты, место и достижения', /Монеты/.test(sheetText) && /Место в топе/.test(sheetText));
    check('в карточке нет технического tg_id', !/tg_?id/i.test(sheetText));

    await page.click('#sheetClose');
    await sleep(300);
    check('карточка закрывается', await page.$eval('#sheet', (el) => el.hidden === true));

    await page.click('#rankChip');
    await page.waitForSelector('#sheet .cos-item', { timeout: 8000 });
    const cosItems = await page.$$eval('#sheet .cos-item', (nodes) => nodes.length);
    check('в своём профиле видна вся косметика (22)', cosItems === 22, `предметов: ${cosItems}`);
    const cosLocked = await page.$$eval('#sheet .cos-item.is-locked', (nodes) => nodes.length);
    check('закрытая косметика помечена', cosLocked > 0, `закрыто: ${cosLocked}`);
    const cosActive = await page.$$eval('#sheet .cos-item.is-active', (nodes) => nodes.length);
    check('надетые предметы отмечены (по одному на тип)', cosActive === 4, `активных: ${cosActive}`);

    // --- магазин за звёзды в карточке игрока ---
    await page.waitForSelector('#shopList [data-good]', { timeout: 8000 });
    const shopRows = await page.$$eval('#shopList .item', (nodes) => nodes.length);
    check('в магазине четыре товара (наборы монет и буст)', shopRows === 4, `товаров: ${shopRows}`);
    const shopPrices = await page.$$eval('#shopList [data-good]', (nodes) => nodes.map((node) => node.textContent.trim()));
    check(
      'у товаров показана цена в звёздах',
      shopPrices.length === 4 && shopPrices.every((text) => /^⭐\s?\d+$/.test(text)),
      shopPrices.join(', ')
    );
    const premiumPrices = await page.$$eval('#sheet .cos-item span:last-child', (nodes) =>
      nodes.map((node) => node.textContent).filter((text) => /^⭐/.test(text))
    );
    check('премиум-косметика продаётся за звёзды в «Стиле»', premiumPrices.length === 5, `с ценой: ${premiumPrices.length}`);
    const purchasesText = await page.$eval('#purchasesBox', (el) => el.textContent);
    check('история покупок показана', /Покупок пока нет/.test(purchasesText), purchasesText);

    // Вне настоящего Telegram оплата не проходит: клиент должен честно сказать об этом
    // (в headless-браузере Telegram WebApp — заглушка, поэтому ответ приходит с сервера).
    await page.$eval('#sheet .cos-item[data-item="hamster_diamond"]', (el) => el.click());
    await sleep(700);
    const payToast = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.toast')).map((node) => node.textContent).join(' | ')
    );
    check(
      'покупка вне Telegram сообщает об ошибке, а не молчит',
      /оплата недоступна|только внутри Telegram/i.test(payToast),
      payToast
    );

    const switches = await page.$$eval('#notifyBox .switch', (nodes) => nodes.length);
    check('в профиле три переключателя напоминаний', switches === 3, `переключателей: ${switches}`);
    const switchWasOn = await page.$eval('#notifyBox .switch', (el) => el.classList.contains('is-on'));
    await page.click('#notifyBox .switch');
    await sleep(900);
    const switchNowOn = await page.$eval('#notifyBox .switch', (el) => el.classList.contains('is-on'));
    check('переключатель меняет состояние', switchWasOn !== switchNowOn);
    const notifySaved = await page.evaluate(async () => {
      const token = localStorage.getItem('hamster-tap-token');
      const res = await fetch('/api/state', { headers: { 'X-Auth': token } });
      const data = await res.json();
      return data.notify;
    });
    check(
      'настройка напоминаний сохраняется на сервере',
      Object.values(notifySaved).some((value) => value === false),
      JSON.stringify(notifySaved)
    );

    const sheetActions = await page.$$eval('#sheetActions .btn', (nodes) => nodes.length);
    check('в своём профиле есть кнопка «поделиться»', sheetActions >= 1);
    const ownDanger = await page.$$eval('#sheetActions .btn-danger', (nodes) => nodes.length);
    check('в своём профиле есть кнопка удаления', ownDanger === 1, `кнопок: ${ownDanger}`);
    await page.click('#sheetClose');
    await sleep(300);

    // --- уведомления: без спама и не мешают обзору ---
    // Открываем ту же страницу с ?debug=1: так доступны внутренние функции (toast и счётчики).
    await page.goto(`${base}/?debug=1`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => !!window.__hamsterTap, { timeout: 8000 });

    // 1. Положение: уведомления должны быть в нижней половине экрана, а не поверх шапки.
    await page.evaluate(() => window.__hamsterTap.toast('тест-низ', 'success', { key: 'low', ttlMs: 1500 }));
    await sleep(200);
    const toastRect = await page.$eval('#toasts .toast', (el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, innerHeight: window.innerHeight };
    });
    check(
      'уведомления не закрывают шапку (нижняя часть экрана)',
      toastRect.top > toastRect.innerHeight / 2,
      `top=${Math.round(toastRect.top)} из ${toastRect.innerHeight}`
    );

    // 2. Лимит: одновременно на экране не больше трёх уведомлений.
    await page.evaluate(() => {
      for (let i = 0; i < 6; i += 1) {
        window.__hamsterTap.toast(`лимит-${i}`, 'success', { key: `limit-${i}`, ttlMs: 4000 });
      }
    });
    await sleep(250);
    const manyToasts = await page.evaluate(() => window.__hamsterTap.toastCount());
    check('на экране не больше трёх уведомлений', manyToasts <= 3, `уведомлений: ${manyToasts}`);

    // 3. Дедупликация: одинаковый текст не плодит узлы, а показывает счётчик повторов.
    await page.evaluate(() => {
      for (let i = 0; i < 3; i += 1) {
        window.__hamsterTap.toast('одно и то же', 'error', { key: 'dupe', cooldownMs: 0, ttlMs: 4000 });
      }
    });
    await sleep(250);
    const dupes = await page.evaluate(() =>
      window.__hamsterTap.toastTexts().filter((text) => text.includes('одно и то же'))
    );
    check('одинаковые уведомления не дублируются', dupes.length === 1, `узлов: ${dupes.length}`);
    check('повтор показан счётчиком', (dupes[0] || '').includes('×3'), dupes[0] || '');

    // 4. Кулдаун: после исчезновения тот же текст в окне кулдауна не показывается вовсе.
    await page.evaluate(() =>
      window.__hamsterTap.toast('редкое', 'error', { key: 'cool', cooldownMs: 4000, ttlMs: 200 })
    );
    await sleep(700);
    await page.evaluate(() =>
      window.__hamsterTap.toast('редкое', 'error', { key: 'cool', cooldownMs: 4000, ttlMs: 200 })
    );
    await sleep(200);
    const cooled = await page.evaluate(() =>
      window.__hamsterTap.toastTexts().filter((text) => text.includes('редкое')).length
    );
    check('кулдаун гасит повтор того же текста', cooled === 0, `уведомлений: ${cooled}`);

    // 5. Самоисчезновение: старое уведомление не виснет, когда приходит новое
    //    (раньше таймер был общий, и предыдущие сообщения оставались на экране).
    await page.evaluate(() => {
      window.__hamsterTap.toast('первое', 'success', { key: 'first', ttlMs: 500 });
      setTimeout(() => window.__hamsterTap.toast('второе', 'success', { key: 'second', ttlMs: 500 }), 200);
    });
    await sleep(1300);
    // Считаем только уведомления этого шага: ниже в очереди могут ещё жить
    // сообщения от предыдущих проверок с большим временем жизни.
    const leftover = await page.evaluate(() =>
      window.__hamsterTap
        .toastTexts()
        .filter((text) => text.includes('первое') || text.includes('второе')).length
    );
    check('уведомления исчезают сами, зависших нет', leftover === 0, `осталось: ${leftover}`);

    // 6. Нулевая энергия: один тост вместо потока одинаковых сообщений на каждый тап.
    await page.evaluate(() => {
      window.__hamsterTap.app.view.energy = 0;
      const box = document.getElementById('hamster').getBoundingClientRect();
      const opts = { clientX: box.x + 10, clientY: box.y + 10, bubbles: true };
      for (let i = 0; i < 6; i += 1) {
        document.getElementById('hamster').dispatchEvent(new PointerEvent('pointerdown', opts));
      }
    });
    await sleep(250);
    const energyToasts = await page.evaluate(() =>
      window.__hamsterTap.toastTexts().filter((text) => text.includes('Энергия на нуле'))
    );
    check('при нулевой энергии ровно одно уведомление', energyToasts.length === 1, `уведомлений: ${energyToasts.length}`);
    check('повторы свёрнуты в счётчик', (energyToasts[0] || '').includes('×'), energyToasts[0] || '');

    // --- энергия за рекламу (Monetag + запасной Chanify) ---
    // Энергию обнуляем и в базе сервера, и в представлении клиента: иначе при
    // следующей синхронизации клиент получит полную энергию и кнопка вернётся к
    // обычному бусту. Реального SDK Monetag в тестах нет — подменяем функцию
    // показа: клиент ищет глобальную show_<зона> и зовёт её.
    const devIdForAd = await page.evaluate(() => Number(localStorage.getItem('hamster-tap-dev-id')));
    const { DatabaseSync: AdDb } = require('node:sqlite');
    const adGame = require(path.join(ROOT, 'lib', 'game'));
    const adDb = new AdDb(path.join(tmpDir, 'browser.db'));
    adDb.prepare('UPDATE users SET energy = 0 WHERE tg_id = ?').run(devIdForAd);
    adDb.close();
    await page.evaluate(() => {
      window.__hamsterTap.hideOverlay();
      window.__adFail = false;
      window.__adOptions = null;
      window.__adPreloads = [];
      window.__adInApp = null;
      // Заглушка SDK Monetag: сеть создаёт глобальную show_<зона>, поэтому подменяем
      // её саму и запоминаем параметры вызовов. type: 'end' — rewarded-ролик,
      // 'preload' — предзагрузка, 'inApp' — пассивный формат.
      window.show_zonebrowser = (options) => {
        const call = options || {};
        if (call.type === 'preload') {
          window.__adPreloads.push(call);
          return Promise.resolve({});
        }
        if (call.type === 'inApp') {
          window.__adInApp = call.inAppSettings || null;
          return Promise.resolve({});
        }
        window.__adOptions = call;
        return Promise.resolve(window.__adFail ? { reward_event_type: 'non_valued' } : { reward_event_type: 'valued' });
      };
      window.__hamsterTap.app.view.energy = 0;
      window.__hamsterTap.app.state.user.energy = 0;
      window.__hamsterTap.app.adReadyAt = 0;
      window.__hamsterTap.app.adStatus = null;
      window.__hamsterTap.renderEnergyButton();
    });
    await sleep(400);
    const adButton = await page.evaluate(() => ({
      disabled: document.getElementById('quickEnergy').disabled,
      emoji: document.getElementById('quickEnergyEmoji').textContent,
      title: document.getElementById('quickEnergyTitle').textContent,
      note: document.getElementById('quickEnergyNote').textContent
    }));
    check(
      'при пустой энергии кнопка предлагает рекламу',
      adButton.emoji === '📺' && adButton.title === 'За рекламу',
      JSON.stringify(adButton)
    );
    check('подсказка говорит, что лимита нет', /без лимита|через/.test(adButton.note), adButton.note);

    // Ролик Monetag: заглушка SDK сообщает об успешном просмотре, поэтому энергия
    // возвращается сразу — без чата и без ожидания.
    await page.click('#quickEnergy');
    await sleep(1200);
    const adRewarded = await page.evaluate(() => ({
      options: window.__adOptions,
      preloads: window.__adPreloads,
      overlay: document.getElementById('overlay').classList.contains('is-active'),
      energy: window.__hamsterTap.app.view.energy,
      pending: !!window.__hamsterTap.app.ad,
      title: document.getElementById('quickEnergyTitle').textContent,
      toasts: window.__hamsterTap.toastTexts()
    }));
    check(
      'после ролика энергия восстановлена сразу',
      adRewarded.energy > 0 && adRewarded.pending === false && adRewarded.title === 'Энергия',
      JSON.stringify(adRewarded)
    );
    check(
      'в SDK ушёл одноразовый токен показа',
      !!adRewarded.options && adRewarded.options.type === 'end' && !!adRewarded.options.ymid &&
        adRewarded.options.catchIfNoFeed === true && adRewarded.options.requestVar === 'energy_button',
      JSON.stringify(adRewarded.options)
    );
    check(
      'ролик предзагружался до показа',
      Array.isArray(adRewarded.preloads) && adRewarded.preloads.length >= 1 &&
        adRewarded.preloads[0].type === 'preload',
      JSON.stringify(adRewarded.preloads)
    );

    // Пассивный формат: настройки приходят из состояния кнопки и уходят в SDK один раз.
    const adInApp = await page.evaluate(async () => {
      await window.__hamsterTap.startInAppAds();
      return window.__adInApp;
    });
    check(
      'пассивная реклама включается с настройками кабинета',
      !!adInApp && adInApp.frequency === 2 && adInApp.capping === 0.1 && adInApp.interval === 30 &&
        adInApp.timeout === 5 && adInApp.everyPage === false,
      JSON.stringify(adInApp)
    );

    // Каскад: сеть не зачла показ (заглушка отдаёт non_valued) — клиент пропускает
    // Monetag, и реклама уходит в чат. Паузу от прошлой награды снимаем прямо в
    // базе, иначе кнопка осталась бы заблокированной.
    const adDbChat = new AdDb(path.join(tmpDir, 'browser.db'));
    adDbChat.prepare('UPDATE users SET energy = 0 WHERE tg_id = ?').run(devIdForAd);
    adDbChat
      .prepare('UPDATE ad_rewards SET credited_at = 0, at = 0 WHERE user_id = (SELECT id FROM users WHERE tg_id = ?)')
      .run(devIdForAd);
    adDbChat.close();
    await page.evaluate(() => {
      window.__adFail = true;
      window.__hamsterTap.app.view.energy = 0;
      window.__hamsterTap.app.state.user.energy = 0;
      window.__hamsterTap.app.adReadyAt = 0;
      window.__hamsterTap.app.adStatus = null;
      window.__hamsterTap.renderEnergyButton();
    });
    await page.click('#quickEnergy');
    await sleep(1200);
    const adPending = await page.evaluate(() => ({
      overlay: document.getElementById('overlay').classList.contains('is-active'),
      title: document.getElementById('overlayTitle').textContent,
      pending: !!window.__hamsterTap.app.ad,
      disabled: document.getElementById('quickEnergy').disabled,
      toasts: window.__hamsterTap.toastTexts()
    }));
    check(
      'если сеть не зачла показ, реклама уходит в чат',
      adPending.pending === true && /Реклама в чате/.test(adPending.title),
      `${adPending.title} | тосты: ${adPending.toasts.join(' / ')}`
    );
    check('на время паузы кнопка заблокирована', adPending.disabled === true);

    // Игрок вернулся из чата: сервер требует обязательной паузы, но в тесте её
    // незачем ждать — сдвигаем время выдачи в базе и подтверждаем показ.
    const adChatToken = await page.evaluate(() => (window.__hamsterTap.app.ad || {}).token);
    const adDbConfirm = new AdDb(path.join(tmpDir, 'browser.db'));
    adDbConfirm
      .prepare('UPDATE ad_rewards SET at = at - ? WHERE token = ?')
      .run(adGame.GAME.adEnergy.confirmDelayMs + 1000, String(adChatToken));
    adDbConfirm.close();
    const adResult = await page.evaluate(async () => {
      window.__hamsterTap.app.ad.readyAt = Date.now() - 1000;
      await window.__hamsterTap.confirmAdEnergy();
      return {
        energy: window.__hamsterTap.app.view.energy,
        pending: !!window.__hamsterTap.app.ad,
        title: document.getElementById('quickEnergyTitle').textContent
      };
    });
    check(
      'после подтверждения энергия восстановлена',
      adResult.energy > 0 && adResult.pending === false,
      JSON.stringify(adResult)
    );
    check('кнопка вернулась в обычный режим', adResult.title === 'Энергия', adResult.title);

    // Возвращаем энергию, чтобы скриншот был «живым», и ждём обновления счётчиков.
    await page.evaluate(() => {
      window.__hamsterTap.app.view.energy = window.__hamsterTap.app.state.user.energyLimit;
    });
    await page.click('.tab[data-screen="tap"]');
    await sleep(1200);
    await page.screenshot({ path: SHOT });
    check('скриншот сохранён', fs.existsSync(SHOT));

    // Доставка приглашения: если мини-апп открыт по адресу со startapp (прямая ссылка
    // или кнопка бота), параметр тоже обязан дойти до сервера — раньше он читался
    // только из initData Telegram и приглашение молча терялось. Новая страница в
    // отдельном контексте — это «новое устройство» с чистым localStorage.
    const guestContext = browser.createBrowserContext ? await browser.createBrowserContext() : null;
    const guest = guestContext ? await guestContext.newPage() : await browser.newPage();
    await guest.goto(`${base}/?debug=1&startapp=ref_${inviterId}`, { waitUntil: 'networkidle2' });
    await guest.waitForFunction(() => document.getElementById('coins').textContent !== '', { timeout: 8000 }).catch(() => {});
    await sleep(600);
    const guestToast = await guest.evaluate(() =>
      Array.from(document.querySelectorAll('.toast')).map((node) => node.textContent).join(' | ')
    );
    check('приглашение из адреса страницы доходит до сервера', /Приветственный бонус/.test(guestToast), guestToast);
    const guestCoins = await guest.$eval('#coins', (el) => el.textContent);
    check('приглашённый видит бонус на балансе', guestCoins !== '0', `монеты: ${guestCoins}`);
    await guest.close();
    if (guestContext) await guestContext.close();

    // --- удаление профиля ---
    // Сценарий целиком: подтверждение можно отменить, а после согласия приложение
    // поднимается заново с пустым профилем, и старая сессия перестаёт работать.
    await page.goto(`${base}/?debug=1`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => !!window.__hamsterTap, { timeout: 8000 });
    const ownId = await page.evaluate(() => window.__hamsterTap.app.state.user.id);
    const tokenBefore = await page.evaluate(() => localStorage.getItem('hamster-tap-token'));
    await page.evaluate((id) => window.__hamsterTap.openProfile(id), ownId);
    await page.waitForSelector('#sheetActions .btn-danger', { timeout: 8000 });

    await page.click('#sheetActions .btn-danger');
    await page.waitForSelector('#deleteActions .btn', { timeout: 5000 });
    const confirmLabels = await page.$$eval('#deleteActions .btn', (nodes) => nodes.map((node) => node.textContent));
    check('подтверждение удаления предлагает отмену и удаление', confirmLabels.length === 2, confirmLabels.join(' | '));

    await page.click('#deleteActions .btn-ghost');
    await page.waitForSelector('#sheetBody .profile-name', { timeout: 8000 });
    const backName = await page.$eval('#sheetBody .profile-name', (el) => el.textContent.trim());
    check('отмена возвращает в профиль', backName.length > 0, backName);

    await page.click('#sheetActions .btn-danger');
    await page.waitForSelector('#deleteActions .btn-danger', { timeout: 5000 });
    await page.click('#deleteActions .btn-danger');
    // В headless Chrome Telegram-клиента нет, поэтому tg.close() недоступен: клиент
    // показывает прощание и больше не авторизуется сам (иначе молча создался бы
    // новый профиль).
    await page
      .waitForFunction(() => document.getElementById('overlay').classList.contains('is-active'), { timeout: 8000 })
      .catch(() => {});
    const farewell = await page.evaluate(() => ({
      active: document.getElementById('overlay').classList.contains('is-active'),
      title: document.getElementById('overlayTitle').textContent,
      token: localStorage.getItem('hamster-tap-token'),
      ref: localStorage.getItem('hamster-tap-ref'),
      sheetHidden: document.getElementById('sheet').hidden
    }));
    check(
      'после удаления показан экран прощания',
      farewell.active && /Профиль удалён/.test(farewell.title),
      `${farewell.active}: ${farewell.title}`
    );
    check(
      'токен и ссылка-приглашение убраны из памяти',
      farewell.token === null && farewell.ref === null,
      JSON.stringify({ token: farewell.token, ref: farewell.ref })
    );
    check('экран профиля закрыт', farewell.sheetHidden === true);
    // Ждём пару секунд: приложение закрыто и не должно авторизоваться заново.
    await sleep(2500);
    const silentToken = await page.evaluate(() => localStorage.getItem('hamster-tap-token'));
    check('повторная авторизация не запускается', silentToken === null, String(silentToken));
    const oldTokenStatus = await page.evaluate(async (token) => {
      const res = await fetch('/api/state', { headers: { 'X-Auth': token } });
      return res.status;
    }, tokenBefore);
    check('сессия удалённого профиля удалена (401)', oldTokenStatus === 401, `HTTP ${oldTokenStatus}`);
  } finally {
    await browser.close();
    if (server) server.kill();
    await sleep(400);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* на Windows файлы SQLite освобождаются позже — для теста не критично */
    }
  }

  console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
  if (failures.length) {
    for (const failure of failures) console.log(` - ${failure}`);
    process.exit(1);
  }
  console.log('Браузерная проверка пройдена.');
})();

