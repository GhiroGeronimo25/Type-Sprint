'use strict';
// Quick match, through the real server.js: queueing, matching, cancelling and the rules around them.
process.env.MM_FILL_MS = '300';   // wait this long for more players before starting a 2-4 player match
process.env.MM_TICK_MS = '50';
const test = require('node:test');
const { afterEach } = require('node:test');
const assert = require('node:assert');
const { sleep, emits, calls, wallets, connect, lastState, called } = require('./harness');

let n = 0;
const everyone = [];                                  // every player a test made, so each test can be cleaned up even if it failed
afterEach(async () => {
  everyone.splice(0).forEach((p) => { p.fire('match:cancel'); p.fire('room:leave'); });
  await sleep(40);
});
const player = (opts) => {
  const pid = 'mm' + ++n;
  const p = connect();
  everyone.push(p);
  return Object.assign(p, { pid, search: (extra) => p.ask('match:join', Object.assign({ name: 'P' + n, pid, ranked: false, difficulty: 'medium' }, opts, extra)) });
};
const found = (p) => emits.filter((e) => e.ev === 'match:found' && e.target === p.socket.id);
const leave = async (...players) => { players.forEach((p) => p.fire('room:leave')); await sleep(30); };

test('two players searching are put in one room with the countdown running', async () => {
  emits.length = 0; calls.length = 0;
  const a = player({ difficulty: 'hard' }); const b = player({ difficulty: 'hard' });
  assert.deepStrictEqual(await a.search(), { ok: true });
  assert.deepStrictEqual(await b.search(), { ok: true });
  assert.strictEqual(found(a).length, 0, 'not matched yet: it waits a moment in case more players turn up');
  await sleep(450);

  assert.strictEqual(found(a).length, 1);
  assert.strictEqual(found(b).length, 1);
  const code = found(a)[0].data.code;
  assert.strictEqual(found(b)[0].data.code, code, 'both are told the same room');
  const state = lastState(code);
  assert.strictEqual(state.players.length, 2);
  assert.strictEqual(state.difficulty, 'hard');
  assert.strictEqual(state.ranked, false);
  assert.strictEqual(state.status, 'countdown', 'the race starts straight away');
  await leave(a, b);
});

test('five searching players fill a room at once, without the wait', async () => {
  emits.length = 0;
  const five = [1, 2, 3, 4, 5].map(() => player({ difficulty: 'easy' }));
  for (const p of five) await p.search();
  await sleep(150);                                                    // well under the 300 ms fill time
  const codes = new Set(five.map((p) => found(p)[0] && found(p)[0].data.code));
  assert.strictEqual(codes.size, 1, 'all five are in the same room');
  assert.strictEqual(lastState([...codes][0]).players.length, 5);
  await leave(...five);
});

test('a sixth player is left searching, not squeezed into a full room', async () => {
  emits.length = 0;
  const six = [1, 2, 3, 4, 5, 6].map(() => player({ difficulty: 'easy' }));
  for (const p of six) await p.search();
  await sleep(100);
  assert.strictEqual(six.slice(0, 5).filter((p) => found(p).length === 1).length, 5);
  assert.strictEqual(found(six[5]).length, 0);
  await leave(...six);
});

test('a ranked match collects the entry fee from everyone', async () => {
  emits.length = 0; calls.length = 0;
  const a = player({ ranked: true }); const b = player({ ranked: true });
  await a.search(); await b.search();
  await sleep(500);
  const code = found(a)[0].data.code;
  assert.strictEqual(lastState(code).ranked, true);
  const collect = called('collectEntries');
  assert.strictEqual(collect.length, 1);
  assert.deepStrictEqual(collect[0][2].sort(), [a.pid, b.pid].sort());
  assert.strictEqual(lastState(code).pot, 100);
  await leave(a, b);
});

