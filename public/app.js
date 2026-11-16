const socket = io();

function $(id) {
  return document.getElementById(id);
}

// what the screen remembers between server updates
const state = { room: null, text: '', startAt: 0, limitMs: 120000, offset: 0, chars: [] };

// ---------- helpers ----------
function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  if (n % 100 >= 11 && n % 100 <= 13) return n + 'th';
  if (n % 10 <= 3) return n + suffixes[n % 10];
  return n + 'th';
}

function formatTime(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function myIndex(room) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].id === socket.id) return i;
  }
  return -1;
}

function showToast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  setTimeout(hideToast, 3000);
}

function hideToast() {
  $('toast').classList.remove('show');
}

function showScreen(name) {
  $('home').hidden = name !== 'home';
  $('room').hidden = name !== 'room';
}

function goHome() {
  state.room = null;
  state.text = '';
  $('typing').disabled = true;
  history.replaceState(null, '', location.pathname);
  showScreen('home');
}

// ---------- home screen ----------
$('name').value = localStorage.getItem('name') || '';
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('code').value = urlRoom.toUpperCase().slice(0, 4);

function onEntered(result) {
  if (!result.ok) return showToast(result.error);
  localStorage.setItem('name', $('name').value);
  history.replaceState(null, '', '?room=' + result.code);
  showScreen('room');
}

function createRoom() {
  socket.emit('room:create', { name: $('name').value }, onEntered);
}

function joinRoom() {
  socket.emit('room:join', { name: $('name').value, code: $('code').value }, onEntered);
}

function onHomeKey(event) {
  if (event.key !== 'Enter') return;
  if ($('code').value) joinRoom();
  else createRoom();
}

function leaveRoom() {
  socket.emit('room:leave');
  goHome();
}

function copyLink() {
  const link = location.origin + '/?room=' + state.room.code;
  navigator.clipboard.writeText(link).then(function () {
    showToast('Invite link copied');
  });
}

$('create').addEventListener('click', createRoom);
$('join').addEventListener('click', joinRoom);
$('name').addEventListener('keydown', onHomeKey);
$('code').addEventListener('keydown', onHomeKey);
$('leave').addEventListener('click', leaveRoom);
$('copyLink').addEventListener('click', copyLink);

// ---------- messages from the server ----------
function onRoomState(snapshot) {
  state.room = snapshot;
  state.offset = snapshot.serverNow - Date.now();
  render();
}

function onCountdown(data) {
  state.text = data.text;
  state.startAt = data.startAt;
  state.limitMs = data.limitMs;
  state.offset = data.serverNow - Date.now();
  $('typing').value = '';
  buildPassage();
}

// the server rejected our typing (for example a paste), so go back to its version
function onResync(data) {
  $('typing').value = data.input;
  updatePassage(data.input);
}

function onDisconnect() {
  if (!state.room) return;
  goHome();
  showToast('Connection lost. Create or join a room again.');
}

socket.on('room:state', onRoomState);
socket.on('race:countdown', onCountdown);
socket.on('race:resync', onResync);
socket.on('disconnect', onDisconnect);

// ---------- drawing the room (runs on every server update) ----------
function render() {
  const room = state.room;
  const index = myIndex(room);
  if (index < 0) return;
  const me = room.players[index];
  const labels = {
    lobby: room.players.length + ' in the room',
    countdown: 'Get ready',
    racing: 'Race in progress',
    finished: 'Race finished',
  };

  $('roomCode').textContent = room.code;
  $('status').textContent = labels[room.status];
  $('stats').hidden = room.status === 'lobby';
  $('passage').hidden = room.status === 'lobby' || !state.text;
  $('hint').hidden = room.status !== 'racing';
  $('statWpm').textContent = me.wpm;
  $('statAcc').textContent = me.accuracy;

  renderLanes(room);
  renderPanel(room, me, index + 1);

  // you can only type while the race is on and you haven't finished
  const canType = room.status === 'racing' && !me.finished;
  if (canType && $('typing').disabled) {
    $('typing').disabled = false;
    $('typing').value = '';
    updatePassage('');
    $('typing').focus();
  }
  if (!canType) $('typing').disabled = true;
}

