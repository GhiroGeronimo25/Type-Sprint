'use strict';

// The text bank. Every passage is plain printable ASCII (letters, digits and ordinary punctuation only),
// so it can be typed on any keyboard layout. Passages are grouped by difficulty:
//   easy   - short, everyday words, just commas and full stops
//   medium - a full paragraph of ordinary prose
//   hard   - longer words, digits, quotes, brackets, semicolons and hyphens
// The server picks a passage from the room's difficulty; clients never choose or send passage text.

const DIFFICULTIES = ['easy', 'medium', 'hard'];
const DEFAULT_DIFFICULTY = 'medium';

const BANK = {
  easy: [
    'The cat sat on the warm mat and looked out at the quiet street. It was a good day to rest.',
    'We went to the park after lunch. The sun was out, the kids ran fast, and we all had a lot of fun.',
    'I like to make tea in the morning. It is hot and sweet, and it helps me think about the day ahead.',
    'My dog likes to run on the beach. He jumps in the waves and then comes back to dry off in the sun.',
    'The bus was late again, so we sat by the road and talked. It was a nice way to spend the time.',
    'She put the book on the shelf and went to bed. The house was quiet, and the night was calm.',
  ],
  medium: [
    'The lighthouse keeper climbed the spiral stairs every evening, counting each step out of habit. By the time the lamp caught fire, the whole coast knew that another night had safely begun.',
    'A good sprint is not about hitting every key as hard as possible. It is about finding a rhythm, trusting your fingers, and letting the words arrive one after another without hurry.',
    'Rain tapped against the window of the little train while the fields outside turned from green to silver. Nobody spoke, and somehow that made the whole journey feel like a shared secret.',
    'The market opened before sunrise, and by seven the air smelled of fresh bread, warm oranges, and coffee. Vendors shouted prices across the aisles as if the whole city were a friendly auction.',
    'When the power went out, the neighbors gathered on the stairs with candles and half-finished stories. By midnight, strangers were sharing blankets, and the building felt more like a village.',
    'Every great project begins with a messy first draft. Write it quickly, fix it slowly, and remember that the person who finishes a rough version beats the person still polishing page one.',
    'The mountain trail curved along a cold river before climbing into the pines. At the summit, the clouds parted just long enough to show a valley full of tiny lights and quiet roofs.',
    'She tuned the old piano by ear, listening for the tiny wobble between two strings. When the wobble finally disappeared, the room seemed to exhale and every note rang clear.',
  ],
  hard: [
    'The committee\'s 2024 report, which took eighteen months to prepare, concluded that infrastructure spending (particularly on railways) must increase; otherwise, regional economies will stagnate.',
    'Photosynthesis converts sunlight, water, and carbon dioxide into glucose; this extraordinary process, refined over 3 billion years, quietly sustains nearly every ecosystem on Earth, including our own.',
    '"Efficiency," the consultant said, "is not merely working faster; it is eliminating unnecessary steps." Nevertheless, several departments resisted, citing budget constraints and 12 pending audits.',
    'Between 1998 and 2006, the observatory catalogued 4,112 distinct celestial objects; astronomers subsequently reclassified roughly one-third of them after reviewing improved spectroscopic measurements.',
    'Although the recipe requires precisely 250 grams of flour, 3 eggs, and a teaspoon of baking soda (level, not heaped), experienced bakers often adjust quantities according to humidity and altitude.',
    'Cryptographic protocols depend on mathematical problems that are easy to verify yet extraordinarily difficult to solve; consequently, even a 1% algorithmic improvement can undermine security assumptions.',
  ],
};

// What a passage of each difficulty must look like. A passage outside its range is almost certainly in the wrong
// group, so the server refuses to start rather than quietly serve it.
const RULES = {
  easy:   { minLength: 70,  maxLength: 130 },
  medium: { minLength: 150, maxLength: 210 },
  hard:   { minLength: 170, maxLength: 260 },
};
const MIN_PER_LEVEL = 5; // enough that back-to-back races rarely repeat

