'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { apiGet, apiSend, called } = require('./harness');
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 250));
let n = 0;
const ip = () => '10.0.0.' + ++n; // every test is a different "address" so the attempt limit never gets in the way
const post = (path, body, extra) => apiSend('POST', path, Object.assign({ body, ip: ip() }, extra));

test('signup: creates the login and returns a session', async () => {
  const r = await post('/api/auth/signup', { email: 'new@example.com', password: 'longenough1', username: 'newbie' });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.user.username, 'newbie');
  assert.strictEqual(r.body.session.tokenType, 'Bearer');
  assert.ok(r.body.session.accessToken && r.body.session.refreshToken);
  assert.ok(!JSON.stringify(r.body).includes('longenough1'), 'the password is never echoed');
});

test('signup and login: ordinary emails are accepted, including ones with an s and a plus tag', async () => {
  for (const email of ['susan.stone@school.edu', 'sam+race@mail.example.co.uk']) {
    assert.strictEqual((await post('/api/auth/signup', { email, password: 'longenough1', username: 'person' + (++n) })).status, 201, email);
    assert.strictEqual((await post('/api/auth/login', { email, password: 'longenough1' })).status, 200, email);
  }
  for (const email of ['two words@x.com', 'a@b', 'a@@b.com', '@b.com']) {
    assert.strictEqual((await post('/api/auth/signup', { email, password: 'longenough1', username: 'person' + (++n) })).status, 400, email);
  }
});

test('signup: bad email, short or long password and bad username are 400', async () => {
  const bad = [
    { email: 'nope', password: 'longenough1', username: 'okname' },
    { email: 'a@b.co', password: 'short', username: 'okname' },
    { email: 'a@b.co', password: 'x'.repeat(73), username: 'okname' },
    { email: 'a@b.co', password: 'longenough1', username: 'no spaces!' },
    { email: 'a@b.co', password: 12345678, username: 'okname' },
    {},
  ];
  for (const body of bad) assert.strictEqual((await post('/api/auth/signup', body)).status, 400, JSON.stringify(body));
  assert.strictEqual((await apiSend('POST', '/api/auth/signup', { ip: ip() })).status, 400, 'no body at all');
});

test('signup: taken username, taken email and a project that needs email confirmation', async () => {
  assert.strictEqual((await post('/api/auth/signup', { email: 'a@b.co', password: 'longenough1', username: 'taken' })).status, 409);
  assert.strictEqual((await post('/api/auth/signup', { email: 'race@b.co', password: 'longenough1', username: 'freshname' })).status, 409, 'username taken a moment ago');
  const dup = await post('/api/auth/signup', { email: 'dup@b.co', password: 'longenough1', username: 'someone' });
  assert.strictEqual(dup.status, 409);
  assert.match(dup.body.error, /email/i);
  const conf = await post('/api/auth/signup', { email: 'confirm@b.co', password: 'longenough1', username: 'waiting' });
  assert.strictEqual(conf.status, 201);
  assert.strictEqual(conf.body.session, null);
  assert.match(conf.body.message, /email/i);
});

test('login: returns a session that works as a Bearer token', async () => {
  const r = await post('/api/auth/login', { email: 'me@example.com', password: 'whatever1' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.session.accessToken, 'token:tester');
  await wait();
  const me = await apiGet('/api/auth/me', { token: r.body.session.accessToken });
  assert.strictEqual(me.status, 200);
});

test('login: a wrong password and a malformed email get the same 401 answer', async () => {
  const wrong = await post('/api/auth/login', { email: 'bad@example.com', password: 'whatever1' });
  const malformed = await post('/api/auth/login', { email: 'not-an-email', password: 'whatever1' });
  const empty = await post('/api/auth/login', { email: 'me@example.com', password: '' });
  for (const r of [wrong, malformed, empty]) assert.strictEqual(r.status, 401);
  assert.strictEqual(wrong.body.error, malformed.body.error, 'nobody can tell which part was wrong');
  assert.ok(!('session' in wrong.body));
});

test('login: an outage is a 502 with a safe message, not the raw error', async () => {
  const r = await post('/api/auth/login', { email: 'boom@example.com', password: 'whatever1' });
  assert.strictEqual(r.status, 502);
  assert.ok(!/refused/i.test(r.body.error));
});

test('login: too many attempts from one address are a 429', async () => {
  const same = '203.0.113.9';
  let last;
  for (let i = 0; i < 11; i++) last = await apiSend('POST', '/api/auth/login', { body: { email: 'bad@example.com', password: 'x1234567' }, ip: same });
  assert.strictEqual(last.status, 429);
  const other = await apiSend('POST', '/api/auth/login', { body: { email: 'me@example.com', password: 'x1234567' }, ip: '203.0.113.10' });
  assert.strictEqual(other.status, 200, 'another address is not affected');
});

test('refresh: a good refresh token gives a new session; a bad or missing one is refused', async () => {
  const ok = await post('/api/auth/refresh', { refreshToken: 'r-tester' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.session.refreshToken, 'r-tester-2');
  assert.strictEqual((await post('/api/auth/refresh', { refreshToken: 'forged' })).status, 401);
  assert.strictEqual((await post('/api/auth/refresh', {})).status, 400);
});

test('me: needs a login and returns your profile without a player id', async () => {
  assert.strictEqual((await apiGet('/api/auth/me')).status, 401);
  await wait();
  const me = await apiGet('/api/auth/me', { token: 'token:me-user-1' });
  assert.strictEqual(me.status, 200);
  assert.strictEqual(me.body.username, 'tester');
  assert.strictEqual(me.body.rating, 1000);
  assert.ok(!JSON.stringify(me.body).includes('me-user-1'));
});

test('logout: needs a login and revokes the token it was called with', async () => {
  assert.strictEqual((await apiSend('POST', '/api/auth/logout', {})).status, 401);
  const r = await apiSend('POST', '/api/auth/logout', { token: 'token:logout-user-1' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body, { ok: true });
  assert.deepStrictEqual(called('signOut').pop(), ['signOut', 'token:logout-user-1']);
});
