// Joining, rejoining and leaving rooms
const { GRACE_MS } = require('./config');
const { io, accounts, ENTRY_FEE, rooms, matchmaker } = require('./core');
const S = require('./shared');
const allFinished = function () { return S.allFinished.apply(this, arguments); };
const broadcast = function () { return S.broadcast.apply(this, arguments); };
const cancelSearch = function () { return S.cancelSearch.apply(this, arguments); };
const endRace = function () { return S.endRace.apply(this, arguments); };
const findById = function () { return S.findById.apply(this, arguments); };
const logError = function () { return S.logError.apply(this, arguments); };
const nameTaken = function () { return S.nameTaken.apply(this, arguments); };
const pickHost = function () { return S.pickHost.apply(this, arguments); };
const resetPlayer = function () { return S.resetPlayer.apply(this, arguments); };
const scheduleLobby = function () { return S.scheduleLobby.apply(this, arguments); };
const sendAccount = function () { return S.sendAccount.apply(this, arguments); };

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

// leaving on purpose: gone straight away
function leaveRoom(socket) {
  const room = rooms[socket.data.code];
  if (!room) { socket.data.code = null; return; } // a stale code must not leave the player stuck "in a room"
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
  if (room.paid && p.entered && (room.status === 'countdown' || room.status === 'racing')) {
    p.entered = false;
    p.forfeited = true;
  }
  if (room.hostId === p.id) room.hostId = pickHost(room);
  if (room.status === 'racing' && allFinished(room)) endRace(room);
  else broadcast(room);
}

Object.assign(S, { cleanName, joinRoom, registerPlayer, rebind, removePlayer, leaveRoom, dropConnection });
