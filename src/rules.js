// Room helpers, scoring, keystroke validation and anti-cheat
const { MAX_CPS, FLAG_WPM, FLAG_MIN_LETTERS, MAX_JUMP, MAX_WRONG } = require('./config');
const { rooms } = require('./core');
const S = require('./shared');
const endRace = function () { return S.endRace.apply(this, arguments); };

// ---------- helpers ----------
function randomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += letters[Math.floor(Math.random() * letters.length)];
  if (rooms[code]) return randomCode();
  return code;
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

// How many letters after the first mistake are wrong. Letters that happen to match don't count, so one typo
// followed by good typing is one mistake, not ten.
function wrongAfter(input, text, from) {
  let n = 0;
  for (let i = from; i < input.length; i++) if (input[i] !== text[i]) n++;
  return n;
}

// Phone keyboards swap plain characters for fancy ones (curly quotes, long dashes, odd spaces). Treat them as
// the plain character the passage uses, so a player typing the right key is never marked wrong.
function normalizeTyped(text) {
  return String(text)
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

function nameTaken(room, name) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].name === name) return true;
  }
  return false;
}

function findByPid(room, pid) {
  if (!pid) return null;
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].pid === pid) return room.players[i];
  }
  return null;
}

function findById(room, id) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].id === id) return room.players[i];
  }
  return null;
}

// prefer someone who is still connected
function pickHost(room) {
  for (let i = 0; i < room.players.length; i++) {
    if (!room.players[i].away) return room.players[i].id;
  }
  return room.players[0].id;
}

function allFinished(room) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].entered && !room.players[i].finished) return false;
  }
  return true;
}

// sort order: finished players (earliest first), then everyone else by progress
function byRank(a, b) {
  if (!!a.lobby !== !!b.lobby) return a.lobby ? 1 : -1; // players waiting in the lobby are not in the race
  if (a.entered !== b.entered) return a.entered ? -1 : 1;
  if (a.finished !== b.finished) return a.finished ? -1 : 1;
  if (a.finished) return a.finishedAt - b.finishedAt;
  return b.correct - a.correct;
}

// ---------- players and scoring ----------
function resetPlayer(p) {
  p.input = '';
  p.correct = 0;   // letters typed correctly in a row
  p.keys = 0;      // letters typed
  p.errors = 0;    // wrong letters typed
  p.missed = {};   // the letters they should have typed and got wrong: { 'e': 3 }
  p.flags = {};    // anti-cheat: { paste: { count, detail }, burst: ..., speed: ... }
  p.wpm = 0;
  p.accuracy = 100;
  p.finished = false;
  p.finishedAt = 0;
  p.entered = false; // paid the entry fee for this race
  p.forfeited = false; // paid, but disconnected (or left) once the race had begun: the fee stays in the pot
  p.result = null;   // coins and rating change once the race is over
  p.lobby = false;   // true: joined while a race/practice was on, so waits in the lobby instead of watching it
}

function updateStats(room, p) {
  let end = Date.now();
  if (p.finished) end = p.finishedAt;
  const minutes = Math.max(end - room.startAt, 1000) / 60000;
  p.wpm = Math.round(p.correct / 5 / minutes);
  if (p.keys > 0) p.accuracy = Math.round((1 - p.errors / p.keys) * 1000) / 10;
}

// returns false if the input looks fake (paste, bots) so the client can be reset
// anti-cheat: note what happened (once per kind per race, with a count) so it can be saved and reviewed
function flag(p, reason, detail) {
  if (p.flags[reason]) p.flags[reason].count++;
  else p.flags[reason] = { count: 1, detail: detail };
}

// what gets saved about each racer when the race ends: typing stats, missed letters and any flags
function statsPayload(room) {
  return room.players.filter(function (p) {
    return p.entered && (p.keys > 0 || Object.keys(p.flags).length > 0); // someone who only tried to paste still gets flagged
  }).map(function (p) {
    return {
      pid: p.pid,
      wpm: p.wpm,
      accuracy: p.accuracy,
      progress: Math.round((p.correct / room.text.length) * 1000) / 10,
      finished: p.finished,
      missed: p.missed,
      flags: Object.keys(p.flags).map(function (reason) {
        return { reason: reason, count: p.flags[reason].count, detail: p.flags[reason].detail };
      }),
    };
  });
}

function handleInput(room, p, input) {
  if (room.status !== 'racing' || !p.entered || p.finished || Date.now() < room.startAt) return true;

  input = normalizeTyped(input || '').slice(0, room.text.length);
  const correct = commonPrefix(input, room.text);
  const seconds = (Date.now() - room.startAt) / 1000;

  if (input.length - p.input.length > MAX_JUMP) {       // pasted text (a whole word from a phone keyboard is fine)
    flag(p, 'paste', (input.length - p.input.length) + ' letters in one message');
    return false;
  }
  if (wrongAfter(input, room.text, correct) > MAX_WRONG) return false; // too many wrong letters
  if (correct > MAX_CPS * seconds + 5) {                // faster than a human
    flag(p, 'burst', correct + ' correct letters after ' + seconds.toFixed(1) + ' seconds');
    return false;
  }

  // only new letters count as keystrokes, backspace is free
  for (let i = p.input.length; i < input.length; i++) {
    p.keys++;
    if (input[i] !== room.text[i]) {
      p.errors++;
      p.missed[room.text[i]] = (p.missed[room.text[i]] || 0) + 1;
    }
  }
  p.input = input;
  p.correct = correct;

  if (correct === room.text.length) {
    p.finished = true;
    p.finishedAt = Date.now();
  }
  updateStats(room, p);
  if (p.correct >= FLAG_MIN_LETTERS && p.wpm > FLAG_WPM) {
    flag(p, 'speed', p.wpm + ' WPM after ' + p.correct + ' letters'); // accepted, but no human averages this
  }
  if (p.finished && allFinished(room)) endRace(room);
  return true;
}

Object.assign(S, { randomCode, commonPrefix, wrongAfter, normalizeTyped, nameTaken, findByPid, findById, pickHost, allFinished, byRank, resetPlayer, updateStats, flag, statsPayload, handleInput });
