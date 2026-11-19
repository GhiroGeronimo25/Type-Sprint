'use strict';
// Integration tests: they call the real SQL functions in a Supabase project.
// Run with:  TEST_SUPABASE=1 npm test   (needs SUPABASE_URL and SUPABASE_SERVICE_KEY in .env)
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const { createClient } = require('@supabase/supabase-js');
const createAccounts = require('../accounts');

const enabled = process.env.TEST_SUPABASE === '1' && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY;
const FEE = 50;
const run = Date.now().toString(36);
const pidOf = (n) => 't' + run + n;
const codeOf = (n) => ('T' + run + n).slice(-6).toUpperCase();

test('Supabase transactions', { skip: enabled ? false : 'set TEST_SUPABASE=1 to run' }, async (t) => {
  const acc = createAccounts(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const pids = [];
  const codes = [];
  const player = async (n) => { const pid = pidOf(n); pids.push(pid); await acc.join(pid, 'P' + n); return pid; };
  const coins = async (pid) => (await acc.view(pid)).coins;

  t.after(async () => {
    for (const c of codes) await db.from('pots').delete().eq('code', c);
    for (const c of codes) await db.from('race_results').delete().eq('room', c);  // players rows go with them
    for (const p of pids) {
      await db.from('cheat_flags').delete().eq('pid', p);
      await db.from('race_stats').delete().eq('pid', p);
      await db.from('ledger').delete().eq('pid', p);
      await db.from('accounts').delete().eq('pid', p);
    }
  });

  await t.test('new account gets the welcome coins', async () => {
    const a = await player('a');
    const v = await acc.view(a);
    assert.strictEqual(v.coins, 500);
    assert.strictEqual(v.rating, 1000);
    assert.strictEqual(v.ledger[0].type, 'grant');
  });

  await t.test('entry fees move into the pot together', async () => {
    const [a, b, c] = [await player('a'), await player('b'), await player('c')];
    const code = codeOf(1); codes.push(code);
    const res = await acc.collectEntries(code, [a, b, c], FEE);
    assert.strictEqual(res.pot, 150);
    assert.strictEqual(res.entered.length, 3);
    for (const p of [a, b, c]) assert.strictEqual(await coins(p), 450);
    await acc.voidPot(code);
    for (const p of [a, b, c]) assert.strictEqual(await coins(p), 500);
  });

  await t.test('a racer who cannot pay is left out', async () => {
    const rich = await player('rich');
    const poor = await player('poor');
    await db.from('accounts').update({ coins: 10 }).eq('pid', poor);
    const code = codeOf(2); codes.push(code);
    const res = await acc.collectEntries(code, [rich, poor], FEE);
    assert.deepStrictEqual(res.entered, [rich]);
    assert.strictEqual(await coins(poor), 10);
    await acc.voidPot(code);
  });

  await t.test('an existing pot makes the whole call roll back', async () => {
    const a = await player('a'); const b = await player('b');
    const code = codeOf(3); codes.push(code);
    await acc.collectEntries(code, [a], FEE);
    await assert.rejects(acc.collectEntries(code, [b], FEE));
    assert.strictEqual(await coins(b), 500);       // b was not charged
    await acc.voidPot(code);
  });

  await t.test('leaving during the countdown refunds from the pot, once', async () => {
    const a = await player('a'); const b = await player('b');
    const code = codeOf(4); codes.push(code);
    await acc.collectEntries(code, [a, b], FEE);
    assert.strictEqual(await acc.refundEntry(code, a), 50);
    assert.strictEqual(await acc.refundEntry(code, a), 50);   // second call does nothing
    assert.strictEqual(await coins(a), 500);
    assert.strictEqual(await acc.refundEntry(code, b), 0);    // pot closes when empty
    assert.strictEqual(await coins(b), 500);
  });

  await t.test('settle pays exactly the pot, conserves coins, closes the pot', async () => {
    const [a, b, c] = [await player('a'), await player('b'), await player('c')];
    const code = codeOf(5); codes.push(code);
    const before = (await coins(a)) + (await coins(b)) + (await coins(c));
    await acc.collectEntries(code, [a, b, c], FEE);
    const out = await acc.settle(code, [{ pid: a, active: true }, { pid: b, active: true }, { pid: c, active: true }]);
    assert.strictEqual(out[a].payout + out[b].payout + out[c].payout, 150);
    assert.strictEqual((await coins(a)) + (await coins(b)) + (await coins(c)), before);
    assert.ok(out[a].ratingAfter > out[a].ratingBefore);
    await assert.rejects(acc.settle(code, [{ pid: a, active: true }]));  // already paid out
  });

  await t.test('pot is split 60/30/10 and the results are saved in the same call', async () => {
    const [a, b, c] = [await player('a'), await player('b'), await player('c')];
    const code = codeOf(8); codes.push(code);
    await acc.collectEntries(code, [a, b, c], FEE);   // pot = 150
    const out = await acc.settle(code, [
      { pid: a, active: true, name: 'Ann', wpm: 70, accuracy: 98.5, finished: true, progress: 100, seconds: 41.2 },
      { pid: b, active: true, name: 'Bo', wpm: 55, accuracy: 95, finished: false, progress: 80, seconds: null },
      { pid: c, active: true, name: 'Cy', wpm: 30, accuracy: 90, finished: false, progress: 40, seconds: null },
    ], 'The passage text.');
    assert.deepStrictEqual([out[a].payout, out[b].payout, out[c].payout], [90, 45, 15]);

    const rows = await db.from('race_results').select('room, ranked, text, race_result_players(rank, pid, name, wpm, payout, net, rating_before, rating_after)').eq('room', code);
    assert.strictEqual(rows.data.length, 1);
    assert.strictEqual(rows.data[0].text, 'The passage text.');
    const players = rows.data[0].race_result_players.sort((x, y) => x.rank - y.rank);
    assert.deepStrictEqual(players.map((p) => p.name), ['Ann', 'Bo', 'Cy']);
    assert.deepStrictEqual(players.map((p) => p.payout), [90, 45, 15]);
    assert.strictEqual(players[0].rating_after, out[a].ratingAfter);

    const recent = await acc.recentResults(5);
    assert.ok(recent.some((r) => r.room === code && r.players[0].name === 'Ann'));
  });

  await t.test('a failed settle saves no results', async () => {
    const a = await player('a'); const x = await player('x');
    const code = codeOf(9); codes.push(code);
    await acc.collectEntries(code, [a], FEE);
    await assert.rejects(acc.settle(code, [{ pid: a, active: true, name: 'A' }, { pid: x, active: true, name: 'X' }], 'text'));
    const rows = await db.from('race_results').select('id').eq('room', code);
    assert.strictEqual(rows.data.length, 0);
    await acc.voidPot(code);
  });

  await t.test('nobody typed: no results are saved', async () => {
    const a = await player('a');
    const code = codeOf(10); codes.push(code);
    await acc.collectEntries(code, [a], FEE);
    await acc.settle(code, [{ pid: a, active: false, name: 'A' }], 'text');
    const rows = await db.from('race_results').select('id').eq('room', code);
    assert.strictEqual(rows.data.length, 0);
  });

  await t.test('coins are virtual only: the ledger has no way to record a purchase or a cash-out', async () => {
    const a = await player('a');
    for (const type of ['purchase', 'deposit', 'withdrawal', 'cashout']) {
      const res = await db.from('ledger').insert({ pid: a, type, amount: 1, balance: 1 });
      assert.ok(res.error, type + ' must be rejected by the database');
    }
    // only these four kinds of entry exist, and none of them is money in or out
    const ok = await db.from('ledger').select('type').eq('pid', a);
    assert.ok(ok.data.every((r) => ['grant', 'entry', 'refund', 'reward'].includes(r.type)));
  });

  await t.test('race stats: best/average WPM, accuracy trend and most-missed letters skip flagged races', async () => {
    const a = await player('statsA');
    const code = codeOf(11); codes.push(code);
    const race = (wpm, accuracy, missed, flags) => ({ pid: a, wpm, accuracy, progress: 100, finished: true, missed, flags: flags || [] });
    await db.rpc('record_race_stats', { p_code: code, p_ranked: false, p_difficulty: 'easy', p_players: [race(60, 90, { e: 2, ' ': 1 })] });
    await db.rpc('record_race_stats', { p_code: code, p_ranked: true, p_difficulty: 'hard', p_players: [race(80, 95, { e: 1, t: 3 })] });
    const cheated = await db.rpc('record_race_stats', { p_code: code, p_ranked: false, p_difficulty: 'easy',
      p_players: [race(300, 100, { z: 99 }, [{ reason: 'speed', count: 1, detail: '300 WPM after 40 letters' }])] });
    assert.strictEqual(cheated.data, 1);

    const stats = (await db.rpc('player_stats', { p_pid: a })).data;
    assert.strictEqual(stats.races, 2);
    assert.strictEqual(stats.flaggedRaces, 1);
    assert.strictEqual(stats.bestWpm, 80);                      // the 300 WPM race does not count
    assert.strictEqual(stats.avgWpm, 70);
    assert.deepStrictEqual(stats.trend.map((t) => Number(t.accuracy)), [90, 95]);   // oldest first
    assert.deepStrictEqual(stats.mostMissed.slice(0, 2).map((m) => [m.ch, m.misses]), [['e', 3], ['t', 3]]);
    assert.ok(!stats.mostMissed.some((m) => m.ch === 'z'), 'letters from a flagged race are ignored');

    const flags = await db.from('cheat_flags').select('reason, times, detail').eq('pid', a);
    assert.deepStrictEqual(flags.data.map((f) => f.reason), ['speed']);
  });

  await t.test('a bad reason is refused and the whole save rolls back', async () => {
    const a = await player('badReason');
    const code = codeOf(12); codes.push(code);
    const res = await db.rpc('record_race_stats', { p_code: code, p_ranked: false, p_difficulty: 'easy', p_players: [
      { pid: a, wpm: 50, accuracy: 100, progress: 100, finished: true, missed: {}, flags: [] },
      { pid: a, wpm: 50, accuracy: 100, progress: 100, finished: true, missed: {}, flags: [{ reason: 'made-up', count: 1 }] },
    ] });
    assert.ok(res.error, 'an unknown flag reason must be rejected');
    const rows = await db.from('race_stats').select('id').eq('room', code);
    assert.strictEqual(rows.data.length, 0, 'the first racer was not saved either');
  });

  await t.test('leaderboard: ranked by rating, marks you, hides pids, hides repeat cheats, uses clean WPM', async () => {
    const [a, b] = [await player('boardTop'), await player('boardCheat')];
    await db.from('accounts').update({ races: 1, rating: 9000, name: 'Top' }).eq('pid', a);
    await db.from('accounts').update({ races: 1, rating: 9500, name: 'Cheat' }).eq('pid', b);
    const code = codeOf(13); codes.push(code);
    const ok = { wpm: 70, accuracy: 97, progress: 100, finished: true, missed: {} };
    await db.rpc('record_race_stats', { p_code: code, p_ranked: true, p_difficulty: 'easy', p_players: [{ pid: a, ...ok }, { pid: a, ...ok, wpm: 400, flags: [{ reason: 'speed', count: 1 }] }] });
    for (let i = 0; i < 3; i++) {
      await db.rpc('record_race_stats', { p_code: code, p_ranked: true, p_difficulty: 'easy', p_players: [{ pid: b, ...ok, flags: [{ reason: 'paste', count: 1 }] }] });
    }

    const board = (await db.rpc('leaderboard', { p_limit: 100, p_pid: a })).data;
    const me = board.find((r) => r.isYou);
    assert.ok(me, 'the asking player is marked');
    assert.strictEqual(me.name, 'Top');
    assert.strictEqual(me.bestWpm, 70, 'the flagged 400 WPM race does not count');
    assert.ok(!board.some((r) => r.name === 'Cheat'), 'a player with 3 flagged races is hidden');
    assert.ok(board.every((r) => !('pid' in r)), 'no pid is ever exposed');
    const ratings = board.map((r) => r.rating);
    assert.deepStrictEqual(ratings, [...ratings].sort((x, y) => y - x), 'sorted by rating, highest first');
  });

  await t.test('settle rolls back if a racer never paid in', async () => {
    const a = await player('a'); const x = await player('x');
    const code = codeOf(6); codes.push(code);
    const start = await coins(a);
    await acc.collectEntries(code, [a], FEE);
    await assert.rejects(acc.settle(code, [{ pid: a, active: true }, { pid: x, active: true }]));
    assert.strictEqual(await coins(a), start - FEE);   // still in the pot, nothing paid
    await acc.voidPot(code);
  });

  await t.test('nobody typed: everyone in the pot, even a leaver, is refunded', async () => {
    const [a, b, gone] = [await player('a'), await player('b'), await player('gone')];
    const code = codeOf(7); codes.push(code);
    const start = [await coins(a), await coins(b), await coins(gone)];
    await acc.collectEntries(code, [a, b, gone], FEE);
    await acc.settle(code, [{ pid: a, active: false }, { pid: b, active: false }]);
    assert.deepStrictEqual([await coins(a), await coins(b), await coins(gone)], start);
  });
});
