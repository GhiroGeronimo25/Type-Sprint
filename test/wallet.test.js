'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { apiGet, called } = require('./harness');

test('wallet API: no token or a forged token gets 401', async () => {
  assert.strictEqual((await apiGet('/api/wallet')).status, 401);
  assert.strictEqual((await apiGet('/api/wallet/transactions', { token: 'garbage' })).status, 401);
});

test('wallet API: returns the logged-in player\'s wallet', async () => {
  const r = await apiGet('/api/wallet', { token: 'token:api-user-1' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(typeof r.body.coins, 'number');
  assert.strictEqual(r.body.entryFee, 50);
});

test('transactions API: always for the logged-in user, with a page of items', async () => {
  const r = await apiGet('/api/wallet/transactions', { token: 'token:api-user-2', query: { pid: 'someone-else' } });
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.body.items));
  assert.strictEqual(typeof r.body.hasMore, 'boolean');
  const call = called('ledgerPage').pop();
  assert.strictEqual(call[1], 'api-user-2');
});

test('transactions API: offset, limit and type are cleaned up', async () => {
  await new Promise((r) => setTimeout(r, 250)); // clear the rate limit
  await apiGet('/api/wallet/transactions', { token: 'token:api-user-3', query: { offset: '-5', limit: '9999', type: 'hack' } });
  let call = called('ledgerPage').pop();
  assert.deepStrictEqual([call[2], call[3], call[4]], [0, 50, '']);
  await new Promise((r) => setTimeout(r, 250));
  await apiGet('/api/wallet/transactions', { token: 'token:api-user-3', query: { offset: '40', limit: '5', type: 'reward' } });
  call = called('ledgerPage').pop();
  assert.deepStrictEqual([call[2], call[3], call[4]], [40, 5, 'reward']);
});

test('transactions API: calling too fast gets 429', async () => {
  await new Promise((r) => setTimeout(r, 250));
  assert.strictEqual((await apiGet('/api/wallet', { token: 'token:api-user-4' })).status, 200);
  assert.strictEqual((await apiGet('/api/wallet', { token: 'token:api-user-4' })).status, 429);
});
