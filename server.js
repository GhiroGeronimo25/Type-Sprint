const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const socketio = require('socket.io');
const PASSAGES = require('./passages');
const createAccounts = require('./accounts');

const PORT = process.env.PORT || 3000;
const COUNTDOWN_MS = 3000; // wait before the race starts
const RACE_MS = 60000;     // race length
const MAX_PLAYERS = 5;
const GRACE_MS = 120000;   // how long a disconnected player's seat is held for them
const MAX_CPS = 25;        // fastest believable typing speed (characters per second)

const app = express();
const server = http.createServer(app);
const io = new socketio.Server(server);
app.use(express.static(path.join(__dirname, 'public')));

// ---------- saved results (survive restarts) ----------
const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const accounts = createAccounts(path.join(DATA_DIR, 'accounts.json'));
const ENTRY_FEE = accounts.ENTRY_FEE;
let results = [];
try {
  results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  if (!Array.isArray(results)) results = [];
} catch (e) {
  results = [];
}

function saveResults() {
  fs.mkdir(DATA_DIR, { recursive: true }, function (err) {
    if (err) return console.error('Could not create data folder:', err.message);
    const tmp = RESULTS_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(results, null, 2), function (err) {
      if (err) return console.error('Could not save results:', err.message);
      fs.rename(tmp, RESULTS_FILE, function (err) {
        if (err) console.error('Could not save results:', err.message);
      });
    });
  });
}

function recordRace(room) {
  let anyone = false;
  const players = [];
  const entrants = room.players.filter(function (p) { return p.entered; });
  for (let i = 0; i < entrants.length; i++) {
    const p = entrants[i];
    if (p.correct > 0) anyone = true;
    players.push({
      rank: i + 1,
      coins: p.result ? p.result.payout : 0,
      name: p.name,
      wpm: p.wpm,
      accuracy: p.accuracy,
      finished: p.finished,
      progress: Math.round((p.correct / room.text.length) * 1000) / 10,
      seconds: p.finished ? Math.round((p.finishedAt - room.startAt) / 100) / 10 : null,
    });
  }
  if (!anyone) return;
  results.push({ room: room.code, endedAt: new Date().toISOString(), text: room.text, players: players });
  if (results.length > 500) results = results.slice(-500);
  saveResults();
}

// the last 50 saved races, newest first
app.get('/api/results', function (req, res) {
  res.json(results.slice(-50).reverse());
});

const rooms = {}; // rooms['ABCD'] = { code, hostId, status, text, startAt, players: [] }

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

function nameTaken(room, name) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].name === name) return true;
  }
  return false;
}

function cleanPid(value) {
  return String(value || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
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
  p.wpm = 0;
  p.accuracy = 100;
  p.finished = false;
  p.finishedAt = 0;
  p.entered = false; // paid the entry fee for this race
  p.result = null;   // coins and rating change once the race is over
}

function updateStats(room, p) {
  let end = Date.now();
  if (p.finished) end = p.finishedAt;
  const minutes = Math.max(end - room.startAt, 1000) / 60000;
  p.wpm = Math.round(p.correct / 5 / minutes);
  if (p.keys > 0) p.accuracy = Math.round((1 - p.errors / p.keys) * 1000) / 10;
}

// returns false if the input looks fake (paste, bots) so the client can be reset
function handleInput(room, p, input) {
  if (room.status !== 'racing' || !p.entered || p.finished || Date.now() < room.startAt) return true;

  input = String(input || '').slice(0, room.text.length);
  const correct = commonPrefix(input, room.text);
  const seconds = (Date.now() - room.startAt) / 1000;

  if (input.length - p.input.length > 4) return false;  // pasted text
  if (input.length - correct > 10) return false;        // too many wrong letters
  if (correct > MAX_CPS * seconds + 5) return false;    // faster than a human

  // only new letters count as keystrokes, backspace is free
  for (let i = p.input.length; i < input.length; i++) {
    p.keys++;
    if (input[i] !== room.text[i]) p.errors++;
  }
  p.input = input;
  p.correct = correct;

  if (correct === room.text.length) {
    p.finished = true;
    p.finishedAt = Date.now();
  }
  updateStats(room, p);
  if (p.finished && allFinished(room)) endRace(room);
  return true;
}

// ---------- sending the leaderboard ----------
function broadcast(room) {
  room.players.sort(byRank); // list order = rank
  const players = [];
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    let progress = 0;
    if (room.text) progress = p.correct / room.text.length;
    players.push({
      id: p.id,
      name: p.name,
      progress: progress,
      wpm: p.wpm,
      accuracy: p.accuracy,
      finished: p.finished,
      entered: p.entered,
      rating: p.rating,
      away: !!p.away,
      finishMs: p.finishedAt - room.startAt,
    });
  }
  io.to(room.code).emit('room:state', {
    code: room.code,
    status: room.status, // lobby, countdown, racing or finished
    hostId: room.hostId,
    startAt: room.startAt,
    serverNow: Date.now(),
    fee: ENTRY_FEE,
    pot: room.pot || 0,
    players: players,
  });
}

