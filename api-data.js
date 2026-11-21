'use strict';
// REST API: wallet, race history, stats, leaderboard and the passage bank. Every route except the passage bank
// needs the login token (Authorization: Bearer <token>); the player is always the logged-in user.

module.exports = function (app, accounts, passages) {
  function pageParams(req) {
    const q = req.query || {};
    return {
      offset: Math.min(Math.max(parseInt(q.offset, 10) || 0, 0), 10000),
      limit: Math.min(Math.max(parseInt(q.limit, 10) || 20, 1), 50),
    };
  }

  function respond(res, promise, failMessage, shape) {
    promise.then(function (data) { res.json(shape ? shape(data) : data); }).catch(function (e) {
      console.error(failMessage + ':', e.message);
      res.status(500).json({ error: failMessage + '.' });
    });
  }

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

  app.get('/api/wallet', requireLogin, function (req, res) {
    accounts.view(req.user.id).then(function (view) {
      if (!view) return res.status(404).json({ error: 'No game account yet. Join a room first.' });
      res.json(view);
    }).catch(function (e) {
      console.error('Could not load wallet:', e.message);
      res.status(500).json({ error: 'Could not load your wallet.' });
    });
  });

  app.get('/api/wallet/transactions', requireLogin, function (req, res) {
    const page = pageParams(req);
    const type = ['grant', 'entry', 'refund', 'reward'].indexOf((req.query || {}).type) >= 0 ? req.query.type : '';
    respond(res, accounts.ledgerPage(req.user.id, page.offset, page.limit, type), 'Could not load your transactions', function (r) {
      return { items: r.items, hasMore: r.hasMore, offset: page.offset, limit: page.limit };
    });
  });

  // ---------- REST API: race history ----------
  app.get('/api/races', requireLogin, function (req, res) {
    const page = pageParams(req);
    respond(res, accounts.raceHistory(req.user.id, page.offset, page.limit), 'Could not load your race history', function (r) {
      return { items: r.items, hasMore: r.hasMore, offset: page.offset, limit: page.limit };
    });
  });

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
  app.get('/api/stats', requireLogin, function (req, res) {
    respond(res, accounts.playerStats(req.user.id), 'Could not load your stats');
  });

  app.get('/api/leaderboard', requireLogin, function (req, res) {
    const limit = Math.min(Math.max(parseInt((req.query || {}).limit, 10) || 20, 1), 50);
    respond(res, accounts.leaderboard(limit, req.user.id), 'Could not load the leaderboard', function (rows) { return { items: rows }; });
  });

  // ---------- REST API: passage bank (public, read-only) ----------
  app.get('/api/passages', function (req, res) {
    res.json({ default: passages.DEFAULT_DIFFICULTY, difficulties: passages.summary() });
  });

  app.get('/api/passages/:difficulty', function (req, res) {
    const level = String((req.params || {}).difficulty || '').toLowerCase();
    const items = passages.describe(level);
    if (!items) return res.status(404).json({ error: 'Unknown difficulty. Use easy, medium or hard.' });
    res.json({ difficulty: level, items: items });
  });


  return { requireLogin: requireLogin };
};
