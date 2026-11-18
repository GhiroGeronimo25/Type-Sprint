// The socket stays disconnected until the player is logged in. Every (re)connect sends a fresh access token,
// and the server uses it to decide who this is.
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
// pid is only used on this screen (for example to mark "you"). The server never trusts it: it uses the id
// from the verified login token instead.
let pid = null;
let supa = null;

async function getAccessToken() {
  if (!supa) return '';
  const res = await supa.auth.getSession(); // refreshes an expired token when needed
  return res.data.session ? res.data.session.access_token : '';
}

function showAuthMessage(text, isError) {
  $('authMsg').hidden = !text;
  $('authMsg').textContent = text || '';
  $('authMsg').classList.toggle('error', !!isError);
}

function setAuthBusy(busy) {
  $('signIn').disabled = busy;
  $('signUp').disabled = busy;
}

function friendlyAuthError(error) {
  const m = String(error && error.message || '');
  if (/invalid login/i.test(m)) return 'Wrong email or password.';
  if (/already registered/i.test(m)) return 'That email already has an account. Try logging in.';
  if (/email not confirmed/i.test(m)) return 'Please confirm your email first (check your inbox).';
  return m || 'Something went wrong. Please try again.';
}

async function onSignIn(event) {
  if (event) event.preventDefault();
  showAuthMessage('');
  setAuthBusy(true);
  const res = await supa.auth.signInWithPassword({ email: $('authEmail').value.trim(), password: $('authPassword').value });
  setAuthBusy(false);
  if (res.error) showAuthMessage(friendlyAuthError(res.error), true);
  // success is handled by onAuthChange
}

async function onSignUp() {
  showAuthMessage('');
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  if (!email || password.length < 6) return showAuthMessage('Enter an email and a password of at least 6 characters.', true);
  setAuthBusy(true);
  const res = await supa.auth.signUp({ email: email, password: password });
  setAuthBusy(false);
  if (res.error) return showAuthMessage(friendlyAuthError(res.error), true);
  // with email confirmation switched on there is no session yet
  if (!res.data.session) showAuthMessage('Account created. Check your email to confirm it, then log in.', false);
}

async function onSignOut() {
  await supa.auth.signOut(); // onAuthChange does the rest
}

// called whenever the login state changes (page load, log in, log out, token refresh)
function onAuthChange(session) {
  if (session && session.user) {
    const changedUser = pid !== session.user.id;
    pid = session.user.id;
    $('userEmail').textContent = session.user.email || '';
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
  $('authForm').addEventListener('submit', onSignIn);
  $('signUp').addEventListener('click', onSignUp);
  $('signOut').addEventListener('click', onSignOut);
  supa.auth.onAuthStateChange(function (event, session) {
    if (event === 'TOKEN_REFRESHED') return; // same user: nothing to redo
    onAuthChange(session);
  });
  const first = await supa.auth.getSession();
  onAuthChange(first.data.session);
}

// what the screen remembers between server updates
const state = { account: null, result: null, room: null, text: '', startAt: 0, limitMs: 60000, offset: 0, chars: [], restore: '' };

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
  $('auth').hidden = name !== 'auth';
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
  loadStats();
}

// ---------- home screen ----------
$('name').value = localStorage.getItem('name') || '';
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('code').value = urlRoom.toUpperCase().slice(0, 4);

function onEntered(result) {
  if (!result.ok) return showToast(result.error);
  showSearching(false);
  localStorage.setItem('name', $('name').value);
  localStorage.setItem('session', result.code);
  history.replaceState(null, '', '?room=' + result.code);
  showScreen('room');
}

// ---------- quick match ----------
function showSearching(on) {
  $('searching').hidden = !on;
  $('quick').disabled = on;
  if (on) $('searchText').textContent = 'Searching for opponents...';
}

