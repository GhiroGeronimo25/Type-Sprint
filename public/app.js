const socket = io({
  autoConnect: false,
  auth: function (cb) {
    getAccessToken().then(function (token) { cb({ token: token }); });
  },
});

function $(id) {
  return document.getElementById(id);
}

// ---------- login (Supabase Auth) ----------
let pid = null;
let supa = null;

async function getAccessToken() {
  if (!supa) return '';
  const res = await supa.auth.getSession(); // refreshes an expired token when needed
  return res.data.session ? res.data.session.access_token : '';
}

async function apiGet(url) {
  return fetch(url, { headers: { Authorization: 'Bearer ' + await getAccessToken() } });
}

function showAuthMessage(text, isError) {
  $('authMsg').hidden = !text;
  $('authMsg').textContent = text || '';
  $('authMsg').classList.toggle('error', !!isError);
}

function friendlyAuthError(error) {
  const m = String(error && error.message || '');
  if (/invalid login/i.test(m)) return 'Wrong email or password.';
  if (/already registered/i.test(m)) return 'That email already has an account. Try logging in.';
  if (/email not confirmed/i.test(m)) return 'Please confirm your email first (check your inbox).';
  return m || 'Something went wrong. Please try again.';
}

let authMode = 'login';
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,16}$/;

function setAuthMode(mode) {
  authMode = mode;
  showAuthMessage('');
  const signup = mode === 'signup';
  $('authTitle').textContent = signup ? 'Create account' : 'Log in';
  $('usernameRow').hidden = !signup;
  $('authSubmit').textContent = signup ? 'Create account' : 'Log in';
  $('authSwitchText').textContent = signup ? 'Already have an account?' : 'New here?';
  $('authSwitch').textContent = signup ? 'Log in' : 'Create an account';
  $('authPassword').autocomplete = signup ? 'new-password' : 'current-password';
}

async function onAuthSubmit(event) {
  event.preventDefault();
  showAuthMessage('');
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  if (!email || password.length < 6) return showAuthMessage('Enter an email and a password of at least 6 characters.', true);
  $('authSubmit').disabled = true;
  try {
    if (authMode === 'login') {
      const res = await supa.auth.signInWithPassword({ email: email, password: password });
      if (res.error) showAuthMessage(friendlyAuthError(res.error), true);
      return; // success is handled by onAuthChange
    }
    const username = $('authUsername').value.trim();
    if (!USERNAME_RE.test(username)) return showAuthMessage('Username: 3-16 letters, numbers, dots, dashes or underscores.', true);
    const check = await (await fetch('/api/username-available?name=' + encodeURIComponent(username))).json();
    if (!check.ok) return showAuthMessage(check.error || 'That username is not available.', true);
    const res = await supa.auth.signUp({ email: email, password: password, options: { data: { username: username }, emailRedirectTo: window.location.origin } });
    if (res.error) return showAuthMessage(friendlyAuthError(res.error), true);
    const created = res.data && res.data.user;
    if (created && Array.isArray(created.identities) && created.identities.length === 0) {
      setAuthMode('login');
      $('authEmail').value = email;
      return showAuthMessage('That email already has an account. Log in instead.', true);
    }
    if (!res.data.session) {
      setAuthMode('login');
      showAuthMessage('Account created. Check your email to confirm it, then log in.', false);
    }
  } catch (e) {
    showAuthMessage('Could not reach the server. Please try again.', true);
  } finally {
    $('authSubmit').disabled = false;
  }
}

function onAuthChange(session) {
  if (session && session.user) {
    const changedUser = pid !== session.user.id;
    pid = session.user.id;
    const username = (session.user.user_metadata || {}).username || String(session.user.email || '').split('@')[0];
    $('userEmail').textContent = username;
    $('authPassword').value = '';
    if (changedUser) socket.disconnect(); // a different person logged in: start a fresh connection
    socket.connect();                     // does nothing if already connected
    if (!state.room) showScreen('home');
  } else {
    pid = null;
    localStorage.removeItem('session');
    socket.disconnect();
    state.room = null;
    state.account = null;
    $('coinPill').hidden = true;
    $('typing').disabled = true;
    history.replaceState(null, '', location.pathname);
    showScreen('auth');
  }
}

