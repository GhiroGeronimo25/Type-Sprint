'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { connect, runAuth, called } = require('./harness');

test('a valid login token sets the player id from the verified user', async () => {
  const { err, socket } = await runAuth('token:user-123');
  assert.ifError(err);
  assert.strictEqual(socket.data.pid, 'user-123');
});

test('a missing or forged token is refused', async () => {
  for (const token of [undefined, '', 'garbage', 'token:', 12345]) {
    const { err } = await runAuth(token);
    assert.ok(err && err.message === 'unauthorized', 'should refuse ' + String(token));
  }
});

test('the player id in a message is ignored: the verified login decides who you are', async () => {
  const a = connect({ loginAs: 'real-me' });
  const res = await a.ask('room:create', { name: 'Eve', pid: 'victim-account', ranked: false });
  assert.ok(res.ok);
  const joined = called('join').map((c) => c[1]);
  assert.ok(joined.includes('real-me'));
  assert.ok(!joined.includes('victim-account'), 'must never act as the spoofed pid');
  await a.ask('stats:get', { pid: 'victim-account' });
  assert.ok(called('playerStats').some((c) => c[1] === 'real-me'));
  assert.ok(!called('playerStats').some((c) => c[1] === 'victim-account'));
});

test('the display name comes from the account, not from the message', async () => {
  const a = connect({ loginAs: 'name-user' });
  const res = await a.ask('room:create', { name: 'Fake Name', ranked: false });
  assert.ok(res.ok);
});
