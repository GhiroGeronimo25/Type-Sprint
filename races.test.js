'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { apiGet, called } = require('./harness');
const wait = () => new Promise((r) => setTimeout(r, 250));

test('race history API: needs a login', async () => {
  assert.strictEqual((await apiGet('/api/races')).status, 401);
  assert.strictEqual((await apiGet('/api/races/:id', { params: { id: '7' } })).status, 401);
});

test('race history API: your own ranked races, a page at a time', async () => {
  const r = await apiGet('/api/races', { token: 'token:race-user-1', query: { pid: 'someone-else', limit: '5' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.items[0].rank, 1);
  assert.strictEqual(r.body.hasMore, true);
  const call = called('raceHistory').pop();
  assert.deepStrictEqual([call[1], call[2], call[3]], ['race-user-1', 0, 5]);
});

test('race history API: offset and limit are cleaned up', async () => {
  await apiGet('/api/races', { token: 'token:race-user-2', query: { offset: '-9', limit: '99999' } });
  const call = called('raceHistory').pop();
  assert.deepStrictEqual([call[2], call[3]], [0, 50]);
});

test('race detail API: a race you were in, 404 for one you were not, 400 for a bad id', async () => {
  await wait();
  const ok = await apiGet('/api/races/:id', { token: 'token:race-user-3', params: { id: '7' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.players[0].name, 'Ann');
  assert.ok(!JSON.stringify(ok.body).includes('race-user-3'), 'no pids in the response');
  await wait();
  assert.strictEqual((await apiGet('/api/races/:id', { token: 'token:race-user-3', params: { id: '999' } })).status, 404);
  await wait();
  assert.strictEqual((await apiGet('/api/races/:id', { token: 'token:race-user-3', params: { id: '7; drop' } })).status, 400);
});

test('the rate limit is per endpoint, so the page can load the wallet and races together', async () => {
  await wait();
  assert.strictEqual((await apiGet('/api/wallet', { token: 'token:race-user-4' })).status, 200);
  assert.strictEqual((await apiGet('/api/races', { token: 'token:race-user-4' })).status, 200);
  assert.strictEqual((await apiGet('/api/races', { token: 'token:race-user-4' })).status, 429);
});
