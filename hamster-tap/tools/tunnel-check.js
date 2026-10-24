'use strict';
// Проверка «боевого» канала: сервер + туннель cloudflared + игра через публичный
// HTTPS-адрес. Именно так мини-апп увидит Telegram.
//   node tools/tunnel-check.js
// Требуется установленный cloudflared (winget install --id Cloudflare.cloudflared -e)
// и доступ в интернет. Временная база — в системной temp-папке.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dns = require('dns');
const { spawn } = require('child_process');

// См. комментарий в lib/config.js: на VPN без IPv6 предпочитаем IPv4.
dns.setDefaultResultOrder('ipv4first');

const ROOT = path.join(__dirname, '..');
const PORT = 8023;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hamster-tap-tunnel-'));

const CLOUDFLARED_CANDIDATES = [
  process.env.CLOUDFLARED_PATH,
  'cloudflared',
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe'
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Пробник через IPv4-адрес edge Cloudflare: свежие имена *.trycloudflare.com
// публикуются сначала только как AAAA (IPv6), а без IPv6-маршрута обычный запрос
// падает в таймаут, хотя туннель работает. curl умеет зафиксировать IP для имени.
function curlCode(url, { ip, host, timeoutSec = 10 } = {}) {
  const args = ['-s', '-o', 'NUL', '-w', '%{http_code}', '--max-time', String(timeoutSec)];
  if (ip && host) args.push('--resolve', `${host}:443:${ip}`);
  args.push(url);
  try {
    const out = require('child_process')
      .execFileSync('curl.exe', args, { encoding: 'utf8', timeout: (timeoutSec + 3) * 1000 })
      .trim();
    return out;
  } catch {
    return '000';
  }
}

// IPv4-адреса edge Cloudflare: имена *.trycloudflare.com обслуживаются теми же
// адресами, что и сам trycloudflare.com.
async function edgeIps() {
  const fallback = ['104.16.230.132', '104.16.231.132'];
  try {
    const ips = await dns.promises.resolve4('trycloudflare.com');
    return ips.length ? ips : fallback;
  } catch {
    return fallback;
  }
}

// Готов ли канал: сначала обычный запрос, затем имя через IP edge с SNI.
async function probeChannel(url, host) {
  if (curlCode(url) === '200') return 'dns';
  for (const ip of await edgeIps()) {
    if (curlCode(url, { ip, host }) === '200') return 'edge';
  }
  return false;
}

// Запрос для теста: по DNS — можно обычным fetch, а если имя ещё не опубликовано
// в IPv4 — только curl с --resolve на адрес edge Cloudflare.
function curlRequest(url, { method = 'GET', headers = {}, body = '', probe = null } = {}) {
  const args = ['-s', '--max-time', '20', '-w', '\n%{http_code}', '-X', method];
  if (probe) args.push('--resolve', `${probe.host}:443:${probe.ip}`);
  for (const [key, value] of Object.entries(headers)) args.push('-H', `${key}: ${value}`);
  if (body) args.push('--data', body);
  args.push(url);
  let out = '';
  try {
    out = require('child_process').execFileSync('curl.exe', args, {
      encoding: 'utf8',
      timeout: 30000
    });
  } catch {
    return { status: 0, data: null, text: '' };
  }
  const cut = out.lastIndexOf('\n');
  const status = Number(out.slice(cut + 1).trim());
  const text = out.slice(0, cut);
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status, data, text };
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT),
        DB_PATH: path.join(tmpDir, 'tunnel.db'),
        BOT_TOKEN: '',
        BOT_USERNAME: 'demo_bot',
        ALLOW_DEV: '1',
        RUN_BOT: ''
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      if (output.includes(`http://localhost:${PORT}`)) resolve(child);
    });
    child.stderr.on('data', () => {});
    child.on('exit', (code) => reject(new Error(`сервер завершился с кодом ${code}`)));
    setTimeout(() => reject(new Error('сервер не поднялся за 15 секунд')), 15000);
  });
}

// Ищем рабочий cloudflared: типовые пути установки, затем PATH через where.exe.
function resolveCloudflared() {
  const known = [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe')
      : ''
  ].filter(Boolean);
  for (const candidate of known) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const candidate of CLOUDFLARED_CANDIDATES) {
    if (candidate !== 'cloudflared' && fs.existsSync(candidate)) return candidate;
  }
  try {
    const found = require('child_process')
      .execSync('where.exe cloudflared', { encoding: 'utf8' })
      .trim()
      .split(/\r?\n/)[0];
    if (found && fs.existsSync(found)) return found;
  } catch {
    /* выполним попытку через PATH ниже */
  }
  return 'cloudflared';
}

