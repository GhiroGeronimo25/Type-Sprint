// REST API: wallet, race history, stats, leaderboard and the passage bank
const passages = require('../../passages');
const { app, accounts } = require('../core');
const S = require('../shared');

// ---------- REST API: wallet and transaction history ----------
// Send the Supabase access token as:  Authorization: Bearer <token>
// The player is always the logged-in user; there is no way to ask for somebody else's wallet.
const apiLastCall = {}; // user id -> time of the last call (a simple rate limit)

function requireLogin(req, res, next) {
  const match = /^Bearer (.+)$/.exec(String((req.headers || {}).authorization || ''));
  if (!match) return res.status(401).json({ error: 'Log in first (missing Bearer token).' });
  accounts.verifyToken(match[1]).then(function (user) {
    if (!user) return res.status(401).json({ error: 'Your login is invalid or expired.' });
    const now = Date.now();
    const key = user.id + ' ' + (req.path || ''); // the limit is per user and per endpoint
    if (apiLastCall[key] && now - apiLastCall[key] < 200) return res.status(429).json({ error: 'Too many requests.' });
    apiLastCall[key] = now;
    req.user = user;
    req.token = match[1]; // kept so POST /api/auth/logout can revoke it
    next();
  }).catch(function (e) {
    console.error('Login check failed:', e.message);
    res.status(401).json({ error: 'Your login is invalid or expired.' });
  });
}
setInterval(function () { // forget old entries so the table cannot grow forever
  const cutoff = Date.now() - 60000;
  Object.keys(apiLastCall).forEach(function (id) { if (apiLastCall[id] < cutoff) delete apiLastCall[id]; });
}, 60000).unref();

// GET /api/wallet -> { coins, rating, races, wins, entryFee, ledger: [latest 10] }
app.get('/api/wallet', requireLogin, function (req, res) {
  accounts.view(req.user.id).then(function (view) {
    if (!view) return res.status(404).json({ error: 'No game account yet. Join a room first.' });
    res.json(view);
  }).catch(function (e) {
    console.error('Could not load wallet:', e.message);
    res.status(500).json({ error: 'Could not load your wallet.' });
  });
});

// GET /api/wallet/transactions?offset=0&limit=20&type=reward
//   type (optional): grant, entry, refund or reward.  limit: 1-50 (default 20).
//   -> { items: [{ id, at, type, amount, balance, room }], hasMore, offset, limit }
app.get('/api/wallet/transactions', requireLogin, function (req, res) {
  const q = req.query || {};
  const offset = Math.min(Math.max(parseInt(q.offset, 10) || 0, 0), 10000);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 50);
  const type = ['grant', 'entry', 'refund', 'reward'].indexOf(q.type) >= 0 ? q.type : '';
  accounts.ledgerPage(req.user.id, offset, limit, type).then(function (page) {
    res.json({ items: page.items, hasMore: page.hasMore, offset: offset, limit: limit });
  }).catch(function (e) {
    console.error('Could not load transactions:', e.message);
    res.status(500).json({ error: 'Could not load your transactions.' });
  });
});

// ---------- REST API: race history ----------
// GET /api/races?offset=0&limit=20 -> your ranked races, newest first
//   -> { items: [{ id, room, ranked, endedAt, rank, wpm, accuracy, finished, progress, seconds, payout, net, ratingBefore, ratingAfter }], hasMore, offset, limit }
app.get('/api/races', requireLogin, function (req, res) {
  const q = req.query || {};
  const offset = Math.min(Math.max(parseInt(q.offset, 10) || 0, 0), 10000);
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 50);
  accounts.raceHistory(req.user.id, offset, limit).then(function (page) {
    res.json({ items: page.items, hasMore: page.hasMore, offset: offset, limit: limit });
  }).catch(function (e) {
    console.error('Could not load race history:', e.message);
    res.status(500).json({ error: 'Could not load your race history.' });
  });
});

// GET /api/races/:id -> one race with every racer's standing. Only for races you took part in.
app.get('/api/races/:id', requireLogin, function (req, res) {
  const id = String((req.params || {}).id || '');
  if (!/^[0-9]{1,15}$/.test(id)) return res.status(400).json({ error: 'Bad race id.' });
  accounts.raceDetail(req.user.id, Number(id)).then(function (race) {
    if (!race) return res.status(404).json({ error: 'No such race in your history.' });
    res.json(race);
  }).catch(function (e) {
    console.error('Could not load race:', e.message);
    res.status(500).json({ error: 'Could not load that race.' });
  });
});

// ---------- REST API: stats and leaderboard ----------
// GET /api/stats -> your own stats: { races, flaggedRaces, bestWpm, avgWpm, trend: [...], mostMissed: [{ ch, misses }] }
app.get('/api/stats', requireLogin, function (req, res) {
  accounts.playerStats(req.user.id).then(function (stats) {
    res.json(stats);
  }).catch(function (e) {
    console.error('Could not load stats:', e.message);
    res.status(500).json({ error: 'Could not load your stats.' });
  });
});

// GET /api/leaderboard?limit=20 -> ranked players by rating (limit 1-50, default 20). Your own row has isYou: true.
//   -> { items: [{ name, rating, races, wins, bestWpm, isYou }] }. Never contains a pid.
app.get('/api/leaderboard', requireLogin, function (req, res) {
  const limit = Math.min(Math.max(parseInt((req.query || {}).limit, 10) || 20, 1), 50);
  accounts.leaderboard(limit, req.user.id).then(function (rows) {
    res.json({ items: rows });
  }).catch(function (e) {
    console.error('Could not load leaderboard:', e.message);
    res.status(500).json({ error: 'Could not load the leaderboard.' });
  });
});

// ---------- REST API: passage bank (public, read-only) ----------
// The bank is described, never handed out: no endpoint returns a passage's full text, so nobody can read
// the text before a race. The server alone picks the passage for each race.
// GET /api/passages -> { default, difficulties: [{ difficulty, description, count, avgWords, avgCharacters, minCharacters, maxCharacters }] }
app.get('/api/passages', function (req, res) {
  res.json({ default: passages.DEFAULT_DIFFICULTY, difficulties: passages.summary() });
});

// GET /api/passages/:difficulty -> { difficulty, items: [{ id, words, characters, preview }] }   (easy, medium or hard)
app.get('/api/passages/:difficulty', function (req, res) {
  const level = String((req.params || {}).difficulty || '').toLowerCase();
  const items = passages.describe(level);
  if (!items) return res.status(404).json({ error: 'Unknown difficulty. Use easy, medium or hard.' });
  res.json({ difficulty: level, items: items });
});

Object.assign(S, { requireLogin });
