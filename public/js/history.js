// Race history, stats and leaderboard
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
