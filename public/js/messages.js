// Messages from the server (room state, countdown, connect)
// ---------- messages from the server ----------
function onRoomState(snapshot) {
  state.room = snapshot;
  state.offset = snapshot.serverNow - Date.now();
  render();
}

function onCountdown(data) {
  state.text = data.text;
  state.startAt = data.startAt;
  state.limitMs = data.limitMs;
  state.offset = data.serverNow - Date.now();
  state.restore = '';
  state.result = null;
  composing = false;
  pendingReset = null;
  lastSent = '';
  $('typing').value = '';
  buildPassage();
}

// the server rejected our typing (for example a paste), so go back to its version
function onResync(data) {
  if (typeof data.seq === 'number' && data.seq !== inputSeq) return; // we have typed since: a newer message decides
  if (composing) { pendingReset = data.input; return; } // changing the box mid-word scrambles phone keyboards
  lastSent = data.input;
  setTypingValue(data.input);
  updatePassage(data.input);
}

function onDisconnect() {
  if (state.room) showToast('Connection lost. Reconnecting...');
}

// on every (re)connect, take our seat back if we were in a room
function onConnect() {
  showSearching(false); // a dropped connection also dropped our place in the queue
  watchLobby();
  socket.emit('account:get', { pid: pid }, function (res) {
    if (res && res.ok) setAccount(res.account);
  });
  loadStats();
  const code = localStorage.getItem('session');
  if (!code) return;
  if (urlRoom && urlRoom.toUpperCase().slice(0, 4) !== code) return; // opened an invite to another room
  socket.emit('room:rejoin', { code: code, pid: pid }, onRejoined);
}

function onRejoined(result) {
  if (!result.ok) {
    localStorage.removeItem('session');
    if (state.room) {
      goHome();
      showToast(result.error);
    }
    return;
  }
  state.text = result.text || '';
  state.startAt = result.startAt;
  state.limitMs = result.limitMs;
  state.offset = result.serverNow - Date.now();
  state.restore = $('typing').disabled ? result.input : '';
  state.result = result.result || null;
  if (state.text) buildPassage();
  history.replaceState(null, '', '?room=' + result.code);
  showScreen('room');
  if (state.room) {
    showToast('Back in the room');
    render();
  }
}

socket.on('connect', onConnect);
socket.on('room:state', onRoomState);
socket.on('race:countdown', onCountdown);
socket.on('race:resync', onResync);
socket.on('account:state', setAccount);
socket.on('race:result', onResult);
socket.on('race:notice', function (data) { showToast(data.message); });
socket.on('match:status', onMatchStatus);
socket.on('match:found', onMatchFound);
socket.on('disconnect', onDisconnect);
socket.on('connect_error', function (err) {
  if (!err || err.message !== 'unauthorized') showToast('Cannot reach the server. Retrying...');
  if (err && err.message === 'unauthorized') {
    showToast('Your login expired. Please log in again.');
    if (supa) supa.auth.signOut();
  }
});