function quickMatch() {
  const mode = document.querySelector('input[name="mode"]:checked');
  const level = document.querySelector('input[name="difficulty"]:checked');
  socket.emit('match:join', {
    name: $('name').value, pid: pid, ranked: !mode || mode.value === 'ranked', difficulty: level ? level.value : 'medium',
  }, function (res) {
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

// the server found a match and has already put us in the room
function onMatchFound(data) {
  onEntered({ ok: true, code: data.code });
}

function createRoom() {
  const mode = document.querySelector('input[name="mode"]:checked');
  const level = document.querySelector('input[name="difficulty"]:checked');
  socket.emit('room:create', { name: $('name').value, pid: pid, ranked: !mode || mode.value === 'ranked', difficulty: level ? level.value : 'medium' }, onEntered);
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
$('quick').addEventListener('click', quickMatch);
$('cancelSearch').addEventListener('click', cancelSearch);
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

// ---------- stats and leaderboard (kept on the server) ----------
function loadStats() {
  socket.emit('stats:get', { pid: pid }, function (res) {
    if (res && res.ok) renderStats(res.stats, res.leaderboard);
  });
}

// accuracy over the last races as a small line chart, oldest on the left
function trendSvg(trend) {
  if (!trend.length) return '<p class="muted">Finish a race to see your accuracy trend.</p>';
  const w = 320, h = 110, padL = 34, padR = 10, padT = 12, padB = 18;
  const values = trend.map(function (t) { return Number(t.accuracy); });
  const hi = 100;
  let lo = Math.min.apply(null, values);
  if (hi - lo < 5) lo = hi - 5; // never zoom in so far that a 1% wobble looks like a crash
  const x = function (i) { return trend.length === 1 ? (padL + w - padR) / 2 : padL + (i * (w - padL - padR)) / (trend.length - 1); };
  const y = function (v) { return padT + ((hi - v) * (h - padT - padB)) / (hi - lo); };
  const points = values.map(function (v, i) { return x(i).toFixed(1) + ',' + y(v).toFixed(1); });
  const label = 'Accuracy over your last ' + trend.length + (trend.length === 1 ? ' race: ' : ' races: from ') +
    (trend.length === 1 ? values[0] + '%' : values[0] + '% to ' + values[values.length - 1] + '%');
  let svg = '<svg class="trend" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + '">' +
    '<line class="axis" x1="' + padL + '" y1="' + y(hi) + '" x2="' + (w - padR) + '" y2="' + y(hi) + '"/>' +
    '<line class="axis" x1="' + padL + '" y1="' + y(lo) + '" x2="' + (w - padR) + '" y2="' + y(lo) + '"/>' +
    '<text x="' + (padL - 6) + '" y="' + (y(hi) + 4) + '" text-anchor="end">' + hi + '%</text>' +
    '<text x="' + (padL - 6) + '" y="' + (y(lo) + 4) + '" text-anchor="end">' + Math.round(lo) + '%</text>';
  if (trend.length > 1) svg += '<polyline class="line" points="' + points.join(' ') + '"/>';
  values.forEach(function (v, i) { svg += '<circle class="dot" cx="' + x(i).toFixed(1) + '" cy="' + y(v).toFixed(1) + '" r="3.5"/>'; });
  return svg + '</svg>';
}

function renderStats(stats, board) {
  const hasStats = stats && (stats.races > 0 || stats.flaggedRaces > 0);
  $('myStats').hidden = !hasStats;
  if (hasStats) {
    $('statsSummary').innerHTML = '<div><b>' + stats.bestWpm + '</b><span>best WPM</span></div>' +
      '<div><b>' + stats.avgWpm + '</b><span>average WPM</span></div>' +
      '<div><b>' + stats.races + '</b><span>races counted</span></div>';
    $('trendChart').innerHTML = trendSvg(stats.trend);
    let missed = '';
    stats.mostMissed.forEach(function (m) {
      missed += '<li><kbd>' + (m.ch === ' ' ? 'space' : esc(m.ch)) + '</kbd><small>\u00d7' + m.misses + '</small></li>';
    });
    $('missedList').innerHTML = missed || '<li class="muted">No mistakes yet. Nice.</li>';
    $('statsNote').hidden = !stats.flaggedRaces;
    if (stats.flaggedRaces) {
      $('statsNote').textContent = stats.flaggedRaces + (stats.flaggedRaces === 1 ? ' race was' : ' races were') +
        ' not counted because anti-cheat flagged unusual typing.';
    }
  }

  const rows = board || [];
  $('board').hidden = rows.length === 0;
  let html = '';
  rows.forEach(function (r, i) {
    html += '<tr' + (r.isYou ? ' class="you"' : '') + '><td>' + (i + 1) + '</td><td>' + esc(r.name) + (r.isYou ? ' (you)' : '') +
      '</td><td>' + r.rating + '</td><td>' + r.bestWpm + '</td><td>' + r.wins + ' / ' + r.races + '</td></tr>';
  });
  $('boardTable').querySelector('tbody').innerHTML = html;
}

// ---------- wallet: rating, coins and transactions ----------
const ledgerLabels = { grant: 'Welcome coins', entry: 'Entry fee', reward: 'Prize', refund: 'Refund' };

function signed(n) {
  return (n > 0 ? '+' : n < 0 ? '\u2212' : '') + Math.abs(n);
}

function setAccount(account) {
  state.account = account;
  renderWallet();
}

function renderWallet() {
  const a = state.account;
  if (!a) return;
  $('wallet').hidden = false;
  $('feeNote').textContent = a.entryFee;
  $('walletStats').innerHTML = '<div><b>' + a.coins + '</b><span>coins</span></div>' +
    '<div><b>' + a.rating + '</b><span>rating</span></div>' +
    '<div><b>' + a.wins + '/' + a.races + '</b><span>wins / races</span></div>';
  let html = '';
  for (let i = 0; i < a.ledger.length; i++) {
    const t = a.ledger[i];
    const when = new Date(t.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    html += '<li><span class="tx ' + (t.amount < 0 ? 'out' : 'in') + '">' + signed(t.amount) + '</span>' +
      '<span class="what">' + ledgerLabels[t.type] + (t.room ? ' <small>' + esc(t.room) + '</small>' : '') + '</span>' +
      '<span class="bal">' + t.balance + ' left</span><span class="when">' + when + '</span></li>';
  }
  $('ledger').innerHTML = html;
  $('walletChip').hidden = false;
  $('walletChip').textContent = a.coins + ' coins \u00b7 rating ' + a.rating;
}

function onResult(result) {
  state.result = result;
  if (state.room) render();
}

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
  showSearching(false); // a dropped connection also dropped our place in the queue
  socket.emit('account:get', { pid: pid }, function (res) {
    if (res && res.ok) setAccount(res.account);
  });
  loadStats();
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
socket.on('match:found', onMatchFound);
socket.on('disconnect', onDisconnect);
socket.on('connect_error', function (err) {
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
  const me = room.players[index];
  const labels = {
    lobby: room.players.length + ' in the room',
    countdown: 'Get ready',
    racing: 'Race in progress',
    finished: 'Race finished',
  };

  $('roomCode').textContent = room.code;
  $('status').textContent = labels[room.status] + (room.ranked ? ' \u00b7 Ranked' : ' \u00b7 Casual') + ' \u00b7 ' + capital(room.difficulty);
  $('stats').hidden = room.status === 'lobby';
  $('passage').hidden = room.status === 'lobby' || !state.text;
  $('hint').hidden = room.status !== 'racing';
  $('statWpm').textContent = me.wpm;
  $('statAcc').textContent = me.accuracy;

  renderLanes(room);
  renderPanel(room, me, index + 1);

  // you can only type while the race is on and you haven't finished
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
  if (me.entered) saveRecord(room, me, index + 1);
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
    if (!p.entered && room.status !== 'lobby') {
      cls += ' watching';
      name += p.forfeited ? ' <small>(forfeited)</small>' : ' <small>(watching)</small>';
    }
    html += '<div class="' + cls + '">' +
      '<span class="rank">' + (i + 1) + '</span>' +
      '<span class="name">' + name + ' <small class="rating">' + p.rating + '</small></span>' +
      '<div class="track"><div class="fill" style="width:' + (p.progress * 100).toFixed(1) + '%"></div></div>' +
      '<span class="speed"><b>' + p.wpm + '</b> wpm</span></div>';
  }
  $('lanes').innerHTML = html;
}

function capital(word) {
  word = String(word || 'medium');
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// the host picks how hard the next passage is; everyone else just sees it
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
  let html = '';

  if (room.status === 'lobby') {
    html = '<h2>Waiting for racers</h2><p>Share the code <strong>' + room.code +
      '</strong> or click it above to copy an invite link. ' + (room.ranked
        ? 'Ranked: entry is ' + room.fee + ' coins per racer, and your rating changes. Disconnecting or leaving once the race has started forfeits your entry fee. Starting alone just returns your own fee.'
        : 'Casual: free to play. No coins are spent or won and ratings do not change.') + '</p>';
    html += difficultyHtml(room, isHost);
    if (isHost) html += '<button id="start" class="btn" type="button">Start race</button>';
    else html += '<p>Waiting for the host to start.</p>';
  } else if (room.status === 'countdown') {
    html = '<div class="count" id="count">3</div>';
  } else if (room.status === 'finished') {
    if (me.forfeited) {
      html = '<h2>You forfeited this race</h2><p>You disconnected, so your ' + room.fee + '-coin entry fee stayed in the pot.';
    } else if (!me.entered) {
      html = '<h2>You watched this one</h2><p>You needed ' + room.fee + ' coins to enter.';
    } else if (me.finished) {
      html = '<h2>You finished ' + ordinal(rank) + '</h2><p>' + me.wpm + ' WPM, ' + me.accuracy +
        '% accuracy, ' + (me.finishMs / 1000).toFixed(1) + ' seconds.';
    } else {
      html = "<h2>Time's up. You placed " + ordinal(rank) + '</h2><p>You reached ' +
        Math.round(me.progress * 100) + '% at ' + me.wpm + ' WPM.';
    }
    if (winner.finished && winner.id !== me.id) html += ' ' + esc(winner.name) + ' won at ' + winner.wpm + ' WPM.';
    html += '</p>' + resultHtml(me);
    if (!room.ranked) html += '<p class="muted">Casual race: no coins or rating changed.</p>';
    html += difficultyHtml(room, isHost);
    if (isHost) html += '<button id="start" class="btn" type="button">Race again</button>';
    else html += '<p>Waiting for the host to start another race.</p>';
  }

  $('panel').innerHTML = html;
  if ($('start')) $('start').addEventListener('click', startRace);
  document.querySelectorAll('#panel [data-difficulty]').forEach(function (button) {
    button.addEventListener('click', function () {
      socket.emit('room:difficulty', { difficulty: button.getAttribute('data-difficulty') });
    });
  });
}

// what this race cost and paid, plus the rating change
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

startAuth();
