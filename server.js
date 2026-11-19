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
const RESERVE_MS = Number(process.env.RESERVE_MS) || 60000;         // how long a room made through the REST API waits for its host to connect
const MATCH_JOIN_MS = Number(process.env.MATCH_JOIN_MS) || 15000;   // how long matched players have to connect to their room

const app = express();
const server = http.createServer(app);
const io = new socketio.Server(server);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '4kb' })); // request bodies for the REST room and matchmaking endpoints

// The browser needs the project URL and the ANON key to show the login form. Both are public by design.
// (Never expose SUPABASE_SERVICE_KEY here.)
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,16}$/;
app.get('/api/username-available', function (req, res) {
  const name = String((req.query || {}).name || '');
  if (!USERNAME_RE.test(name)) return res.json({ ok: false, error: 'Use 3-16 letters, numbers, dots, dashes or underscores.' });
  accounts.usernameAvailable(name).then(function (free) {
    res.json({ ok: free, error: free ? '' : 'That username is taken.' });
  }).catch(function (e) {
    console.error('Username check failed:', e.message);
    res.status(500).json({ ok: false, error: 'Could not check the username. Please try again.' });
  });
});

app.get('/config.json', function (req, res) {
  res.json({ supabaseUrl: process.env.SUPABASE_URL || '', supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '' });
});

