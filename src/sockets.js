// Socket.IO events for each connected player
const passages = require('../passages');
const { RACE_MS, MAX_PLAYERS } = require('./config');
const { io, accounts, ENTRY_FEE, rooms, matchmaker, matchResults } = require('./core');
const S = require('./shared');
const broadcast = function () { return S.broadcast.apply(this, arguments); };
const cancelSearch = function () { return S.cancelSearch.apply(this, arguments); };
const cleanName = function () { return S.cleanName.apply(this, arguments); };
const dropConnection = function () { return S.dropConnection.apply(this, arguments); };
const findById = function () { return S.findById.apply(this, arguments); };
const findByPid = function () { return S.findByPid.apply(this, arguments); };
const handleInput = function () { return S.handleInput.apply(this, arguments); };
const joinRoom = function () { return S.joinRoom.apply(this, arguments); };
const leaveRoom = function () { return S.leaveRoom.apply(this, arguments); };
const logError = function () { return S.logError.apply(this, arguments); };
const openRooms = function () { return S.openRooms.apply(this, arguments); };
const randomCode = function () { return S.randomCode.apply(this, arguments); };
const rebind = function () { return S.rebind.apply(this, arguments); };
const registerPlayer = function () { return S.registerPlayer.apply(this, arguments); };
const resetPlayer = function () { return S.resetPlayer.apply(this, arguments); };
const runMatchmaking = function () { return S.runMatchmaking.apply(this, arguments); };
const startMatchedRace = function () { return S.startMatchedRace.apply(this, arguments); };
const startRace = function () { return S.startRace.apply(this, arguments); };

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
    const room = rooms[code];
    const pid = socket.data.pid;
    const existing = room && findByPid(room, pid);
    // a practice run (one player) does not close the room: newcomers wait in the lobby until it is over
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

  // Back to the room's waiting lobby. Only the host, and only when nobody can lose a fee:
  // once the race is over, or while racing alone (practice).
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
    for (let i = 0; i < room.players.length; i++) {
      const p = room.players[i];
      if (p.id !== socket.id) continue;
      if (!handleInput(room, p, (data || {}).input)) socket.emit('race:resync', { input: p.input, seq: (data || {}).seq });
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
  socket.on('room:lobby', onToLobby);
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

Object.assign(S, { onConnection });
