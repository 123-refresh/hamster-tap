// Авторизация в Worker'е: проверка подписи initData и серверные сессии.
// Чистые функции (разбор и проверка подписи) берём из lib/auth.js — общий код
// с локальной версией. Здесь только асинхронный вход и работа с D1.
import { randomBytes } from 'node:crypto';
import auth from '../../lib/auth.js';
import game from '../../lib/game.js';

const { validateInitData, parseReferrer } = auth;

export async function login(store, payload, config, now) {
  const { initData = '', devId = '', devName = '', startParam = '' } = payload || {};

  let tgId;
  let profile;
  let refParam = startParam;

  if (config.BOT_TOKEN && initData) {
    const verdict = validateInitData(initData, config.BOT_TOKEN, {
      now,
      maxAgeMs: config.AUTH_MAX_AGE_MS
    });
    if (!verdict.ok) return { error: verdict.error, status: 401 };
    tgId = Number(verdict.user.id);
    profile = {
      username: verdict.user.username || null,
      firstName: verdict.user.first_name || null,
      lastName: verdict.user.last_name || null,
      // Язык и Premium берём из проверенной initData: они уходят в userMeta
      // рекламной сети, поэтому подделывать их со стороны клиента нельзя.
      languageCode: verdict.user.language_code || null,
      isPremium: verdict.user.is_premium ? 1 : 0
    };
    refParam = verdict.startParam || startParam;
  } else if (initData && !config.BOT_TOKEN) {
    return { error: 'сервер не настроен: не задан BOT_TOKEN', status: 503 };
  } else if (config.ALLOW_DEV) {
    const id = Number(devId);
    if (!Number.isSafeInteger(id) || id === 0) {
      return { error: 'нужен devId для локального входа', status: 400 };
    }
    tgId = id;
    profile = {
      username: `dev${Math.abs(id) % 10000}`,
      firstName: devName || 'Dev Игрок',
      lastName: null,
      languageCode: null,
      isPremium: 0
    };
  } else {
    return { error: 'нет initData: открывайте игру из Telegram', status: 401 };
  }

  let user = await store.userByTgId(tgId);
  let referralApplied = false;
  // Данные для поздравления обоих участников приглашения (только на первом входе).
  let referralInfo = null;

  if (!user) {
    // Приглашение приходит либо ссылкой на мини-апп (start_param = ref_<tg_id>),
    // либо через бота (/start ref_<tg_id>).
    const referrerTgId = parseReferrer(refParam) || (await store.takePendingRef(tgId));
    let referrerId = null;
    if (referrerTgId && referrerTgId !== tgId) {
      const referrer = await store.userByTgId(referrerTgId);
      if (referrer) {
        referrerId = referrer.id;
        // Награда пригласившему здесь не начисляется: она придёт, когда друг
        // реально поиграет (referralTapsTarget тапов, см. service.tap).
        referralApplied = true;
        referralInfo = {
          referrerTgId: referrer.tg_id,
          referrerName: referrer.first_name,
          invitedTgId: tgId,
          invitedName: profile.firstName,
          referrerBonus: game.GAME.referralBonus,
          invitedBonus: game.GAME.referralInvitedBonus,
          tapsTarget: game.GAME.referralTapsTarget
        };
      }
    }
    user = await store.createUser({
      tgId,
      username: profile.username,
      firstName: profile.firstName,
      lastName: profile.lastName,
      referrerId,
      now,
      defaults: game.GAME
    });
    if (referralApplied) {
      // Приветственный бонус другу — сразу; награду пригласившему начислит первый
      // тап, которым друг доберёт порог активности (см. service.tap).
      user = await store.updateUser(user.id, {
        coins: user.coins + game.GAME.referralInvitedBonus,
        total_earned: user.total_earned + game.GAME.referralInvitedBonus
      });
    }
    // Язык и Premium из initData: нужны для userMeta рекламы.
    user = await store.updateUser(user.id, {
      language_code: profile.languageCode,
      is_premium: profile.isPremium
    });
  } else {
    // Игравший раньше уже не может стать приглашённым.
    await store.takePendingRef(tgId);
    const patch = {};
    if (profile.username !== user.username) patch.username = profile.username;
    if (profile.firstName !== user.first_name) patch.first_name = profile.firstName;
    // Язык и Premium могли измениться — держим их актуальными для userMeta рекламы.
    if (profile.languageCode !== (user.language_code || null)) patch.language_code = profile.languageCode;
    if (Number(profile.isPremium) !== Number(user.is_premium || 0)) patch.is_premium = profile.isPremium;
    if (Object.keys(patch).length) user = await store.updateUser(user.id, patch);
  }

  const token = randomBytes(24).toString('hex');
  await store.createSession(token, user.id, now, config.SESSION_TTL_MS);
  return { token, user, referralApplied, referral: referralInfo };
}
