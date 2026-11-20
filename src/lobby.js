// Live lobby (open rooms) and the room:state broadcast
const { MAX_PLAYERS } = require('./config');
const { io, ENTRY_FEE, rooms } = require('./core');
const S = require('./shared');
const byRank = function () { return S.byRank.apply(this, arguments); };
const findById = function () { return S.findById.apply(this, arguments); };

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

Object.assign(S, { openRooms, scheduleLobby, broadcast });
