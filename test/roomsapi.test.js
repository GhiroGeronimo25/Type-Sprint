'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { apiGet, apiSend, connect } = require('./harness');
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 250));
const tok = (id) => 'token:' + id;

test('rooms API: every route needs a login', async () => {
  assert.strictEqual((await apiGet('/api/rooms')).status, 401);
  assert.strictEqual((await apiGet('/api/rooms/:code', { params: { code: 'ABCD' }, token: 'nope' })).status, 401);
  assert.strictEqual((await apiSend('POST', '/api/rooms', {})).status, 401);
  assert.strictEqual((await apiSend('DELETE', '/api/rooms/:code', { params: { code: 'ABCD' } })).status, 401);
});

test('POST /api/rooms: bad settings are a 400', async () => {
  assert.strictEqual((await apiSend('POST', '/api/rooms', { token: tok('rest-bad-1'), body: { difficulty: 'impossible' } })).status, 400);
  await wait();
  assert.strictEqual((await apiSend('POST', '/api/rooms', { token: tok('rest-bad-1'), body: { ranked: 'yes' } })).status, 400);
});

test('POST /api/rooms reserves a room, and the owner takes the host seat over the socket', async () => {
  const made = await apiSend('POST', '/api/rooms', { token: tok('rest-host-1'), body: { ranked: false, difficulty: 'hard' } });
  assert.strictEqual(made.status, 201);
  assert.match(made.body.code, /^[A-Z0-9]{4}$/);
  assert.strictEqual(made.body.difficulty, 'hard');
  assert.strictEqual(made.body.ranked, false);
  assert.ok(made.body.expiresInMs > 0);
  assert.ok(!JSON.stringify(made.body).includes('rest-host-1'), 'no player id in the response');

  // not listed in the open rooms until the host has connected
  await wait();
  const before = await apiGet('/api/rooms', { token: tok('rest-viewer-1') });
  assert.ok(!before.body.rooms.some((r) => r.code === made.body.code));

  // somebody else cannot take the seat first
  const thief = await connect().ask('room:join', { name: 'Thief', pid: 'rest-thief-1', code: made.body.code });
  assert.strictEqual(thief.ok, false);
  assert.match(thief.error, /host has not arrived/);

  const host = connect();
  const joined = await host.ask('room:join', { name: 'RestHost', pid: 'rest-host-1', code: made.body.code });
  assert.ok(joined.ok);

  await wait();
  const after = await apiGet('/api/rooms', { token: tok('rest-viewer-1') });
  const row = after.body.rooms.find((r) => r.code === made.body.code);
  assert.ok(row, 'listed once the host is in');
  assert.strictEqual(row.difficulty, 'hard');
  assert.strictEqual(row.players, 1);

  // the host can start the race: the seat really is the host's
  const guest = await connect().ask('room:join', { name: 'Guest', pid: 'rest-guest-1', code: made.body.code });
  assert.ok(guest.ok, 'others can join after the host arrives');
});

test('GET /api/rooms/:code: details without pids or passage text; unknown rooms are 404', async () => {
  const made = await apiSend('POST', '/api/rooms', { token: tok('rest-host-2'), body: { ranked: false } });
  await wait();
  // reserved room is invisible to everyone but its owner
  assert.strictEqual((await apiGet('/api/rooms/:code', { params: { code: made.body.code }, token: tok('rest-other-2') })).status, 404);
  await wait();
  assert.strictEqual((await apiGet('/api/rooms/:code', { params: { code: made.body.code }, token: tok('rest-host-2') })).status, 200);

  await connect().ask('room:join', { name: 'DetailHost', pid: 'rest-host-2', code: made.body.code });
  await wait();
  const r = await apiGet('/api/rooms/:code', { params: { code: made.body.code.toLowerCase() }, token: tok('rest-other-2') });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.host, 'DetailHost');
  assert.strictEqual(r.body.youAreIn, false);
  assert.strictEqual(r.body.players.length, 1);
  assert.ok(!JSON.stringify(r.body).includes('rest-host-2'));
  assert.ok(!('text' in r.body));
  await wait();
  assert.strictEqual((await apiGet('/api/rooms/:code', { params: { code: 'ZZZZ' }, token: tok('rest-other-2') })).status, 404);
});

test('POST /api/rooms: one room at a time; DELETE cancels a reservation (only the owner)', async () => {
  const a = await apiSend('POST', '/api/rooms', { token: tok('rest-host-3'), body: {} });
  assert.strictEqual(a.status, 201);
  await wait();
  assert.strictEqual((await apiSend('POST', '/api/rooms', { token: tok('rest-host-3'), body: {} })).status, 409);
  assert.strictEqual((await apiSend('DELETE', '/api/rooms/:code', { token: tok('rest-other-3'), params: { code: a.body.code } })).status, 404);
  assert.strictEqual((await apiSend('DELETE', '/api/rooms/:code', { token: tok('rest-host-3'), params: { code: a.body.code } })).status, 200);
  const late = await connect().ask('room:join', { name: 'Late', pid: 'rest-host-3', code: a.body.code });
  assert.strictEqual(late.ok, false, 'a cancelled room is gone');
  await wait();
  assert.strictEqual((await apiSend('POST', '/api/rooms', { token: tok('rest-host-3'), body: {} })).status, 201, 'free to make another');
});

test('POST /api/rooms: refused while you are already in a room', async () => {
  const sock = await connect().ask('room:create', { name: 'Busy', pid: 'rest-busy-1', ranked: false });
  assert.ok(sock.ok);
  assert.strictEqual((await apiSend('POST', '/api/rooms', { token: tok('rest-busy-1'), body: {} })).status, 409);
});
