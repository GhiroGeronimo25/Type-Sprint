'use strict';

// Coins, ratings and race pots live in Supabase (Postgres). All the money logic is in SQL functions
// (see supabase/migrations/001_init.sql); each one runs as a single database transaction, so this file
// only calls them. Use the service_role key and keep it on the server.

const { createClient } = require('@supabase/supabase-js');

const ENTRY_FEE = 50;

function createAccounts(url, serviceKey, anonKey) {
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set (see .env.example)');
  }
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  async function call(fn, args) {
    const res = await db.rpc(fn, args);
    if (res.error) throw new Error(fn + ' failed: ' + res.error.message);
    return res.data;
  }

  // for operations that are safe to repeat (refunds): retry a few times before giving up
  async function callWithRetry(fn, args) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await call(fn, args);
      } catch (e) {
        lastError = e;
        await new Promise(function (resolve) { setTimeout(resolve, 300 * attempt); });
      }
    }
    throw lastError;
  }

  // Checks a Supabase access token (the JWT the browser got when logging in) and returns
  // { id, email } for that user, or null if the token is missing, forged or expired.
  async function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const res = await db.auth.getUser(token);
    if (res.error || !res.data || !res.data.user) return null;
    const meta = res.data.user.user_metadata || {};
    return { id: res.data.user.id, email: res.data.user.email || '', username: typeof meta.username === 'string' ? meta.username : '' };
  }

  // true if nobody has this username yet (case-insensitive). Used by the sign-up form.
  async function usernameAvailable(name) {
    const pattern = String(name).replace(/[\\%_]/g, function (c) { return '\\' + c; }); // ilike treats % and _ as wildcards
    const res = await db.from('accounts').select('pid').ilike('name', pattern).limit(1);
    if (res.error) throw new Error('username check failed: ' + res.error.message);
    return res.data.length === 0;
  }

  // ---------- REST authentication ----------
  // Sign-up and login go through Supabase Auth with the ANON key, on a fresh client for every call. A client keeps
  // the session of whoever signed in on it, so the privileged service-role client above must never be used for this.
  // Failures throw an Error with a short .code that server.js turns into a status and a safe message.
  function authClient() {
    if (!anonKey) { const e = new Error('SUPABASE_ANON_KEY is not set'); e.code = 'not_configured'; throw e; }
    return createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  }

  function authError(error) {
    const text = String((error && (error.code || error.message)) || '');
    let code = 'auth_failed';
    if (/invalid_credentials|invalid login/i.test(text)) code = 'invalid_credentials';
    else if (/user_already_exists|already registered|already been registered/i.test(text)) code = 'email_taken';
    else if (/weak_password|password/i.test(text) && !/invalid login/i.test(text)) code = 'weak_password';
    else if (/rate_limit|rate limit|too many/i.test(text) || (error && error.status === 429)) code = 'rate_limited';
    else if (/email_not_confirmed|not confirmed/i.test(text)) code = 'unconfirmed';
    else if (/refresh_token|session_not_found|invalid.*token/i.test(text)) code = 'invalid_refresh';
    const e = new Error('auth: ' + text);
    e.code = code;
    return e;
  }

  function sessionView(s) {
    if (!s) return null;
    return { accessToken: s.access_token, refreshToken: s.refresh_token, tokenType: 'Bearer', expiresIn: s.expires_in, expiresAt: s.expires_at };
  }

  function userView(u) {
    const meta = (u && u.user_metadata) || {};
    return { email: (u && u.email) || '', username: typeof meta.username === 'string' ? meta.username : '' };
  }

  // creates the login; the database trigger creates the game account (with the welcome coins) from the username.
  // Resolves to { user, session } where session is null when the project needs the email confirmed first.
  async function signUp(email, password, username, redirectTo) {
    const options = { data: { username: username } };
    if (redirectTo) options.emailRedirectTo = redirectTo; // Supabase only accepts addresses on its allowed list
    const res = await authClient().auth.signUp({ email: email, password: password, options: options });
    if (res.error) {
      const e = authError(res.error);
      // "Database error saving new user" is what a username that was taken a moment ago looks like
      if (e.code === 'auth_failed' && /database error/i.test(String(res.error.message)) && !(await usernameAvailable(username))) e.code = 'username_taken';
      throw e;
    }
    // an email that is already registered comes back as a fake user with no identities: report it as taken
    const made = res.data && res.data.user;
    if (made && Array.isArray(made.identities) && made.identities.length === 0) {
      const e = new Error('auth: user_already_exists');
      e.code = 'email_taken';
      throw e;
    }
    return { user: userView(res.data.user), session: sessionView(res.data.session) };
  }

  // Creates the login already confirmed. Called only after the person clicked the link in their email, so nothing
  // about a sign-up is stored in Supabase before that. The database trigger makes the game account from the username.
  async function createConfirmedUser(email, password, username) {
    const res = await db.auth.admin.createUser({ email: email, password: password, email_confirm: true, user_metadata: { username: username } });
    if (res.error) {
      const text = String(res.error.code || res.error.message || '');
      const e = new Error('auth: ' + text);
      if (/email_exists|already (been )?registered|user_already_exists/i.test(text) || /already (been )?registered/i.test(String(res.error.message))) e.code = 'email_taken';
      else if (/weak_password/i.test(text)) e.code = 'weak_password';
      else {
        e.code = 'auth_failed';
        // "Database error creating new user" is what a username that was taken a moment ago looks like
        if (/database error/i.test(String(res.error.message)) && !(await usernameAvailable(username))) e.code = 'username_taken';
      }
      throw e;
    }
    return { id: res.data.user.id, email: res.data.user.email };
  }

  async function signIn(email, password) {
    const res = await authClient().auth.signInWithPassword({ email: email, password: password });
    if (res.error) throw authError(res.error);
    return { user: userView(res.data.user), session: sessionView(res.data.session) };
  }

  // trades a refresh token for a new session (refresh tokens are single-use: keep the new one)
  async function refreshSession(refreshToken) {
    const res = await authClient().auth.refreshSession({ refresh_token: refreshToken });
    if (res.error || !res.data || !res.data.session) throw authError(res.error || { code: 'refresh_token_not_found' });
    return { user: userView(res.data.user), session: sessionView(res.data.session) };
  }

  // revokes the login behind this access token everywhere, so its refresh token stops working too
  async function signOut(accessToken) {
    const res = await db.auth.admin.signOut(accessToken, 'global');
    if (res.error && !/session_not_found|invalid/i.test(String(res.error.code || res.error.message))) throw authError(res.error);
  }

  // Removes sign-ups that never confirmed their email once they are older than maxAgeMs, so an unconfirmed
  // email address is not kept. Resolves to how many were removed.
  async function purgeUnconfirmed(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    const stale = [];
    for (let page = 1; page <= 100; page++) {
      const res = await db.auth.admin.listUsers({ page: page, perPage: 200 });
      if (res.error) throw new Error('listing users failed: ' + res.error.message);
      const users = (res.data && res.data.users) || [];
      users.forEach(function (u) {
        if (u.email && !u.email_confirmed_at && !u.confirmed_at && Date.parse(u.created_at) < cutoff) stale.push(u.id);
      });
      if (users.length < 200) break;
    }
    let removed = 0;
    for (let i = 0; i < stale.length; i++) { // collected first: deleting while paging would skip people
      const del = await db.auth.admin.deleteUser(stale[i]);
      if (del.error) console.error('Could not remove unconfirmed user ' + stale[i] + ':', del.error.message);
      else {
        removed++;
        // older sign-ups also got a game account from the database trigger: remove it so the username is free again
        const acc = await db.from('accounts').delete().eq('pid', stale[i]);
        if (acc.error) console.error('Could not remove game account for ' + stale[i] + ':', acc.error.message);
      }
    }
    return removed;
  }

  function withFee(view) {
    if (view) view.entryFee = ENTRY_FEE;
    return view;
  }

  // creates the account on first visit (with the welcome coins) and returns it
  async function join(pid, name) {
    return withFee(await call('join_account', { p_pid: pid, p_name: name }));
  }

  // null if there is no such account
  async function view(pid) {
    return withFee(await call('account_view', { p_pid: pid }));
  }

  // Entry fees -> race pot in ONE transaction. Resolves to { entered: [pid], pot }.
  // Racers who can't pay are left out; if anything fails nobody is charged.
  async function collectEntries(code, pids, fee) {
    return call('collect_entries', { p_code: code, p_pids: pids, p_fee: fee });
  }

  // a racer leaves before the start: their fee goes back from the pot. Resolves to what is left in it.
  async function refundEntry(code, pid) {
    return callWithRetry('refund_entry', { p_code: code, p_pid: pid });
  }

  // race cancelled: everyone still in the pot gets their fee back
  async function voidPot(code) {
    return callWithRetry('void_pot', { p_code: code });
  }

  // at server start: return the pots of races that were running when the server stopped
  async function voidAllPots() {
    return call('void_all_pots', {});
  }

  // Ends one ranked race in ONE transaction: the pot is split by placement (60/30/10), every rating is
  // updated, the results are saved and the pot is closed. If any step fails, none of it happens.
  // ranked: [{ pid, active, name, wpm, accuracy, finished, progress, seconds }] in finishing order.
  // Resolves to { [pid]: { rank, payout, net, ratingBefore, ratingAfter, ratingDelta } }
  async function settle(code, ranked, text) {
    return call('settle_race', { p_code: code, p_ranked: ranked, p_text: text || '' });
  }

  // the latest saved ranked races, newest first
  async function recentResults(limit) {
    const res = await db.from('race_results')
      .select('id, room, ranked, text, ended_at, race_result_players(rank, name, wpm, accuracy, finished, progress, seconds, payout)')
      .order('id', { ascending: false })
      .limit(limit || 50);
    if (res.error) throw new Error('race_results query failed: ' + res.error.message);
    return res.data.map(function (r) {
      const players = r.race_result_players.slice().sort(function (a, b) { return a.rank - b.rank; });
      return {
        room: r.room, ranked: r.ranked, endedAt: r.ended_at, text: r.text,
        players: players.map(function (p) {
          return { rank: p.rank, coins: p.payout, name: p.name, wpm: p.wpm, accuracy: Number(p.accuracy),
                   finished: p.finished, progress: Number(p.progress), seconds: p.seconds === null ? null : Number(p.seconds) };
        }),
      };
    });
  }

  // Saves how everyone typed in a finished race (and any anti-cheat flags) in one transaction.
  // players: [{ pid, wpm, accuracy, progress, finished, missed: { char: count }, flags: [{ reason, count, detail }] }]
  async function recordRaceStats(code, ranked, difficulty, players) {
    return call('record_race_stats', { p_code: code, p_ranked: ranked, p_difficulty: difficulty, p_players: players });
  }

  // One page of a player's coin history, newest first. type (optional): grant, entry, refund or reward.
  // Resolves to { items: [{ id, at, type, amount, balance, room }], hasMore }
  async function ledgerPage(pid, offset, limit, type) {
    let q = db.from('ledger').select('id, at, type, amount, balance, room').eq('pid', pid).order('id', { ascending: false });
    if (type) q = q.eq('type', type);
    const res = await q.range(offset, offset + limit); // one extra row tells us whether there is more
    if (res.error) throw new Error('ledger query failed: ' + res.error.message);
    return { items: res.data.slice(0, limit), hasMore: res.data.length > limit };
  }

  // One page of a player's ranked race history, newest first (their own row of each race).
  // Resolves to { items: [{ id, room, ranked, endedAt, rank, wpm, accuracy, finished, progress, seconds, payout, net, ratingBefore, ratingAfter }], hasMore }
  async function raceHistory(pid, offset, limit) {
    const res = await db.from('race_result_players')
      .select('result_id, rank, wpm, accuracy, finished, progress, seconds, payout, net, rating_before, rating_after, race_results!inner(room, ranked, ended_at)')
      .eq('pid', pid)
      .order('result_id', { ascending: false })
      .range(offset, offset + limit); // one extra row tells us whether there is more
    if (res.error) throw new Error('race history query failed: ' + res.error.message);
    const items = res.data.slice(0, limit).map(function (r) {
      return {
        id: r.result_id, room: r.race_results.room, ranked: r.race_results.ranked, endedAt: r.race_results.ended_at,
        rank: r.rank, wpm: r.wpm, accuracy: Number(r.accuracy), finished: r.finished, progress: Number(r.progress),
        seconds: r.seconds === null ? null : Number(r.seconds), payout: r.payout, net: r.net,
        ratingBefore: r.rating_before, ratingAfter: r.rating_after,
      };
    });
    return { items: items, hasMore: res.data.length > limit };
  }

  // One race with everybody's standings. null unless this player took part in it. Never contains a pid.
  async function raceDetail(pid, id) {
    const mine = await db.from('race_result_players').select('result_id').eq('pid', pid).eq('result_id', id).limit(1);
    if (mine.error) throw new Error('race detail query failed: ' + mine.error.message);
    if (!mine.data.length) return null;
    const res = await db.from('race_results')
      .select('id, room, ranked, text, ended_at, race_result_players(rank, name, wpm, accuracy, finished, progress, seconds, payout, net, rating_before, rating_after)')
      .eq('id', id).single();
    if (res.error) throw new Error('race detail query failed: ' + res.error.message);
    const players = res.data.race_result_players.slice().sort(function (a, b) { return a.rank - b.rank; }).map(function (p) {
      return {
        rank: p.rank, name: p.name, wpm: p.wpm, accuracy: Number(p.accuracy), finished: p.finished, progress: Number(p.progress),
        seconds: p.seconds === null ? null : Number(p.seconds), payout: p.payout, net: p.net,
        ratingBefore: p.rating_before, ratingAfter: p.rating_after,
      };
    });
    return { id: res.data.id, room: res.data.room, ranked: res.data.ranked, endedAt: res.data.ended_at, text: res.data.text, players: players };
  }

  // best and average WPM, accuracy trend (last 20 races, oldest first) and the 5 most-missed characters
  async function playerStats(pid) {
    return call('player_stats', { p_pid: pid });
  }

  // ranked players by rating; the row of the player asking (pid) is marked isYou. Never contains a pid.
  async function leaderboard(limit, pid) {
    return call('leaderboard', { p_limit: limit || 20, p_pid: pid || null });
  }

  return {
    verifyToken: verifyToken, purgeUnconfirmed: purgeUnconfirmed, signUp: signUp, createConfirmedUser: createConfirmedUser, signIn: signIn, refreshSession: refreshSession, signOut: signOut, ledgerPage: ledgerPage, raceHistory: raceHistory, raceDetail: raceDetail, usernameAvailable: usernameAvailable, join: join, view: view,
    recordRaceStats: recordRaceStats, playerStats: playerStats, leaderboard: leaderboard,
    collectEntries: collectEntries, refundEntry: refundEntry, voidPot: voidPot, voidAllPots: voidAllPots,
    settle: settle, recentResults: recentResults, ENTRY_FEE: ENTRY_FEE,
  };
}

module.exports = createAccounts;
