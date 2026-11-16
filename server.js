const path = require('path');
const http = require('http');
const express = require('express');
const socketio = require('socket.io');
const PASSAGES = require('./passages');

const PORT = process.env.PORT || 3000;
const COUNTDOWN_MS = 3000; // wait before the race starts
const RACE_MS = 60000;     // race length
const MAX_PLAYERS = 8;
const MAX_CPS = 25;        // fastest believable typing speed (characters per second)

const app = express();
const server = http.createServer(app);
const io = new socketio.Server(server);
app.use(express.static(path.join(__dirname, 'public')));

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

function allFinished(room) {
  for (let i = 0; i < room.players.length; i++) {
    if (!room.players[i].finished) return false;
  }
  return true;
}

// sort order: finished players (earliest first), then everyone else by progress
function byRank(a, b) {
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
  if (room.status !== 'racing' || p.finished || Date.now() < room.startAt) return true;

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
      finishMs: p.finishedAt - room.startAt,
    });
  }
  io.to(room.code).emit('room:state', {
    code: room.code,
    status: room.status, // lobby, countdown, racing or finished
    hostId: room.hostId,
    startAt: room.startAt,
    serverNow: Date.now(),
    players: players,
  });
}

// ---------- race flow ----------
function startRace(room) {
  room.text = PASSAGES[Math.floor(Math.random() * PASSAGES.length)];
  room.status = 'countdown';
  room.startAt = Date.now() + COUNTDOWN_MS;
  for (let i = 0; i < room.players.length; i++) resetPlayer(room.players[i]);

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

function endRace(room) {
  if (room.status !== 'racing') return;
  clearInterval(room.tickTimer);
  clearTimeout(room.endTimer);
  room.status = 'finished';
  for (let i = 0; i < room.players.length; i++) {
    if (!room.players[i].finished) updateStats(room, room.players[i]);
  }
  broadcast(room);
}

// ---------- joining and leaving ----------
function joinRoom(socket, room, rawName) {
  const base = String(rawName || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16) || 'Racer';
  let name = base;
  let n = 1;
  while (nameTaken(room, name)) {
    n++;
    name = base + ' ' + n;
  }
  const player = { id: socket.id, name: name };
  resetPlayer(player);
  room.players.push(player);
  socket.join(room.code);
  socket.data.code = room.code;
  broadcast(room);
}

function leaveRoom(socket) {
  const room = rooms[socket.data.code];
  if (!room) return;
  socket.leave(room.code);
  socket.data.code = null;

  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].id === socket.id) room.players.splice(i, 1);
  }
  if (room.players.length === 0) {
    clearInterval(room.tickTimer);
    clearTimeout(room.endTimer);
    delete rooms[room.code];
    return;
  }
  if (room.hostId === socket.id) room.hostId = room.players[0].id;
  if (room.status === 'racing' && allFinished(room)) endRace(room);
  else broadcast(room);
}

// ---------- socket events ----------
function onConnection(socket) {
  socket.data.code = null;

  function onCreate(data, ack) {
    if (socket.data.code) return;
    const room = { code: randomCode(), hostId: socket.id, status: 'lobby', text: '', startAt: 0, players: [] };
    rooms[room.code] = room;
    joinRoom(socket, room, (data || {}).name);
    ack({ ok: true, code: room.code });
  }

  function onJoin(data, ack) {
    data = data || {};
    const code = String(data.code || '').toUpperCase().slice(0, 4);
    const room = rooms[code];
    let error = '';
    if (socket.data.code) error = 'You are already in a room.';
    else if (!room) error = 'No room with code ' + code + '.';
    else if (room.status === 'countdown' || room.status === 'racing') error = 'That race has already started.';
    else if (room.players.length >= MAX_PLAYERS) error = 'That room is full.';

    if (error) return ack({ ok: false, error: error });
    joinRoom(socket, room, data.name);
    ack({ ok: true, code: code });
  }

  function onStart() {
    const room = rooms[socket.data.code];
    if (!room || room.hostId !== socket.id) return; // only the host starts races
    if (room.status === 'lobby' || room.status === 'finished') startRace(room);
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

  socket.on('room:create', onCreate);
  socket.on('room:join', onJoin);
  socket.on('race:start', onStart);
  socket.on('race:input', onInput);
  socket.on('room:leave', onLeave);
  socket.on('disconnect', onLeave);
}

io.on('connection', onConnection);

server.listen(PORT, function () {
  console.log('Type Sprint running at http://localhost:' + PORT);
});