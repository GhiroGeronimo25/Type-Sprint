'use strict';
// Stats and anti-cheat: what the server records about how people typed, and what it flags.
process.env.RACE_MS = '2200'; // long enough for realistic timing, short enough to wait for the end
const test = require('node:test');
const assert = require('node:assert');
const { sleep, emits, calls, connect } = require('./harness');

let n = 0;
async function startedRace(options) {
  emits.length = 0; calls.length = 0;
  const a = connect();
  const made = await a.ask('room:create', Object.assign({ name: 'A', pid: 'st' + ++n, ranked: false, difficulty: 'medium' }, options));
  a.fire('race:start');
  await sleep(30);
  const text = [...emits].reverse().find((e) => e.ev === 'race:countdown').data.text;
  await sleep(150);                                    // the race is on
  return { a, code: made.code, text, pid: 'st' + n };
}
const saved = () => calls.filter((c) => c[0] === 'recordRaceStats');
const reasons = (player) => player.flags.map((f) => f.reason).sort();
const resyncs = (a) => emits.filter((e) => e.ev === 'race:resync' && e.target === a.socket.id);
const raceEnds = () => sleep(2300);                    // the 2.2 second race hits its time limit

test('an honest race is saved with its stats, its missed letters and no flags', async () => {
  const race = await startedRace();
  race.a.fire('race:input', { input: race.text.slice(0, 3) + 'Z' });   // 3 right, then a wrong letter
  race.a.fire('race:input', { input: race.text.slice(0, 3) });         // backspace
  race.a.fire('race:input', { input: race.text.slice(0, 4) });         // the right letter
  await raceEnds();

  assert.strictEqual(saved().length, 1);
  const [, code, ranked, difficulty, players] = saved()[0];
  assert.strictEqual(code, race.code);
  assert.strictEqual(ranked, false);
  assert.strictEqual(difficulty, 'medium');
  assert.strictEqual(players.length, 1);
  const me = players[0];
  assert.strictEqual(me.pid, race.pid);
  assert.strictEqual(me.accuracy, 80);                                 // 4 right letters out of 5 keys
  assert.strictEqual(me.finished, false);
  assert.ok(Math.abs(me.progress - (4 / race.text.length) * 100) < 0.1, 'progress is a percentage of the passage');
  assert.deepStrictEqual(me.missed, { [race.text[3]]: 1 }, 'the letter they should have typed is counted once');
  assert.deepStrictEqual(me.flags, []);
  race.a.fire('room:leave');
  await sleep(30);
});

test('a racer who types nothing is not saved', async () => {
  const race = await startedRace();
  const b = connect();
  race.a.fire('race:input', { input: race.text.slice(0, 2) });
  await raceEnds();
  assert.strictEqual(saved().length, 1);
  assert.strictEqual(saved()[0][4].length, 1);
  race.a.fire('room:leave'); b.fire('room:leave');
  await sleep(30);
});

test('a ranked race saves its stats too, marked ranked', async () => {
  const race = await startedRace({ ranked: true, difficulty: 'hard' });
  race.a.fire('race:input', { input: race.text.slice(0, 2) });
  await raceEnds();
  assert.strictEqual(saved().length, 1);
  assert.strictEqual(saved()[0][2], true);
  assert.strictEqual(saved()[0][3], 'hard');
  race.a.fire('room:leave');
  await sleep(30);
});

test('pasting is rejected and flagged, even if nothing else was typed', async () => {
  const race = await startedRace();
  race.a.fire('race:input', { input: race.text });                     // the whole passage in one go
  await raceEnds();
  assert.strictEqual(resyncs(race.a).length, 1, 'the paste was rejected');
  const me = saved()[0][4][0];
  assert.deepStrictEqual(reasons(me), ['paste']);
  assert.strictEqual(me.progress, 0, 'it earned nothing');
  race.a.fire('room:leave');
  await sleep(30);
});

test('typing faster than any human is rejected and flagged', async () => {
  const race = await startedRace();
  for (let k = 1; k * 4 <= race.text.length && resyncs(race.a).length === 0; k++) {
    race.a.fire('race:input', { input: race.text.slice(0, k * 4) });
  }
  await raceEnds();
  assert.ok(resyncs(race.a).length >= 1);
  const me = saved()[0][4][0];
  assert.ok(reasons(me).includes('burst'));
  assert.ok(!reasons(me).includes('paste'), 'a burst of 4 letters at a time is not a paste');
  race.a.fire('room:leave');
  await sleep(30);
});

test('an average speed no human sustains is flagged, though every message was accepted', async () => {
  const race = await startedRace();
  await sleep(1550);                                                   // about 1.6 seconds into the race
  for (let end = 4; end <= 40; end += 4) {
    race.a.fire('race:input', { input: race.text.slice(0, end) });     // 40 letters: allowed by the speed limit by a hair
  }
  assert.strictEqual(resyncs(race.a).length, 0, 'nothing was rejected, so this test is measuring the average-speed flag');
  await raceEnds();
  const me = saved()[0][4][0];
  assert.deepStrictEqual(reasons(me), ['speed']);
  assert.match(me.flags[0].detail, /WPM after 40 letters/);
  race.a.fire('room:leave');
  await sleep(30);
});

test('a short fast burst is never flagged as an unsustainable average (it needs 40 letters)', async () => {
  const race = await startedRace();
  await sleep(1000);
  for (let end = 4; end <= 28; end += 4) {                             // 28 letters in about a second: the WPM looks huge, but it is only 28 letters
    race.a.fire('race:input', { input: race.text.slice(0, end) });
  }
  await raceEnds();
  assert.deepStrictEqual(saved()[0][4][0].flags, []);
  race.a.fire('room:leave');
  await sleep(30);
});
