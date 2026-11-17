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
    for (const p of pids) {
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
