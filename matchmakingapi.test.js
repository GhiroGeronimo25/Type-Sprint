'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { apiGet, apiSend, connect, lastState, called, wallets, sleep } = require('./harness');
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 250));
const tok = (id) => 'token:' + id;
const post = (id, body) => apiSend('POST', '/api/matchmaking', { token: tok(id), body });
const status = (id) => apiGet('/api/matchmaking', { token: tok(id) });
const leave = (id) => apiSend('DELETE', '/api/matchmaking', { token: tok(id) });

test('matchmaking API: needs a login', async () => {
  assert.strictEqual((await apiGet('/api/matchmaking')).status, 401);
  assert.strictEqual((await apiSend('POST', '/api/matchmaking', {})).status, 401);
  assert.strictEqual((await apiSend('DELETE', '/api/matchmaking', { token: 'nope' })).status, 401);
});

test('matchmaking API: idle, searching, then leaving the queue', async () => {
  assert.deepStrictEqual((await status('mm-solo-1')).body, { status: 'idle' });
  await wait();
  const q = await post('mm-solo-1', { ranked: false, difficulty: 'easy' });
  assert.strictEqual(q.status, 202);
  assert.strictEqual(q.body.status, 'searching');
  await wait();
  const s = await status('mm-solo-1');
  assert.strictEqual(s.body.status, 'searching');
  assert.strictEqual(s.body.difficulty, 'easy');
  assert.strictEqual(s.body.ranked, false);
  assert.strictEqual(s.body.searching, 1);
  await wait();
  assert.strictEqual((await post('mm-solo-1', { ranked: false })).status, 409, 'one search at a time');
  await wait();
  assert.deepStrictEqual((await leave('mm-solo-1')).body, { status: 'idle' });
  await wait();
  assert.strictEqual((await status('mm-solo-1')).body.status, 'idle');
});

test('matchmaking API: bad settings are a 400; a ranked search needs the entry fee', async () => {
  assert.strictEqual((await post('mm-bad-1', { difficulty: 'nope' })).status, 400);
  await wait();
  wallets['mm-broke-1'] = 0;
  const broke = await post('mm-broke-1', { ranked: true });
  assert.strictEqual(broke.status, 403);
  assert.match(broke.body.error, /50 coins/);
});

test('matchmaking API: refused while you are in a room', async () => {
  await connect().ask('room:create', { name: 'InRoom', pid: 'mm-inroom-1', ranked: false });
  assert.strictEqual((await post('mm-inroom-1', { ranked: false })).status, 409);
});

test('two REST searchers are matched, connect with the code, and the race starts', async () => {
  await post('mm-pair-a', { ranked: false, difficulty: 'medium' });
  await post('mm-pair-b', { ranked: false, difficulty: 'medium' });
  // the queue waits MM_FILL_MS for more players before making a match with only two
  let a;
  for (let i = 0; i < 40 && (!a || a.body.status !== 'matched'); i++) { await sleep(250); a = await status('mm-pair-a'); }
  assert.strictEqual(a.body.status, 'matched', 'the pair was matched');
  assert.match(a.body.code, /^[A-Z0-9]{4}$/);
  assert.ok(a.body.expiresInMs > 0);
  const b = await status('mm-pair-b');
  assert.strictEqual(b.body.code, a.body.code, 'same room for both');

  // a stranger cannot slip into the matched room
  const stranger = await connect().ask('room:join', { name: 'Stranger', pid: 'mm-stranger', code: a.body.code });
  assert.strictEqual(stranger.ok, false);
  assert.match(stranger.error, /reserved/);

  const ja = await connect().ask('room:join', { name: 'A', pid: 'mm-pair-a', code: a.body.code });
  assert.ok(ja.ok);
  assert.notStrictEqual(lastState(a.body.code).status, 'countdown', 'waits for the other player');
  const jb = await connect().ask('room:join', { name: 'B', pid: 'mm-pair-b', code: a.body.code });
  assert.ok(jb.ok);
  await sleep(100);
  assert.strictEqual(lastState(a.body.code).status, 'countdown', 'everyone is in: the race starts');
  assert.strictEqual(lastState(a.body.code).players.length, 2);
  await wait();
  assert.strictEqual((await status('mm-pair-a')).body.status, 'idle', 'the match is used up once you join');
});

test('a REST searcher and a socket searcher can be matched together', async () => {
  const sock = connect();
  const acked = await sock.ask('match:join', { name: 'SockMM', pid: 'mm-mix-sock', ranked: false, difficulty: 'hard' });
  assert.ok(acked.ok);
  await post('mm-mix-rest', { ranked: false, difficulty: 'hard' });
  let m;
  for (let i = 0; i < 40 && (!m || m.body.status !== 'matched'); i++) { await sleep(250); m = await status('mm-mix-rest'); }
  assert.strictEqual(m.body.status, 'matched');
  assert.ok(lastState(m.body.code).players.some((p) => p.name === 'SockMM'), 'the socket player is already seated');
  assert.ok((await connect().ask('room:join', { name: 'RestMM', pid: 'mm-mix-rest', code: m.body.code })).ok);
  await sleep(100);
  assert.strictEqual(lastState(m.body.code).status, 'countdown');
});