// ---------- race flow ----------
function sendAccount(p) {
  io.to(p.id).emit('account:state', accounts.view(p.pid));
}

// Returns an error message if the race can't start. Charges the entry fee of everyone who can pay;
// racers with too few coins stay in the room and watch.
function startRace(room) {
  const payers = room.players.filter(function (p) { return accounts.canAfford(p.pid, ENTRY_FEE); });
  if (payers.length === 0) return 'Nobody has ' + ENTRY_FEE + ' coins for the entry fee.';

  room.text = PASSAGES[Math.floor(Math.random() * PASSAGES.length)];
  room.status = 'countdown';
  room.startAt = Date.now() + COUNTDOWN_MS;
  room.pot = 0;
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    resetPlayer(p);
    if (accounts.charge(p.pid, ENTRY_FEE, room.code)) {
      p.entered = true;
      room.pot += ENTRY_FEE;
    } else {
      io.to(p.id).emit('race:notice', { message: 'You need ' + ENTRY_FEE + ' coins to enter. You are watching this one.' });
    }
    sendAccount(p);
  }

  // the passage is only revealed when the countdown starts
  io.to(room.code).emit('race:countdown', {
    text: room.text,
    startAt: room.startAt,
    serverNow: Date.now(),
    limitMs: RACE_MS,
  });
  broadcast(room);
  setTimeout(function () {
    beginRacing(room);
  }, COUNTDOWN_MS);
  return '';
}

function beginRacing(room) {
  if (rooms[room.code] !== room) return; // everyone left during the countdown
  room.status = 'racing';
  broadcast(room);
  room.tickTimer = setInterval(function () {
    for (let i = 0; i < room.players.length; i++) {
      if (!room.players[i].finished) updateStats(room, room.players[i]);
    }
    broadcast(room);
  }, 100);
  room.endTimer = setTimeout(function () {
    endRace(room);
  }, RACE_MS);
}

// pay prizes and update ratings, once per race
function settleRace(room) {
  const ranked = room.players.filter(function (p) { return p.entered; });
  if (ranked.length === 0) return;
  const outcome = accounts.settle(room.code, ranked.map(function (p) {
    return { pid: p.pid, active: p.correct > 0 };
  }), ENTRY_FEE, room.pot);
  for (let i = 0; i < ranked.length; i++) {
    const p = ranked[i];
    p.result = outcome[p.pid];
    p.result.fee = ENTRY_FEE;
    p.rating = p.result.ratingAfter;
    io.to(p.id).emit('race:result', p.result);
    sendAccount(p);
  }
}

function endRace(room) {
  if (room.status !== 'racing') return;
  clearInterval(room.tickTimer);
  clearTimeout(room.endTimer);
  room.status = 'finished';
  for (let i = 0; i < room.players.length; i++) {
    if (!room.players[i].finished) updateStats(room, room.players[i]);
  }
  room.players.sort(byRank);
  settleRace(room);
  recordRace(room);
  broadcast(room);
}

