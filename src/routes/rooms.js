// REST API: rooms and matchmaking
const passages = require('../../passages');
const { MAX_PLAYERS, RESERVE_MS, MATCH_JOIN_MS } = require('../config');
const { app, accounts, ENTRY_FEE, rooms, matchmaker, matchResults } = require('../core');
const S = require('../shared');
const cancelSearch = function () { return S.cancelSearch.apply(this, arguments); };
const cleanName = function () { return S.cleanName.apply(this, arguments); };
const findById = function () { return S.findById.apply(this, arguments); };
const findByPid = function () { return S.findByPid.apply(this, arguments); };
const matchFor = function () { return S.matchFor.apply(this, arguments); };
const openRooms = function () { return S.openRooms.apply(this, arguments); };
const randomCode = function () { return S.randomCode.apply(this, arguments); };
const requireLogin = function () { return S.requireLogin.apply(this, arguments); };
const runMatchmaking = function () { return S.runMatchmaking.apply(this, arguments); };

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

Object.assign(S, { roomOfPid, reservedRoomOf, restName, checkRaceSettings, roomView });