async function startAuth() {
  let config;
  try {
    config = await (await fetch('/config.json')).json();
  } catch (e) {
    config = {};
  }
  if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase) {
    showScreen('auth');
    return showAuthMessage('Login is not set up yet: the server needs SUPABASE_URL and SUPABASE_ANON_KEY.', true);
  }
  supa = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
  $('authForm').addEventListener('submit', onAuthSubmit);
  $('authSwitch').addEventListener('click', function () { setAuthMode(authMode === 'login' ? 'signup' : 'login'); });
  $('signOut').addEventListener('click', function () { supa.auth.signOut(); }); // onAuthChange does the rest
  supa.auth.onAuthStateChange(function (event, session) {
    if (event === 'TOKEN_REFRESHED') return; // same user: nothing to redo
    onAuthChange(session);
  });
  const first = await supa.auth.getSession();
  onAuthChange(first.data.session);
}

const state = { account: null, result: null, room: null, text: '', startAt: 0, limitMs: 60000, offset: 0, chars: [], restore: '', resultDismissed: false };

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
  return room.players.findIndex(function (p) { return p.id === socket.id; });
}

function showToast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  setTimeout(function () { $('toast').classList.remove('show'); }, 3000);
}

const TABS = ['play', 'stats', 'wallet', 'board'];
let currentTab = 'play';

function tabFromHash() {
  const t = location.hash.replace('#', '');
  return TABS.indexOf(t) >= 0 ? t : 'play';
}

function setTab(tab, pushHash) {
  if (TABS.indexOf(tab) < 0) tab = 'play';
  currentTab = tab;
  $('home').setAttribute('data-tab', tab);
  const buttons = document.querySelectorAll('#tabs .navtab');
  for (let i = 0; i < buttons.length; i++) {
    const on = buttons[i].getAttribute('data-nav') === tab;
    if (on) buttons[i].setAttribute('aria-current', 'page');
    else buttons[i].removeAttribute('aria-current');
  }
  if (pushHash !== false && !state.room) history.replaceState(null, '', (location.search || '') + '#' + tab);
  updateEmptyStates();
  if (!$('home').hidden) window.scrollTo(0, 0);
}

function updateEmptyStates() {
  $('statsEmpty').hidden = currentTab !== 'stats' || !$('raceHistory').hidden || !$('myStats').hidden;
  $('boardEmpty').hidden = currentTab !== 'board' || !$('board').hidden;
}

function showScreen(name) {
  $('auth').hidden = name !== 'auth';
  $('topnav').hidden = name !== 'home';
  $('home').hidden = name !== 'home';
  $('room').hidden = name !== 'room';
  document.body.classList.toggle('has-nav', name === 'home');
  if (name === 'home') setTab(tabFromHash(), false);
  window.scrollTo(0, 0);
}

document.addEventListener('click', function (event) {
  const nav = event.target.closest('[data-nav]');
  if (!nav) return;
  event.preventDefault();
  if (state.room) return; // never switch tabs while racing
  setTab(nav.getAttribute('data-nav'));
});
window.addEventListener('hashchange', function () {
  if (!$('home').hidden) setTab(tabFromHash(), false);
});

function goHome() {
  watchLobby();
  state.room = null;
  state.text = '';
  $('typing').disabled = true;
  history.replaceState(null, '', location.pathname + '#play');
  showScreen('home');
  loadStats();
}

// ---------- live lobby: open rooms ----------
function watchLobby() {
  socket.emit('lobby:watch', {}, function (res) {
    if (res && res.ok) renderLobby(res.rooms);
  });
}

