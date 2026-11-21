require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const socketio = require('socket.io');
const passages = require('./passages'); // the text bank, grouped by difficulty
const createAccounts = require('./accounts');
const createMatchmaker = require('./matchmaker'); // the quick-match queue

const PORT = process.env.PORT || 3000;
const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS) || 3000; // wait before the race starts (env override is for tests)
const RACE_MS = Number(process.env.RACE_MS) || 60000;           // race length
const MAX_PLAYERS = 5;
const GRACE_MS = 120000;   // how long a disconnected player's seat is held for them
const MAX_CPS = 25;        // fastest believable typing speed (characters per second); anything beyond is rejected and flagged
const FLAG_WPM = 250;      // an average speed no human sustains: flagged (needs FLAG_MIN_LETTERS so a short burst can't trip it)
const FLAG_MIN_LETTERS = 40;
const MAX_JUMP = 20;      // most letters one message may add: phone keyboards insert a whole word at once (swipe typing, suggestions), a pasted passage is far longer
const MAX_WRONG = 10;     // wrong letters a player may leave in the box before they have to backspace
const RESERVE_MS = Number(process.env.RESERVE_MS) || 60000;         // how long a room made through the REST API waits for its host to connect
const MATCH_JOIN_MS = Number(process.env.MATCH_JOIN_MS) || 15000;   // how long matched players have to connect to their room

const app = express();
const server = http.createServer(app);
const io = new socketio.Server(server);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '4kb' })); // request bodies for the REST room and matchmaking endpoints

app.get('/config.json', function (req, res) {
  res.json({ supabaseUrl: process.env.SUPABASE_URL || '', supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '' });
});

// ---------- saved results (survive restarts) ----------
const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const accounts = createAccounts(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, process.env.SUPABASE_ANON_KEY);
const ENTRY_FEE = accounts.ENTRY_FEE;
const requireLogin = require('./api-data')(app, accounts, passages).requireLogin; // wallet, races, stats, leaderboard, passages
require('./api-auth')(app, accounts, requireLogin);                             // sign-up, login, refresh, logout, profile

io.use(async function (socket, next) {
  try {
    const user = await accounts.verifyToken(((socket.handshake || {}).auth || {}).token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.pid = user.id;
    socket.data.name = user.username || String(user.email || '').split('@')[0];
    next();
  } catch (e) {
    console.error('Login check failed:', e.message);
    next(new Error('unauthorized'));
  }
});
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
  results.push({ room: room.code, ranked: room.ranked, difficulty: room.difficulty, endedAt: new Date().toISOString(), text: room.text, players: players });
  if (results.length > 500) results = results.slice(-500);
  saveResults();
}

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

