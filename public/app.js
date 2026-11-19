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
  $('authSubmit').disabled = busy;
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
  setAuthBusy(true);
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
    const res = await supa.auth.signUp({ email: email, password: password, options: { data: { username: username } } });
    if (res.error) return showAuthMessage(friendlyAuthError(res.error), true);
    // When an email is already registered, Supabase answers with a fake "new" user that has no identities (so it
    // can't be used to find out who has an account). That is not a new account: say so instead of "check your email".
    const created = res.data && res.data.user;
    if (created && Array.isArray(created.identities) && created.identities.length === 0) {
      setAuthMode('login');
      $('authEmail').value = email;
      return showAuthMessage('That email already has an account. Log in instead.', true);
    }
    // with email confirmation switched on there is no session yet
    if (!res.data.session) {
      setAuthMode('login');
      showAuthMessage('Account created. Check your email to confirm it, then log in.', false);
    }
  } catch (e) {
    showAuthMessage('Could not reach the server. Please try again.', true);
  } finally {
    setAuthBusy(false);
  }
}

async function onSignOut() {
  await supa.auth.signOut(); // onAuthChange does the rest
}

// called whenever the login state changes (page load, log in, log out, token refresh)
function onAuthChange(session) {
  if (session && session.user) {
    const changedUser = pid !== session.user.id;
    pid = session.user.id;
    const username = (session.user.user_metadata || {}).username || String(session.user.email || '').split('@')[0];
    $('userEmail').textContent = username;
    $('name').value = username; // the server uses the account's name; this only keeps the screen consistent
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
  $('signOut').addEventListener('click', onSignOut);
  supa.auth.onAuthStateChange(function (event, session) {
    if (event === 'TOKEN_REFRESHED') return; // same user: nothing to redo
    onAuthChange(session);
  });
  const first = await supa.auth.getSession();
  onAuthChange(first.data.session);
}

// what the screen remembers between server updates
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
  // friendly messages when a tab would otherwise be blank
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
      '<span class="lobby-code">' + esc(r.code) + '</span>' +
      '<span class="lobby-host">' + esc(r.host) + '<small>' + (r.ranked ? 'Ranked \u00b7 ' + r.fee + ' coins' : 'Casual \u00b7 free') + ' \u00b7 ' + esc(capital(r.difficulty)) + '</small></span>' +
      '<span class="lobby-seats">' + r.players + '/' + r.max + '</span>' +
      '<button class="btn secondary" type="button" data-code="' + esc(r.code) + '">Join</button></li>';
  }
  $('lobbyList').innerHTML = html;
}

$('lobbyList').addEventListener('click', function (event) {
  const button = event.target.closest('button[data-code]');
  if (!button) return;
  button.disabled = true;
  socket.emit('room:join', { name: $('name').value, code: button.getAttribute('data-code'), pid: pid }, function (result) {
    button.disabled = false;
    onEntered(result);
  });
});
socket.on('lobby:rooms', function (data) { renderLobby((data || {}).rooms); });

// ---------- home screen ----------
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('code').value = urlRoom.toUpperCase().slice(0, 4);