// ---------- joining and leaving ----------
function joinRoom(socket, room, rawName, pid) {
  const base = String(rawName || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Racer';
  let name = base;
  let n = 1;
  while (nameTaken(room, name)) {
    n++;
    name = base + ' ' + n;
  }
  const player = { id: socket.id, pid: pid || socket.id, name: name, away: false, awayTimer: null };
  resetPlayer(player);
  accounts.get(player.pid, name);
  player.rating = accounts.rating(player.pid);
  room.players.push(player);
  socket.join(room.code);
  socket.data.code = room.code;
  sendAccount(player);
  broadcast(room);
}

// a returning player takes their old seat back on a new connection
function rebind(socket, room, p) {
  clearTimeout(p.awayTimer);
  p.awayTimer = null;
  p.away = false;
  const oldId = p.id;
  p.id = socket.id;
  if (room.hostId === oldId) room.hostId = p.id;
  socket.join(room.code);
  socket.data.code = room.code;
  sendAccount(p);
}

function removePlayer(room, p) {
  clearTimeout(p.awayTimer);
  const i = room.players.indexOf(p);
  if (i >= 0) room.players.splice(i, 1);
  if (room.status === 'countdown' && p.entered) { // race hasn't begun: give the fee back
    accounts.refund(p.pid, ENTRY_FEE, room.code);
    room.pot -= ENTRY_FEE;
    sendAccount(p);
  }
  if (rooms[room.code] !== room) return;
  if (room.players.length === 0) {
    clearInterval(room.tickTimer);
    clearTimeout(room.endTimer);
    delete rooms[room.code];
    return;
  }
  if (room.hostId === p.id) room.hostId = pickHost(room);
  if (room.status === 'racing' && allFinished(room)) endRace(room);
  else broadcast(room);
}

// leaving on purpose: gone straight away
function leaveRoom(socket) {
  const room = rooms[socket.data.code];
  if (!room) return;
  socket.leave(room.code);
  socket.data.code = null;
  const p = findById(room, socket.id);
  if (p) removePlayer(room, p);
}

// connection dropped (closed tab, refresh, bad wifi): hold the seat for a while
function dropConnection(socket) {
  const room = rooms[socket.data.code];
  if (!room) return;
  const p = findById(room, socket.id);
  if (!p) return; // this player already reconnected on a newer socket
  p.away = true;
  p.awayTimer = setTimeout(function () {
    removePlayer(room, p);
  }, GRACE_MS);
  if (room.hostId === p.id) room.hostId = pickHost(room);
  broadcast(room);
}

// ---------- socket events ----------
function onConnection(socket) {
  socket.data.code = null;

  function onCreate(data, ack) {
    if (socket.data.code) return;
    const room = { code: randomCode(), hostId: socket.id, status: 'lobby', text: '', startAt: 0, players: [] };
    rooms[room.code] = room;
    joinRoom(socket, room, (data || {}).name, cleanPid((data || {}).pid));
    ack({ ok: true, code: room.code });
  }

  function onJoin(data, ack) {
    data = data || {};
    const code = String(data.code || '').toUpperCase().slice(0, 4);
    const room = rooms[code];
    const pid = cleanPid(data.pid);
    const existing = room && findByPid(room, pid);
    const started = room && (room.status === 'countdown' || room.status === 'racing');
    let error = '';
    if (socket.data.code) error = 'You are already in a room.';
    else if (!room) error = 'No room with code ' + code + '.';
    else if (existing && started) error = 'You are already in this race. Reload the page to get back in.';
    else if (existing) {
      rebind(socket, room, existing);
      broadcast(room);
      return ack({ ok: true, code: code });
    } else if (started) error = 'That race has already started.';
    else if (room.players.length >= MAX_PLAYERS) error = 'That room is full (' + MAX_PLAYERS + ' players max).';

    if (error) return ack({ ok: false, error: error });
    joinRoom(socket, room, data.name, pid);
    ack({ ok: true, code: code });
  }

  function onRejoin(data, ack) {
    if (typeof ack !== 'function') return;
    data = data || {};
    const room = rooms[String(data.code || '').toUpperCase().slice(0, 4)];
    const p = room && findByPid(room, cleanPid(data.pid));
    if (!p) return ack({ ok: false, error: 'That room no longer exists.' });
    if (socket.data.code && socket.data.code !== room.code) return ack({ ok: false, error: 'You are already in a room.' });

    rebind(socket, room, p);
    ack({
      ok: true,
      code: room.code,
      status: room.status,
      text: room.status === 'lobby' ? '' : room.text,
      startAt: room.startAt,
      limitMs: RACE_MS,
      serverNow: Date.now(),
      input: room.status === 'racing' && !p.finished ? p.input : '',
      result: p.result,
    });
    broadcast(room);
  }

  function onStart() {
    const room = rooms[socket.data.code];
    if (!room || room.hostId !== socket.id) return; // only the host starts races
    if (room.status !== 'lobby' && room.status !== 'finished') return;
    const error = startRace(room);
    if (error) socket.emit('race:notice', { message: error });
  }

  function onInput(data) {
    const room = rooms[socket.data.code];
    if (!room) return;
    for (let i = 0; i < room.players.length; i++) {
      const p = room.players[i];
      if (p.id !== socket.id) continue;
      if (!handleInput(room, p, (data || {}).input)) socket.emit('race:resync', { input: p.input });
    }
  }

  function onLeave() {
    leaveRoom(socket);
  }

  function onAccount(data, ack) {
    if (typeof ack !== 'function') return;
    const view = accounts.view(cleanPid((data || {}).pid));
    ack(view ? { ok: true, account: view } : { ok: false });
  }

  socket.on('account:get', onAccount);
  socket.on('room:create', onCreate);
  socket.on('room:join', onJoin);
  socket.on('race:start', onStart);
  socket.on('race:input', onInput);
  socket.on('room:rejoin', onRejoin);
  socket.on('room:leave', onLeave);
  socket.on('disconnect', function () {
    dropConnection(socket);
  });
}

io.on('connection', onConnection);

server.listen(PORT, function () {
  console.log('Type Sprint running at http://localhost:' + PORT);
});