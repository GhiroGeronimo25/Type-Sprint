'use strict';

// Coins, ratings and race pots live in Supabase (Postgres). All the money logic is in SQL functions
// (see supabase/migrations/001_init.sql); each one runs as a single database transaction, so this file
// only calls them. Use the service_role key and keep it on the server.

const { createClient } = require('@supabase/supabase-js');

const ENTRY_FEE = 50;

function createAccounts(url, serviceKey) {
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

  // best and average WPM, accuracy trend (last 20 races, oldest first) and the 5 most-missed characters
  async function playerStats(pid) {
    return call('player_stats', { p_pid: pid });
  }

  // ranked players by rating; the row of the player asking (pid) is marked isYou. Never contains a pid.
  async function leaderboard(limit, pid) {
    return call('leaderboard', { p_limit: limit || 20, p_pid: pid || null });
  }

  return {
    verifyToken: verifyToken, ledgerPage: ledgerPage, usernameAvailable: usernameAvailable, join: join, view: view,
    recordRaceStats: recordRaceStats, playerStats: playerStats, leaderboard: leaderboard,
    collectEntries: collectEntries, refundEntry: refundEntry, voidPot: voidPot, voidAllPots: voidAllPots,
    settle: settle, recentResults: recentResults, ENTRY_FEE: ENTRY_FEE,
  };
}

module.exports = createAccounts;
