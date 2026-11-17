require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const socketio = require('socket.io');
const PASSAGES = require('./passages');
const createAccounts = require('./accounts');

const PORT = process.env.PORT || 3000;
const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS) || 3000; // wait before the race starts (env override is for tests)
const RACE_MS = Number(process.env.RACE_MS) || 60000;           // race length
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
const accounts = createAccounts(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
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
  results.push({ room: room.code, ranked: room.ranked, endedAt: new Date().toISOString(), text: room.text, players: players });
  if (results.length > 500) results = results.slice(-500);
  saveResults();
}

// the last 50 saved races, newest first
app.get('/api/results', function (req, res) {
  accounts.recentResults(50).catch(function (e) {
    console.error('Could not load saved races:', e.message);
    return [];
  }).then(function (ranked) {
    const all = ranked.concat(results.slice(-50)); // ranked from the database, casual from the local file
    all.sort(function (a, b) { return String(b.endedAt).localeCompare(String(a.endedAt)); });
    res.json(all.slice(0, 50));
  });
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
  p.forfeited = false; // paid, but disconnected (or left) once the race had begun: the fee stays in the pot
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
      forfeited: !!p.forfeited,
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
    ranked: room.ranked,
    fee: ENTRY_FEE,
    pot: room.pot || 0,
    players: players,
  });
}

// ---------- race flow ----------
function logError(what) {
  return function (e) { console.error(what + ':', e.message); };
}

function sendAccount(p) {
  accounts.view(p.pid).then(function (view) {
    if (view) io.to(p.id).emit('account:state', view);
  }).catch(logError('Could not load account ' + p.pid));
}

