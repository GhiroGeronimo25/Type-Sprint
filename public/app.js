const socket = io();

function $(id) {
  return document.getElementById(id);
}

// a permanent id for this browser, so the server can recognise us after a refresh or reconnect
function getPid() {
  let id = localStorage.getItem('pid');
  if (!id) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
    localStorage.setItem('pid', id);
  }
  return id;
}
const pid = getPid();

// what the screen remembers between server updates
const state = { room: null, text: '', startAt: 0, limitMs: 60000, offset: 0, chars: [], restore: '' };

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
  renderRecords();
}

// ---------- home screen ----------
$('name').value = localStorage.getItem('name') || '';
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('code').value = urlRoom.toUpperCase().slice(0, 4);

function onEntered(result) {
  if (!result.ok) return showToast(result.error);
  localStorage.setItem('name', $('name').value);
  localStorage.setItem('session', result.code);
  history.replaceState(null, '', '?room=' + result.code);
  showScreen('room');
}

function createRoom() {
  socket.emit('room:create', { name: $('name').value, pid: pid }, onEntered);
}

function joinRoom() {
  socket.emit('room:join', { name: $('name').value, code: $('code').value, pid: pid }, onEntered);
}

function onHomeKey(event) {
  if (event.key !== 'Enter') return;
  if ($('code').value) joinRoom();
  else createRoom();
}

function leaveRoom() {
  localStorage.removeItem('session');
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

// ---------- saved races (kept in this browser) ----------
function loadRecords() {
  try {
    return JSON.parse(localStorage.getItem('records')) || [];
  } catch (e) {
    return [];
  }
}

function saveRecord(room, me, rank) {
  if (room.status !== 'finished' || (!me.finished && me.wpm === 0)) return;
  const id = room.code + ':' + room.startAt;
  const list = loadRecords();
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return;
  }
  list.unshift({
    id: id,
    date: Date.now(),
    rank: rank,
    players: room.players.length,
    wpm: me.wpm,
    accuracy: me.accuracy,
    finished: me.finished,
    progress: me.progress,
    seconds: me.finished ? me.finishMs / 1000 : null,
  });
  localStorage.setItem('records', JSON.stringify(list.slice(0, 30)));
}

function renderRecords() {
  const list = loadRecords();
  $('records').hidden = list.length === 0;
  if (!list.length) return;
  let best = 0;
  let wins = 0;
  let html = '';
  for (let i = 0; i < list.length; i++) {
    if (list[i].wpm > best) best = list[i].wpm;
    if (list[i].finished && list[i].rank === 1) wins++;
  }
  $('recordBest').innerHTML = '<div><b>' + best + '</b><span>best WPM</span></div>' +
    '<div><b>' + list.length + '</b><span>races saved</span></div>' +
    '<div><b>' + wins + '</b><span>wins</span></div>';
  for (let i = 0; i < Math.min(list.length, 5); i++) {
    const r = list[i];
    const when = new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const result = r.finished ? (r.seconds.toFixed(1) + 's') : (Math.round(r.progress * 100) + '% done');
    html += '<li><span class="rr">' + ordinal(r.rank) + '</span><b>' + r.wpm + '</b> wpm' +
      '<span>' + r.accuracy + '% acc</span><span>' + result + '</span><span class="when">' + when + '</span></li>';
  }
  $('recordList').innerHTML = html;
}

function clearRecords() {
  localStorage.removeItem('records');
  renderRecords();
}

$('clearRecords').addEventListener('click', clearRecords);
renderRecords();

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
  state.restore = '';
  $('typing').value = '';
  buildPassage();
}

// the server rejected our typing (for example a paste), so go back to its version
function onResync(data) {
  $('typing').value = data.input;
  updatePassage(data.input);
}

function onDisconnect() {
  if (state.room) showToast('Connection lost. Reconnecting...');
}

// on every (re)connect, take our seat back if we were in a room
function onConnect() {
  const code = localStorage.getItem('session');
  if (!code) return;
  if (urlRoom && urlRoom.toUpperCase().slice(0, 4) !== code) return; // opened an invite to another room
  socket.emit('room:rejoin', { code: code, pid: pid }, onRejoined);
}

function onRejoined(result) {
  if (!result.ok) {
    localStorage.removeItem('session');
    if (state.room) {
      goHome();
      showToast(result.error);
    }
    return;
  }
  state.text = result.text || '';
  state.startAt = result.startAt;
  state.limitMs = result.limitMs;
  state.offset = result.serverNow - Date.now();
  state.restore = $('typing').disabled ? result.input : '';
  if (state.text) buildPassage();
  history.replaceState(null, '', '?room=' + result.code);
  showScreen('room');
  if (state.room) {
    showToast('Back in the room');
    render();
  }
}

socket.on('connect', onConnect);
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
    const restore = state.restore;
    state.restore = '';
    $('typing').disabled = false;
    $('typing').value = restore;
    updatePassage(restore);
    $('typing').focus();
  }
  if (!canType) $('typing').disabled = true;
  saveRecord(room, me, index + 1);
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
    if (p.away) cls += ' left';
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