function renderLobby(rooms) {
  rooms = rooms || [];
  $('lobbyEmpty').hidden = rooms.length > 0;
  let html = '';
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    html += '<li class="lobby-row">' +
      '<span class="share-line">' + esc(r.code) + '</span>' +
      '<span class="lobby-host">' + esc(r.host) + '<small>' + (r.ranked ? 'Ranked \u00b7 ' + r.fee + ' coins' : 'Casual \u00b7 free') + ' \u00b7 ' + esc(capital(r.difficulty)) + (r.practicing ? ' \u00b7 <span class="badge-practice">Practicing now</span>' : '') + '</small></span>' +
      '<span class="lobby-seats">' + r.players + '/' + r.max + '</span>' +
      '<button class="btn secondary" type="button" data-code="' + esc(r.code) + '">Join</button></li>';
  }
  $('lobbyList').innerHTML = html;
}

$('lobbyList').addEventListener('click', function (event) {
  const button = event.target.closest('button[data-code]');
  if (!button) return;
  button.disabled = true;
  socket.emit('room:join', { code: button.getAttribute('data-code') }, function (result) {
    button.disabled = false;
    onEntered(result);
  });
});
socket.on('lobby:rooms', function (data) { renderLobby((data || {}).rooms); });

// ---------- home screen ----------
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('code').value = urlRoom.toUpperCase().slice(0, 4);

function onEntered(result) {
  if (!result || !result.ok) return showToast(result && result.error ? result.error : 'Something went wrong. Please try again.');
  showSearching(false);
  localStorage.setItem('session', result.code);
  history.replaceState(null, '', '?room=' + result.code);
  showScreen('room');
}

function emitWithFeedback(event, payload, handler, onFail) {
  if (!socket.connected) {
    if (onFail) onFail();
    showToast('Not connected to the server yet. Reconnecting...');
    socket.connect();
    return;
  }
  let done = false;
  const timer = setTimeout(function () {
    if (done) return;
    done = true;
    if (onFail) onFail();
    showToast('The server did not answer. Please try again.');
  }, 10000);
  socket.emit(event, payload, function (res) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    handler(res);
  });
}

// ---------- quick match ----------
function showSearching(on) {
  $('searching').hidden = !on;
  $('quick').disabled = on;
  if (on) $('searchText').textContent = 'Searching for opponents...';
}

function raceSettings() {
  const mode = document.querySelector('input[name="mode"]:checked');
  const level = document.querySelector('input[name="difficulty"]:checked');
  return { ranked: !mode || mode.value === 'ranked', difficulty: level ? level.value : 'medium' };
}

function quickMatch() {
  emitWithFeedback('match:join', raceSettings(), function (res) {
    if (!res || !res.ok) return showToast(res && res.error ? res.error : 'Could not start searching.');
    showSearching(true);
  });
}

function cancelSearch() {
  socket.emit('match:cancel', {}, function () { showSearching(false); });
}

function onMatchStatus(data) {
  if ($('searching').hidden) return;
  const seconds = Math.round(data.waitedMs / 1000);
  $('searchText').textContent = 'Searching for opponents... ' + seconds + 's \u00b7 ' + data.searching +
    (data.searching === 1 ? ' player' : ' players') + ' searching';
}

function createRoom() {
  emitWithFeedback('room:create', raceSettings(), onEntered);
}

function joinRoom() {
  emitWithFeedback('room:join', { code: $('code').value }, onEntered);
}

function onHomeKey(event) {
  if (event.key !== 'Enter') return;
  if ($('code').value.length >= 4) joinRoom();
  else if (!$('code').value) createRoom();
}

function leaveRoom() {
  localStorage.removeItem('session');
  socket.emit('room:leave');
  goHome();
  $('lobby').scrollIntoView(); // leaving lands on the open rooms list
}

function copyLink() {
  const link = location.origin + '/?room=' + state.room.code;
  navigator.clipboard.writeText(link).then(function () {
    showToast('Invite link copied');
  });
}