test('ranked search needs the entry fee; casual does not', async () => {
  const broke = player({});
  wallets[broke.pid] = 10;
  const refused = await broke.search({ ranked: true });
  assert.strictEqual(refused.ok, false);
  assert.match(refused.error, /50 coins/);
  await sleep(550);                                                    // past the short throttle
  assert.deepStrictEqual(await broke.search({ ranked: false }), { ok: true }, 'casual is free');
  broke.fire('match:cancel');
});

test('cancelling leaves the queue', async () => {
  emits.length = 0;
  const a = player({}); const b = player({});
  await a.search();
  const cancel = await a.ask('match:cancel', {});
  assert.deepStrictEqual(cancel, { ok: true });
  await b.search();
  await sleep(450);
  assert.strictEqual(found(a).length, 0);
  assert.strictEqual(found(b).length, 0, 'b is alone: a really left');
  b.fire('match:cancel');
});

test('disconnecting while searching leaves the queue', async () => {
  emits.length = 0;
  const a = player({}); const b = player({});
  await a.search();
  a.fire('disconnect');
  await b.search();
  await sleep(450);
  assert.strictEqual(found(b).length, 0);
  b.fire('match:cancel');
});

test('searches stay in their own pool: type and difficulty', async () => {
  emits.length = 0;
  const easy = player({ difficulty: 'easy' }); const hard = player({ difficulty: 'hard' }); const ranked = player({ ranked: true, difficulty: 'easy' });
  await easy.search(); await hard.search(); await ranked.search();
  await sleep(450);
  assert.strictEqual(found(easy).length + found(hard).length + found(ranked).length, 0);
  [easy, hard, ranked].forEach((p) => p.fire('match:cancel'));
});

test('you cannot search while in a room, or twice', async () => {
  const inRoom = player({});
  await inRoom.ask('room:create', { name: 'A', pid: inRoom.pid, ranked: false });
  const refused = await inRoom.search();
  assert.strictEqual(refused.ok, false);
  assert.match(refused.error, /Leave your current room/);
  await leave(inRoom);

  const a = player({}); const twin = connect();                        // the same player on a second connection
  await a.search();
  const second = await twin.ask('match:join', { name: 'A', pid: a.pid, ranked: false });
  assert.strictEqual(second.ok, false);
  assert.match(second.error, /already searching/);
  a.fire('match:cancel');
});

test('searches are throttled', async () => {
  const a = player({});
  assert.strictEqual((await a.search()).ok, true);
  const quick = await a.search();                                      // straight away
  assert.strictEqual(quick.ok, false);
  assert.match(quick.error, /already searching|Slow down/);
  a.fire('match:cancel');
});

test('creating or joining a room ends a search', async () => {
  emits.length = 0;
  const a = player({}); const b = player({});
  await a.search();
  await a.ask('room:create', { name: 'A', pid: a.pid, ranked: false });   // a gives up searching and makes their own room
  await b.search();
  await sleep(450);
  assert.strictEqual(found(b).length, 0, 'a is not in the queue any more');
  b.fire('match:cancel');
  await leave(a);
});

test('searchers are told how long they have waited and how many are searching', async () => {
  emits.length = 0;
  const a = player({ difficulty: 'hard' }); const b = player({ difficulty: 'hard' });
  await a.search(); await b.search();
  await sleep(120);
  const status = emits.filter((e) => e.ev === 'match:status' && e.target === a.socket.id).pop();
  assert.ok(status, 'a status update arrived');
  assert.strictEqual(status.data.searching, 2);
  assert.ok(status.data.waitedMs >= 0);
  a.fire('match:cancel'); b.fire('match:cancel');
});

test('a bad difficulty is treated as medium', async () => {
  emits.length = 0;
  const a = player({}); const b = player({});
  await a.search({ difficulty: 'nonsense' }); await b.search({ difficulty: '__proto__' });
  await sleep(450);
  assert.strictEqual(lastState(found(a)[0].data.code).difficulty, 'medium');
  await leave(a, b);
});