// ---------- saved results (survive restarts) ----------
const DATA_DIR = path.join(__dirname, 'data');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const accounts = createAccounts(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const ENTRY_FEE = accounts.ENTRY_FEE;

// Every socket must log in first. The browser sends its Supabase access token in the handshake; we verify it
// and remember who it belongs to. From here on the player id (pid) is the verified Supabase user id and is
// NEVER taken from what the client sends, so nobody can play (or spend coins) as someone else.
io.use(async function (socket, next) {
  try {
    const user = await accounts.verifyToken(((socket.handshake || {}).auth || {}).token);
    if (!user) return next(new Error('unauthorized'));
    socket.data.pid = user.id;
    socket.data.email = user.email;
    // the display name comes from the account (chosen at sign-up), never from what the browser sends
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

// ---------- REST API: wallet and transaction history ----------
// Send the Supabase access token as:  Authorization: Bearer <token>
// The player is always the logged-in user; there is no way to ask for somebody else's wallet.
const apiLastCall = {}; // user id -> time of the last call (a simple rate limit)

function requireLogin(req, res, next) {
  const match = /^Bearer (.+)$/.exec(String((req.headers || {}).authorization || ''));
  if (!match) return res.status(401).json({ error: 'Log in first (missing Bearer token).' });
  accounts.verifyToken(match[1]).then(function (user) {
    if (!user) return res.status(401).json({ error: 'Your login is invalid or expired.' });
    const now = Date.now();
    const key = user.id + ' ' + (req.path || ''); // the limit is per user and per endpoint
    if (apiLastCall[key] && now - apiLastCall[key] < 200) return res.status(429).json({ error: 'Too many requests.' });
    apiLastCall[key] = now;
    req.user = user;
    next();
  }).catch(function (e) {
    console.error('Login check failed:', e.message);
    res.status(401).json({ error: 'Your login is invalid or expired.' });
  });
}
setInterval(function () { // forget old entries so the table cannot grow forever
  const cutoff = Date.now() - 60000;
  Object.keys(apiLastCall).forEach(function (id) { if (apiLastCall[id] < cutoff) delete apiLastCall[id]; });
}, 60000).unref();

// GET /api/wallet -> { coins, rating, races, wins, entryFee, ledger: [latest 10] }
app.get('/api/wallet', requireLogin, function (req, res) {
  accounts.view(req.user.id).then(function (view) {
    if (!view) return res.status(404).json({ error: 'No game account yet. Join a room first.' });
    res.json(view);
  }).catch(function (e) {
    console.error('Could not load wallet:', e.message);
    res.status(500).json({ error: 'Could not load your wallet.' });
  });
});

// GET /api/wallet/transactions?offset=0&limit=20&type=reward
//   type (optional): grant, entry, refund or reward.  limit: 1-50 (default 20).
//   -> { items: [{ id, at, type, amount, balance, room }], hasMore, offset, limit }
app.get('/api/wallet/transactions', requireLogin, function (req, res) {
  const q = req.query || {};
  const offset = Math.min(Math.max(parseInt(q.offset, 10) || 0, 0), 10000);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 50);
  const type = ['grant', 'entry', 'refund', 'reward'].indexOf(q.type) >= 0 ? q.type : '';
  accounts.ledgerPage(req.user.id, offset, limit, type).then(function (page) {
    res.json({ items: page.items, hasMore: page.hasMore, offset: offset, limit: limit });
  }).catch(function (e) {
    console.error('Could not load transactions:', e.message);
    res.status(500).json({ error: 'Could not load your transactions.' });
  });
});

// ---------- REST API: race history ----------
// GET /api/races?offset=0&limit=20 -> your ranked races, newest first
//   -> { items: [{ id, room, ranked, endedAt, rank, wpm, accuracy, finished, progress, seconds, payout, net, ratingBefore, ratingAfter }], hasMore, offset, limit }
app.get('/api/races', requireLogin, function (req, res) {
  const q = req.query || {};
  const offset = Math.min(Math.max(parseInt(q.offset, 10) || 0, 0), 10000);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 50);
  accounts.raceHistory(req.user.id, offset, limit).then(function (page) {
    res.json({ items: page.items, hasMore: page.hasMore, offset: offset, limit: limit });
  }).catch(function (e) {
    console.error('Could not load race history:', e.message);
    res.status(500).json({ error: 'Could not load your race history.' });
  });
});

// GET /api/races/:id -> one race with every racer's standing. Only for races you took part in.
app.get('/api/races/:id', requireLogin, function (req, res) {
  const id = String((req.params || {}).id || '');
  if (!/^[0-9]{1,15}$/.test(id)) return res.status(400).json({ error: 'Bad race id.' });
  accounts.raceDetail(req.user.id, Number(id)).then(function (race) {
    if (!race) return res.status(404).json({ error: 'No such race in your history.' });
    res.json(race);
  }).catch(function (e) {
    console.error('Could not load race:', e.message);
    res.status(500).json({ error: 'Could not load that race.' });
  });
});

// ---------- REST API: stats and leaderboard ----------
// GET /api/stats -> your own stats: { races, flaggedRaces, bestWpm, avgWpm, trend: [...], mostMissed: [{ ch, misses }] }
app.get('/api/stats', requireLogin, function (req, res) {
  accounts.playerStats(req.user.id).then(function (stats) {
    res.json(stats);
  }).catch(function (e) {
    console.error('Could not load stats:', e.message);
    res.status(500).json({ error: 'Could not load your stats.' });
  });
});

// GET /api/leaderboard?limit=20 -> ranked players by rating (limit 1-50, default 20). Your own row has isYou: true.
//   -> { items: [{ name, rating, races, wins, bestWpm, isYou }] }. Never contains a pid.
app.get('/api/leaderboard', requireLogin, function (req, res) {
  const limit = Math.min(Math.max(parseInt((req.query || {}).limit, 10) || 20, 1), 50);
  accounts.leaderboard(limit, req.user.id).then(function (rows) {
    res.json({ items: rows });
  }).catch(function (e) {
    console.error('Could not load leaderboard:', e.message);
    res.status(500).json({ error: 'Could not load the leaderboard.' });
  });
});

// ---------- REST API: passage bank (public, read-only) ----------
// The bank is described, never handed out: no endpoint returns a passage's full text, so nobody can read
// the text before a race. The server alone picks the passage for each race.
// GET /api/passages -> { default, difficulties: [{ difficulty, description, count, avgWords, avgCharacters, minCharacters, maxCharacters }] }
app.get('/api/passages', function (req, res) {
  res.json({ default: passages.DEFAULT_DIFFICULTY, difficulties: passages.summary() });
});

// GET /api/passages/:difficulty -> { difficulty, items: [{ id, words, characters, preview }] }   (easy, medium or hard)
app.get('/api/passages/:difficulty', function (req, res) {
  const level = String((req.params || {}).difficulty || '').toLowerCase();
  const items = passages.describe(level);
  if (!items) return res.status(404).json({ error: 'Unknown difficulty. Use easy, medium or hard.' });
  res.json({ difficulty: level, items: items });
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
  p.missed = {};   // the letters they should have typed and got wrong: { 'e': 3 }
  p.flags = {};    // anti-cheat: { paste: { count, detail }, burst: ..., speed: ... }
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

  input = String(input || '').slice(0, room.text.length);
  const correct = commonPrefix(input, room.text);
  const seconds = (Date.now() - room.startAt) / 1000;

  if (input.length - p.input.length > 4) {              // pasted text
    flag(p, 'paste', (input.length - p.input.length) + ' letters in one message');
    return false;
  }
  if (input.length - correct > 10) return false;        // too many wrong letters
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

// ---------- sending the leaderboard ----------
// ---------- live lobby: the open rooms anybody can join ----------
// Sockets on the home screen sit in the 'lobby' channel and get the list whenever it changes.
// The list never holds a pid: only the room code, the host's name and a few settings.
const LOBBY_MAX_ROOMS = 20;
let lobbyTimer = null;

function openRooms() {
  const list = [];
  Object.keys(rooms).forEach(function (code) {
    const room = rooms[code];
    if (room.status !== 'lobby' || room.starting || room.listed === false) return; // already racing, or a quick-match room
    if (room.players.length >= MAX_PLAYERS) return;
    const here = room.players.filter(function (p) { return !p.away; });
    if (here.length === 0) return;
    const host = findById(room, room.hostId) || here[0];
    list.push({
      code: room.code, host: host.name, ranked: room.ranked, difficulty: room.difficulty,
      players: room.players.length, max: MAX_PLAYERS, fee: ENTRY_FEE, createdAt: room.createdAt || 0,
    });
  });
  list.sort(function (a, b) { return b.createdAt - a.createdAt; });
  return list.slice(0, LOBBY_MAX_ROOMS).map(function (r) { delete r.createdAt; return r; });
}

// many room updates in a row (typing, joins) become one lobby message
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

  room.text = passages.pick(room.difficulty, room.text); // the server chooses: from the room's difficulty, never the same passage twice in a row
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
  const stats = statsPayload(room);
  if (stats.length > 0) { // saved for every race, ranked or casual; a flagged race will not count towards anyone's stats
    accounts.recordRaceStats(room.code, room.ranked, room.difficulty, stats).catch(logError('Could not save race stats'));
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
    scheduleLobby();
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
// ---------- quick match ----------
const matchmaker = createMatchmaker({ fillMs: Number(process.env.MM_FILL_MS) || 5000 }); // the env override is for tests

function cancelSearch(socket) {
  if (socket.data.searching) {
    matchmaker.remove(socket.data.searching);
    socket.data.searching = null;
  }
}

// Players who queued through the REST API have no socket yet: their seat in the room is held for them, they
// learn the room code from GET /api/matchmaking, and they claim the seat with a room:join event.
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

// not everyone showed up in time: race with whoever is here (2+), or let the room become a normal one
function matchDeadline(room) {
  if (rooms[room.code] !== room || !room.matchPids || room.status !== 'lobby') return;
  room.matchPids = null;
  if (room.players.length === 0) { delete rooms[room.code]; return; }
  if (room.players.length >= 2) return startMatchedRace(room);
  room.listed = true;
  io.to(room.code).emit('race:notice', { message: 'Your opponents did not connect in time. Wait here or leave.' });
  broadcast(room);
}

// a group of players the queue has matched: put them in a fresh room and start the countdown
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

// every second: make any matches that are ready, and tell each searcher how it is going
setInterval(function () {
  runMatchmaking();
  const now = Date.now();
  matchmaker.all().forEach(function (t) {
    if (!t.socket) return; // REST searchers poll GET /api/matchmaking instead
    io.to(t.socket.id).emit('match:status', { waitedMs: now - t.joinedAt, searching: matchmaker.poolSize(t) });
  });
}, Number(process.env.MM_TICK_MS) || 1000).unref();

// ---------- REST API: rooms and matchmaking ----------
// Same login as the other endpoints (Authorization: Bearer <token>). Nothing here ever returns a player id.
// A race is typed over a live connection, so the REST calls reserve a place and the socket claims it:
//   rooms:        POST /api/rooms (a room is held for you for RESERVE_MS), then emit room:join { code } on your socket.
//   matchmaking:  POST /api/matchmaking to queue, poll GET /api/matchmaking until it says "matched" with a code,
//                 then emit room:join { code } within MATCH_JOIN_MS. DELETE /api/matchmaking leaves the queue.
function roomOfPid(pid) {
  const codes = Object.keys(rooms);
  for (let i = 0; i < codes.length; i++) {
    if (findByPid(rooms[codes[i]], pid)) return rooms[codes[i]];
  }
  return null;
}

function reservedRoomOf(pid) {
  const codes = Object.keys(rooms);
  for (let i = 0; i < codes.length; i++) if (rooms[codes[i]].reservedHost === pid) return rooms[codes[i]];
  return null;
}

function restName(user) {
  return cleanName(user.username || String(user.email || '').split('@')[0]);
}

// returns an error message, or '' when the body's ranked/difficulty are fine
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

// GET /api/rooms -> { rooms: [{ code, host, ranked, difficulty, players, max, fee }] }  the open rooms, newest first
app.get('/api/rooms', requireLogin, function (req, res) {
  res.json({ rooms: openRooms() });
});

// GET /api/rooms/:code -> { code, status, ranked, difficulty, host, players: [{ name, rating, away }], max, fee, pot, youAreIn }
// (a room still waiting for its host to connect is only visible to its owner; the passage text is never included)
app.get('/api/rooms/:code', requireLogin, function (req, res) {
  const room = rooms[String((req.params || {}).code || '').toUpperCase().slice(0, 4)];
  if (!room || (room.players.length === 0 && room.reservedHost !== req.user.id)) return res.status(404).json({ error: 'No room with that code.' });
  res.json(roomView(room, req.user.id));
});

// POST /api/rooms { ranked?: true, difficulty?: 'easy'|'medium'|'hard' } -> 201 { code, ranked, difficulty, expiresInMs }
// Reserves a room with you as the host. Connect and emit room:join { code } within expiresInMs to take the seat.
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

// DELETE /api/rooms/:code -> { ok: true }   cancels your own reservation, before you have connected
app.delete('/api/rooms/:code', requireLogin, function (req, res) {
  const room = rooms[String((req.params || {}).code || '').toUpperCase().slice(0, 4)];
  if (!room || room.reservedHost !== req.user.id) return res.status(404).json({ error: 'You have no reserved room with that code.' });
  clearTimeout(room.reserveTimer);
  delete rooms[room.code];
  res.json({ ok: true });
});

// GET /api/matchmaking -> { status: 'idle' }
//                      or { status: 'searching', ranked, difficulty, waitedMs, searching }
//                      or { status: 'matched', code, expiresInMs }  (emit room:join { code } to take your seat)
app.get('/api/matchmaking', requireLogin, function (req, res) {
  const pid = req.user.id;
  const m = matchFor(pid);
  if (m) return res.json({ status: 'matched', code: m.code, expiresInMs: Math.max(0, MATCH_JOIN_MS - (Date.now() - m.at)) });
  const t = matchmaker.all().filter(function (x) { return x.pid === pid; })[0];
  if (!t) return res.json({ status: 'idle' });
  res.json({ status: 'searching', ranked: t.ranked, difficulty: t.difficulty, waitedMs: Date.now() - t.joinedAt, searching: matchmaker.poolSize(t) });
});

// POST /api/matchmaking { ranked?: true, difficulty?: ... } -> 202 { status: 'searching', ranked, difficulty }
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

// DELETE /api/matchmaking -> { status: 'idle' }   leaves the queue (also drops a match you have not joined yet)
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
    if (socket.data.code) return;
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
    const room = rooms[code];
    const pid = socket.data.pid;
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
    else if (room.reservedHost && room.reservedHost !== pid && room.players.length === 0) error = 'The host has not arrived yet.';
    else if (room.matchPids && room.matchPids.indexOf(pid) < 0) error = 'That room is reserved for a matched race.';
    else if (room.players.length >= MAX_PLAYERS) error = 'That room is full (' + MAX_PLAYERS + ' players max).';

    if (error) return ack({ ok: false, error: error });
    // a room made through POST /api/rooms: its owner takes the host seat; a matched room: first one in hosts
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
    // matched room: everybody has connected, so start now instead of waiting for the deadline
    if (room.matchPids && room.status === 'lobby' && !room.starting && room.players.length >= room.matchPids.length) {
      clearTimeout(room.matchTimer);
      room.matchPids = null;
      startMatchedRace(room);
    }
  }

  function onRejoin(data, ack) {
    if (typeof ack !== 'function') return;
    data = data || {};
    const room = rooms[String(data.code || '').toUpperCase().slice(0, 4)];
    const p = room && findByPid(room, socket.data.pid);
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
    accounts.view(socket.data.pid).then(function (view) {
      ack(view ? { ok: true, account: view } : { ok: false });
    }).catch(function (e) {
      console.error('Could not load account:', e.message);
      ack({ ok: false });
    });
  }

  // quick match: queue for a race with players of a similar rating (same type and difficulty)
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
    // things can change while the database answers
    if (socket.data.gone || socket.data.code || socket.data.searching || matchmaker.has(pid)) {
      return ack({ ok: false, error: 'Could not start searching. Please try again.' });
    }
    matchmaker.add({ id: pid, pid: pid, socket: socket, name: name, rating: account.rating, ranked: ranked, difficulty: difficulty, joinedAt: Date.now() });
    socket.data.searching = pid;
    ack({ ok: true });
    runMatchmaking(); // someone may already be waiting
  }
  socket.on('account:get', onAccount);
  // the home screen asks to watch the open rooms; it gets the list now and again on every change
  socket.on('lobby:watch', function (data, ack) {
    if (socket.data.code) return typeof ack === 'function' && ack({ ok: false, rooms: [] });
    socket.join('lobby');
    if (typeof ack === 'function') ack({ ok: true, rooms: openRooms() });
  });
  socket.on('lobby:unwatch', function () { socket.leave('lobby'); });
  // the host picks how hard the next passage will be (only between races, and only a real difficulty)
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
  socket.on('race:input', onInput);
  socket.on('room:rejoin', onRejoin);
  socket.on('room:leave', onLeave);
  socket.on('disconnect', function () {
    socket.data.gone = true;
    cancelSearch(socket);
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