'use strict';
// REST API: sign-up, login, token refresh, logout and profile. Passwords only ever go to Supabase Auth.

const mail = require('./confirm-mail');

module.exports = function (app, accounts, requireLogin) {
  const CONFIRM_TTL_MS = (Number(process.env.UNCONFIRMED_TTL_MIN) || 60) * 60000; // how long the emailed link works
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
      if (!mail.configured()) { const e = new Error('mail not configured'); e.code = 'not_configured'; throw e; }
      // nothing is saved yet: the details ride inside the emailed link and the account is made when it is clicked
      const token = mail.makeToken(email, body.password, body.username, CONFIRM_TTL_MS);
      const base = process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'));
      await mail.sendConfirmation(email, body.username, base.replace(/\/+$/, '') + '/api/auth/confirm?token=' + encodeURIComponent(token), CONFIRM_TTL_MS);
      res.status(201).json({ user: { email: email, username: body.username }, session: null, message: 'Check your email to confirm your account, then log in.' });
    } catch (e) {
      authFail(res, 'Sign-up', e);
    }
  });

  function page(res, status, title, text) {
    const esc = function (v) { return String(v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
    res.status(status).type('html').send('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Type Sprint</title></head>'
      + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#2043f0;font-family:Arial,Helvetica,sans-serif;padding:16px;box-sizing:border-box;">'
      + '<div style="max-width:440px;width:100%;background:#fff;color:#0a0f2a;border:3px solid #0a0f2a;border-radius:14px;padding:32px 28px;text-align:center;">'
      + '<h1 style="margin:0 0 12px;font-size:24px;">' + esc(title) + '</h1><p style="margin:0 0 24px;font-size:16px;line-height:1.55;">' + esc(text) + '</p>'
      + '<a href="/" style="display:inline-block;padding:14px 32px;background:#ffd23f;border:3px solid #0a0f2a;border-radius:10px;color:#0a0f2a;font-weight:800;text-decoration:none;">Go to Type Sprint</a></div></body></html>');
  }

  // the link in the confirmation email: this is the moment the login and the game account are created
  app.get('/api/auth/confirm', authLimit, async function (req, res) {
    const info = mail.readToken(typeof req.query.token === 'string' ? req.query.token : '');
    if (info.error === 'expired') return page(res, 410, 'Link expired', 'This confirmation link ran out. Sign up again to get a new one.');
    if (info.error) return page(res, 400, 'Link not valid', 'This confirmation link doesn\u2019t look right. Try signing up again.');
    try {
      await accounts.createConfirmedUser(info.email, info.password, info.username);
      page(res, 200, 'Email confirmed!', 'Your account is ready. Go back to Type Sprint and log in.');
    } catch (e) {
      if (e && e.code === 'email_taken') return page(res, 200, 'Already confirmed', 'This email already has an account. Go back to Type Sprint and log in.');
      if (e && e.code === 'username_taken') return page(res, 409, 'Username taken', 'Someone took that username while you waited. Sign up again with a different one.');
      console.error('Confirm failed:', e && e.message);
      page(res, 502, 'Something went wrong', 'We couldn\u2019t create your account just now. Please try the link again in a moment.');
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
