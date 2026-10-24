#!/usr/bin/env node
'use strict';

/**
 * Применяет схему D1 по отдельным утверждениям (по одному SQL-запросу за вызов).
 *
 * Зачем: файловый импорт (`wrangler d1 execute --file=...`) заливает SQL
 * multipart-запросом в /import, и на нестабильном канале (VPN) этот шаг падает
 * с «fetch failed» уже после загрузки файла. Запросы через /query, которые
 * использует `--command`, проходят стабильно. Поэтому схему разбиваем на
 * утверждения и применяем по одному, с повторами.
 *
 * Использование:
 *   node tools/cf-d1-apply.js hamster-tap                  # прод, удалённая база
 *   node tools/cf-d1-apply.js hamster-tap --env staging    # окружение staging
 *   node tools/cf-d1-apply.js hamster-tap --local          # локальная база разработки
 *   node tools/cf-d1-apply.js hamster-tap --check          # только проверка таблиц
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCHEMA = path.join(ROOT, 'cloudflare', 'schema.sql');
const WRANGLER_BIN = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const RETRY_DELAYS_MS = [2000, 3000, 5000, 8000];

function ok(text) { console.log('  ok  ' + text); }
function warn(text) { console.log('  !!  ' + text); }
function fail(text, hint) {
  console.log('  XX  ' + text);
  if (hint) console.log('      ' + hint);
  process.exit(1);
}

/** Убирает построчные комментарии `-- ...` вне строковых литералов. */
function stripComments(sql) {
  let out = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") { out += sql[++i]; continue; }
        inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; out += ch; continue; }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

/** Разбивает SQL на отдельные утверждения по `;` вне строк. */
function splitStatements(sql) {
  const clean = stripComments(sql);
  const parts = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (clean[i + 1] === "'") { current += clean[++i]; continue; }
        inString = false;
      }
      continue;
    }
    if (ch === "'") { inString = true; current += ch; continue; }
    if (ch === ';') { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Имя объекта из утверждения — для понятного лога. */
function statementLabel(sql) {
  const table = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([\w]+)/i);
  if (table) return 'таблица ' + table[1];
  const index = sql.match(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([\w]+)/i);
  if (index) return 'индекс ' + index[1];
  return sql.replace(/\s+/g, ' ').slice(0, 50);
}

/** Ожидаемые имена таблиц из схемы — по ним проверяем результат. */
function expectedTables(statements) {
  const names = [];
  for (const sql of statements) {
    const m = sql.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([\w]+)/i);
    if (m) names.push(m[1]);
  }
  return names;
}

/**
 * Директивы добавления колонок: `-- @add-column: users.day_key TEXT NOT NULL DEFAULT ''`.
 * Нужны потому, что SQLite не поддерживает `ADD COLUMN IF NOT EXISTS`, а схему
 * приходится применять и к базам, где игроки уже есть. Инструмент читает колонки
 * таблицы и добавляет только отсутствующие — повторный запуск ничего не ломает.
 */
function parseAddColumns(sql) {
  const out = [];
  const re = /^[ \t]*--[ \t]*@add-column:[ \t]*(\w+)\.(\w+)[ \t]+(.+?)[ \t]*$/gm;
  let match;
  while ((match = re.exec(sql))) {
    out.push({ table: match[1], column: match[2], ddl: match[3].trim() });
  }
  return out;
}

/**
 * Директивы разовой миграции данных: `-- @on-add users.referral_paid: UPDATE ...`.
 * Выполняются только в тот запуск, когда соответствующая колонка добавлялась:
 * так старые данные переводятся на новые правила ровно один раз, а повторные
 * деплои (и новые игроки) их уже не задевают.
 */
function parseOnAdd(sql) {
  const out = [];
  // Поддерживаем оба написания: `-- @on-add таблица.колонка: SQL` (как у @add-column)
  // и `-- @on-add: таблица.колонка SQL`.
  const re = /^[ \t]*--[ \t]*@on-add:?[ \t]*(\w+)\.(\w+)[ \t]*:?[ \t]*(.+?)[ \t]*$/gm;
  let match;
  while ((match = re.exec(sql))) {
    out.push({ table: match[1], column: match[2], sql: match[3].trim() });
  }
  return out;
}

