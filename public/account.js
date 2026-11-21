// Stats, race history and wallet screens. Loaded before app.js, which calls initAccountUi() once.

// ---------- stats and leaderboard (kept on the server) ----------
// ---------- race history (REST API: GET /api/races) ----------
const races_ = { items: [], hasMore: false, loading: false };

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
  if (room.ranked && !room.practice) return; // real ranked races are saved on the account
  if (!me.finished && me.wpm === 0) return;
  const id = room.code + ':' + room.startAt;
  const list = loadLocalRaces();
  if (list.some(function (r) { return r.id === id; })) return;
  list.unshift({
    id: id, endedAt: new Date().toISOString(), room: room.code, rank: rank,
    wpm: me.wpm, accuracy: me.accuracy, finished: me.finished, progress: me.progress,
    seconds: me.finished ? Math.round(me.finishMs / 100) / 10 : null,
    kind: room.practice ? 'Practice' : 'Casual',
  });
  try { localStorage.setItem(LOCAL_RACES_KEY, JSON.stringify(list.slice(0, 30))); } catch (e) { /* storage can be blocked */ }
  renderRaceHistory();
}

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
    const res = await apiGet('/api/races?offset=' + (reset ? 0 : races_.items.length));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const page = await res.json();
    races_.items = reset ? page.items : races_.items.concat(page.items);
    races_.hasMore = page.hasMore;
  } catch (e) {
  }
  races_.loading = false;
  renderRaceHistory();
}

async function loadStats() {
  loadRaceHistory(true);
  if (!supa) return;
  try {
    const both = await Promise.all([apiGet('/api/stats'), apiGet('/api/leaderboard?limit=20')]);
    if (!both[0].ok || !both[1].ok) throw new Error('HTTP ' + both[0].status + '/' + both[1].status);
    const stats = await both[0].json();
    const board = await both[1].json();
    renderStats(stats, board.items);
  } catch (e) {
  }
}

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

async function loadHistory(reset) {
  if (history_.loading) return;
  history_.loading = true;
  $('ledgerMore').disabled = true;
  const type = history_.type;
  try {
    const res = await apiGet('/api/wallet/transactions?offset=' + (reset ? 0 : history_.items.length) + '&type=' + encodeURIComponent(type));
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

function refreshChip() {
  const casual = state.room && state.room.ranked === false;
  $('walletChip').hidden = !state.account || !!casual;
}

function onResult(result) {
  state.result = result;
  loadRaceHistory(true); // the race has just been saved: refresh the history
  if (state.room) render();
}

function initAccountUi() {
  $('raceMore').addEventListener('click', function () { loadRaceHistory(false); });
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
}
