// The passage and typing
// ---------- the passage ----------
function buildPassage() {
  $('passage').textContent = '';
  state.chars = [];
  for (let i = 0; i < state.text.length; i++) {
    const span = document.createElement('span');
    span.textContent = state.text[i];
    $('passage').appendChild(span);
    state.chars.push(span);
  }
  updatePassage('');
}

// ok = typed right, bad = typed wrong, cur = the next letter to type
// wip = letters the phone keyboard is still building (not judged yet)
function updatePassage(input, pending) {
  pending = pending || 0;
  for (let i = 0; i < state.chars.length; i++) {
    let cls = '';
    if (i < input.length && input[i] === state.text[i]) cls = 'ok';
    else if (i < input.length) cls = 'bad';
    else if (i < input.length + pending) cls = 'wip';
    else if (i === input.length + pending) cls = 'cur';
    state.chars[i].className = cls;
  }
}



// ---------- typing ----------
// how many letters from `from` on are wrong (letters that match don't count)
function wrongAfter(input, text, from) {
  let n = 0;
  for (let i = from; i < input.length; i++) if (input[i] !== text[i]) n++;
  return n;
}

const MAX_WRONG = 10; // same limit as the server

// Phone keyboards swap plain characters for fancy ones (curly quotes, long dashes, odd spaces). The passage only
// uses plain ones, so treat them as the plain character (the server does the same).
function normalizeTyped(text) {
  return String(text)
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

let composing = false;   // a phone keyboard is in the middle of building a word: never rewrite the box now
let pendingReset = null; // the server's version of the text, to apply once the word is finished
let inputSeq = 0;        // numbers our messages so a late "go back" from the server can't undo newer typing
let lastSent = '';       // what the server last heard from us
const isTouch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

function setTypingValue(value) {
  const box = $('typing');
  box.value = value;
  try { box.setSelectionRange(value.length, value.length); } catch (e) { /* not every browser allows it */ }
}

// A stray key at the very start (for example tapped while the keyboard slides up) pushes every later letter one
// place out, so correct typing looks wrong. If dropping 1-3 leading keys makes what was typed match the start of
// the passage, drop them.
function dropStrayStart(value) {
  if (value.length < 4 || value[0] === state.text[0]) return value;
  for (let j = 1; j <= 3; j++) {
    const rest = value.slice(j);
    if (rest.length >= 3 && commonPrefix(rest, state.text) === rest.length) return rest;
  }
  return value;
}

// The box is only ever appended to or backspaced. If the phone moves the caret to the start, every new letter goes
// in front of the others and the text comes out backwards ("eht" for "the"): put the caret back at the end.
function caretToEnd() {
  const box = $('typing');
  const end = box.value.length;
  try {
    if (box.selectionStart !== end || box.selectionEnd !== end) box.setSelectionRange(end, end);
  } catch (e) { /* not every browser allows it */ }
}

function onTyping() {
  caretToEnd();
  const raw = $('typing').value;
  let full = normalizeTyped(raw);
  // Phone keyboards rewrite the word they are building (autocorrect, suggestions). That word is not final, so it
  // is not marked wrong and not sent until the keyboard commits it (space, punctuation or finishing the word).
  let pending = 0;
  if (composing) pending = full.length - (full.lastIndexOf(' ') + 1);
  let value = full.slice(0, full.length - pending);
  if (!composing) {
    const healed = dropStrayStart(value);
    if (healed !== value) { value = healed; setTypingValue(value); }
  }
  const correct = commonPrefix(value, state.text);
  let wrong = 0;
  let trimmed = false;
  for (let i = correct; i < value.length; i++) {
    if (value[i] !== state.text[i] && ++wrong > MAX_WRONG) { // stop piling up mistakes
      value = value.slice(0, i);
      trimmed = true;
      break;
    }
  }
  if (trimmed && !composing) setTypingValue(value);
  updatePassage(value, trimmed ? 0 : pending);
  if (value !== lastSent) { // nothing new to say while a word is only being rebuilt
    lastSent = value;
    socket.emit('race:input', { input: value, seq: ++inputSeq }); // the server decides what this is worth
  }
}

function onCompositionStart() {
  composing = true;
}

function onCompositionEnd() {
  composing = false;
  if (pendingReset !== null) { // the server rejected something while the word was being built
    const v = pendingReset;
    pendingReset = null;
    lastSent = v;
    setTypingValue(v);
    updatePassage(v);
    return;
  }
  onTyping(); // word finished: judge it now
}

function blockEvent(event) {
  event.preventDefault();
}

function refocus() {
  if (!$('typing').disabled && document.activeElement === document.body) $('typing').focus();
}

// Phones only open the keyboard when the player taps, so the passage is a big tap target and says so.
function focusTyping() {
  const box = $('typing');
  if (box.disabled) return;
  box.focus({ preventScroll: true });
  keepPassageVisible();
}

function updateTapHint() {
  const needsTap = isTouch && !$('typing').disabled && document.activeElement !== $('typing');
  $('passage').classList.toggle('tap-to-type', needsTap);
}

let scrollTimer = null;
function keepPassageVisible() { // the on-screen keyboard covers the bottom half: keep the passage above it
  if (!isTouch || $('passage').hidden) return;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(function () {
    $('passage').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 120);
}

$('typing').addEventListener('input', onTyping);
$('typing').addEventListener('compositionstart', onCompositionStart);
$('typing').addEventListener('compositionend', onCompositionEnd);
$('typing').addEventListener('focus', function () { caretToEnd(); updateTapHint(); keepPassageVisible(); });
$('typing').addEventListener('select', caretToEnd);
document.addEventListener('selectionchange', function () { if (document.activeElement === $('typing')) caretToEnd(); });
$('typing').addEventListener('blur', function () { composing = false; updateTapHint(); });
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', function () {
    if (document.activeElement === $('typing')) keepPassageVisible();
  });
}
if (isTouch) $('hint').textContent = 'Tap the passage if the keyboard closes.';
const blocked = ['paste', 'cut', 'drop'];
for (let i = 0; i < blocked.length; i++) $('typing').addEventListener(blocked[i], blockEvent);
$('passage').addEventListener('click', focusTyping);
document.addEventListener('keydown', refocus);