function renderLanes(room) {
  let html = '';
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    let cls = 'lane';
    let name = esc(p.name);
    if (p.id === socket.id) {
      cls += ' me';
      name += ' <small>(you)</small>';
    }
    if (p.finished) cls += ' finished';
    html += '<div class="' + cls + '">' +
      '<span class="rank">' + (i + 1) + '</span>' +
      '<span class="name">' + name + '</span>' +
      '<div class="track"><div class="fill" style="width:' + (p.progress * 100).toFixed(1) + '%"></div></div>' +
      '<span class="speed"><b>' + p.wpm + '</b> wpm</span></div>';
  }
  $('lanes').innerHTML = html;
}

function renderPanel(room, me, rank) {
  const isHost = room.hostId === socket.id;
  const winner = room.players[0];
  let html = '';

  if (room.status === 'lobby') {
    html = '<h2>Waiting for racers</h2><p>Share the code <strong>' + room.code +
      '</strong> or click it above to copy an invite link. You can also start alone to practice.</p>';
    if (isHost) html += '<button id="start" class="btn" type="button">Start race</button>';
    else html += '<p>Waiting for the host to start.</p>';
  } else if (room.status === 'countdown') {
    html = '<div class="count" id="count">3</div>';
  } else if (room.status === 'finished') {
    if (me.finished) {
      html = '<h2>You finished ' + ordinal(rank) + '</h2><p>' + me.wpm + ' WPM, ' + me.accuracy +
        '% accuracy, ' + (me.finishMs / 1000).toFixed(1) + ' seconds.';
    } else {
      html = "<h2>Time's up. You placed " + ordinal(rank) + '</h2><p>You reached ' +
        Math.round(me.progress * 100) + '% at ' + me.wpm + ' WPM.';
    }
    if (winner.finished && winner.id !== me.id) html += ' ' + esc(winner.name) + ' won at ' + winner.wpm + ' WPM.';
    html += '</p>';
    if (isHost) html += '<button id="start" class="btn" type="button">Race again</button>';
    else html += '<p>Waiting for the host to start another race.</p>';
  }

  $('panel').innerHTML = html;
  if ($('start')) $('start').addEventListener('click', startRace);
}

function startRace() {
  socket.emit('race:start');
}

// ---------- the passage ----------
function buildPassage() {
  $('passage').textContent = '';
  state.chars = [];
  for (let i = 0; i < state.text.length; i++) {
    const span = document.createElement('span');
    span.textContent = state.text[i];
    $('passage').appendChild(span);
    state.chars.push(span);
  }
  updatePassage('');
}

// ok = typed right, bad = typed wrong, cur = the next letter to type
function updatePassage(input) {
  for (let i = 0; i < state.chars.length; i++) {
    let cls = '';
    if (i < input.length && input[i] === state.text[i]) cls = 'ok';
    else if (i < input.length) cls = 'bad';
    else if (i === input.length) cls = 'cur';
    state.chars[i].className = cls;
  }
}

// ---------- typing ----------
function onTyping() {
  let value = $('typing').value;
  const correct = commonPrefix(value, state.text);
  if (value.length - correct > 10) { // stop piling up mistakes
    value = value.slice(0, correct + 10);
    $('typing').value = value;
  }
  updatePassage(value);
  socket.emit('race:input', { input: value }); // the server decides what this is worth
}

function blockEvent(event) {
  event.preventDefault();
}

function refocus() {
  if (!$('typing').disabled && document.activeElement === document.body) $('typing').focus();
}

$('typing').addEventListener('input', onTyping);
const blocked = ['paste', 'cut', 'drop'];
for (let i = 0; i < blocked.length; i++) $('typing').addEventListener(blocked[i], blockEvent);
$('passage').addEventListener('click', refocus);
document.addEventListener('keydown', refocus);

// ---------- clock: countdown number and time left ----------
function updateClock() {
  const room = state.room;
  if (!room) return;
  const now = Date.now() + state.offset;

  if (room.status === 'countdown' && $('count')) {
    $('count').textContent = Math.max(1, Math.ceil((state.startAt - now) / 1000));
  }
  if (room.status === 'racing') $('statTime').textContent = formatTime(state.startAt + state.limitMs - now);
  else if (room.status === 'finished') $('statTime').textContent = 'Done';
  else $('statTime').textContent = formatTime(state.limitMs);
}

setInterval(updateClock, 100);
