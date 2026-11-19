'use strict';
// Checks ranked vs casual rooms, forfeits and passage difficulty against the real server.js
// (see harness.js for the fake modules).
const test = require('node:test');
const assert = require('node:assert');
const { sleep, emits, calls, wallets, connect, lastState, called } = require('./harness');

test('casual race: free, no pot, nobody is charged', async () => {
  calls.length = 0; emits.length = 0;
  const a = connect(); const b = connect();
  const made = await a.ask('room:create', { name: 'A', pid: 'casualA', ranked: false });
  assert.strictEqual(made.ok, true);
  assert.strictEqual(lastState(made.code).ranked, false);
  await b.ask('room:join', { name: 'B', code: made.code, pid: 'casualB' });

  wallets.casualB = 0;                  // even a broke player can race in casual
  a.fire('race:start');
  await sleep(30);

  const state = lastState(made.code);
  assert.strictEqual(state.status, 'countdown');
  assert.strictEqual(state.pot, 0);
  assert.ok(state.players.every((p) => p.entered), 'everyone should be entered');
  assert.strictEqual(called('collectEntries').length, 0);
  assert.strictEqual(emits.filter((e) => e.ev === 'race:notice').length, 0);

  a.fire('room:leave'); b.fire('room:leave');   // leaving a casual countdown refunds nothing
  await sleep(30);
  assert.strictEqual(called('refundEntry').length, 0);
  assert.strictEqual(called('voidPot').length, 0);
});

test('ranked race: fees are collected, and a racer who cannot pay watches', async () => {
  calls.length = 0; emits.length = 0;
  const a = connect(); const b = connect();
  const made = await a.ask('room:create', { name: 'A', pid: 'rankA', ranked: true });
  assert.strictEqual(lastState(made.code).ranked, true);
  await b.ask('room:join', { name: 'B', code: made.code, pid: 'rankB' });

  wallets.rankB = 10;
  a.fire('race:start');
  await sleep(30);

  assert.strictEqual(called('collectEntries').length, 1);
  const state = lastState(made.code);
  assert.strictEqual(state.status, 'countdown');
  assert.strictEqual(state.pot, 50);
  assert.strictEqual(state.players.filter((p) => p.entered).length, 1);
  assert.strictEqual(emits.filter((e) => e.ev === 'race:notice' && e.target === b.socket.id).length, 1);

  a.fire('room:leave');                 // the paying racer leaves during the countdown: fee goes back
  await sleep(30);
  assert.strictEqual(called('refundEntry').length, 1);
  b.fire('room:leave');
  await sleep(30);
});

test('rooms are ranked unless the host picks casual', async () => {
  const a = connect();
  const made = await a.ask('room:create', { name: 'A', pid: 'defaultA' });
  assert.strictEqual(lastState(made.code).ranked, true);
  a.fire('room:leave');
  await sleep(30);
});

test('ranked: everyone leaving the countdown returns the pot', async () => {
  calls.length = 0;
  const a = connect();
  const made = await a.ask('room:create', { name: 'A', pid: 'soloA', ranked: true });
  a.fire('race:start');
  await sleep(30);
  assert.strictEqual(called('collectEntries').length, 1);
  a.fire('room:leave');
  await sleep(30);
  assert.strictEqual(called('refundEntry').length, 1);   // sole racer refunded from the pot
});

