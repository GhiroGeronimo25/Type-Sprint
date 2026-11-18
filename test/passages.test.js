'use strict';
const test = require('node:test');
const assert = require('node:assert');
const passages = require('../passages');

const avgWordLength = (list) => list.reduce((sum, t) => sum + t.replace(/ /g, '').length / t.split(' ').length, 0) / list.length;

test('the shipped bank is valid', () => {
  assert.deepStrictEqual(passages.validate(passages.BANK), []);
});

test('every difficulty has enough passages, all plain ASCII', () => {
  for (const level of passages.DIFFICULTIES) {
    assert.ok(passages.BANK[level].length >= 5, level + ' needs at least 5 passages');
    passages.BANK[level].forEach((text) => assert.match(text, /^[\x20-\x7E]+$/));
  }
});

test('harder levels really are harder: longer words, and hard has digits and punctuation', () => {
  const { easy, medium, hard } = passages.BANK;
  assert.ok(avgWordLength(easy) < avgWordLength(medium));
  assert.ok(avgWordLength(medium) < avgWordLength(hard));
  assert.ok(hard.every((t) => /\d/.test(t)), 'every hard passage contains a number');
  assert.ok(hard.every((t) => /[;"()]/.test(t)), 'every hard passage uses tougher punctuation');
  assert.ok(easy.every((t) => !/[\d;"()]/.test(t)), 'easy passages stay simple');
});

test('pick returns a passage from the asked difficulty', () => {
  for (const level of passages.DIFFICULTIES) {
    for (let i = 0; i < 30; i++) assert.ok(passages.BANK[level].includes(passages.pick(level)));
  }
});

test('pick never repeats the previous passage', () => {
  const previous = passages.BANK.hard[0];
  for (let i = 0; i < 100; i++) assert.notStrictEqual(passages.pick('hard', previous), previous);
});

test('an unknown difficulty falls back to the default', () => {
  assert.ok(passages.BANK[passages.DEFAULT_DIFFICULTY].includes(passages.pick('impossible')));
  assert.ok(passages.BANK[passages.DEFAULT_DIFFICULTY].includes(passages.pick(undefined)));
  assert.strictEqual(passages.isDifficulty('hard'), true);
  assert.strictEqual(passages.isDifficulty('__proto__'), false);
  assert.strictEqual(passages.isDifficulty(['hard']), false);
});

test('validate catches bad passages', () => {
  const make = () => JSON.parse(JSON.stringify(passages.BANK));
  const bad = (change) => { const b = make(); change(b); return passages.validate(b); };

  assert.ok(bad((b) => { b.easy[0] = 'Caf\u00e9 au lait is a nice drink to have in the morning with a friend or two on a calm day.'; }).some((p) => /ASCII/.test(p)));
  assert.ok(bad((b) => { b.easy[0] = b.easy[0] + ' '; }).some((p) => /start or end/.test(p)));
  assert.ok(bad((b) => { b.easy[0] = b.easy[0].replace('The cat', 'The  cat'); }).some((p) => /double space/.test(p)));
  assert.ok(bad((b) => { b.easy[0] = 'Too short.'; }).some((p) => /must be/.test(p)));
  assert.ok(bad((b) => { b.hard[0] = b.medium[0]; }).some((p) => /duplicate/.test(p)));
  assert.ok(bad((b) => { b.easy = b.easy.slice(0, 2); }).some((p) => /at least/.test(p)));
  assert.ok(bad((b) => { b.extreme = []; }).some((p) => /unknown difficulty/.test(p)));
});
