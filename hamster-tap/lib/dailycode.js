'use strict';
// Код дня («шифр»): короткий код, одинаковый для всех, который выдаёт бот по команде
// /code, а игрок вводит в игре и получает монеты — один раз в сутки (по UTC).
//
// Свойства кода:
//   • детерминированный: считается от даты, поэтому и бот, и сервер, и тесты
//     получают одно и то же значение без хранения состояния;
//   • удобный для ввода: 6 символов из алфавита без похожих друг на друга знаков
//     (нет I, L, O, 0, 1), регистр и дефисы не важны;
//   • не секрет: код можно передать другу — награда от этого не «расходится»,
//     потому что забрать её можно только один раз в сутки на игрока.
// Модуль не подключает другие файлы: одинаково работает в Node и в воркере.

// Символы без визуальных двойников: нет 0 и O, нет 1, I и L — такой код легко
// продиктовать и трудно перепутать при вводе.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 6;
const SALT = 'hamster-tap:code';
// Награда за код дня: заметно больше ежедневных заданий, но требует зайти в бота.
const CODE_REWARD = 7500;
// В user_quests клейм кода хранится с этим идентификатором (таблица уже есть — новых нет).
const CODE_QUEST_ID = 'daily_code';

/** FNV-1a: детерминированно и одинаково в Node и в Workers (без криптографии). */
function hash32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

// Код дня: берём по 5 бит хеша на символ (диапазон 0..31 сворачиваем в алфавит).
function codeFor(day, salt = SALT) {
  const hash = hash32(`${salt}|${day}`);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    const chunk = (hash >>> (5 * i)) & 31;
    code += ALPHABET[chunk % ALPHABET.length];
  }
  return code;
}

// Приводим ввод к каноническому виду: убираем пробелы, дефисы и регистр.
// Всё, что не латинская буква или цифра (в том числе кириллица и слова вроде «код:»),
// просто выкидываем — игрок может вставить строку как есть.
function normalize(input) {
  return String(input === null || input === undefined ? '' : input)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '');
}

function check(input, day, salt = SALT) {
  const value = normalize(input);
  return value.length === CODE_LENGTH && value === codeFor(day, salt);
}

// Сколько миллисекунд осталось до конца суток UTC: код действует до полуночи.
function msUntilDayEnd(day, now) {
  const next = Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000;
  return Math.max(0, next - now);
}

// Подсказка для интерфейса: где взять код.
function hint() {
  return 'Код дня выдаёт бот: отправьте ему /code и введите его здесь';
}

module.exports = {
  ALPHABET,
  CODE_LENGTH,
  CODE_REWARD,
  CODE_QUEST_ID,
  hash32,
  codeFor,
  normalize,
  check,
  msUntilDayEnd,
  hint
};
