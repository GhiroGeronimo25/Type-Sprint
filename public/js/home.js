// Home screen: quick match, create/join room, buttons
// ---------- home screen ----------
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('code').value = urlRoom.toUpperCase().slice(0, 4);

function onEntered(result) {
  if (!result || !result.ok) return showToast(result && result.error ? result.error : 'Something went wrong. Please try again.');
  showSearching(false);
  localStorage.setItem('session', result.code);
  history.replaceState(null, '', '?room=' + result.code);
  showScreen('room');
}

// every home-screen button goes through this: it says so when the connection is down or the server stays silent
function emitWithFeedback(event, payload, handler, onFail) {
  if (!socket.connected) {
    if (onFail) onFail();
    showToast('Not connected to the server yet. Reconnecting...');
    socket.connect();
    return;
  }
  let done = false;
  const timer = setTimeout(function () {
    if (done) return;
    done = true;
    if (onFail) onFail();
    showToast('The server did not answer. Please try again.');
  }, 10000);
  socket.emit(event, payload, function (res) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    handler(res);
  });
}

// ---------- quick match ----------
function showSearching(on) {
  $('searching').hidden = !on;
  $('quick').disabled = on;
  if (on) $('searchText').textContent = 'Searching for opponents...';
}

function quickMatch() {
  const mode = document.querySelector('input[name="mode"]:checked');
  const level = document.querySelector('input[name="difficulty"]:checked');
  emitWithFeedback('match:join', {
    name: $('name').value, pid: pid, ranked: !mode || mode.value === 'ranked', difficulty: level ? level.value : 'medium',
  }, function (res) {
    if (!res || !res.ok) return showToast(res && res.error ? res.error : 'Could not start searching.');
    showSearching(true);
  });
}

function cancelSearch() {
  socket.emit('match:cancel', {}, function () { showSearching(false); });
}

function onMatchStatus(data) {
  if ($('searching').hidden) return;
  const seconds = Math.round(data.waitedMs / 1000);
  $('searchText').textContent = 'Searching for opponents... ' + seconds + 's \u00b7 ' + data.searching +
    (data.searching === 1 ? ' player' : ' players') + ' searching';
}

// the server found a match and has already put us in the room
function onMatchFound(data) {
  onEntered({ ok: true, code: data.code });
}

function createRoom() {
  const mode = document.querySelector('input[name="mode"]:checked');
  const level = document.querySelector('input[name="difficulty"]:checked');
  emitWithFeedback('room:create', { name: $('name').value, pid: pid, ranked: !mode || mode.value === 'ranked', difficulty: level ? level.value : 'medium' }, onEntered);
}

function joinRoom() {
  emitWithFeedback('room:join', { name: $('name').value, code: $('code').value, pid: pid }, onEntered);
}

function onHomeKey(event) {
  if (event.key !== 'Enter') return;
  if ($('code').value.length >= 4) joinRoom();
  else if (!$('code').value) createRoom();
}

function leaveRoom() {
  localStorage.removeItem('session');
  socket.emit('room:leave');
  goHome();
  $('lobby').scrollIntoView(); // leaving lands on the open rooms list
}

function copyLink() {
  const link = location.origin + '/?room=' + state.room.code;
  navigator.clipboard.writeText(link).then(function () {
    showToast('Invite link copied');
  });
}

// Join stays disabled until a full four-letter code is typed
function syncJoin() {
  $('code').value = $('code').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  $('join').disabled = $('code').value.length < 4;
}
$('code').addEventListener('input', syncJoin);
syncJoin();

$('create').addEventListener('click', createRoom);
$('join').addEventListener('click', joinRoom);
$('quick').addEventListener('click', quickMatch);
$('cancelSearch').addEventListener('click', cancelSearch);
$('name').addEventListener('keydown', onHomeKey);
$('code').addEventListener('keydown', onHomeKey);
$('leave').addEventListener('click', leaveRoom);
$('copyLink').addEventListener('click', copyLink);

// The old browser-only "saved races" list is gone: race history lives on the account. Tidy up what it left behind.
try { localStorage.removeItem('records'); } catch (e) { /* storage can be blocked */ }