// Resolves to an error message if the race can't start.
// Ranked: entry fees of everyone who can pay are moved into the race pot in one database transaction
// (all or nothing); racers with too few coins stay in the room and watch.
// Casual: free for everyone, no pot, no coins or rating change, and no database calls.
async function startRace(room) {
  let entered;
  if (!room.ranked) {
    entered = room.players.map(function (p) { return p.pid; });
  } else {
    room.starting = true; // blocks a second start (and new joiners) while the fees are being collected
    let collected;
    try {
      collected = await accounts.collectEntries(room.code, room.players.map(function (p) { return p.pid; }), ENTRY_FEE);
    } catch (e) {
      room.starting = false;
      console.error('Could not collect entry fees for ' + room.code + ':', e.message);
      return 'Could not collect the entry fees. Nobody was charged, please try again.';
    }

    room.starting = false;
    if (rooms[room.code] !== room) { // everyone left while the fees were being collected
      if (collected.entered.length > 0) accounts.voidPot(room.code).catch(logError('Could not return pot ' + room.code));
      return '';
    }

    // racers who left in the meantime get their fee back
    const here = room.players.map(function (p) { return p.pid; });
    entered = collected.entered.filter(function (pid) { return here.indexOf(pid) >= 0; });
    collected.entered.forEach(function (pid) {
      if (here.indexOf(pid) < 0) accounts.refundEntry(room.code, pid).catch(logError('Could not refund ' + pid));
    });
    if (entered.length === 0) {
      if (collected.entered.length > 0) return 'Everyone who paid left, so the race was cancelled.';
      return 'Nobody has ' + ENTRY_FEE + ' coins for the entry fee.';
    }
  }

  room.text = PASSAGES[Math.floor(Math.random() * PASSAGES.length)];
  room.status = 'countdown';
  room.startAt = Date.now() + COUNTDOWN_MS;
  room.pot = room.ranked ? entered.length * ENTRY_FEE : 0;
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    resetPlayer(p);
    if (entered.indexOf(p.pid) >= 0) {
      if (room.ranked && p.away) p.forfeited = true; // already disconnected: paid in, but out of the race
      else p.entered = true;
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
  if (allFinished(room)) return endRace(room); // everyone who paid has already disconnected
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
async function settleRace(room) {
  if (!room.ranked) return; // casual races pay nothing and change no ratings
  const ranked = room.players.filter(function (p) { return p.entered; });
  if (ranked.length === 0) {
    // everyone who paid disconnected or left: there is nobody to pay, so the race is cancelled and every fee goes back
    await accounts.voidPot(room.code).catch(logError('Could not return pot ' + room.code));
    return;
  }
  let outcome;
  try {
    // one transaction: split the pot by placement, update every rating, save the results
    outcome = await accounts.settle(room.code, ranked.map(function (p) {
      return {
        pid: p.pid,
        active: p.correct > 0,
        name: p.name,
        wpm: p.wpm,
        accuracy: p.accuracy,
        finished: p.finished,
        progress: Math.round((p.correct / room.text.length) * 1000) / 10,
        seconds: p.finished ? Math.round((p.finishedAt - room.startAt) / 100) / 10 : null,
      };
    }), room.text);
  } catch (e) {
    // the transaction was rolled back: nothing was paid, so return the fees instead of losing them
    console.error('Could not settle race ' + room.code + ':', e.message);
    await accounts.voidPot(room.code).catch(logError('Could not return pot ' + room.code));
    ranked.forEach(function (p) {
      io.to(p.id).emit('race:notice', { message: 'Something went wrong paying out this race. Your entry fee was returned.' });
      sendAccount(p);
    });
    return;
  }
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
  broadcast(room);
  room.settling = true; // the payout is in flight: no new race until it is done
  settleRace(room).catch(logError('Could not settle race ' + room.code)).then(function () {
    room.settling = false;
    if (!room.ranked) recordRace(room); // ranked results were saved inside the payout transaction
    broadcast(room);
  });
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
  player.rating = 1000; // replaced by the real rating once the account has loaded
  room.players.push(player);
  socket.join(room.code);
  socket.data.code = room.code;
  broadcast(room);
  return player;
}

// creates the account on first visit and loads the rating; the player's seat is already held
async function registerPlayer(room, player) {
  const view = await accounts.join(player.pid, player.name);
  player.rating = view.rating;
  io.to(player.id).emit('account:state', view);
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
  if (p.forfeited) {
    io.to(p.id).emit('race:notice', { message: 'You disconnected during the race, so you forfeited your entry fee.' });
  }
  sendAccount(p);
}

function removePlayer(room, p) {
  clearTimeout(p.awayTimer);
  const i = room.players.indexOf(p);
  if (i >= 0) room.players.splice(i, 1);
  if (room.ranked && room.status === 'countdown' && p.entered) { // race hasn't begun: give the fee back
    p.entered = false;
    room.pot = Math.max(0, (room.pot || 0) - ENTRY_FEE);
    accounts.refundEntry(room.code, p.pid).then(function () {
      sendAccount(p);
    }).catch(logError('Could not refund ' + p.pid));
  }
  if (rooms[room.code] !== room) return;
  if (room.players.length === 0) {
    clearInterval(room.tickTimer);
    clearTimeout(room.endTimer);
    delete rooms[room.code];
    if (room.ranked && (room.status === 'countdown' || room.status === 'racing')) { // everyone left mid-race: return what is still in the pot
      accounts.voidPot(room.code).catch(logError('Could not return pot ' + room.code));
    }
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
  // Ranked: once the fee is in the pot, a disconnect forfeits it. The racer is out of this race (they can come
  // back to watch), and their fee stays in the pot for the racers who stay.
  if (room.ranked && p.entered && (room.status === 'countdown' || room.status === 'racing')) {
    p.entered = false;
    p.forfeited = true;
  }
  if (room.hostId === p.id) room.hostId = pickHost(room);
  if (room.status === 'racing' && allFinished(room)) endRace(room);
  else broadcast(room);
}

// ---------- socket events ----------
function onConnection(socket) {
  socket.data.code = null;

  async function onCreate(data, ack) {
    if (socket.data.code) return;
    const ranked = (data || {}).ranked !== false; // ranked unless the host picked casual
    const room = { code: randomCode(), hostId: socket.id, ranked: ranked, status: 'lobby', text: '', startAt: 0, players: [] };
    rooms[room.code] = room;
    const player = joinRoom(socket, room, (data || {}).name, cleanPid((data || {}).pid));
    try {
      await registerPlayer(room, player);
    } catch (e) {
      console.error('Could not create account:', e.message);
      leaveRoom(socket);
      return ack({ ok: false, error: 'Could not reach the account service. Please try again.' });
    }
    ack({ ok: true, code: room.code });
  }

  async function onJoin(data, ack) {
    data = data || {};
    const code = String(data.code || '').toUpperCase().slice(0, 4);
    const room = rooms[code];
    const pid = cleanPid(data.pid);
    const existing = room && findByPid(room, pid);
    const started = room && (room.starting || room.status === 'countdown' || room.status === 'racing');
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
    const player = joinRoom(socket, room, data.name, pid);
    try {
      await registerPlayer(room, player);
    } catch (e) {
      console.error('Could not create account:', e.message);
      leaveRoom(socket);
      return ack({ ok: false, error: 'Could not reach the account service. Please try again.' });
    }
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

  async function onStart() {
    const room = rooms[socket.data.code];
    if (!room || room.hostId !== socket.id) return; // only the host starts races
    if (room.status !== 'lobby' && room.status !== 'finished') return;
    if (room.starting) return;
    if (room.settling) return socket.emit('race:notice', { message: 'Still paying out the last race. Try again in a second.' });
    const error = await startRace(room);
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
    accounts.view(cleanPid((data || {}).pid)).then(function (view) {
      ack(view ? { ok: true, account: view } : { ok: false });
    }).catch(function (e) {
      console.error('Could not load account:', e.message);
      ack({ ok: false });
    });
  }

  socket.on('account:get', onAccount);
  socket.on('room:create', function (data, ack) { onCreate(data, ack).catch(logError('room:create')); });
  socket.on('room:join', function (data, ack) { onJoin(data, ack).catch(logError('room:join')); });
  socket.on('race:start', function () { onStart().catch(logError('race:start')); });
  socket.on('race:input', onInput);
  socket.on('room:rejoin', onRejoin);
  socket.on('room:leave', onLeave);
  socket.on('disconnect', function () {
    dropConnection(socket);
  });
}

io.on('connection', onConnection);

// races that were running when the server stopped never finish: give those entry fees back, then open up
accounts.voidAllPots().then(function (count) {
  if (count > 0) console.log('Returned ' + count + ' unfinished race pot(s).');
}).catch(function (e) {
  console.error('Could not return old pots (is the database set up?):', e.message);
}).then(function () {
  server.listen(PORT, function () {
    console.log('Type Sprint running at http://localhost:' + PORT);
  });
});