function syncJoin() {
  $('code').value = $('code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  $('join').disabled = $('code').value.length < 4;
}
$('code').addEventListener('input', syncJoin);
syncJoin();

$('create').addEventListener('click', createRoom);
$('join').addEventListener('click', joinRoom);
$('quick').addEventListener('click', quickMatch);
$('cancelSearch').addEventListener('click', cancelSearch);
$('code').addEventListener('keydown', onHomeKey);
$('leave').addEventListener('click', leaveRoom);
$('copyLink').addEventListener('click', copyLink);

try { localStorage.removeItem('records'); } catch (e) { /* storage can be blocked */ }

initAccountUi(); // wires the stats, race history and wallet controls (account.js)

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
  state.result = null;
  composing = false;
  pendingReset = null;
  lastSent = '';
  $('typing').value = '';
  buildPassage();
}

function onResync(data) {
  if (typeof data.seq === 'number' && data.seq !== inputSeq) return; // we have typed since: a newer message decides
  if (composing) { pendingReset = data.input; return; } // changing the box mid-word scrambles phone keyboards
  applyServerInput(data.input);
}

function applyServerInput(value) {
  lastSent = value;
  setTypingValue(value);
  updatePassage(value);
}

function onDisconnect() {
  if (state.room) showToast('Connection lost. Reconnecting...');
}

function onConnect() {
  showSearching(false); // a dropped connection also dropped our place in the queue
  watchLobby();
  socket.emit('account:get', {}, function (res) {
    if (res && res.ok) setAccount(res.account);
  });
  loadStats();
  const code = localStorage.getItem('session');
  if (!code) return;
  if (urlRoom && urlRoom.toUpperCase().slice(0, 4) !== code) return; // opened an invite to another room
  socket.emit('room:rejoin', { code: code }, onRejoined);
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
  state.result = result.result || null;
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
socket.on('account:state', setAccount);
socket.on('race:result', onResult);
socket.on('race:notice', function (data) { showToast(data.message); });
socket.on('match:status', onMatchStatus);
socket.on('match:found', function (data) { onEntered({ ok: true, code: data.code }); });
socket.on('disconnect', onDisconnect);
socket.on('connect_error', function (err) {
  if (!err || err.message !== 'unauthorized') showToast('Cannot reach the server. Retrying...');
  if (err && err.message === 'unauthorized') {
    showToast('Your login expired. Please log in again.');
    if (supa) supa.auth.signOut();
  }
});

// ---------- drawing the room (runs on every server update) ----------
function render() {
  const room = state.room;
  const index = myIndex(room);
  if (index < 0) return;
  refreshChip();
  const me = room.players[index];
  const practice = !!room.practice; // racing alone is practice: nobody to beat, nothing won or lost
  const inLobby = !!me.lobby && room.status !== 'lobby'; // joined while a practice was on: waits in the lobby
  const labels = {
    lobby: room.players.length + ' in the room',
    countdown: 'Get ready',
    racing: practice ? 'Practice in progress' : 'Race in progress',
    finished: practice ? 'Practice finished' : 'Race finished',
  };
  $('roomCode').textContent = room.code;
  $('status').textContent = '';
  const main = document.createElement('span');
  main.textContent = inLobby ? 'In the lobby' : labels[room.status];
  const extra = document.createElement('span');
  extra.className = 'status-extra';
  extra.textContent = (practice && room.status !== 'lobby' ? '' : room.ranked ? ' \u00b7 Ranked' : ' \u00b7 Casual') + ' \u00b7 ' + capital(room.difficulty);
  $('status').appendChild(main);
  $('status').appendChild(extra);
  $('room').dataset.status = room.status;
  $('countOverlay').hidden = room.status !== 'countdown' || inLobby;
  $('toLobby').hidden = !(room.hostId === socket.id && (room.status === 'finished' || (practice && room.status !== 'lobby')));
  $('room').dataset.solo = practice ? '1' : '0';
  $('stats').hidden = room.status === 'lobby' || inLobby;
  $('passage').hidden = room.status === 'lobby' || !state.text || inLobby;
  $('hint').hidden = room.status !== 'racing' || inLobby;
  $('statWpm').textContent = me.wpm;
  $('statAcc').textContent = me.accuracy;
  renderLanes(room);
  renderPanel(room, me, index + 1);
  saveLocalRace(room, me, index + 1);
  const canType = room.status === 'racing' && me.entered && !me.finished;
  if (canType && $('typing').disabled) {
    const restore = state.restore;
    state.restore = '';
    $('typing').disabled = false;
    $('typing').value = restore;
    updatePassage(restore);
    $('typing').focus();
  }
  if (!canType) $('typing').disabled = true;
  updateTapHint();
}

function renderLanes(room) {
  let html = '';
  const waiting = [];
  const me = room.players[myIndex(room)];
  const meWaiting = !!me && !!me.lobby && room.status !== 'lobby';
  if (meWaiting) html += '<p class="lane-title">Practicing now</p>';
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p.lobby && room.status !== 'lobby') { waiting.push(p); continue; } // waiting in the lobby: not in the race
    let cls = 'lane';
    let name = esc(p.name);
    if (p.id === socket.id) {
      cls += ' me';
      name += ' <small>(you)</small>';
    }
    if (p.finished) cls += ' finished';
    if (p.away) cls += ' left';
    if (!p.entered && room.status !== 'lobby') {
      cls += ' watching';
      name += p.forfeited ? ' <small>(forfeited)</small>' : ' <small>(watching)</small>';
    }
    html += '<div class="' + cls + '">' +
      '<span class="rank">' + (i + 1) + '</span>' +
      '<span class="name">' + name + (room.ranked ? ' <small class="rating">' + p.rating + '</small>' : '') + '</span>' +
      '<div class="track"><div class="fill" style="width:' + (p.progress * 100).toFixed(1) + '%"></div></div>' +
      '<span class="speed"><b>' + p.wpm + '</b> wpm</span></div>';
  }
  if (waiting.length > 0 && !meWaiting) {
    html += '<p class="lane-note">In the lobby: ' + waiting.map(function (p) { return esc(p.name); }).join(', ') + '</p>';
  }
  $('lanes').innerHTML = html;
}

