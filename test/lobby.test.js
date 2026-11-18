'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { connect, emits, sleep } = require('./harness');

const watch = async (p) => (await p.ask('lobby:watch', {})).rooms;

test('an open room shows up in the live lobby with its host and seats, and no player ids', async () => {
  const host = connect(); const watcher = connect();
  const made = await host.ask('room:create', { name: 'LobbyHost', pid: 'lobby-host-1', ranked: false, difficulty: 'hard' });
  assert.ok(made.ok);
  const row = (await watch(watcher)).find((r) => r.code === made.code);
  assert.ok(row, 'the new room is listed');
  assert.strictEqual(row.host, 'LobbyHost');
  assert.strictEqual(row.ranked, false);
  assert.strictEqual(row.difficulty, 'hard');
  assert.strictEqual(row.players, 1);
  assert.strictEqual(row.max, 5);
  assert.ok(!JSON.stringify(row).includes('lobby-host-1'), 'a pid must never reach the lobby');
});

test('the lobby is pushed to watchers when rooms change', async () => {
  const watcher = connect();
  await watch(watcher);
  const before = emits.filter((e) => e.ev === 'lobby:rooms').length;
  const host = connect();
  const made = await host.ask('room:create', { name: 'PushHost', pid: 'lobby-host-2', ranked: false });
  await sleep(400);
  const pushes = emits.filter((e) => e.ev === 'lobby:rooms');
  assert.ok(pushes.length > before, 'a lobby:rooms message was sent');
  assert.ok(pushes[pushes.length - 1].data.rooms.some((r) => r.code === made.code));
  assert.strictEqual(pushes[pushes.length - 1].target, 'lobby');
});

test('a full room, and a room that was left empty, are not listed', async () => {
  const host = connect();
  const made = await host.ask('room:create', { name: 'FullHost', pid: 'lobby-full-0', ranked: false });
  for (let i = 1; i < 5; i++) {
    const joined = await connect().ask('room:join', { name: 'F' + i, pid: 'lobby-full-' + i, code: made.code });
    assert.ok(joined.ok);
  }
  const watcher = connect();
  assert.ok(!(await watch(watcher)).some((r) => r.code === made.code), 'full room hidden');

  const solo = connect();
  const room2 = await solo.ask('room:create', { name: 'Gone', pid: 'lobby-gone', ranked: false });
  assert.ok((await watch(watcher)).some((r) => r.code === room2.code));
  solo.fire('room:leave');
  assert.ok(!(await watch(watcher)).some((r) => r.code === room2.code), 'an empty room disappears');
});

test('a player who is already in a room cannot watch the lobby', async () => {
  const p = connect();
  await p.ask('room:create', { name: 'Busy', pid: 'lobby-busy', ranked: false });
  const res = await p.ask('lobby:watch', {});
  assert.strictEqual(res.ok, false);
});
