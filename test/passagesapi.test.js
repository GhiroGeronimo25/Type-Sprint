'use strict';
const test = require('node:test');
const assert = require('node:assert');
const passages = require('../passages');
const { apiGet } = require('./harness');

test('passage bank API: summary of every difficulty, no login needed', async () => {
  const r = await apiGet('/api/passages');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.default, 'medium');
  assert.deepStrictEqual(r.body.difficulties.map((d) => d.difficulty), ['easy', 'medium', 'hard']);
  for (const d of r.body.difficulties) {
    assert.strictEqual(d.count, passages.BANK[d.difficulty].length);
    assert.ok(d.avgWords > 0 && d.minCharacters <= d.avgCharacters && d.avgCharacters <= d.maxCharacters);
  }
  assert.ok(r.body.difficulties[0].avgWords < r.body.difficulties[2].avgWords, 'hard passages are longer than easy ones');
});

test('passage bank API: one difficulty lists its passages with sizes and a short preview', async () => {
  const r = await apiGet('/api/passages/:difficulty', { params: { difficulty: 'Hard' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.difficulty, 'hard');
  assert.strictEqual(r.body.items.length, passages.BANK.hard.length);
  assert.deepStrictEqual(r.body.items.map((p) => p.id), r.body.items.map((_, i) => i + 1));
  r.body.items.forEach((item, i) => {
    assert.strictEqual(item.characters, passages.BANK.hard[i].length);
    assert.ok(item.preview.length < item.characters / 2, 'only a short preview');
  });
});

test('passage bank API never leaks a full passage text', async () => {
  const all = JSON.stringify([await apiGet('/api/passages')].concat(
    await Promise.all(['easy', 'medium', 'hard'].map((d) => apiGet('/api/passages/:difficulty', { params: { difficulty: d } })))));
  for (const level of passages.DIFFICULTIES) {
    for (const text of passages.BANK[level]) assert.ok(!all.includes(JSON.stringify(text).slice(1, -1)), 'a full passage was exposed');
  }
});

test('passage bank API: an unknown difficulty is a 404', async () => {
  assert.strictEqual((await apiGet('/api/passages/:difficulty', { params: { difficulty: 'impossible' } })).status, 404);
  assert.strictEqual((await apiGet('/api/passages/:difficulty', { params: { difficulty: '../etc' } })).status, 404);
});