function capital(word) {
  word = String(word || 'medium');
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function difficultyHtml(room, isHost) {
  if (!isHost) return '<p class="muted">Difficulty: ' + capital(room.difficulty) + '</p>';
  let html = '<div class="difficulty" role="group" aria-label="Passage difficulty"><span class="muted">Difficulty</span>';
  ['easy', 'medium', 'hard'].forEach(function (level) {
    html += '<button type="button" class="diff' + (room.difficulty === level ? ' on' : '') + '" data-difficulty="' + level +
      '" aria-pressed="' + (room.difficulty === level) + '">' + capital(level) + '</button>';
  });
  return html + '</div>';
}

function renderPanel(room, me, rank) {
  const isHost = room.hostId === socket.id;
  const winner = room.players[0];
  const practice = room.players.length === 1; // alone in the room
  let html = '';
  if (me.lobby && room.status !== 'lobby') {
    const busy = room.status === 'countdown' || room.status === 'racing';
    const names = room.players.filter(function (p) { return !p.lobby; }).map(function (p) { return esc(p.name); }).join(', ');
    html = '<h2>You are in the lobby</h2>' +
      '<p class="share-line">Room code <strong>' + room.code + '</strong></p>' +
      (busy
        ? '<p class="practice-ind"><span class="dot"></span>' + (names || 'The host') + ' is practicing. You can join the next race when it is over.</p>'
        : '<p class="practice-ind idle">' + (names || 'The host') + ' finished practicing. Waiting for the next race.</p>');
    html += difficultyHtml(room, isHost && !busy);
    if (isHost && !busy) html += '<button id="start" class="btn" type="button">Start race</button>';
    else if (!isHost) html += '<p class="fine">Waiting for the host to start.</p>';
    $('resultOverlay').hidden = true;
    $('resultCard').innerHTML = '';
    $('panel').innerHTML = html;
    wirePanel();
    return;
  }
  if (room.status === 'lobby') {
    html = '<h2>' + (room.players.length === 1 ? 'Waiting for racers' : 'Ready to race') + '</h2>' +
      '<p class="share-line">Share the code <strong>' + room.code + '</strong> or tap it above to copy an invite link.</p>' +
      '<p class="fine">' + (room.ranked
        ? 'Ranked: ' + room.fee + ' coins per racer, rating changes. Leaving after the start forfeits your fee. Alone = free practice.'
        : 'Casual: free to play. No coins or rating changes.') + '</p>';
    html += difficultyHtml(room, isHost);
    if (isHost) html += '<button id="start" class="btn" type="button">' + (room.players.length === 1 ? 'Start practice' : 'Start race') + '</button>';
    else html += '<p>Waiting for the host to start.</p>';
  } else if (room.status === 'countdown') {
    html = ''; // the 3-2-1 is an overlay (#countOverlay), so the page does not jump
  } else if (room.status === 'finished') {
    if (me.forfeited) {
      html = '<h2>You forfeited this race</h2><p>You disconnected, so your ' + room.fee + '-coin entry fee stayed in the pot.';
    } else if (!me.entered) {
      html = '<h2>You watched this one</h2><p>You needed ' + room.fee + ' coins to enter.';
    } else if (practice && me.finished) {
      html = '<h2>Practice complete</h2><p>' + me.wpm + ' WPM, ' + me.accuracy +
        '% accuracy, ' + (me.finishMs / 1000).toFixed(1) + ' seconds.';
    } else if (practice) {
      html = "<h2>Time's up</h2><p>You reached " + Math.round(me.progress * 100) + '% at ' + me.wpm + ' WPM.';
    } else if (me.finished) {
      html = '<h2>You finished ' + ordinal(rank) + '</h2><p>' + me.wpm + ' WPM, ' + me.accuracy +
        '% accuracy, ' + (me.finishMs / 1000).toFixed(1) + ' seconds.';
    } else {
      html = "<h2>Time's up. You placed " + ordinal(rank) + '</h2><p>You reached ' +
        Math.round(me.progress * 100) + '% at ' + me.wpm + ' WPM.';
    }
    if (winner.finished && winner.id !== me.id) html += ' ' + esc(winner.name) + ' won at ' + winner.wpm + ' WPM.';
    html += '</p>';
    if (practice && me.entered) {
      html += '<p class="muted">' + (room.ranked
        ? 'Practice run: it was free, and your rating did not change.'
        : 'Practice run: no coins or rating changed.') + '</p>';
    } else {
      html += resultHtml(me);
      if (!room.ranked) html += '<p class="muted">Casual race: no coins or rating changed.</p>';
    }
    html += difficultyHtml(room, isHost);
    const waitingNames = room.players.filter(function (p) { return p.lobby; }).map(function (p) { return esc(p.name); });
    if (waitingNames.length > 0) html += '<p class="muted">' + waitingNames.join(', ') + (waitingNames.length === 1 ? ' is' : ' are') + ' waiting in the lobby.</p>';
    if (isHost) html += '<button id="start" class="btn" type="button">' + (waitingNames.length > 0 ? 'Start race' : practice ? 'Practice again' : 'Race again') + '</button>';
    else html += '<p>Waiting for the host to start another race.</p>';
  }
  const finished = room.status === 'finished';
  if (!finished) state.resultDismissed = false;
  if (finished) {
    html += '<button id="closeResult" class="btn ghost result-close" type="button">Close</button>';
    $('resultCard').innerHTML = html;
    $('resultOverlay').hidden = state.resultDismissed;
    $('panel').innerHTML = state.resultDismissed
      ? '<button id="showResult" class="btn" type="button">Show results</button>' : '';
    if ($('showResult')) $('showResult').addEventListener('click', function () {
      state.resultDismissed = false;
      renderPanel(room, me, rank);
    });
    if ($('closeResult')) $('closeResult').addEventListener('click', function () {
      state.resultDismissed = true;
      renderPanel(room, me, rank);
    });
  } else {
    $('resultOverlay').hidden = true;
    $('resultCard').innerHTML = '';
    $('panel').innerHTML = html;
  }
  wirePanel();
}

function wirePanel() {
  if ($('start')) $('start').addEventListener('click', startRace);
  document.querySelectorAll('#panel [data-difficulty], #resultCard [data-difficulty]').forEach(function (button) {
    button.addEventListener('click', function () {
      socket.emit('room:difficulty', { difficulty: button.getAttribute('data-difficulty') });
    });
  });
}

function resultHtml(me) {
  const r = state.result;
  if (!me.entered || !r) return '';
  return '<ul class="payout">' +
    '<li><span>Entry fee</span><b class="out">' + signed(-r.fee) + '</b></li>' +
    '<li><span>Prize</span><b class="in">' + signed(r.payout) + '</b></li>' +
    '<li><span>Net coins</span><b class="' + (r.net < 0 ? 'out' : 'in') + '">' + signed(r.net) + '</b></li>' +
    '<li><span>Rating</span><b class="' + (r.ratingDelta < 0 ? 'out' : 'in') + '">' + r.ratingBefore + ' \u2192 ' + r.ratingAfter +
    ' (' + signed(r.ratingDelta) + ')</b></li></ul>';
}

$('toLobby').addEventListener('click', function () {
  socket.emit('room:lobby');
});

function startRace() { socket.emit('race:start'); }

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

function updatePassage(input, pending) {
  pending = pending || 0;
  for (let i = 0; i < state.chars.length; i++) {
    let cls = '';
    if (i < input.length && input[i] === state.text[i]) cls = 'ok';
    else if (i < input.length) cls = 'bad';
    else if (i < input.length + pending) cls = 'wip';
    else if (i === input.length + pending) cls = 'cur';
    state.chars[i].className = cls;
  }
}

// ---------- typing ----------
const MAX_WRONG = 10; // same limit as the server

function normalizeTyped(text) {
  return String(text)
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

let composing = false;   // a phone keyboard is in the middle of building a word: never rewrite the box now
let pendingReset = null; // the server's version of the text, to apply once the word is finished
let inputSeq = 0;        // numbers our messages so a late "go back" from the server can't undo newer typing
let lastSent = '';       // what the server last heard from us
const isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

function setTypingValue(value) {
  const box = $('typing');
  box.value = value;
  try { box.setSelectionRange(value.length, value.length); } catch (e) { /* not every browser allows it */ }
}

function dropStrayStart(value) {
  if (value.length < 4 || value[0] === state.text[0]) return value;
  for (let j = 1; j <= 3; j++) {
    const rest = value.slice(j);
    if (rest.length >= 3 && commonPrefix(rest, state.text) === rest.length) return rest;
  }
  return value;
}

function caretToEnd() {
  const box = $('typing');
  const end = box.value.length;
  try {
    if (box.selectionStart !== end || box.selectionEnd !== end) box.setSelectionRange(end, end);
  } catch (e) { /* not every browser allows it */ }
}

function onTyping() {
  caretToEnd();
  const raw = $('typing').value;
  let full = normalizeTyped(raw);
  let pending = 0;
  if (composing) pending = full.length - (full.lastIndexOf(' ') + 1);
  let value = full.slice(0, full.length - pending);
  if (!composing) {
    const healed = dropStrayStart(value);
    if (healed !== value) { value = healed; setTypingValue(value); }
  }
  const correct = commonPrefix(value, state.text);
  let wrong = 0;
  let trimmed = false;
  for (let i = correct; i < value.length; i++) {
    if (value[i] !== state.text[i] && ++wrong > MAX_WRONG) { // stop piling up mistakes
      value = value.slice(0, i);
      trimmed = true;
      break;
    }
  }
  if (trimmed && !composing) setTypingValue(value);
  updatePassage(value, trimmed ? 0 : pending);
  if (value !== lastSent) { // nothing new to say while a word is only being rebuilt
    lastSent = value;
    socket.emit('race:input', { input: value, seq: ++inputSeq }); // the server decides what this is worth
  }
}

function onCompositionEnd() {
  composing = false;
  if (pendingReset !== null) { // the server rejected something while the word was being built
    const v = pendingReset;
    pendingReset = null;
    applyServerInput(v);
    return;
  }
  onTyping(); // word finished: judge it now
}

function blockEvent(event) { event.preventDefault(); }

function refocus() {
  if (!$('typing').disabled && document.activeElement === document.body) $('typing').focus();
}

function focusTyping() {
  const box = $('typing');
  if (box.disabled) return;
  box.focus({ preventScroll: true });
  keepPassageVisible();
}

function updateTapHint() {
  const needsTap = isTouch && !$('typing').disabled && document.activeElement !== $('typing');
  $('passage').classList.toggle('tap-to-type', needsTap);
}

let scrollTimer = null;
function keepPassageVisible() { // the on-screen keyboard covers the bottom half: keep the passage above it
  if (!isTouch || $('passage').hidden) return;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(function () {
    $('passage').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 120);
}

$('typing').addEventListener('input', onTyping);
$('typing').addEventListener('compositionstart', function () { composing = true; });
$('typing').addEventListener('compositionend', onCompositionEnd);
$('typing').addEventListener('focus', function () { caretToEnd(); updateTapHint(); keepPassageVisible(); });
$('typing').addEventListener('select', caretToEnd);
document.addEventListener('selectionchange', function () { if (document.activeElement === $('typing')) caretToEnd(); });
$('typing').addEventListener('blur', function () { composing = false; updateTapHint(); });
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', function () {
    if (document.activeElement === $('typing')) keepPassageVisible();
  });
}
if (isTouch) $('hint').textContent = 'Tap the passage if the keyboard closes.';
['paste', 'cut', 'drop'].forEach(function (name) { $('typing').addEventListener(name, blockEvent); });
$('passage').addEventListener('click', focusTyping);
document.addEventListener('keydown', refocus);