// Returns a list of problems with a bank (empty if it is fine).
function validate(bank) {
  const problems = [];
  const seen = {};
  DIFFICULTIES.forEach(function (level) {
    const list = bank[level];
    if (!Array.isArray(list) || list.length < MIN_PER_LEVEL) {
      problems.push(level + ': needs at least ' + MIN_PER_LEVEL + ' passages');
      return;
    }
    list.forEach(function (text, i) {
      const where = level + ' #' + (i + 1);
      if (typeof text !== 'string' || text.length === 0) { problems.push(where + ': is empty'); return; }
      if (!/^[\x20-\x7E]+$/.test(text)) problems.push(where + ': has a character that is not plain printable ASCII');
      if (text !== text.trim()) problems.push(where + ': has spaces at the start or end');
      if (/ {2}/.test(text)) problems.push(where + ': has a double space');
      const rule = RULES[level];
      if (text.length < rule.minLength || text.length > rule.maxLength) {
        problems.push(where + ': is ' + text.length + ' characters, but ' + level + ' passages must be ' + rule.minLength + '-' + rule.maxLength);
      }
      if (seen[text]) problems.push(where + ': is a duplicate of ' + seen[text]);
      seen[text] = where;
    });
  });
  Object.keys(bank).forEach(function (level) {
    if (DIFFICULTIES.indexOf(level) < 0) problems.push('unknown difficulty "' + level + '"');
  });
  return problems;
}

const problems = validate(BANK);
if (problems.length > 0) {
  throw new Error('The text bank (passages.js) is invalid:\n - ' + problems.join('\n - '));
}

function isDifficulty(value) {
  return typeof value === 'string' && DIFFICULTIES.indexOf(value) >= 0;
}

// Picks a random passage of the given difficulty (unknown values fall back to the default).
// previous: the passage just raced, so a room doesn't get the same one twice in a row.
function pick(difficulty, previous) {
  const list = BANK[isDifficulty(difficulty) ? difficulty : DEFAULT_DIFFICULTY];
  const options = list.length > 1 ? list.filter(function (text) { return text !== previous; }) : list;
  return options[Math.floor(Math.random() * options.length)];
}

// ---------- read-only description of the bank, for the REST API ----------
// The API never returns a passage's full text: players must not be able to read (or memorise) the text
// before a race. It describes the bank instead: sizes, and a short preview of how each passage starts.
const DESCRIPTIONS = {
  easy: 'Short, everyday words with just commas and full stops.',
  medium: 'A full paragraph of ordinary prose.',
  hard: 'Longer words, digits, quotes, brackets, semicolons and hyphens.',
};
const PREVIEW_WORDS = 5;

function wordCount(text) { return text.split(' ').length; }

function summary() {
  return DIFFICULTIES.map(function (level) {
    const list = BANK[level];
    const lengths = list.map(function (t) { return t.length; });
    const words = list.map(wordCount);
    const avg = function (a) { return Math.round(a.reduce(function (x, y) { return x + y; }, 0) / a.length); };
    return {
      difficulty: level, description: DESCRIPTIONS[level], count: list.length,
      avgWords: avg(words), avgCharacters: avg(lengths), minCharacters: Math.min.apply(null, lengths), maxCharacters: Math.max.apply(null, lengths),
    };
  });
}

// the passages of one difficulty, as { id, words, characters, preview } (id counts from 1)
function describe(level) {
  if (!isDifficulty(level)) return null;
  return BANK[level].map(function (text, i) {
    return { id: i + 1, words: wordCount(text), characters: text.length, preview: text.split(' ').slice(0, PREVIEW_WORDS).join(' ') + '\u2026' };
  });
}

module.exports = { summary: summary, describe: describe, DEFAULT_DIFFICULTY: DEFAULT_DIFFICULTY, isDifficulty: isDifficulty, pick: pick };
