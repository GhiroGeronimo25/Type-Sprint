'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { apiGet, calls, called } = require('./harness');
const wait = () => new Promise((r) => setTimeout(r, 250));

test('stats and leaderboard API: need a login', async () => {
  assert.strictEqual((await apiGet('/api/stats')).status, 401);
  assert.strictEqual((await apiGet('/api/leaderboard', { token: 'nope' })).status, 401);
});

test('stats API: your own stats, whatever pid the request names', async () => {
  const r = await apiGet('/api/stats', { token: 'token:stats-user-1', query: { pid: 'someone-else' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.bestWpm, 80);
  assert.deepStrictEqual(called('playerStats').pop(), ['playerStats', 'stats-user-1']);
});

test('leaderboard API: rows without pids, your row marked by your login, limit cleaned up', async () => {
  const r = await apiGet('/api/leaderboard', { token: 'token:stats-user-2' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.items[0].name, 'Ann');
  assert.ok(!('pid' in r.body.items[0]), 'the leaderboard never exposes a pid');
  assert.deepStrictEqual(called('leaderboard').pop(), ['leaderboard', 20, 'stats-user-2']);
  await wait();
  await apiGet('/api/leaderboard', { token: 'token:stats-user-2', query: { limit: '99999' } });
  assert.strictEqual(called('leaderboard').pop()[1], 50);
  await wait();
  await apiGet('/api/leaderboard', { token: 'token:stats-user-2', query: { limit: '-3' } });
  assert.strictEqual(called('leaderboard').pop()[1], 1);
});

test('stats API: calling too fast gets 429', async () => {
  await wait();
  assert.strictEqual((await apiGet('/api/stats', { token: 'token:stats-user-3' })).status, 200);
  assert.strictEqual((await apiGet('/api/stats', { token: 'token:stats-user-3' })).status, 429);
});
