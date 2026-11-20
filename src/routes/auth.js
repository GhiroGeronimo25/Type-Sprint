// REST API: authentication
const { USERNAME_RE } = require('../config');
const { app, accounts } = require('../core');
const S = require('../shared');
const requireLogin = function () { return S.requireLogin.apply(this, arguments); };

// ---------- REST API: authentication ----------
// POST /api/auth/signup   { email, password, username }  -> 201 { user: { email, username }, session }   (session is null when the email must be confirmed first)
// POST /api/auth/login    { email, password }            -> 200 { user, session }
// POST /api/auth/refresh  { refreshToken }               -> 200 { user, session }   (refresh tokens are single use: keep the new one)
// POST /api/auth/logout   (logged in)                    -> 200 { ok: true }        (revokes the login everywhere)
// GET  /api/auth/me       (logged in)                    -> 200 { username, email, rating, coins, races, wins }
// session = { accessToken, refreshToken, tokenType: 'Bearer', expiresIn, expiresAt }. Send accessToken as "Authorization: Bearer ...".
// Passwords are only ever sent to Supabase Auth: this server never stores or logs them.
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const authHits = {}; // 'ip path' -> [timestamps]: the logged-out endpoints can be guessed at, so they get a stricter limit
const AUTH_LIMIT = Number(process.env.AUTH_LIMIT) || 10;   // tries ...
const AUTH_WINDOW_MS = Number(process.env.AUTH_WINDOW_MS) || 60000; // ... per minute, per address and endpoint

function authLimit(req, res, next) {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  const key = ip + ' ' + (req.path || '');
  const now = Date.now();
  const hits = (authHits[key] || []).filter(function (t) { return now - t < AUTH_WINDOW_MS; });
  if (hits.length >= AUTH_LIMIT) return res.status(429).json({ error: 'Too many attempts. Wait a minute and try again.' });
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
  invalid_credentials: [401, 'Wrong email or password.'],
  email_taken: [409, 'That email already has an account.'],
  username_taken: [409, 'That username is taken.'],
  weak_password: [422, 'That password is too weak. Use at least 8 characters.'],
  unconfirmed: [403, 'Confirm your email first, then log in.'],
  invalid_refresh: [401, 'Your login has expired. Log in again.'],
  rate_limited: [429, 'Too many attempts. Wait a minute and try again.'],
  not_configured: [503, 'Login is not set up on this server.'],
};

function authFail(res, what, e) {
  const known = AUTH_ERRORS[e && e.code];
  if (known) return res.status(known[0]).json({ error: known[1] });
  console.error(what + ' failed:', e && e.message); // never the password or tokens: they are not in the message
  res.status(502).json({ error: 'Could not reach the login service. Please try again.' });
}

function cleanEmail(v) {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v.trim()) ? v.trim() : '';
}

app.post('/api/auth/signup', authLimit, async function (req, res) {
  const body = req.body || {};
  const email = cleanEmail(body.email);
  if (!email) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (typeof body.password !== 'string' || body.password.length < 8 || body.password.length > 72) {
    return res.status(400).json({ error: 'The password must be 8 to 72 characters.' });
  }
  if (typeof body.username !== 'string' || !USERNAME_RE.test(body.username)) {
    return res.status(400).json({ error: 'Username: 3-16 letters, numbers, dots, dashes or underscores.' });
  }
  try {
    if (!(await accounts.usernameAvailable(body.username))) return res.status(409).json({ error: 'That username is taken.' });
    const out = await accounts.signUp(email, body.password, body.username);
    res.status(201).json(out.session ? out : { user: out.user, session: null, message: 'Check your email to confirm your account, then log in.' });
  } catch (e) {
    authFail(res, 'Sign-up', e);
  }
});

app.post('/api/auth/login', authLimit, async function (req, res) {
  const body = req.body || {};
  const email = cleanEmail(body.email);
  // the same answer for a bad email and a bad password: nobody can use this to find out who has an account
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

Object.assign(S, { authLimit, authFail, cleanEmail });
