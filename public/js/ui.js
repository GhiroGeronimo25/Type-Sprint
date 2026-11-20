// Shared helpers, tabs and screens
// ---------- helpers ----------
function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function ordinal(n) {
  const suffixes = ['th', 'st', 'nd', 'rd'];
  if (n % 100 >= 11 && n % 100 <= 13) return n + 'th';
  if (n % 10 <= 3) return n + suffixes[n % 10];
  return n + 'th';
}

function formatTime(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function myIndex(room) {
  for (let i = 0; i < room.players.length; i++) {
    if (room.players[i].id === socket.id) return i;
  }
  return -1;
}

function showToast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  setTimeout(hideToast, 3000);
}

function hideToast() {
  $('toast').classList.remove('show');
}

const TABS = ['play', 'stats', 'wallet', 'board'];
let currentTab = 'play';

function tabFromHash() {
  const t = location.hash.replace('#', '');
  return TABS.indexOf(t) >= 0 ? t : 'play';
}

function setTab(tab, pushHash) {
  if (TABS.indexOf(tab) < 0) tab = 'play';
  currentTab = tab;
  $('home').setAttribute('data-tab', tab);
  const buttons = document.querySelectorAll('#tabs .navtab');
  for (let i = 0; i < buttons.length; i++) {
    const on = buttons[i].getAttribute('data-nav') === tab;
    if (on) buttons[i].setAttribute('aria-current', 'page');
    else buttons[i].removeAttribute('aria-current');
  }
  if (pushHash !== false && !state.room) history.replaceState(null, '', (location.search || '') + '#' + tab);
  updateEmptyStates();
  if (!$('home').hidden) window.scrollTo(0, 0);
}

function updateEmptyStates() {
  // friendly messages when a tab would otherwise be blank
  $('statsEmpty').hidden = currentTab !== 'stats' || !$('raceHistory').hidden || !$('myStats').hidden;
  $('boardEmpty').hidden = currentTab !== 'board' || !$('board').hidden;
}

function showScreen(name) {
  $('auth').hidden = name !== 'auth';
  $('topnav').hidden = name !== 'home';
  $('home').hidden = name !== 'home';
  $('room').hidden = name !== 'room';
  document.body.classList.toggle('has-nav', name === 'home');
  if (name === 'home') setTab(tabFromHash(), false);
  window.scrollTo(0, 0);
}

document.addEventListener('click', function (event) {
  const nav = event.target.closest('[data-nav]');
  if (!nav) return;
  event.preventDefault();
  if (state.room) return; // never switch tabs while racing
  setTab(nav.getAttribute('data-nav'));
});
window.addEventListener('hashchange', function () {
  if (!$('home').hidden) setTab(tabFromHash(), false);
});

function goHome() {
  watchLobby();
  state.room = null;
  state.text = '';
  $('typing').disabled = true;
  history.replaceState(null, '', location.pathname + '#play');
  showScreen('home');
  loadStats();
}
