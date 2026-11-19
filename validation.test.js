'use strict';
// The server, not the client, decides how a race is going. These tests behave like a cheating client:
// they paste the passage, send absurd speeds, make up stats, and check that only honest typing counts.
process.env.RACE_MS = '6000'; // long enough to test real timing
const test = require('node:test');
const assert = require('node:assert');
const { sleep, emits, connect, lastState } = require('./harness');

let n = 0;
async function startedRace(difficulty) {
  emits.length = 0;
  const a = connect();
  const made = await a.ask('room:create', { name: 'A', pid: 'val' + ++n, ranked: false, difficulty: difficulty || 'medium' });
  a.fire('race:start');
  await sleep(30);
  const text = [...emits].reverse().find((e) => e.ev === 'race:countdown').data.text;
  await sleep(150);                                    // the countdown is over, the race is on
  return { a, code: made.code, text };
}
const lane = (code) => lastState(code).players[0];
const resyncs = (a) => emits.filter((e) => e.ev === 'race:resync' && e.target === a.socket.id);
const finish = async ({ a }) => { a.fire('room:leave'); await sleep(30); };

test('the client has no event for reporting progress, speed or "I finished"', async () => {
  const race = await startedRace();
  const events = Object.keys(race.a.socket.handlers);
  assert.ok(events.includes('race:input'), 'typing goes through race:input');
  assert.deepStrictEqual(events.filter((e) => /progress|finish|wpm|accuracy|score|done|result|complete/i.test(e)), []);
  await finish(race);
});

test('stats the client makes up are ignored; the server works them out', async () => {
  const race = await startedRace();
  race.a.fire('race:input', { input: race.text.slice(0, 2), wpm: 999, accuracy: 100, progress: 1, finished: true, correct: 9999 });
  await sleep(150);                                    // the next live update
  const me = lane(race.code);
  assert.strictEqual(me.finished, false);
  assert.strictEqual(me.wpm, 24);                      // 2 correct letters = 0.4 words in the first (minimum) second
  assert.ok(Math.abs(me.progress - 2 / race.text.length) < 1e-9, 'progress is 2 letters of the passage');
  await finish(race);
});

test('pasting the whole passage is rejected and the client is put back', async () => {
  const race = await startedRace();
  race.a.fire('race:input', { input: race.text });
  await sleep(150);
  assert.strictEqual(resyncs(race.a).length, 1);
  assert.strictEqual(resyncs(race.a)[0].data.input, '');
  assert.strictEqual(lane(race.code).progress, 0);
  assert.strictEqual(lane(race.code).finished, false);
  await finish(race);
});

test('more than 4 new letters in one message counts as a paste, even a small one', async () => {
  const race = await startedRace();
  race.a.fire('race:input', { input: race.text.slice(0, 5) });         // 5 letters at once: inside the speed limit, but not typing
  assert.strictEqual(resyncs(race.a).length, 1);
  assert.strictEqual(resyncs(race.a)[0].data.input, '');
  race.a.fire('race:input', { input: race.text.slice(0, 4) });         // 4 letters: a fast typist's burst, fine
  assert.strictEqual(resyncs(race.a).length, 1, 'no further rejection');
  await sleep(150);
  assert.ok(Math.abs(lane(race.code).progress - 4 / race.text.length) < 1e-9);
  await finish(race);
});

test('typing faster than a human can is rejected', async () => {
  const race = await startedRace();
  for (let k = 1; k * 4 <= race.text.length && resyncs(race.a).length === 0; k++) {
    race.a.fire('race:input', { input: race.text.slice(0, k * 4) });  // 4 letters at a time, as fast as possible
  }
  assert.ok(resyncs(race.a).length >= 1, 'the burst was stopped');
  await sleep(150);
  const reached = Math.round(lane(race.code).progress * race.text.length);
  assert.ok(reached <= 25 * 1 + 5, 'it got only as far as a believable speed allows (' + reached + ' letters)');
  assert.strictEqual(lane(race.code).finished, false);
  await finish(race);
});

test('piling up wrong letters is rejected', async () => {
  const race = await startedRace();
  race.a.fire('race:input', { input: 'ZZZZ' });
  race.a.fire('race:input', { input: 'ZZZZZZZZ' });
  assert.strictEqual(resyncs(race.a).length, 0);
  race.a.fire('race:input', { input: 'ZZZZZZZZZZZZ' }); // 12 wrong letters in a row
  assert.strictEqual(resyncs(race.a).length, 1);
  assert.strictEqual(resyncs(race.a)[0].data.input, 'ZZZZZZZZ');
  await finish(race);
});

test('accuracy counts every key the server saw, and backspace does not erase a mistake', async () => {
  const race = await startedRace();
  race.a.fire('race:input', { input: race.text.slice(0, 3) + 'Z' });   // 3 right, 1 wrong
  await sleep(150);
  assert.strictEqual(lane(race.code).accuracy, 75);

  race.a.fire('race:input', { input: race.text.slice(0, 3) });         // backspace
  race.a.fire('race:input', { input: race.text.slice(0, 4) });         // the right letter
  await sleep(150);
  assert.strictEqual(lane(race.code).accuracy, 80);                    // 4 right of 5 keys: the mistake still counts
  await finish(race);
});

test('WPM, accuracy and progress keep updating live, with no message from the client', async () => {
  const race = await startedRace();
  race.a.fire('race:input', { input: race.text.slice(0, 3) });
  await sleep(150);
  assert.strictEqual(lane(race.code).wpm, 36);                         // 3 letters in the first second

  const before = emits.filter((e) => e.ev === 'room:state').length;
  await sleep(1800);                                                   // typing nothing
  const updates = emits.filter((e) => e.ev === 'room:state').length - before;
  assert.ok(updates >= 10, 'the scoreboard updates about ten times a second (' + updates + ' updates)');
  const me = lane(race.code);
  assert.ok(me.wpm > 0 && me.wpm < 36, 'WPM falls as time passes without typing (' + me.wpm + ')');
  assert.strictEqual(me.accuracy, 100);
  assert.ok(Math.abs(me.progress - 3 / race.text.length) < 1e-9);
  await finish(race);
});

test('honest typing at a believable speed finishes the race', async () => {
  const race = await startedRace('easy');
  await sleep(4000);                                                   // a fast typist needs a few seconds for ~95 letters
  for (let end = 4; ; end += 4) {
    race.a.fire('race:input', { input: race.text.slice(0, Math.min(end, race.text.length)) });
    if (end >= race.text.length) break;
  }
  assert.strictEqual(resyncs(race.a).length, 0, 'nothing honest was rejected');
  await sleep(150);
  const state = lastState(race.code);
  assert.strictEqual(state.status, 'finished');
  assert.strictEqual(state.players[0].finished, true);
  assert.strictEqual(state.players[0].progress, 1);
  assert.strictEqual(state.players[0].accuracy, 100);
  assert.ok(state.players[0].wpm > 0);
  await finish(race);
});
