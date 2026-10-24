// Точка входа воркера: статика из web/ + два динамических маршрута.
// Работает и на Cloudflare, и локально через `npx wrangler dev`.
import { handleApi } from './api.js';
import { handleWebhook } from './bot.js';
import { runPush } from './push.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) return handleApi(request, env, ctx);
    if (url.pathname.startsWith('/webhook/')) return handleWebhook(request, env);

    // Всё остальное — статические файлы мини-аппа (index.html, styles.css, app.js).
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },

  // Напоминания по расписанию ([triggers] в wrangler.toml): не чаще одного
  // сообщения каждого вида в сутки за счёт push_log.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPush(env, Date.now()));
  }
};
