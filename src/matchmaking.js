// Quick-match queue: making matches and starting their rooms
const { MATCH_JOIN_MS } = require('./config');
const { io, rooms, matchmaker, matchResults } = require('./core');
const S = require('./shared');
const broadcast = function () { return S.broadcast.apply(this, arguments); };
const joinRoom = function () { return S.joinRoom.apply(this, arguments); };
const logError = function () { return S.logError.apply(this, arguments); };
const randomCode = function () { return S.randomCode.apply(this, arguments); };
const sendAccount = function () { return S.sendAccount.apply(this, arguments); };
const startRace = function () { return S.startRace.apply(this, arguments); };

function cancelSearch(socket) {
  if (socket.data.searching) {
    matchmaker.remove(socket.data.searching);
    socket.data.searching = null;
  }
}

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

Object.assign(S, { cancelSearch, matchFor, startMatchedRace, matchDeadline, startMatch, runMatchmaking });