function runWrangler(args) {
  // wrangler пишет предупреждения и спиннер в stderr — это нормально,
  // поэтому смотрим только на код возврата.
  const env = { ...process.env };
  // Node предпочитает IPv6, а в VPN его может не быть: заставляем дочерний
  // процесс разрешать имена в IPv4 первыми.
  if (!String(env.NODE_OPTIONS || '').includes('dns-result-order')) {
    env.NODE_OPTIONS = (env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : '') + '--dns-result-order=ipv4first';
  }
  const res = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = String(res.stdout || '');
  const stderr = String(res.stderr || '');
  const status = typeof res.status === 'number' ? res.status : 1;
  const combined = (stderr + '\n' + stdout).replace(/\u001b\[[0-9;]*m/g, '');
  return { status, stdout, stderr, combined, error: res.error };
}

/** Один запрос с повторами: сеть через VPN иногда рвёт единичные запросы. */
function executeWithRetry(dbName, sql, options) {
  const args = ['d1', 'execute', dbName, options.local ? '--local' : '--remote', '--command', sql, '-y'];
  if (options.env) args.push('--env', options.env);

  let last = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const res = runWrangler(args);
    const errored = res.status !== 0 || /\bERROR\b/.test(res.combined) || /fetch failed/.test(res.combined);
    if (!errored) return { res, attempts: attempt + 1 };
    last = res;
    if (attempt < RETRY_DELAYS_MS.length) {
      const wait = RETRY_DELAYS_MS[attempt];
      warn(`попытка ${attempt + 1} не прошла (${firstLine(res.combined)}) — повтор через ${wait / 1000} с`);
      sleep(wait);
    }
  }
  return { res: last, attempts: RETRY_DELAYS_MS.length + 1, failed: true };
}

function firstLine(text) {
  const line = String(text).split('\n').map((s) => s.trim()).filter(Boolean)
    .find((s) => !/^(⛅|─|▲|│|├|╭|╰|🌀|To execute|Resource location|Note:)/.test(s));
  return line ? line.slice(0, 120) : 'нет вывода';
}

