'use strict';
const test = require('node:test');
const assert = require('node:assert');
const createMatchmaker = require('../matchmaker');

let n = 0;
const ticket = (rating, joinedAt, extra) => Object.assign({ id: 'p' + ++n, rating, ranked: true, difficulty: 'medium', joinedAt: joinedAt || 0 }, extra);
const ids = (group) => group.map((t) => t.id);

test('two close players are matched once they have waited the fill time, not before', () => {
  const mm = createMatchmaker();
  const a = ticket(1000, 0); const b = ticket(1040, 0);
  mm.add(a); mm.add(b);
  assert.deepStrictEqual(mm.take(1000), [], 'too soon: more players might still turn up');
  assert.strictEqual(mm.all().length, 2, 'they are still in the queue');
  const groups = mm.take(5000);
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(ids(groups[0]).sort(), [a.id, b.id].sort());
  assert.strictEqual(mm.all().length, 0, 'matched players leave the queue');
});

test('five compatible players are matched at once, without waiting', () => {
  const mm = createMatchmaker();
  const five = [1000, 1010, 990, 1020, 1005].map((r) => ticket(r, 0));
  five.forEach((t) => mm.add(t));
  const groups = mm.take(0);
  assert.strictEqual(groups.length, 1);
  assert.strictEqual(groups[0].length, 5);
});

test('a room never has more than 5 players; the rest keep waiting', () => {
  const mm = createMatchmaker();
  for (let i = 0; i < 7; i++) mm.add(ticket(1000 + i, 0));
  const groups = mm.take(0);
  assert.deepStrictEqual(groups.map((g) => g.length), [5]);
  assert.strictEqual(mm.all().length, 2);
  const later = mm.take(5000);
  assert.deepStrictEqual(later.map((g) => g.length), [2], 'the two left over match once they have waited');
});

test('players too far apart in rating are not matched, until the window widens', () => {
  const mm = createMatchmaker();
  const low = ticket(1000, 0); const high = ticket(1300, 0);
  mm.add(low); mm.add(high);
  assert.deepStrictEqual(mm.take(5000), [], 'a 300 gap is outside the 150 window at 5 seconds');
  assert.deepStrictEqual(mm.take(15000), [], 'still outside the 250 window at 15 seconds');
  const groups = mm.take(20000);                          // window is 100 + 4*50 = 300
  assert.strictEqual(groups.length, 1);
});

test('after 30 seconds any rating will do', () => {
  const mm = createMatchmaker();
  mm.add(ticket(800, 0)); mm.add(ticket(2400, 0));
  assert.deepStrictEqual(mm.take(29000), []);
  assert.strictEqual(mm.take(30000).length, 1);
});

test('the rating window only ever grows', () => {
  const mm = createMatchmaker();
  let last = 0;
  for (let ms = 0; ms <= 40000; ms += 500) {
    const w = mm.windowFor(ms);
    assert.ok(w >= last, 'window shrank at ' + ms);
    last = w;
  }
  assert.strictEqual(mm.windowFor(0), 100);
  assert.strictEqual(mm.windowFor(5000), 150);
  assert.strictEqual(mm.windowFor(30000), Infinity);
});

test('ranked and casual, and different difficulties, never mix', () => {
  const mm = createMatchmaker();
  mm.add(ticket(1000, 0, { ranked: true, difficulty: 'easy' }));
  mm.add(ticket(1000, 0, { ranked: false, difficulty: 'easy' }));
  mm.add(ticket(1000, 0, { ranked: true, difficulty: 'hard' }));
  assert.deepStrictEqual(mm.take(60000), [], 'each is alone in its own pool');
  mm.add(ticket(1000, 0, { ranked: true, difficulty: 'hard' }));
  const groups = mm.take(60000);
  assert.strictEqual(groups.length, 1);
  assert.ok(groups[0].every((t) => t.ranked && t.difficulty === 'hard'));
});

test('an outlier does not block everyone else', () => {
  const mm = createMatchmaker();
  const outlier = ticket(1000, 0);                        // waited longest, but nobody is near 1000
  mm.add(outlier);
  const crowd = [1500, 1510, 1490, 1505, 1495].map((r) => ticket(r, 1000));
  crowd.forEach((t) => mm.add(t));
  const groups = mm.take(2000);
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(ids(groups[0]).sort(), ids(crowd).sort());
  assert.ok(mm.has(outlier.id), 'the outlier is still waiting');
});

test('the player who has waited longest is matched first, with the closest ratings', () => {
  const mm = createMatchmaker();
  const old = ticket(1000, 0);
  const near = ticket(1020, 100); const nearer = ticket(1005, 200); const far = ticket(1090, 50);
  [old, near, nearer, far].forEach((t) => mm.add(t));
  const [group] = mm.take(6000);
  assert.strictEqual(group[0].id, old.id, 'the longest waiter anchors the match');
  assert.deepStrictEqual(ids(group).slice(1), [nearer.id, near.id, far.id], 'closest rating first');
});

test('a player can only be queued once, and can leave the queue', () => {
  const mm = createMatchmaker();
  const a = ticket(1000, 0);
  assert.strictEqual(mm.add(a), true);
  assert.strictEqual(mm.add(a), false, 'same id twice');
  assert.strictEqual(mm.has(a.id), true);
  assert.strictEqual(mm.remove(a.id), true);
  assert.strictEqual(mm.has(a.id), false);
  assert.strictEqual(mm.remove(a.id), false);
});

test('poolSize counts only the same pool', () => {
  const mm = createMatchmaker();
  const a = ticket(1000, 0, { difficulty: 'easy' });
  mm.add(a); mm.add(ticket(1100, 0, { difficulty: 'easy' })); mm.add(ticket(1000, 0, { difficulty: 'hard' }));
  assert.strictEqual(mm.poolSize(a), 2);
});

test('options can be changed', () => {
  const mm = createMatchmaker({ fillMs: 0, maxPlayers: 3 });
  for (let i = 0; i < 4; i++) mm.add(ticket(1000, 0));
  assert.deepStrictEqual(mm.take(0).map((g) => g.length), [3]);
});