test('ranked race end: one settle call carries placement, stats and the passage', async () => {
  calls.length = 0; emits.length = 0;
  const a = connect(); const b = connect();
  const made = await a.ask('room:create', { name: 'A', pid: 'flowA', ranked: true });
  await b.ask('room:join', { name: 'B', code: made.code, pid: 'flowB' });
  a.fire('race:start');
  await sleep(30);
  const text = emits.find((e) => e.ev === 'race:countdown').data.text;

  await sleep(150);                                  // countdown over, race is on
  a.fire('race:input', { input: text.slice(0, 3) }); // A types 3 letters, B only 1
  b.fire('race:input', { input: text.slice(0, 1) });
  await sleep(600);                                  // the race hits its time limit

  const settles = called('settle');
  assert.strictEqual(settles.length, 1, 'the race is settled exactly once');
  const [, code, ranked, sentText] = settles[0];
  assert.strictEqual(code, made.code);
  assert.strictEqual(sentText, text, 'the passage is saved with the results');
  assert.deepStrictEqual(ranked.map((r) => r.pid), ['flowA', 'flowB'], 'finishing order = placement');
  assert.strictEqual(ranked[0].name, 'A');
  assert.strictEqual(ranked[0].active, true);
  assert.strictEqual(ranked[0].finished, false);
  assert.ok(ranked[0].progress > ranked[1].progress && ranked[1].progress > 0);
  assert.strictEqual(ranked[0].seconds, null);
  assert.ok('wpm' in ranked[0] && 'accuracy' in ranked[0]);

  const results = emits.filter((e) => e.ev === 'race:result');
  assert.strictEqual(results.length, 2, 'both racers are told their result');

  a.fire('room:leave'); b.fire('room:leave');
  await sleep(30);
});

test('casual race end: nothing is settled and nobody gets a result', async () => {
  calls.length = 0; emits.length = 0;
  const a = connect();
  const made = await a.ask('room:create', { name: 'A', pid: 'flowCasual', ranked: false });
  a.fire('race:start');
  await sleep(700);                                  // countdown + the full race, nobody types
  assert.strictEqual(lastState(made.code).status, 'finished');
  assert.strictEqual(called('settle').length, 0);
  assert.strictEqual(emits.filter((e) => e.ev === 'race:result').length, 0);
  a.fire('room:leave');
  await sleep(30);
});

test('ranked: a racer who disconnects forfeits and is not paid', async () => {
  calls.length = 0; emits.length = 0;
  const a = connect(); const b = connect();
  const made = await a.ask('room:create', { name: 'A', pid: 'forfA', ranked: true });
  await b.ask('room:join', { name: 'B', code: made.code, pid: 'forfB' });
  a.fire('race:start');
  await sleep(30);
  const text = emits.find((e) => e.ev === 'race:countdown').data.text;

  await sleep(150);                                   // the race is on
  a.fire('race:input', { input: text.slice(0, 3) });
  b.fire('race:input', { input: text.slice(0, 2) });  // B types a little ...
  b.fire('disconnect');                               // ... then drops

  const mid = lastState(made.code);
  const bLane = mid.players.find((p) => p.name === 'B');
  assert.strictEqual(bLane.entered, false);
  assert.strictEqual(bLane.forfeited, true);

  await sleep(600);                                   // the race hits its time limit
  const settles = called('settle');
  assert.strictEqual(settles.length, 1);
  assert.deepStrictEqual(settles[0][2].map((r) => r.pid), ['forfA'], 'only the racer who stayed is paid');
  assert.strictEqual(called('refundEntry').length, 0, 'the forfeited fee is not refunded');
  assert.strictEqual(called('voidPot').length, 0, 'the pot is paid out, not cancelled');

  const b2 = connect();                               // B comes back to watch
  await b2.ask('room:rejoin', { code: made.code, pid: 'forfB' });
  const notice = emits.find((e) => e.ev === 'race:notice' && e.target === b2.socket.id);
  assert.ok(notice && /forfeited/.test(notice.data.message), 'a returning racer is told they forfeited');

  a.fire('room:leave'); b2.fire('room:leave');
  await sleep(30);
});

test('ranked: if everyone who paid disconnects, the race is cancelled and fees go back', async () => {
  calls.length = 0; emits.length = 0;
  const a = connect();
  const made = await a.ask('room:create', { name: 'A', pid: 'allGone', ranked: true });
  a.fire('race:start');
  await sleep(30);
  a.fire('disconnect');                               // drops during the countdown
  await sleep(250);                                   // racing begins with nobody in it
  assert.strictEqual(called('settle').length, 0);
  assert.strictEqual(called('voidPot').length, 1);
  assert.strictEqual(lastState(made.code).status, 'finished');
  a.fire('room:leave');                               // clears the held seat
  await sleep(30);
});