function onEntered(result) {
  if (!result.ok) return showToast(result.error);
  showSearching(false);
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

// Join stays disabled until a full four-letter code is typed
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
$('name').addEventListener('keydown', onHomeKey);
$('code').addEventListener('keydown', onHomeKey);
$('leave').addEventListener('click', leaveRoom);
$('copyLink').addEventListener('click', copyLink);

// The old browser-only "saved races" list is gone: race history lives on the account. Tidy up what it left behind.
try { localStorage.removeItem('records'); } catch (e) { /* storage can be blocked */ }

// ---------- stats and leaderboard (kept on the server) ----------
// ---------- race history (REST API: GET /api/races) ----------
const races_ = { items: [], hasMore: false, loading: false };

// Casual and practice races change no coins or rating, so the server does not keep them. This browser does, and
// they are merged into the race history below (ranked races come from the account).
const LOCAL_RACES_KEY = 'casualRaces';

function loadLocalRaces() {
  try {
    const list = JSON.parse(localStorage.getItem(LOCAL_RACES_KEY));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

function saveLocalRace(room, me, rank) {
  if (room.status !== 'finished' || !me.entered) return;
  if (room.ranked && room.players.length > 1) return; // real ranked races are saved on the account
  if (!me.finished && me.wpm === 0) return;
  const id = room.code + ':' + room.startAt;
  const list = loadLocalRaces();
  if (list.some(function (r) { return r.id === id; })) return;
  list.unshift({
    id: id, endedAt: new Date().toISOString(), room: room.code, rank: rank,
    wpm: me.wpm, accuracy: me.accuracy, finished: me.finished, progress: me.progress,
    seconds: me.finished ? Math.round(me.finishMs / 100) / 10 : null,
    kind: room.players.length === 1 ? 'Practice' : 'Casual',
  });
  try { localStorage.setItem(LOCAL_RACES_KEY, JSON.stringify(list.slice(0, 30))); } catch (e) { /* storage can be blocked */ }
  renderRaceHistory();
}

// the account's ranked races plus this browser's casual and practice races, newest first
function mergedRaces() {
  const server = races_.items;
  const oldest = server.length ? Date.parse(server[server.length - 1].endedAt) : Infinity;
  const local = loadLocalRaces().filter(function (l) {
    const t = Date.parse(l.endedAt);
    if (races_.hasMore && t < oldest) return false; // older than the page on screen: shows up after "Show more"
    return !server.some(function (r) { // a ranked practice run the server already lists
      return r.room === l.room && Math.abs(Date.parse(r.endedAt) - t) < 5 * 60 * 1000;
    });
  }).map(function (l) { return Object.assign({}, l, { local: true }); });
  return server.concat(local).sort(function (a, b) { return Date.parse(b.endedAt) - Date.parse(a.endedAt); });
}

function renderRaceHistory() {
  const items = mergedRaces();
  $('raceHistory').hidden = items.length === 0;
  updateEmptyStates();
  let html = '';
  for (let i = 0; i < items.length; i++) {
    const r = items[i];
    const when = new Date(r.endedAt).toLocaleString(undefined, ledgerTime);
    const time = r.seconds === null ? 'DNF' : r.seconds + 's';
    if (r.local) {
      html += '<li><span class="place">' + (r.kind === 'Practice' ? '\u2014' : ordinal(r.rank)) + '</span>' +
        '<span><b>' + r.wpm + '</b> wpm</span>' +
        '<span>' + r.accuracy + '%<span class="lbl"> acc</span></span>' +
        '<span>' + time + '</span>' +
        '<span class="tag">' + r.kind + '</span>' +
        '<span class="muted">no coins or rating</span>' +
        '<span class="muted">' + esc(r.room) + ' \u00b7 ' + when + '</span></li>';
      continue;
    }
    const coins = r.net === 0 ? '0' : signed(r.net);
    html += '<li><span class="place' + (r.rank === 1 ? ' first' : '') + '">' + ordinal(r.rank) + '</span>' +
      '<span><b>' + r.wpm + '</b> wpm</span>' +
      '<span>' + r.accuracy + '%<span class="lbl"> acc</span></span>' +
      '<span>' + time + '</span>' +
      '<span class="' + (r.net < 0 ? 'out' : 'in') + '">' + coins + ' coins</span>' +
      '<span>rating ' + r.ratingBefore + ' \u2192 ' + r.ratingAfter + '</span>' +
      '<span class="muted">' + esc(r.room) + ' \u00b7 ' + when + '</span></li>';
  }
  $('raceList').innerHTML = html;
  $('raceMore').hidden = !races_.hasMore;
  $('raceMore').disabled = races_.loading;
}

async function loadRaceHistory(reset) {
  if (races_.loading || !supa) return;
  races_.loading = true;
  try {
    const token = await getAccessToken();
    const res = await fetch('/api/races?offset=' + (reset ? 0 : races_.items.length), { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const page = await res.json();
    races_.items = reset ? page.items : races_.items.concat(page.items);
    races_.hasMore = page.hasMore;
  } catch (e) {
    // a failed refresh just keeps what is already on screen
  }
  races_.loading = false;
  renderRaceHistory();
}
$('raceMore').addEventListener('click', function () { loadRaceHistory(false); });

// Uses the REST API: GET /api/stats and GET /api/leaderboard with the login token.
async function loadStats() {
  loadRaceHistory(true);
  if (!supa) return;
  try {
    const headers = { Authorization: 'Bearer ' + await getAccessToken() };
    const both = await Promise.all([fetch('/api/stats', { headers: headers }), fetch('/api/leaderboard?limit=20', { headers: headers })]);
    if (!both[0].ok || !both[1].ok) throw new Error('HTTP ' + both[0].status + '/' + both[1].status);
    const stats = await both[0].json();
    const board = await both[1].json();
    renderStats(stats, board.items);
  } catch (e) {
    // a failed refresh keeps what is already on screen
  }
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
  updateEmptyStates();
  if (hasStats) {
    $('statsSummary').innerHTML = '<div><b>' + stats.bestWpm + '</b><span>best WPM</span></div>' +
      '<div><b>' + stats.avgWpm + '</b><span>avg WPM</span></div>' +
      '<div><b>' + stats.races + '</b><span>races</span></div>';
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
  updateEmptyStates();
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

const history_ = { type: '', items: [], hasMore: false, loading: false };
const ledgerTime = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };

function renderLedger() {
  let html = '';
  for (let i = 0; i < history_.items.length; i++) {
    const t = history_.items[i];
    html += '<li><span class="tx ' + (t.amount < 0 ? 'out' : 'in') + '">' + signed(t.amount) + '</span>' +
      '<span class="what">' + ledgerLabels[t.type] + (t.room ? ' <small>' + esc(t.room) + '</small>' : '') + '</span>' +
      '<span class="bal">' + t.balance + ' left</span>' +
      '<span class="when">' + new Date(t.at).toLocaleString(undefined, ledgerTime) + '</span></li>';
  }
  $('ledger').innerHTML = html;
  $('ledgerEmpty').hidden = history_.items.length > 0;
  $('ledgerMore').hidden = !history_.hasMore;
  $('ledgerMore').disabled = history_.loading;
}

// reset = start again from the newest; otherwise add the next page below what is shown
// Uses the REST API: GET /api/wallet/transactions with the login token.
async function loadHistory(reset) {
  if (history_.loading) return;
  history_.loading = true;
  $('ledgerMore').disabled = true;
  const type = history_.type;
  try {
    const token = await getAccessToken();
    const url = '/api/wallet/transactions?offset=' + (reset ? 0 : history_.items.length) + '&type=' + encodeURIComponent(type);
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const page = await res.json();
    if (type === history_.type) { // the filter may have changed while we waited
      history_.items = reset ? page.items : history_.items.concat(page.items);
      history_.hasMore = page.hasMore;
    }
  } catch (e) {
    showToast('Could not load your transactions.');
  }
  history_.loading = false;
  renderLedger();
}

$('ledgerFilters').addEventListener('click', function (event) {
  const button = event.target.closest('button[data-type]');
  if (!button) return;
  history_.type = button.getAttribute('data-type');
  const all = document.querySelectorAll('#ledgerFilters button');
  for (let i = 0; i < all.length; i++) all[i].classList.toggle('active', all[i] === button);
  if (history_.type === '' && state.account) { renderWallet(); return; }
  history_.items = [];
  history_.hasMore = false;
  renderLedger();
  loadHistory(true);
});
$('ledgerMore').addEventListener('click', function () { loadHistory(false); });

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
  // the account message carries the latest 10; any other filter is fetched from the server
  if (history_.type === '') {
    history_.items = a.ledger.slice();
    history_.hasMore = a.ledger.length >= 10;
    renderLedger();
  } else {
    loadHistory(true);
  }
  $('walletChip').innerHTML = Number(a.coins) + ' coins<span class="chip-rating"> \u00b7 rating ' + Number(a.rating) + '</span>';
  $('coinPill').hidden = false;
  $('coinPill').innerHTML = Number(a.coins) + ' coins<span class="chip-rating"> \u00b7 ' + Number(a.rating) + '</span>';
  refreshChip();
}

// coins and rating only matter in ranked races, so a casual room doesn't show them
function refreshChip() {
  const casual = state.room && state.room.ranked === false;
  $('walletChip').hidden = !state.account || !!casual;
}

function onResult(result) {
  state.result = result;
  loadRaceHistory(true); // the race has just been saved: refresh the history
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
  composing = false;
  pendingReset = null;
  lastSent = '';
  $('typing').value = '';
  buildPassage();
}

// the server rejected our typing (for example a paste), so go back to its version
function onResync(data) {
  if (typeof data.seq === 'number' && data.seq !== inputSeq) return; // we have typed since: a newer message decides
  if (composing) { pendingReset = data.input; return; } // changing the box mid-word scrambles phone keyboards
  lastSent = data.input;
  setTypingValue(data.input);
  updatePassage(data.input);
}

function onDisconnect() {
  if (state.room) showToast('Connection lost. Reconnecting...');
}

// on every (re)connect, take our seat back if we were in a room
function onConnect() {
  showSearching(false); // a dropped connection also dropped our place in the queue
  watchLobby();
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
  refreshChip();
  const me = room.players[index];
  const practice = room.players.length === 1; // racing alone is practice: nobody to beat, nothing won or lost
  const labels = {
    lobby: room.players.length + ' in the room',
    countdown: 'Get ready',
    racing: practice ? 'Practice in progress' : 'Race in progress',
    finished: practice ? 'Practice finished' : 'Race finished',
  };

  $('roomCode').textContent = room.code;
  $('status').textContent = '';
  const main = document.createElement('span');
  main.textContent = labels[room.status];
  const extra = document.createElement('span');
  extra.className = 'status-extra';
  extra.textContent = (practice && room.status !== 'lobby' ? '' : room.ranked ? ' \u00b7 Ranked' : ' \u00b7 Casual') + ' \u00b7 ' + capital(room.difficulty);
  $('status').appendChild(main);
  $('status').appendChild(extra);
  $('room').dataset.status = room.status;
  $('countOverlay').hidden = room.status !== 'countdown';
  // back to the room's waiting lobby: the host, when racing alone or once the race is over
  $('toLobby').hidden = !(room.hostId === socket.id && (room.status === 'finished' || (practice && room.status !== 'lobby')));
  $('room').dataset.solo = practice ? '1' : '0';
  $('stats').hidden = room.status === 'lobby';
  $('passage').hidden = room.status === 'lobby' || !state.text;
  $('hint').hidden = room.status !== 'racing';
  $('statWpm').textContent = me.wpm;
  $('statAcc').textContent = me.accuracy;

  renderLanes(room);
  renderPanel(room, me, index + 1);
  saveLocalRace(room, me, index + 1);

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
  updateTapHint();
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
      '<span class="name">' + name + (room.ranked ? ' <small class="rating">' + p.rating + '</small>' : '') + '</span>' +
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
  const practice = room.players.length === 1; // alone in the room
  let html = '';

  if (room.status === 'lobby') {
    html = '<h2>' + (room.players.length === 1 ? 'Waiting for racers' : 'Ready to race') + '</h2><p>Share the code <strong>' + room.code +
      '</strong> or click it above to copy an invite link. ' + (room.ranked
        ? 'Ranked: entry is ' + room.fee + ' coins per racer and your rating changes. Leaving once the race has started forfeits your fee. Starting alone is practice: it is free, with no fee and no rating change.'
        : 'Casual: free to play. No coins are spent or won and ratings do not change.') + '</p>';
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
      // alone in the room: the fee is handed back and the rating stays put, so there is no payout table to show
      html += '<p class="muted">' + (room.ranked
        ? 'Practice run: it was free, and your rating did not change.'
        : 'Practice run: no coins or rating changed.') + '</p>';
    } else {
      html += resultHtml(me);
      if (!room.ranked) html += '<p class="muted">Casual race: no coins or rating changed.</p>';
    }
    html += difficultyHtml(room, isHost);
    if (isHost) html += '<button id="start" class="btn" type="button">' + (practice ? 'Practice again' : 'Race again') + '</button>';
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
  if ($('start')) $('start').addEventListener('click', startRace);
  document.querySelectorAll('#panel [data-difficulty], #resultCard [data-difficulty]').forEach(function (button) {
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

$('toLobby').addEventListener('click', function () {
  socket.emit('room:lobby');
});

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
// wip = letters the phone keyboard is still building (not judged yet)
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
// how many letters from `from` on are wrong (letters that match don't count)
function wrongAfter(input, text, from) {
  let n = 0;
  for (let i = from; i < input.length; i++) if (input[i] !== text[i]) n++;
  return n;
}

const MAX_WRONG = 10; // same limit as the server

// Phone keyboards swap plain characters for fancy ones (curly quotes, long dashes, odd spaces). The passage only
// uses plain ones, so treat them as the plain character (the server does the same).
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

// A stray key at the very start (for example tapped while the keyboard slides up) pushes every later letter one
// place out, so correct typing looks wrong. If dropping 1-3 leading keys makes what was typed match the start of
// the passage, drop them.
function dropStrayStart(value) {
  if (value.length < 4 || value[0] === state.text[0]) return value;
  for (let j = 1; j <= 3; j++) {
    const rest = value.slice(j);
    if (rest.length >= 3 && commonPrefix(rest, state.text) === rest.length) return rest;
  }
  return value;
}

// The box is only ever appended to or backspaced. If the phone moves the caret to the start, every new letter goes
// in front of the others and the text comes out backwards ("eht" for "the"): put the caret back at the end.
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
  // Phone keyboards rewrite the word they are building (autocorrect, suggestions). That word is not final, so it
  // is not marked wrong and not sent until the keyboard commits it (space, punctuation or finishing the word).
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

function onCompositionStart() {
  composing = true;
}

function onCompositionEnd() {
  composing = false;
  if (pendingReset !== null) { // the server rejected something while the word was being built
    const v = pendingReset;
    pendingReset = null;
    lastSent = v;
    setTypingValue(v);
    updatePassage(v);
    return;
  }
  onTyping(); // word finished: judge it now
}

function blockEvent(event) {
  event.preventDefault();
}

function refocus() {
  if (!$('typing').disabled && document.activeElement === document.body) $('typing').focus();
}

// Phones only open the keyboard when the player taps, so the passage is a big tap target and says so.
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
$('typing').addEventListener('compositionstart', onCompositionStart);
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
const blocked = ['paste', 'cut', 'drop'];
for (let i = 0; i < blocked.length; i++) $('typing').addEventListener(blocked[i], blockEvent);
$('passage').addEventListener('click', focusTyping);
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


// ---------- fixed header: keep the page content clear of it ----------
(function () {
  const nav = $('topnav');
  function sync() {
    const space = nav.hidden ? 0 : nav.offsetHeight + 16;
    document.documentElement.style.setProperty('--nav-space', space + 'px');
  }
  new ResizeObserver(sync).observe(nav);
  new MutationObserver(sync).observe(nav, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('resize', sync);
  sync();
})();

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !$('resultOverlay').hidden && $('closeResult')) $('closeResult').click();
});
