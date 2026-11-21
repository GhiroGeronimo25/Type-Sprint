'use strict';
// REST API: sign-up, login, token refresh, logout and profile. Passwords only ever go to Supabase Auth.

module.exports = function (app, accounts, requireLogin) {
  const USERNAME_RE = /^[A-Za-z0-9_.-]{3,16}$/;
  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
  const authHits = {}; // 'ip path' -> [timestamps]: the logged-out endpoints can be guessed at, so they get a stricter limit
  const AUTH_LIMIT = Number(process.env.AUTH_LIMIT) || 10;   // tries ...
  const AUTH_WINDOW_MS = Number(process.env.AUTH_WINDOW_MS) || 60000; // ... per minute, per address and endpoint

  function authLimit(req, res, next) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const key = ip + ' ' + (req.path || '');
    const now = Date.now();
    const hits = (authHits[key] || []).filter(function (t) { return now - t < AUTH_WINDOW_MS; });
    if (hits.length >= AUTH_LIMIT) return res.status(429).json({ error: 'Too many attempts. Wait a minute, then try again.' });
    hits.push(now);
    authHits[key] = hits;
    next();
  }
  setInterval(function () {
    const now = Date.now();
    Object.keys(authHits).forEach(function (k) {
      authHits[k] = authHits[k].filter(function (t) { return now - t < AUTH_WINDOW_MS; });
      if (authHits[k].length === 0) delete authHits[k];
    });
  }, 60000).unref();

  const AUTH_ERRORS = { // what accounts.js reports -> [status, what the caller is told]
    invalid_credentials: [401, 'Incorrect email or password.'],
    email_taken: [409, 'That email already has an account.'],
    username_taken: [409, 'That username is taken.'],
    weak_password: [422, 'That password is too weak.'],
    unconfirmed: [403, 'Your email isn\u2019t confirmed yet.'],
    invalid_refresh: [401, 'Your session expired. Please log in again.'],
    rate_limited: [429, 'Too many attempts. Try again later.'],
    not_configured: [503, 'Login isn\u2019t available right now. Please try again later.'],
  };

  function authFail(res, what, e) {
    const known = AUTH_ERRORS[e && e.code];
    if (known) return res.status(known[0]).json({ error: known[1] });
    console.error(what + ' failed:', e && e.message); // never the password or tokens: they are not in the message
    res.status(502).json({ error: 'We couldn\u2019t reach the login service. Please try again in a moment.' });
  }

  function cleanEmail(v) {
    return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v.trim()) ? v.trim() : '';
  }

  app.post('/api/auth/signup', authLimit, async function (req, res) {
    const body = req.body || {};
    const email = cleanEmail(body.email);
    if (!email) return res.status(400).json({ error: 'That email doesn\u2019t look right. Check it for typos.' });
    if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 72) {
      return res.status(400).json({ error: 'Your password must be 8 to 72 characters.' });
    }
    if (typeof body.username !== 'string' || !USERNAME_RE.test(body.username)) {
      return res.status(400).json({ error: 'Usernames use 3 to 16 letters, numbers, dots, dashes or underscores.' });
    }
    try {
      if (!(await accounts.usernameAvailable(body.username))) return res.status(409).json({ error: 'That username is taken. Try another one.' });
      const out = await accounts.signUp(email, body.password, body.username, typeof body.redirectTo === 'string' ? body.redirectTo.slice(0, 200) : '');
      res.status(201).json(out.session ? out : { user: out.user, session: null, message: 'Account created. Check your email to confirm it, then log in.' });
    } catch (e) {
      authFail(res, 'Sign-up', e);
    }
  });

  app.post('/api/auth/login', authLimit, async function (req, res) {
    const body = req.body || {};
    const email = cleanEmail(body.email);
    if (!email || typeof body.password !== 'string' || body.password.length === 0 || body.password.length > 72) {
      return res.status(401).json({ error: AUTH_ERRORS.invalid_credentials[1] });
    }
    try {
      res.json(await accounts.signIn(email, body.password));
    } catch (e) {
      authFail(res, 'Login', e);
    }
  });

  app.post('/api/auth/refresh', authLimit, async function (req, res) {
    const token = (req.body || {}).refreshToken;
    if (typeof token !== 'string' || token.length === 0 || token.length > 500) return res.status(400).json({ error: 'Send your refreshToken.' });
    try {
      res.json(await accounts.refreshSession(token));
    } catch (e) {
      authFail(res, 'Refresh', e);
    }
  });

  app.post('/api/auth/logout', requireLogin, async function (req, res) {
    try {
      await accounts.signOut(req.token);
      res.json({ ok: true });
    } catch (e) {
      authFail(res, 'Logout', e);
    }
  });

  app.get('/api/auth/me', requireLogin, async function (req, res) {
    try {
      const view = await accounts.view(req.user.id);
      res.json({
        username: req.user.username, email: req.user.email,
        rating: view ? view.rating : 1000, coins: view ? view.coins : 0, races: view ? view.races : 0, wins: view ? view.wins : 0,
      });
    } catch (e) {
      authFail(res, 'Profile', e);
    }
  });

};