// ---------- clock: countdown number and time left ----------
function updateClock() {
  const room = state.room;
  if (!room) return;
  const now = Date.now() + state.offset;
  if (room.status === 'countdown' && $('count')) $('count').textContent = Math.max(1, Math.ceil((state.startAt - now) / 1000));
  if (room.status === 'racing') $('statTime').textContent = formatTime(state.startAt + state.limitMs - now);
  else if (room.status === 'finished') $('statTime').textContent = 'Done';
  else $('statTime').textContent = formatTime(state.limitMs);
}

setInterval(updateClock, 100);

startAuth();

// ---------- fixed header: keep the page content clear of it ----------
(function () {
  const nav = $('topnav');
  function sync() {
    const phone = window.matchMedia('(max-width: 760px)').matches;
    const space = nav.hidden ? 0 : nav.offsetHeight + (phone ? 0 : 16);
    document.documentElement.style.setProperty('--nav-space', space + 'px');
  }
  new ResizeObserver(sync).observe(nav);
  new MutationObserver(sync).observe(nav, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('resize', sync);
  sync();
})();

// ---------- phones: the top menu slides away when you scroll down and comes back when you scroll up ----------
(function () {
  const nav = $('topnav');
  const phone = window.matchMedia('(max-width: 760px)');
  let lastY = window.scrollY;
  let waiting = false;
  function update() {
    waiting = false;
    const y = Math.max(0, window.scrollY);
    if (!phone.matches || y < 40) {
      nav.classList.remove('nav-hidden');
    } else if (Math.abs(y - lastY) > 6) {
      nav.classList.toggle('nav-hidden', y > lastY);
    }
    lastY = y;
  }
  window.addEventListener('scroll', function () {
    if (!waiting) { waiting = true; requestAnimationFrame(update); }
  }, { passive: true });
})();

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !$('resultOverlay').hidden && $('closeResult')) $('closeResult').click();
});