function sleep(ms) {
  // Синхронный сон: инструмент линейный, асинхронность тут только мешает.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Один SELECT с флагом --json; null — если прочитать не удалось. */
function queryRows(dbName, sql, options) {
  const args = ['d1', 'execute', dbName, options.local ? '--local' : '--remote'];
  args.push('--json', '--command', sql, '-y');
  if (options.env) args.push('--env', options.env);
  const res = runWrangler(args);
  if (res.status !== 0) return null;
  const json = res.stdout.match(/\[[\s\S]*\]/);
  if (!json) return null;
  try {
    const parsed = JSON.parse(json[0]);
    return parsed[0] && parsed[0].results ? parsed[0].results : [];
  } catch {
    return null;
  }
}

function listTables(dbName, options) {
  const rows = queryRows(dbName, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", options);
  if (rows === null) return null;
  return rows.map((r) => r.name).filter((n) => n && n !== '_cf_KV');
}

function listColumns(dbName, options, table) {
  const rows = queryRows(dbName, `SELECT name FROM pragma_table_info('${table}')`, options);
  if (rows === null) return null;
  return rows.map((r) => r.name);
}

function main() {
  const argv = process.argv.slice(2);
  const dbName = argv.find((a) => !a.startsWith('--'));
  const envIndex = argv.indexOf('--env');
  const options = {
    env: envIndex >= 0 ? argv[envIndex + 1] : null,
    local: argv.includes('--local'),
    check: argv.includes('--check'),
  };

  if (!dbName) fail('не указано имя базы D1', 'Пример: node tools/cf-d1-apply.js hamster-tap');
  if (!fs.existsSync(WRANGLER_BIN)) fail('wrangler не установлен', 'Выполните: npm install --save-dev wrangler');
  if (!fs.existsSync(SCHEMA)) fail('не найден cloudflare/schema.sql');

  const where = options.local ? 'локальная база' : 'удалённая база';
  console.log(`  ..  схема → ${dbName} (${where}${options.env ? ', env ' + options.env : ''})`);

  const sql = fs.readFileSync(SCHEMA, 'utf8');
  const statements = splitStatements(sql);
  const tables = expectedTables(statements);
  if (!statements.length) fail('в схеме нет утверждений');

  if (!options.check) {
    let applied = 0;
    for (const statement of statements) {
      const label = statementLabel(statement);
      const { res, attempts, failed } = executeWithRetry(dbName, statement, options);
      if (failed) {
        warn(`не удалось применить: ${label}`);
        console.log(res.combined.trim());
        fail('схема применена не полностью', 'Повторите запуск — инструмент идемпотентен (IF NOT EXISTS).');
      }
      applied++;
      ok(`${label}${attempts > 1 ? ` (с ${attempts}-й попытки)` : ''}`);
    }
    console.log(`  ok  утверждений применено: ${applied}`);
  }

  // Колонки из директив `-- @add-column:`: добавляем только те, которых нет.
  // Так схема применяется и к базе, где уже есть игроки (миграция без потери данных).
  const addColumns = parseAddColumns(sql);
  const addedColumns = new Set();
  for (const table of [...new Set(addColumns.map((col) => col.table))]) {
    const wanted = addColumns.filter((col) => col.table === table);
    const have = listColumns(dbName, options, table);
    const missing = have ? wanted.filter((col) => !have.includes(col.column)) : wanted;
    if (!missing.length) {
      ok(`колонки ${table}: на месте (${wanted.length})`);
      continue;
    }
    if (options.check) {
      fail(
        `в таблице ${table} нет колонок: ${missing.map((col) => col.column).join(', ')}`,
        'Запустите инструмент без --check, чтобы добавить их.'
      );
    }
    for (const col of missing) {
      const { res } = executeWithRetry(
        dbName,
        `ALTER TABLE ${table} ADD COLUMN ${col.column} ${col.ddl}`,
        options
      );
      if (/duplicate column name/i.test(res.combined)) {
        ok(`колонка ${table}.${col.column}: уже есть`);
        continue;
      }
      if (res.status !== 0 || /\bERROR\b/.test(res.combined)) {
        warn(`не удалось добавить колонку ${table}.${col.column}`);
        console.log(res.combined.trim());
        fail('схема применена не полностью', 'Повторите запуск — инструмент идемпотентен.');
      }
      ok(`колонка ${table}.${col.column}`);
      addedColumns.add(`${table}.${col.column}`);
    }
  }

  // Разовая миграция данных, привязанная к появлению колонки (`-- @on-add`):
  // выполняется только в том запуске, когда колонка действительно добавлялась.
  if (!options.check) {
    for (const item of parseOnAdd(sql)) {
      if (!addedColumns.has(`${item.table}.${item.column}`)) continue;
      const { res, failed } = executeWithRetry(dbName, item.sql, options);
      if (failed) {
        warn(`не удалось применить миграцию данных: ${item.table}.${item.column}`);
        console.log(res.combined.trim());
        fail('миграция данных не применена', 'Повторите запуск — инструмент идемпотентен.');
      }
      ok(`миграция данных ${item.table}.${item.column}`);
    }
  }

  const existing = listTables(dbName, options);
  if (existing === null) {
    warn('не удалось прочитать список таблиц — проверьте результат вручную');
    process.exit(options.check ? 1 : 0);
  }
  const missing = tables.filter((t) => !existing.includes(t));
  if (missing.length) fail('в базе нет таблиц: ' + missing.join(', '));
  ok(`таблицы на месте: ${tables.join(', ')}`);
}

main();