function roomByCode(code) {
  return rooms[String(code || '').toUpperCase().slice(0, 4)];
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function wrongAfter(input, text, from) {
  let n = 0;
  for (let i = from; i < input.length; i++) if (input[i] !== text[i]) n++;
  return n;
}

function normalizeTyped(text) {
  return String(text)
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

function nameTaken(room, name) {
  return room.players.some(function (p) { return p.name === name; });
}

function findByPid(room, pid) {
  if (!pid) return null;
  return room.players.find(function (p) { return p.pid === pid; }) || null;
}

function findById(room, id) {
  return room.players.find(function (p) { return p.id === id; }) || null;
}

function pickHost(room) {
  return (room.players.find(function (p) { return !p.away; }) || room.players[0]).id;
}

function allFinished(room) {
  return room.players.every(function (p) { return !p.entered || p.finished; });
}

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

function flag(p, reason, detail) {
  if (p.flags[reason]) p.flags[reason].count++;
  else p.flags[reason] = { count: 1, detail: detail };
}

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

// ---------- live lobby: the open rooms anybody can join ----------
const LOBBY_MAX_ROOMS = 20;
let lobbyTimer = null;

function openRooms() {
  const list = [];
  Object.keys(rooms).forEach(function (code) {
    const room = rooms[code];
    const practicing = !!room.practice && (room.status === 'countdown' || room.status === 'racing');
    if (!((room.status === 'lobby' && !room.starting) || practicing) || room.listed === false) return; // a race with others is already on, or a quick-match room
    if (room.players.length >= MAX_PLAYERS) return;
    const here = room.players.filter(function (p) { return !p.away; });
    if (here.length === 0) return;
    const host = findById(room, room.hostId) || here[0];
    list.push({
      code: room.code, host: host.name, ranked: room.ranked, difficulty: room.difficulty,
      practicing: practicing, players: room.players.length, max: MAX_PLAYERS, fee: ENTRY_FEE, createdAt: room.createdAt || 0,
    });
  });
  list.sort(function (a, b) { return b.createdAt - a.createdAt; });
  return list.slice(0, LOBBY_MAX_ROOMS).map(function (r) { delete r.createdAt; return r; });
}

function scheduleLobby() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(function () {
    lobbyTimer = null;
    io.to('lobby').emit('lobby:rooms', { rooms: openRooms() });
  }, 250);
  if (lobbyTimer.unref) lobbyTimer.unref();
}

function broadcast(room) {
  scheduleLobby();
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
      lobby: !!p.lobby,
      finishMs: p.finishedAt - room.startAt,
    });
  }
  io.to(room.code).emit('room:state', {
    code: room.code,
    status: room.status, // lobby, countdown, racing or finished
    practice: !!room.practice, // a solo practice run: others who join wait in the lobby (player.lobby)
    hostId: room.hostId,
    startAt: room.startAt,
    serverNow: Date.now(),
    ranked: room.ranked,
    difficulty: room.difficulty,
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

async function startRace(room) {
  let entered;
  room.practice = room.players.length === 1; // racing alone: free, and anyone who joins waits in the lobby
  room.paid = room.ranked && room.players.length > 1;
  if (!room.paid) {
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
  room.text = passages.pick(room.difficulty, room.text); // the server chooses: from the room's difficulty, never the same passage twice in a row
  room.status = 'countdown';
  room.startAt = Date.now() + COUNTDOWN_MS;
  room.pot = room.paid ? entered.length * ENTRY_FEE : 0;
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    resetPlayer(p);
    if (entered.indexOf(p.pid) >= 0) {
      if (room.paid && p.away) p.forfeited = true; // already disconnected: paid in, but out of the race
      else p.entered = true;
    } else {
      io.to(p.id).emit('race:notice', { message: 'You need ' + ENTRY_FEE + ' coins to enter. You are watching this one.' });
    }
    sendAccount(p);
  }
  io.to(room.code).emit('race:countdown', {
    text: room.text,
    startAt: room.startAt,
    serverNow: Date.now(),
    limitMs: RACE_MS,
  });
  broadcast(room);
  const startAt = room.startAt;
  setTimeout(function () {
    if (room.status !== 'countdown' || room.startAt !== startAt) return; // sent back to the lobby meanwhile
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

async function settleRace(room) {
  if (!room.paid) return; // casual and practice races pay nothing and change no ratings
  const ranked = room.players.filter(function (p) { return p.entered; });
  if (ranked.length === 0) {
    await accounts.voidPot(room.code).catch(logError('Could not return pot ' + room.code));
    return;
  }
  let outcome;
  try {
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
  const stats = statsPayload(room);
  if (stats.length > 0) { // saved for every race, ranked or casual; a flagged race will not count towards anyone's stats
    accounts.recordRaceStats(room.code, room.paid, room.difficulty, stats).catch(logError('Could not save race stats'));
  }
  room.players.sort(byRank);
  broadcast(room);
  room.settling = true; // the payout is in flight: no new race until it is done
  settleRace(room).catch(logError('Could not settle race ' + room.code)).then(function () {
    room.settling = false;
    if (!room.paid) recordRace(room); // ranked results were saved inside the payout transaction
    broadcast(room);
  });
}

// ---------- joining and leaving ----------
function cleanName(rawName) {
  return String(rawName || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Racer';
}

function joinRoom(socket, room, rawName, pid) {
  cancelSearch(socket); // joining a room ends any quick-match search
  if (pid) matchmaker.remove(pid); // ... including one started through the REST API
  socket.leave('lobby'); // a player in a room no longer needs the open-rooms list
  const base = cleanName(rawName);
  let name = base;
  let n = 1;
  while (nameTaken(room, name)) {
    n++;
    name = base + ' ' + n;
  }
  const player = { id: socket.id, pid: pid || socket.id, name: name, away: false, awayTimer: null };
  resetPlayer(player);
  player.lobby = room.status !== 'lobby'; // joined mid-practice (or after a race): waits in the lobby, not in the race
  player.rating = 1000; // replaced by the real rating once the account has loaded
  room.players.push(player);
  socket.join(room.code);
  socket.data.code = room.code;
  broadcast(room);
  return player;
}

async function registerPlayer(room, player) {
  const view = await accounts.join(player.pid, player.name);
  player.rating = view.rating;
  io.to(player.id).emit('account:state', view);
  broadcast(room);
}

function rebind(socket, room, p) {
  clearTimeout(p.awayTimer);
  p.awayTimer = null;
  p.away = false;
  const oldId = p.id;
  p.id = socket.id;
  if (room.hostId === oldId) room.hostId = p.id;
  socket.leave('lobby');
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
  if (room.paid && room.status === 'countdown' && p.entered) { // race hasn't begun: give the fee back
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
    scheduleLobby();
    if (room.paid && (room.status === 'countdown' || room.status === 'racing')) { // everyone left mid-race: return what is still in the pot
      accounts.voidPot(room.code).catch(logError('Could not return pot ' + room.code));
    }
    return;
  }
  if (room.hostId === p.id) room.hostId = pickHost(room);
  if (room.status === 'racing' && allFinished(room)) endRace(room);
  else broadcast(room);
}

function leaveRoom(socket) {
  const room = rooms[socket.data.code];
  if (!room) { socket.data.code = null; return; } // a stale code must not leave the player stuck "in a room"
  socket.leave(room.code);
  socket.data.code = null;
  const p = findById(room, socket.id);
  if (p) removePlayer(room, p);
}

function dropConnection(socket) {
  const room = rooms[socket.data.code];
  if (!room) return;
  const p = findById(room, socket.id);
  if (!p) return; // this player already reconnected on a newer socket
  p.away = true;
  p.awayTimer = setTimeout(function () {
    removePlayer(room, p);
  }, GRACE_MS);
  if (room.paid && p.entered && (room.status === 'countdown' || room.status === 'racing')) {
    p.entered = false;
    p.forfeited = true;
  }
  if (room.hostId === p.id) room.hostId = pickHost(room);
  if (room.status === 'racing' && allFinished(room)) endRace(room);
  else broadcast(room);
}

// ---------- quick match ----------
const matchmaker = createMatchmaker({ fillMs: Number(process.env.MM_FILL_MS) || 5000 }); // the env override is for tests

function cancelSearch(socket) {
  if (socket.data.searching) {
    matchmaker.remove(socket.data.searching);
    socket.data.searching = null;
  }
}

const matchResults = {}; // pid -> { code, at }: a REST searcher's finished match, until they connect

function matchFor(pid) {
  const m = matchResults[pid];
  if (!m) return null;
  if (Date.now() - m.at > MATCH_JOIN_MS + 5000 || !rooms[m.code]) { delete matchResults[pid]; return null; }
  return m;
}
setInterval(function () { Object.keys(matchResults).forEach(matchFor); }, 10000).unref();

function startMatchedRace(room) {
  startRace(room).then(function (error) {
    if (error) io.to(room.code).emit('race:notice', { message: error });
  }).catch(logError('Could not start matched race ' + room.code));
}

function matchDeadline(room) {
  if (rooms[room.code] !== room || !room.matchPids || room.status !== 'lobby') return;
  room.matchPids = null;
  if (room.players.length === 0) { delete rooms[room.code]; return; }
  if (room.players.length >= 2) return startMatchedRace(room);
  room.listed = true;
  io.to(room.code).emit('race:notice', { message: 'Your opponents did not connect in time. Wait here or leave.' });
  broadcast(room);
}

function startMatch(group) {
  const first = group.filter(function (t) { return t.socket; })[0];
  const waiting = group.filter(function (t) { return !t.socket; }); // REST searchers: they still have to connect
  const room = {
    code: randomCode(), hostId: first ? first.socket.id : null, ranked: group[0].ranked, difficulty: group[0].difficulty,
    status: 'lobby', text: '', startAt: 0, players: [], listed: false, createdAt: Date.now(), // quick-match rooms start at once: not listed
  };
  if (waiting.length > 0) room.matchPids = group.map(function (t) { return t.pid; });
  rooms[room.code] = room;
  group.forEach(function (t) {
    if (!t.socket) { matchResults[t.pid] = { code: room.code, at: Date.now() }; return; }
    t.socket.data.searching = null;
    const player = joinRoom(t.socket, room, t.name, t.pid);
    player.rating = t.rating;
    io.to(t.socket.id).emit('match:found', { code: room.code });
    sendAccount(player);
  });
  if (waiting.length === 0) return startMatchedRace(room);
  room.matchTimer = setTimeout(function () { matchDeadline(room); }, MATCH_JOIN_MS);
  if (room.matchTimer.unref) room.matchTimer.unref();
}

function runMatchmaking() {
  matchmaker.take(Date.now()).forEach(startMatch);
}

setInterval(function () {
  runMatchmaking();
  const now = Date.now();
  matchmaker.all().forEach(function (t) {
    if (!t.socket) return; // REST searchers poll GET /api/matchmaking instead
    io.to(t.socket.id).emit('match:status', { waitedMs: now - t.joinedAt, searching: matchmaker.poolSize(t) });
  });
}, Number(process.env.MM_TICK_MS) || 1000).unref();

// ---------- REST API: rooms and matchmaking ----------
function roomOfPid(pid) {
  const code = Object.keys(rooms).find(function (c) { return findByPid(rooms[c], pid); });
  return code ? rooms[code] : null;
}

function reservedRoomOf(pid) {
  const code = Object.keys(rooms).find(function (c) { return rooms[c].reservedHost === pid; });
  return code ? rooms[code] : null;
}

function restName(user) {
  return cleanName(user.username || String(user.email || '').split('@')[0]);
}

function checkRaceSettings(body) {
  if (body.ranked !== undefined && typeof body.ranked !== 'boolean') return '"ranked" must be true or false.';
  if (body.difficulty !== undefined && !passages.isDifficulty(body.difficulty)) return '"difficulty" must be easy, medium or hard.';
  return '';
}

function roomView(room, pid) {
  const host = findById(room, room.hostId) || room.players[0];
  return {
    code: room.code, status: room.status, ranked: room.ranked, difficulty: room.difficulty,
    host: host ? host.name : null, players: room.players.map(function (p) { return { name: p.name, rating: p.rating, away: !!p.away }; }),
    max: MAX_PLAYERS, fee: ENTRY_FEE, pot: room.pot || 0, youAreIn: !!findByPid(room, pid),
  };
}

app.get('/api/rooms', requireLogin, function (req, res) {
  res.json({ rooms: openRooms() });
});

app.get('/api/rooms/:code', requireLogin, function (req, res) {
  const room = roomByCode((req.params || {}).code);
  if (!room || (room.players.length === 0 && room.reservedHost !== req.user.id)) return res.status(404).json({ error: 'No room with that code.' });
  res.json(roomView(room, req.user.id));
});

app.post('/api/rooms', requireLogin, function (req, res) {
  const body = req.body || {};
  const bad = checkRaceSettings(body);
  if (bad) return res.status(400).json({ error: bad });
  const pid = req.user.id;
  if (roomOfPid(pid) || reservedRoomOf(pid)) return res.status(409).json({ error: 'You already have a room. Leave it first.' });
  if (matchmaker.has(pid) || matchFor(pid)) return res.status(409).json({ error: 'You are in matchmaking. Cancel it first.' });
  const room = {
    code: randomCode(), hostId: null, reservedHost: pid, ranked: body.ranked !== false,
    difficulty: body.difficulty || passages.DEFAULT_DIFFICULTY, status: 'lobby', text: '', startAt: 0, players: [], createdAt: Date.now(),
  };
  rooms[room.code] = room;
  room.reserveTimer = setTimeout(function () { // the host never connected: free the code
    if (rooms[room.code] === room && room.reservedHost) delete rooms[room.code];
  }, RESERVE_MS);
  if (room.reserveTimer.unref) room.reserveTimer.unref();
  res.status(201).json({ code: room.code, ranked: room.ranked, difficulty: room.difficulty, expiresInMs: RESERVE_MS });
});

app.delete('/api/rooms/:code', requireLogin, function (req, res) {
  const room = roomByCode((req.params || {}).code);
  if (!room || room.reservedHost !== req.user.id) return res.status(404).json({ error: 'You have no reserved room with that code.' });
  clearTimeout(room.reserveTimer);
  delete rooms[room.code];
  res.json({ ok: true });
});

app.get('/api/matchmaking', requireLogin, function (req, res) {
  const pid = req.user.id;
  const m = matchFor(pid);
  if (m) return res.json({ status: 'matched', code: m.code, expiresInMs: Math.max(0, MATCH_JOIN_MS - (Date.now() - m.at)) });
  const t = matchmaker.all().filter(function (x) { return x.pid === pid; })[0];
  if (!t) return res.json({ status: 'idle' });
  res.json({ status: 'searching', ranked: t.ranked, difficulty: t.difficulty, waitedMs: Date.now() - t.joinedAt, searching: matchmaker.poolSize(t) });
});

app.post('/api/matchmaking', requireLogin, async function (req, res) {
  try {
    const body = req.body || {};
    const bad = checkRaceSettings(body);
    if (bad) return res.status(400).json({ error: bad });
    const pid = req.user.id;
    const ranked = body.ranked !== false;
    const difficulty = body.difficulty || passages.DEFAULT_DIFFICULTY;
    const busy = function () {
      if (roomOfPid(pid) || reservedRoomOf(pid)) return 'Leave your current room first.';
      if (matchmaker.has(pid)) return 'You are already searching for a match.';
      if (matchFor(pid)) return 'You already have a match waiting. Join it first.';
      return '';
    };
    if (busy()) return res.status(409).json({ error: busy() });
    let account;
    try {
      account = await accounts.join(pid, restName(req.user));
    } catch (e) {
      console.error('Could not create account for matchmaking:', e.message);
      return res.status(502).json({ error: 'Could not reach the account service. Please try again.' });
    }
    if (ranked && account.coins < ENTRY_FEE) {
      return res.status(403).json({ error: 'You need ' + ENTRY_FEE + ' coins for a ranked match. Try a casual match.' });
    }
    if (busy()) return res.status(409).json({ error: busy() }); // things can change while the database answers
    matchmaker.add({ id: pid, pid: pid, socket: null, name: restName(req.user), rating: account.rating, ranked: ranked, difficulty: difficulty, joinedAt: Date.now() });
    res.status(202).json({ status: 'searching', ranked: ranked, difficulty: difficulty });
    runMatchmaking(); // someone may already be waiting
  } catch (e) {
    console.error('POST /api/matchmaking failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'Something went wrong.' });
  }
});

app.delete('/api/matchmaking', requireLogin, function (req, res) {
  const pid = req.user.id;
  const t = matchmaker.all().filter(function (x) { return x.pid === pid; })[0];
  if (t && t.socket) cancelSearch(t.socket); else matchmaker.remove(pid);
  delete matchResults[pid];
  res.json({ status: 'idle' });
});

function onConnection(socket) {
  socket.data.code = null;
  async function onCreate(data, ack) {
    if (typeof ack !== 'function') return;
    if (socket.data.code) return ack({ ok: false, error: 'You are already in a room. Leave it first.' });
    const ranked = (data || {}).ranked !== false; // ranked unless the host picked casual
    const difficulty = passages.isDifficulty((data || {}).difficulty) ? data.difficulty : passages.DEFAULT_DIFFICULTY; // anything else becomes the default
    const room = { code: randomCode(), hostId: socket.id, ranked: ranked, difficulty: difficulty, status: 'lobby', text: '', startAt: 0, players: [], createdAt: Date.now() };
    rooms[room.code] = room;
    const player = joinRoom(socket, room, socket.data.name, socket.data.pid);
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
    const room = roomByCode(code);
    const pid = socket.data.pid;
    const existing = room && findByPid(room, pid);
    const started = room && (room.starting || ((room.status === 'countdown' || room.status === 'racing') && !room.practice));
    let error = '';
    if (socket.data.code) error = 'You are already in a room.';
    else if (!room) error = 'No room with code ' + code + '.';
    else if (existing && started) error = 'You are already in this race. Reload the page to get back in.';
    else if (existing) {
      rebind(socket, room, existing);
      broadcast(room);
      return ack({ ok: true, code: code });
    } else if (started) error = 'That race has already started.';
    else if (room.reservedHost && room.reservedHost !== pid && room.players.length === 0) error = 'The host has not arrived yet.';
    else if (room.matchPids && room.matchPids.indexOf(pid) < 0) error = 'That room is reserved for a matched race.';
    else if (room.players.length >= MAX_PLAYERS) error = 'That room is full (' + MAX_PLAYERS + ' players max).';
    if (error) return ack({ ok: false, error: error });
    if (room.reservedHost === pid) {
      room.reservedHost = null;
      clearTimeout(room.reserveTimer);
      room.hostId = socket.id;
    } else if (room.matchPids && !findById(room, room.hostId)) room.hostId = socket.id;
    delete matchResults[pid];
    const player = joinRoom(socket, room, socket.data.name, pid);
    try {
      await registerPlayer(room, player);
    } catch (e) {
      console.error('Could not create account:', e.message);
      leaveRoom(socket);
      return ack({ ok: false, error: 'Could not reach the account service. Please try again.' });
    }
    ack({ ok: true, code: code });
    if (room.matchPids && room.status === 'lobby' && !room.starting && room.players.length >= room.matchPids.length) {
      clearTimeout(room.matchTimer);
      room.matchPids = null;
      startMatchedRace(room);
    }
  }
  function onRejoin(data, ack) {
    if (typeof ack !== 'function') return;
    data = data || {};
    const room = roomByCode(data.code);
    const p = room && findByPid(room, socket.data.pid);
    if (!p) return ack({ ok: false, error: 'That room no longer exists.' });
    if (socket.data.code && socket.data.code !== room.code) return ack({ ok: false, error: 'You are already in a room.' });
    rebind(socket, room, p);
    ack({
      ok: true,
      code: room.code,
      status: room.status,
      text: room.status === 'lobby' || p.lobby ? '' : room.text,
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
  function onToLobby() {
    const room = rooms[socket.data.code];
    if (!room || room.hostId !== socket.id) return;
    if (room.starting || room.settling) return;
    const practice = !!room.practice;
    if (!(room.status === 'finished' || (practice && (room.status === 'countdown' || room.status === 'racing')))) return;
    clearInterval(room.tickTimer);
    clearTimeout(room.endTimer);
    room.status = 'lobby';
    room.startAt = 0;
    room.pot = 0;
    room.paid = false;
    room.practice = false;
    room.players.forEach(resetPlayer);
    broadcast(room);
  }
  function onInput(data) {
    const room = rooms[socket.data.code];
    if (!room) return;
    const p = findById(room, socket.id);
    if (p && !handleInput(room, p, (data || {}).input)) socket.emit('race:resync', { input: p.input, seq: (data || {}).seq });
  }
  function onAccount(data, ack) {
    if (typeof ack !== 'function') return;
    accounts.view(socket.data.pid).then(function (view) {
      ack(view ? { ok: true, account: view } : { ok: false });
    }).catch(function (e) {
      console.error('Could not load account:', e.message);
      ack({ ok: false });
    });
  }
  socket.on('match:join', function (data, ack) { onMatchJoin(data, ack).catch(logError('match:join')); });
  socket.on('match:cancel', function (data, ack) {
    cancelSearch(socket);
    if (typeof ack === 'function') ack({ ok: true });
  });
  async function onMatchJoin(data, ack) {
    if (typeof ack !== 'function') return;
    data = data || {};
    if (socket.data.code) return ack({ ok: false, error: 'Leave your current room first.' });
    const now = Date.now();
    if (socket.data.lastMatch && now - socket.data.lastMatch < 500) return ack({ ok: false, error: 'Slow down a little.' });
    socket.data.lastMatch = now;
    const pid = socket.data.pid;
    if (socket.data.searching || matchmaker.has(pid)) return ack({ ok: false, error: 'You are already searching for a match.' });
    const ranked = data.ranked !== false; // ranked unless the player picked casual
    const difficulty = passages.isDifficulty(data.difficulty) ? data.difficulty : passages.DEFAULT_DIFFICULTY;
    const name = cleanName(socket.data.name);
    let account;
    try {
      account = await accounts.join(pid, name);
    } catch (e) {
      console.error('Could not create account for matchmaking:', e.message);
      return ack({ ok: false, error: 'Could not reach the account service. Please try again.' });
    }
    if (ranked && account.coins < ENTRY_FEE) {
      return ack({ ok: false, error: 'You need ' + ENTRY_FEE + ' coins for a ranked match. Try a casual match.' });
    }
    if (socket.data.gone || socket.data.code || socket.data.searching || matchmaker.has(pid)) {
      return ack({ ok: false, error: 'Could not start searching. Please try again.' });
    }
    matchmaker.add({ id: pid, pid: pid, socket: socket, name: name, rating: account.rating, ranked: ranked, difficulty: difficulty, joinedAt: Date.now() });
    socket.data.searching = pid;
    ack({ ok: true });
    runMatchmaking(); // someone may already be waiting
  }
  socket.on('account:get', onAccount);
  socket.on('lobby:watch', function (data, ack) {
    if (socket.data.code) return typeof ack === 'function' && ack({ ok: false, rooms: [] });
    socket.join('lobby');
    if (typeof ack === 'function') ack({ ok: true, rooms: openRooms() });
  });
  socket.on('lobby:unwatch', function () { socket.leave('lobby'); });
  socket.on('room:difficulty', function (data) {
    const room = rooms[socket.data.code];
    if (!room || room.hostId !== socket.id) return;
    if (room.status !== 'lobby' && room.status !== 'finished') return;
    if (room.starting || room.settling) return;
    const difficulty = (data || {}).difficulty;
    if (!passages.isDifficulty(difficulty) || difficulty === room.difficulty) return;
    room.difficulty = difficulty;
    broadcast(room);
  });
  socket.on('room:create', function (data, ack) { onCreate(data, ack).catch(logError('room:create')); });
  socket.on('room:join', function (data, ack) { onJoin(data, ack).catch(logError('room:join')); });
  socket.on('race:start', function () { onStart().catch(logError('race:start')); });
  socket.on('room:lobby', onToLobby);
  socket.on('race:input', onInput);
  socket.on('room:rejoin', onRejoin);
  socket.on('room:leave', function () { leaveRoom(socket); });
  socket.on('disconnect', function () {
    socket.data.gone = true;
    cancelSearch(socket);
    dropConnection(socket);
  });
}

io.on('connection', onConnection);

accounts.voidAllPots().then(function (count) {
  if (count > 0) console.log('Returned ' + count + ' unfinished race pot(s).');
}).catch(function (e) {
  console.error('Could not return old pots (is the database set up?):', e.message);
}).then(function () {
  server.listen(PORT, function () {
    console.log('Type Sprint running at http://localhost:' + PORT);
  });
});
