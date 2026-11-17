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

  // Pays out one finished race from its pot, in ONE transaction (prizes, ratings, closing the pot).
  // ranked: [{ pid, active }] in finishing order. Resolves to { [pid]: { rank, payout, net, ratingBefore, ratingAfter, ratingDelta } }
  async function settle(code, ranked) {
    return call('settle_race', { p_code: code, p_ranked: ranked });
  }

  return {
    join: join, view: view,
    collectEntries: collectEntries, refundEntry: refundEntry, voidPot: voidPot, voidAllPots: voidAllPots,
    settle: settle, ENTRY_FEE: ENTRY_FEE,
  };
}

module.exports = createAccounts;