test('casual: disconnecting forfeits nothing', async () => {
  calls.length = 0; emits.length = 0;
  const a = connect(); const b = connect();
  const made = await a.ask('room:create', { name: 'A', pid: 'casDropA', ranked: false });
  await b.ask('room:join', { name: 'B', code: made.code, pid: 'casDropB' });
  a.fire('race:start');
  await sleep(30);
  b.fire('disconnect');
  const lane = lastState(made.code).players.find((p) => p.name === 'B');
  assert.strictEqual(lane.entered, true);
  assert.strictEqual(lane.forfeited, false);
  a.fire('room:leave'); b.fire('room:leave');
  await sleep(30);
});

// ---------- passage difficulty ----------
const bank = require('../passages');
const countdownText = () => [...emits].reverse().find((e) => e.ev === 'race:countdown').data.text;

test('the server picks the passage from the room\'s difficulty', async () => {
  for (const level of ['easy', 'medium', 'hard']) {
    emits.length = 0;
    const a = connect();
    const made = await a.ask('room:create', { name: 'A', pid: 'diff' + level, ranked: false, difficulty: level });
    assert.strictEqual(lastState(made.code).difficulty, level);
    a.fire('race:start');
    await sleep(30);
    assert.ok(bank.BANK[level].includes(countdownText()), 'a ' + level + ' room gets a ' + level + ' passage');
    a.fire('room:leave');
    await sleep(30);
  }
});

test('a missing or invalid difficulty becomes medium', async () => {
  for (const bad of [undefined, 'impossible', 7, null, ['hard'], '__proto__']) {
    const a = connect();
    const made = await a.ask('room:create', { name: 'A', pid: 'bad' + String(bad).slice(0, 5), ranked: false, difficulty: bad });
    assert.strictEqual(lastState(made.code).difficulty, 'medium', 'difficulty ' + JSON.stringify(bad));
    a.fire('room:leave');
    await sleep(10);
  }
});

test('the host can change the difficulty between races; nobody else can', async () => {
  emits.length = 0;
  const a = connect(); const b = connect();
  const made = await a.ask('room:create', { name: 'A', pid: 'chgA', ranked: false });
  await b.ask('room:join', { name: 'B', code: made.code, pid: 'chgB' });

  b.fire('room:difficulty', { difficulty: 'hard' });                 // not the host
  assert.strictEqual(lastState(made.code).difficulty, 'medium');

  a.fire('room:difficulty', { difficulty: 'bogus' });                // not a real difficulty
  assert.strictEqual(lastState(made.code).difficulty, 'medium');

  a.fire('room:difficulty', { difficulty: 'hard' });                 // the host, a real difficulty
  assert.strictEqual(lastState(made.code).difficulty, 'hard');

  a.fire('race:start');
  await sleep(30);
  assert.ok(bank.BANK.hard.includes(countdownText()));

  a.fire('room:difficulty', { difficulty: 'easy' });                 // a race is on: no changing
  assert.strictEqual(lastState(made.code).difficulty, 'hard');

  a.fire('room:leave'); b.fire('room:leave');
  await sleep(30);
});

test('the same room never gets the same passage twice in a row', async () => {
  emits.length = 0;
  const a = connect();
  const made = await a.ask('room:create', { name: 'A', pid: 'repeatA', ranked: false, difficulty: 'easy' });
  const seen = [];
  for (let i = 0; i < 3; i++) {
    a.fire('race:start');
    await sleep(30);
    seen.push(countdownText());
    await sleep(600);                                                // countdown + the whole race, so the room is "finished"
    assert.strictEqual(lastState(made.code).status, 'finished');
  }
  assert.notStrictEqual(seen[0], seen[1]);
  assert.notStrictEqual(seen[1], seen[2]);
  a.fire('room:leave');
  await sleep(30);
});