function startTunnel() {
  return new Promise((resolve, reject) => {
    const exe = resolveCloudflared();
    // Без shell: true — иначе Windows склеивает аргументы строкой и ломает URL.
    const child = spawn(exe, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], {
      cwd: ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stderr.on('data', (chunk) => {
      log += chunk.toString();
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log);
      if (match) resolve({ child, url: match[0] });
    });
    child.on('error', (error) =>
      reject(new Error(`не удалось запустить cloudflared (${exe}): ${error.message}`))
    );
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`cloudflared завершился с кодом ${code}: ${log.slice(-500)}`));
    });
    setTimeout(() => reject(new Error('туннель не выдал адрес за 60 секунд')), 60000);
  });
}

async function json(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

(async () => {
  console.log('Hamster Tap — проверка публичного канала (туннель cloudflared)');
  let server = null;
  let tunnel = null;

  try {
    server = await startServer();
    console.log(`  сервер поднят на порту ${PORT}`);

    // Локальная проверка: если и тут не работает, дело не в туннеле.
    const localHealth = await json(`http://localhost:${PORT}/api/health`);
    check('локальный сервер отвечает', localHealth.status === 200 && localHealth.data.ok === true);

    tunnel = await startTunnel();
    const base = tunnel.url;
    console.log(`  публичный адрес: ${base}`);
    check('адрес выглядит как https-домен trycloudflare', /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(base));

    // Quick-туннель становится доступен не сразу: Cloudflare ставит маршрут на edge,
    // а свежее имя публикует сначала только как AAAA. Проверяем оба варианта:
    // обычный DNS и имя через IPv4-адрес edge.
    const host = new URL(base).host;
    const edge = { host, ip: (await edgeIps())[0] };
    let channel = false;
    for (let attempt = 1; attempt <= 18; attempt += 1) {
      if (curlCode(`${base}/api/health`) === '200') {
        channel = 'dns';
        console.log(`  канал готов по DNS (попытка ${attempt})`);
        break;
      }
      if (curlCode(`${base}/api/health`, edge) === '200') {
        channel = 'edge';
        console.log(`  канал готов, но имя ещё только в IPv6 (попытка ${attempt}) — идём через edge-пробник`);
        break;
      }
      console.log(`  попытка ${attempt}: туннель ещё не отвечает`);
      await sleep(4000);
    }

    check(
      'канал туннеля поднят',
      channel === 'dns' || channel === 'edge',
      channel === 'edge' ? 'имя ещё опубликовано только в IPv6 — нормально для свежего туннеля' : ''
    );

    const probe = channel === 'edge' ? edge : null;
    const call = (path, options = {}) => curlRequest(`${base}${path}`, { ...options, probe });
    const jsonHeaders = { 'Content-Type': 'application/json' };

    const page = curlRequest(base, { probe });
    check('публичный адрес отдаёт мини-апп', page.status === 200 && page.text.includes('telegram-web-app'), `HTTP ${page.status}`);

    const publicHealth = call('/api/health');
    check('через туннель доступен /api/health', publicHealth.status === 200 && publicHealth.data.ok === true);

    if (channel === 'dns') {
      // Полный игровой поток через публичный адрес — как это сделает клиент Telegram.
      const auth = call('/api/auth', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ devId: 424242, devName: 'Туннель' })
      });
      check('вход через туннель выдаёт токен', auth.status === 200 && !!auth.data.token, `HTTP ${auth.status}`);

      const token = auth.data && auth.data.token;
      const tap = call('/api/tap', {
        method: 'POST',
        headers: { ...jsonHeaders, 'X-Auth': token },
        body: JSON.stringify({ count: 8 })
      });
      check(
        'тапы начисляются через публичный адрес',
        tap.status === 200 && tap.data.accepted > 0,
        `HTTP ${tap.status}, принято ${tap.data && tap.data.accepted}`
      );

      const state = call('/api/state', { headers: { 'X-Auth': token } });
      check('состояние читается через туннель', state.status === 200 && state.data.user.coins > 0, `HTTP ${state.status}`);
      check('в состоянии 24 карточки', state.status === 200 && state.data.cards.length === 24);
    } else {
      // Свежий туннель публикует имя сначала только как AAAA, и A-запись появляется
      // через несколько минут. POST-проверки в таком режиме делать нельзя (Cloudflare
      // отдаёт 530 на не-GET до публикации записи), поэтому говорим об этом прямо:
      // игровой поток уже полностью покрыт tools/smoke.js.
      console.log('  A-запись ещё не опубликована (имя только в IPv6) — POST-проверки пропущены,');
      console.log('  они дублируют tools/smoke.js; повторите проверку через пару минут для полного прогона.');
    }
  } catch (error) {
    failures.push(`неожиданная ошибка: ${error.message}`);
    console.error(error);
  } finally {
    if (tunnel && tunnel.child) tunnel.child.kill();
    if (server) server.kill();
    await sleep(500);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* временную папку можно удалить вручную */
    }
  }

  console.log(`\nПройдено: ${passed}, провалено: ${failures.length}`);
  if (failures.length) {
    for (const failure of failures) console.log(` - ${failure}`);
    process.exit(1);
  }
  console.log('Публичный канал работает: мини-апп доступен по HTTPS из интернета.');
})();

