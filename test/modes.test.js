'use strict';
// Checks ranked vs casual rooms by running the real server.js against fake Express, Socket.IO and
// accounts modules. No database or network needed.
const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const path = require('path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emits = [];                       // every message the server sent: { target, ev, data }
const calls = [];                       // every accounts call: [name, ...args]
const wallets = {};                     // pid -> coins, for the fake accounts
let onConnection;

function fakeAccounts() {
  const log = (name) => (...args) => { calls.push([name, ...args]); };
  return {
    ENTRY_FEE: 50,
    join: async (pid) => { calls.push(['join', pid]); if (!(pid in wallets)) wallets[pid] = 500; return { rating: 1000, coins: wallets[pid], races: 0, wins: 0, ledger: [], entryFee: 50 }; },
    view: async (pid) => ({ rating: 1000, coins: wallets[pid] || 0, races: 0, wins: 0, ledger: [], entryFee: 50 }),
    collectEntries: async (code, pids, fee) => {
      calls.push(['collectEntries', code, pids.slice(), fee]);
      const entered = pids.filter((p) => wallets[p] >= fee);
      return { entered, pot: entered.length * fee };
    },
    refundEntry: async (...a) => { log('refundEntry')(...a); return 0; },
    voidPot: async (...a) => { log('voidPot')(...a); return []; },
    voidAllPots: async () => 0,
    settle: async (code, ranked, text) => {
      calls.push(['settle', code, ranked, text]);
      const out = {};
      ranked.forEach((r, i) => { out[r.pid] = { rank: i + 1, payout: i === 0 ? 100 : 0, net: i === 0 ? 50 : -50, ratingBefore: 1000, ratingAfter: 1010 - i * 20, ratingDelta: 10 - i * 20 }; });
      return out;
    },
    recentResults: async () => [],
  };
}

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'dotenv') return { config() {} };
  if (request === 'express') {
    const express = () => ({ use() {}, get() {} });
    express.static = () => () => {};
    return express;
  }
  if (request === 'socket.io') {
    return { Server: class { to(target) { return { emit: (ev, data) => emits.push({ target, ev, data }) }; } on(ev, fn) { if (ev === 'connection') onConnection = fn; } } };
  }
  if (request === 'http') return { createServer: () => ({ listen: (p, cb) => cb && cb() }) };
  if (request === './accounts') return () => fakeAccounts();
  return realLoad.apply(this, arguments);
};
process.env.PORT = '0';
process.env.COUNTDOWN_MS = '120';   // short race so the whole flow runs in under a second
process.env.RACE_MS = '400';
require(path.join(__dirname, '..', 'server.js'));
Module._load = realLoad;

let counter = 0;
function connect() {
  const id = 'sock' + ++counter;
  const handlers = {};
  const socket = {
    id, data: {}, handlers,
    on(ev, fn) { handlers[ev] = fn; },
    join() {}, leave() {},
    emit(ev, data) { emits.push({ target: id, ev, data }); },
  };
  onConnection(socket);
  const ask = (ev, data) => new Promise((resolve) => handlers[ev](data, resolve));
  return { socket, ask, fire: (ev, data) => handlers[ev](data) };
}
const lastState = (code) => [...emits].reverse().find((e) => e.ev === 'room:state' && e.data.code === code).data;
const called = (name) => calls.filter((c) => c[0] === name);

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
