'use strict';
// Проверка API воркера Cloudflare — по локальному адресу разработки или по боевому.
//
//   node tools/cf-check.js                          # локальный wrangler dev (localhost:8787)
//   node tools/cf-check.js https://hamster-tap.xxx.workers.dev
//
// Логин без Telegram работает только там, где включён ALLOW_DEV=1 (локально и staging),
// поэтому на проде проверяются только health, страница и защита без токена.
const BASE = (process.argv[2] || 'http://localhost:8787').replace(/\/+$/, '');

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

async function call(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Auth'] = token;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
}

(async () => {
  console.log(`Hamster Tap — проверка воркера: ${BASE}`);

  const health = await call('/api/health');
  check('GET /api/health отвечает', health.status === 200 && health.data.ok === true, `HTTP ${health.status}`);
  check(
    'health сообщает рантайм',
    !health.data.runtime || health.data.runtime === 'cloudflare-workers',
    String(health.data.runtime)
  );

  const page = await fetch(BASE);
  const html = await page.text();
  check('страница мини-аппа отдаётся', page.status === 200 && html.includes('telegram-web-app'), `HTTP ${page.status}`);
  check('клиент подключён', html.includes('app.js'));

  const css = await fetch(`${BASE}/styles.css`);
  check('статика styles.css отдаётся', css.status === 200, `HTTP ${css.status}`);

  const noAuth = await call('/api/state');
  check('без токена /api/state -> 401', noAuth.status === 401, `HTTP ${noAuth.status}`);

  const unknown = await call('/api/nope');
  check('неизвестный маршрут -> 404', unknown.status === 404, `HTTP ${unknown.status}`);

  const webhook = await fetch(`${BASE}/webhook/wrong-secret`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  });
  check('чужой секрет webhook отклоняется', webhook.status === 403, `HTTP ${webhook.status}`);

  if (!health.data.devMode) {
    console.log('\n  (прод-режим: вход без Telegram выключен, проверки авторизации пропущены)');
  } else {
    // Каждый прогон — новый игрок, иначе повторные проверки бустов и бонуса дня
    // упираются в уже израсходованные лимиты.
    const devId = 400000 + Math.floor(Math.random() * 500000);
    const auth = await call('/api/auth', {
      method: 'POST',
      body: { devId, devName: 'Проверка воркера' }
    });
    check('вход в dev-режиме выдаёт токен', auth.status === 200 && !!auth.data.token, `HTTP ${auth.status}`);
    const token = auth.data.token;

    check('в состоянии 24 карточки', auth.data.state.cards.length === 24);
    check('в состоянии есть лига и бусты', !!auth.data.state.level.name && !!auth.data.state.boosts.turbo);
    check('ссылка-приглашение собрана', typeof auth.data.state.friends.link === 'string');

    const tap = await call('/api/tap', { method: 'POST', token, body: { count: 5 } });
    check('тапы начисляют монеты', tap.status === 200 && tap.data.accepted > 0, `HTTP ${tap.status}`);

    const flood = await call('/api/tap', { method: 'POST', token, body: { count: 100 } });
    check('античит ограничивает пачку тапов', flood.data.accepted < 100, `принято ${flood.data.accepted}`);

    const poor = await call('/api/cards/buy', { method: 'POST', token, body: { cardId: 'memcoin' } });
    check('покупка без монет -> 402', poor.status === 402, `HTTP ${poor.status}`);

    const badBoost = await call('/api/boosts/use', { method: 'POST', token, body: { boostId: 'nope' } });
    check('неизвестный буст -> 400', badBoost.status === 400, `HTTP ${badBoost.status}`);

    const turbo = await call('/api/boosts/use', { method: 'POST', token, body: { boostId: 'turbo' } });
    check('буст турбо работает', turbo.status === 200 && turbo.data.state.boosts.turbo.active === true, `HTTP ${turbo.status}`);
    check(
      'цена тапа учитывает турбо',
      turbo.data.state.tapValue === turbo.data.state.user.tapPower * 5,
      `tapValue=${turbo.data.state.tapValue}`
    );

    const daily = await call('/api/daily/claim', { method: 'POST', token });
    check('ежедневный бонус начисляется', daily.status === 200 && daily.data.reward > 0, `HTTP ${daily.status}`);

    const top = await call('/api/leaderboard', { token });
    check('лидерборд отдаёт данные', top.status === 200 && Array.isArray(top.data.top), `HTTP ${top.status}`);
    check('в топе есть поле с монетами', typeof top.data.top[0]?.coins === 'number', `coins=${top.data.top[0]?.coins}`);
    check('в топе есть счётчик достижений', typeof top.data.top[0]?.ach === 'number', `ach=${top.data.top[0]?.ach}`);
    check(
      'топ отсортирован по монетам',
      (top.data.top || []).every((row, i, arr) => i === 0 || arr[i - 1].coins >= row.coins),
      'порядок по монетам нарушен'
    );

    const friends = await call('/api/friends', { token });
    check('друзья отдают ссылку', friends.status === 200 && typeof friends.data.link === 'string');
    check(
      'в ответе друзей обе суммы бонуса',
      friends.data.bonus === 100000 && friends.data.friendBonus === 25000,
      `${friends.data.bonus}/${friends.data.friendBonus}`
    );

    // Рефералка: приглашаем второго игрока ровно той ссылкой, которую отдаёт игра.
    // id берём случайный и повторяем попытку, если он занят прошлым прогоном.
    const inviteParam = new URL(friends.data.link).searchParams.get('startapp');
    check('ссылка-приглашение содержит префикс ref_', /^ref_\d+$/.test(inviteParam), `start_param=${inviteParam}`);
    const beforeInvite = await call('/api/state', { token });
    let friendAuth = null;
    for (let attempt = 0; attempt < 3 && !friendAuth; attempt += 1) {
      const friendId = 400000 + Math.floor(Math.random() * 500000);
      const attemptAuth = await call('/api/auth', {
        method: 'POST',
        body: { devId: friendId, devName: 'Друг по ссылке', startParam: inviteParam }
      });
      if (attemptAuth.data && attemptAuth.data.referralApplied === true) friendAuth = attemptAuth;
    }
    check('вход по ссылке из игры начисляет бонус', friendAuth !== null);
    check(
      'друг получил приветственный бонус',
      friendAuth?.data?.referralCoins === 25000,
      String(friendAuth?.data?.referralCoins)
    );
    const afterInvite = await call('/api/state', { token });
    // Награда пригласившему ждёт активности друга (100 тапов), а не входа.
    check(
      'награда пригласившему ждёт тапов друга',
      afterInvite.data.user.coins < beforeInvite.data.user.coins + 100000,
      `${beforeInvite.data.user.coins} -> ${afterInvite.data.user.coins}`
    );
    const waiting = await call('/api/friends', { token });
    check(
      'друг отмечен как ожидающий награду',
      waiting.data.tapsTarget === 100 && waiting.data.rewardsWaiting >= 1,
      `tapsTarget=${waiting.data.tapsTarget} waiting=${waiting.data.rewardsWaiting}`
    );
    // Друг тапает до порога: награда приходит пригласившему. Рывок античита —
    // 40 тапов на запрос, между пачками нужно ~2 секунды реального времени.
    let rewardsPaid = 0;
    for (let round = 0; round < 4 && !rewardsPaid; round += 1) {
      await call('/api/tap', { method: 'POST', token: friendAuth.data.token, body: { count: 40 } });
      const progress = await call('/api/friends', { token });
      rewardsPaid = progress.data.rewardsPaid || 0;
      if (!rewardsPaid) await new Promise((resolve) => setTimeout(resolve, 2200));
    }
    check('после порога награда выплачена пригласившему', rewardsPaid >= 1, `выплат ${rewardsPaid}`);
    const paidState = await call('/api/state', { token });
    check(
      'пригласивший получил монеты за друга',
      paidState.data.user.coins >= beforeInvite.data.user.coins + 100000,
      `${beforeInvite.data.user.coins} -> ${paidState.data.user.coins}`
    );

    // Задания, достижения, косметика и профиль (этап 1).
    const quests = await call('/api/quests', { token });
    check('задания дня отдаются', quests.status === 200 && quests.data.total === 8, `HTTP ${quests.status}`);
    const tapQuest = (quests.data.list || []).find((q) => q.id === 'tap_500');
    check('прогресс задания считается по тапам', !!tapQuest && tapQuest.progress >= 5, `прогресс ${tapQuest?.progress}`);

    const achievements = await call('/api/achievements', { token });
    check('достижения отдаются', achievements.status === 200 && achievements.data.total === 12, `HTTP ${achievements.status}`);
    check('первое достижение уже выдано', achievements.data.done >= 1, `получено ${achievements.data.done}`);

    const cosmetics = await call('/api/cosmetics', { token });
    check('каталог косметики отдаётся', cosmetics.status === 200 && cosmetics.data.catalog.length === 22);

    const equip = await call('/api/cosmetics/equip', {
      method: 'POST',
      token,
      body: { itemId: 'palette_default' }
    });
    check('косметика надевается', equip.status === 200 && !!equip.data.state.cosmetics.palette, `HTTP ${equip.status}`);

    const lockedEquip = await call('/api/cosmetics/equip', {
      method: 'POST',
      token,
      body: { itemId: 'hamster_bear' }
    });
    check('закрытая косметика не надевается -> 403', lockedEquip.status === 403, `HTTP ${lockedEquip.status}`);

    const claim = await call('/api/quests/claim', { method: 'POST', token, body: { questId: 'daily_bonus' } });
    check('награда за задание забирается', claim.status === 200 && claim.data.coins > 0, `HTTP ${claim.status}`);

    const claimAgain = await call('/api/quests/claim', { method: 'POST', token, body: { questId: 'daily_bonus' } });
    check('повторная награда -> 409', claimAgain.status === 409, `HTTP ${claimAgain.status}`);

    const meId = auth.data.state.user.id;
    const profile = await call(`/api/profile/${meId}`, { token });
    check('профиль игрока отдаётся', profile.status === 200 && profile.data.mine === true, `HTTP ${profile.status}`);
    check('профиль не раскрывает tg_id', profile.data.tg_id === undefined);
    check('в профиле есть достижения и статистика', profile.data.achievementsTotal === 12 && profile.data.totalTaps >= 5);
    check(
      'в профиле «стена» из 12 достижений с флагом открытия',
      profile.data.achievements?.length === 12 &&
        profile.data.achievements.every((item) => typeof item.done === 'boolean'),
      `достижений: ${profile.data.achievements?.length}`
    );

    const profileMissing = await call('/api/profile/999999', { token });
    check('неизвестный профиль -> 404', profileMissing.status === 404, `HTTP ${profileMissing.status}`);

    const push = await call('/api/push', { method: 'POST', token, body: { daily: false } });
    check('настройки напоминаний сохраняются', push.status === 200 && push.data.notify.daily === false, `HTTP ${push.status}`);

    // Магазин за звёзды: каталог и создание счёта.
    const shop = await call('/api/shop', { token });
    check('магазин отдаёт товары', shop.status === 200 && shop.data.items.length === 9, `HTTP ${shop.status}`);
    check('в магазине есть премиум-косметика', (shop.data.items || []).some((item) => item.source === 'stars'));

    const invoice = await call('/api/shop/invoice', { method: 'POST', token, body: { itemId: 'coins_5k' } });
    if (invoice.status === 200) {
      check('счёт на товар создан (валюта XTR)', /^https:\/\/t\.me\//.test(invoice.data.link || ''), String(invoice.data.link).slice(0, 40));
    } else {
      check('оплата честно недоступна без BOT_TOKEN', invoice.status === 503, `HTTP ${invoice.status}`);
    }

    // Код дня: значение считается тем же модулем, что и в боте.
    const codeLib = require('../lib/dailycode');
    const dayCode = codeLib.codeFor(new Date().toISOString().slice(0, 10));

    const codeStatus = await call('/api/code', { token });
    check('код дня отдаёт статус', codeStatus.status === 200 && codeStatus.data.claimed === false, `HTTP ${codeStatus.status}`);

    const codeBad = await call('/api/code/claim', { method: 'POST', token, body: { code: 'ZZZZZZ' } });
    check('неверный код дня отклонён', codeBad.status === 400, `HTTP ${codeBad.status}`);

    const codeOk = await call('/api/code/claim', { method: 'POST', token, body: { code: dayCode } });
    check('верный код дня принят', codeOk.status === 200 && codeOk.data.coins > 0, `HTTP ${codeOk.status}`);

    const codeTwice = await call('/api/code/claim', { method: 'POST', token, body: { code: dayCode } });
    check('повторный код дня отклонён', codeTwice.status === 409, `HTTP ${codeTwice.status}`);

    const stateWithQuests = await call('/api/state', { token });
    check('в состоянии есть сводка заданий', !!stateWithQuests.data.quests && stateWithQuests.data.quests.total === 8);
    check('в состоянии есть активная косметика', !!stateWithQuests.data.cosmetics.hamster);

    const again = await call('/api/daily/claim', { method: 'POST', token });
    check('повторный бонус дня отклонён', again.status === 409, `HTTP ${again.status}`);

    // Энергия за рекламу: локальный воркер поднят с AD_MODE=stub (.dev.vars), а
    // Monetag включён тестовой зоной — сервер выдаёт сессию, ролик показывает
    // клиент, поэтому в автотестах просмотр подтверждается сразу.
    const adStatus = await call('/api/energy/ad/status', { token });
    check(
      'статус рекламы отдаётся',
      adStatus.status === 200 && typeof adStatus.data.available === 'boolean' && Array.isArray(adStatus.data.providers),
      JSON.stringify(adStatus.data)
    );
    check(
      'в статусе сети идут по приоритету',
      (adStatus.data.providers || []).map((p) => p.id).join(',') === 'monetag,chanify',
      JSON.stringify(adStatus.data.providers)
    );

    // Запасная сеть (Chanify): ролик не запустился — клиент просит skip, реклама
    // уходит в чат, награда выдаётся по возвращении (confirm).
    const chatReq = await call('/api/energy/ad/request', { method: 'POST', token, body: { skip: ['monetag'] } });
    check(
      'skip переводит рекламу в чат',
      chatReq.status === 200 && chatReq.data.provider === 'chanify' && chatReq.data.mode === 'chat' && !!chatReq.data.token,
      `HTTP ${chatReq.status}: ${JSON.stringify(chatReq.data)}`
    );
    const chatEarly = await call('/api/energy/ad/confirm', { method: 'POST', token, body: { token: chatReq.data.token } });
    check('подтверждение раньше срока отклонено', chatEarly.status === 409, `HTTP ${chatEarly.status}`);
    await new Promise((resolve) => setTimeout(resolve, 11000));
    const chatDone = await call('/api/energy/ad/confirm', { method: 'POST', token, body: { token: chatReq.data.token } });
    check(
      'после возвращения энергия восстановлена',
      chatDone.status === 200 && chatDone.data.energy > 0 && chatDone.data.restored > 0,
      `HTTP ${chatDone.status}: ${JSON.stringify({ energy: chatDone.data?.energy, restored: chatDone.data?.restored })}`
    );
    const chatRepeat = await call('/api/energy/ad/confirm', { method: 'POST', token, body: { token: chatReq.data.token } });
    check('повторный confirm отклонён', chatRepeat.status === 409, `HTTP ${chatRepeat.status}`);

    // Monetag: отдельный игрок, потому что после награды у первого уже пауза.
    // Здесь проверяем весь путь ролика — сессию, недосмотр и награду.
    const adAuth = await call('/api/auth', { method: 'POST', body: { devId: devId + 1, devName: 'Проверка Monetag' } });
    const adToken = adAuth.data.token;
    await call('/api/tap', { method: 'POST', token: adToken, body: { count: 100 } });

    const adReq = await call('/api/energy/ad/request', { method: 'POST', token: adToken });
    check(
      'запрос уходит в Monetag за сессией ролика',
      adReq.status === 200 && adReq.data.provider === 'monetag' && adReq.data.mode === 'client' &&
        !!adReq.data.token && !!adReq.data.zoneId,
      `HTTP ${adReq.status}: ${JSON.stringify(adReq.data)}`
    );
    const adUndone = await call('/api/energy/ad/claim', {
      method: 'POST',
      token: adToken,
      body: { token: adReq.data.token, done: false }
    });
    check(
      'недосмотренный ролик награду не даёт',
      adUndone.status === 200 && adUndone.data.credited === false,
      `HTTP ${adUndone.status}: ${JSON.stringify(adUndone.data)}`
    );
    const adClaim = await call('/api/energy/ad/claim', {
      method: 'POST',
      token: adToken,
      body: { token: adReq.data.token, done: true }
    });
    check(
      'после ролика энергия восстановлена',
      adClaim.status === 200 && adClaim.data.credited === true && adClaim.data.restored > 0,
      `HTTP ${adClaim.status}: ${JSON.stringify({ energy: adClaim.data?.energy, restored: adClaim.data?.restored })}`
    );
    const adTwice = await call('/api/energy/ad/claim', {
      method: 'POST',
      token: adToken,
      body: { token: adReq.data.token, done: true }
    });
    check(
      'повторный claim не начисляет дважды',
      adTwice.status === 200 && adTwice.data.credited === true && adTwice.data.restored === 0,
      `HTTP ${adTwice.status}: ${JSON.stringify({ credited: adTwice.data?.credited, restored: adTwice.data?.restored })}`
    );
    // Постбек сети: подтверждение показа по нашему ymid. Локальный воркер запущен с
    // секретом из .dev.vars, поэтому «свой» адрес принимается, чужой — 404.
    const pbWrong = await call('/api/ads/monetag/wrong-secret?ymid=x&event=impression&value=valued');
    check('чужой секрет постбека отклоняется', pbWrong.status === 404, `HTTP ${pbWrong.status}`);
    const pbOk = await call(
      `/api/ads/monetag/local-postback-secret?ymid=${adReq.data.token}&event=impression&value=valued&sub=777`
    );
    check(
      'постбек сети принимается',
      pbOk.status === 200 && pbOk.data.ok === true,
      `HTTP ${pbOk.status}: ${JSON.stringify(pbOk.data)}`
    );
    const adPause = await call('/api/energy/ad/status', { token: adToken });
    check('награда включает паузу', adPause.data.readyInMs > 0, `ждём ${adPause.data.readyInMs} мс`);
    const adRemove = await call('/api/profile/delete', { method: 'POST', token: adToken });
    check('тестовый игрок Monetag удалён', adRemove.status === 200, `HTTP ${adRemove.status}`);

    // Оплата: витрина отдаёт цены в двух валютах, а страница внешней оплаты и приём
    // уведомлений ЮKassa защищены (в локальном воркере секреты берутся из .dev.vars).
    const shopPay = await call('/api/shop', { token });
    check(
      'витрина отдаёт цены в рублях и звёздах',
      shopPay.status === 200 &&
        (shopPay.data.items || []).every((item) => item.price > 0 && !!item.priceText && !!item.starsText),
      JSON.stringify((shopPay.data.items || [])[0])
    );
    const payBad = await call('/api/pay/info');
    check('страница оплаты без токена -> 401', payBad.status === 401, `HTTP ${payBad.status}`);
    const hookBad = await call('/api/payments/yookassa/wrong-secret', {
      method: 'POST',
      body: { event: 'payment.succeeded', object: { id: 'x' } }
    });
    check('чужой секрет уведомления ЮKassa -> 404', hookBad.status === 404, `HTTP ${hookBad.status}`);

    // Удаление профиля: тестовый игрок уходит вместе со своими данными, его сессия
    // перестаёт работать, а повторный вход создаёт нового игрока.
    const removeSelf = await call('/api/profile/delete', { method: 'POST', token });
    check(
      'удаление своего профиля -> 200',
      removeSelf.status === 200 && removeSelf.data.deleted === true,
      JSON.stringify(removeSelf.data)
    );
    const deadToken = await call('/api/state', { token });
    check('токен удалённого игрока больше не работает (401)', deadToken.status === 401, `HTTP ${deadToken.status}`);
    const reborn = await call('/api/auth', { method: 'POST', body: { devId, devName: 'Проверка воркера' } });
    check(
      'после удаления вход создаёт новый профиль',
      reborn.status === 200 && !!reborn.data.token && reborn.data.state.user.coins === 0,
      `монет ${reborn.data?.state?.user?.coins}`
    );
    const oldProfile = await call(`/api/profile/${meId}`, { token: reborn.data.token });
    check('удалённого игрока нет в профилях (404)', oldProfile.status === 404, `HTTP ${oldProfile.status}`);
  }

  console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
  if (failures.length) {
    for (const failure of failures) console.log(` - ${failure}`);
    process.exit(1);
  }
  console.log('Воркер отвечает корректно.');
})();
