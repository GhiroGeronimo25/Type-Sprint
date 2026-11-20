// Drawing the room: lanes, panel, results
// ---------- drawing the room (runs on every server update) ----------
function render() {
  const room = state.room;
  const index = myIndex(room);
  if (index < 0) return;
  refreshChip();
  const me = room.players[index];
  const practice = !!room.practice; // racing alone is practice: nobody to beat, nothing won or lost
  const inLobby = !!me.lobby && room.status !== 'lobby'; // joined while a practice was on: waits in the lobby
  const labels = {
    lobby: room.players.length + ' in the room',
    countdown: 'Get ready',
    racing: practice ? 'Practice in progress' : 'Race in progress',
    finished: practice ? 'Practice finished' : 'Race finished',
  };

  $('roomCode').textContent = room.code;
  $('status').textContent = '';
  const main = document.createElement('span');
  main.textContent = inLobby ? 'In the lobby' : labels[room.status];
  const extra = document.createElement('span');
  extra.className = 'status-extra';
  extra.textContent = (practice && room.status !== 'lobby' ? '' : room.ranked ? ' \u00b7 Ranked' : ' \u00b7 Casual') + ' \u00b7 ' + capital(room.difficulty);
  $('status').appendChild(main);
  $('status').appendChild(extra);
  $('room').dataset.status = room.status;
  $('countOverlay').hidden = room.status !== 'countdown' || inLobby;
  // back to the room's waiting lobby: the host, when racing alone or once the race is over
  $('toLobby').hidden = !(room.hostId === socket.id && (room.status === 'finished' || (practice && room.status !== 'lobby')));
  $('room').dataset.solo = practice ? '1' : '0';
  $('stats').hidden = room.status === 'lobby' || inLobby;
  $('passage').hidden = room.status === 'lobby' || !state.text || inLobby;
  $('hint').hidden = room.status !== 'racing' || inLobby;
  $('statWpm').textContent = me.wpm;
  $('statAcc').textContent = me.accuracy;

  renderLanes(room);
  renderPanel(room, me, index + 1);
  saveLocalRace(room, me, index + 1);

  // you can only type while the race is on and you haven't finished
  const canType = room.status === 'racing' && me.entered && !me.finished;
  if (canType && $('typing').disabled) {
    const restore = state.restore;
    state.restore = '';
    $('typing').disabled = false;
    $('typing').value = restore;
    updatePassage(restore);
    $('typing').focus();
  }
  if (!canType) $('typing').disabled = true;
  updateTapHint();
}

function renderLanes(room) {
  let html = '';
  const waiting = [];
  const me = room.players[myIndex(room)];
  const meWaiting = !!me && !!me.lobby && room.status !== 'lobby';
  if (meWaiting && room.players.some(function (p) { return !p.lobby; })) html += '<p class="lane-title">' + (room.status === 'finished' ? 'Last practice' : 'Practicing now') + '</p>';
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p.lobby && room.status !== 'lobby') { waiting.push(p); continue; } // waiting in the lobby: not in the race
    let cls = 'lane';
    let name = esc(p.name);
    if (p.id === socket.id) {
      cls += ' me';
      name += ' <small>(you)</small>';
    }
    if (p.finished) cls += ' finished';
    if (p.away) cls += ' left';
    if (!p.entered && room.status !== 'lobby') {
      cls += ' watching';
      name += p.forfeited ? ' <small>(forfeited)</small>' : ' <small>(watching)</small>';
    }
    html += '<div class="' + cls + '">' +
      '<span class="rank">' + (i + 1) + '</span>' +
      '<span class="name">' + name + (room.ranked ? ' <small class="rating">' + p.rating + '</small>' : '') + '</span>' +
      '<div class="track"><div class="fill" style="width:' + (p.progress * 100).toFixed(1) + '%"></div></div>' +
      '<span class="speed"><b>' + p.wpm + '</b> wpm</span></div>';
  }
  if (waiting.length > 0 && !meWaiting) {
    html += '<p class="lane-note">In the lobby: ' + waiting.map(function (p) { return esc(p.name); }).join(', ') + '</p>';
  }
  $('lanes').innerHTML = html;
}

function capital(word) {
  word = String(word || 'medium');
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// the host picks how hard the next passage is; everyone else just sees it
function difficultyHtml(room, isHost) {
  if (!isHost) return '<p class="muted">Difficulty: ' + capital(room.difficulty) + '</p>';
  let html = '<div class="difficulty" role="group" aria-label="Passage difficulty"><span class="muted">Difficulty</span>';
  ['easy', 'medium', 'hard'].forEach(function (level) {
    html += '<button type="button" class="diff' + (room.difficulty === level ? ' on' : '') + '" data-difficulty="' + level +
      '" aria-pressed="' + (room.difficulty === level) + '">' + capital(level) + '</button>';
  });
  return html + '</div>';
}

function renderPanel(room, me, rank) {
  const isHost = room.hostId === socket.id;
  const winner = room.players[0];
  const practice = !!room.practice; // a solo practice run (others who joined wait in the lobby)
  let html = '';

  if (me.lobby && room.status !== 'lobby') {
    // joined while someone was practicing: this player is in the lobby, not in the practice
    const busy = room.status === 'countdown' || room.status === 'racing';
    const names = room.players.filter(function (p) { return !p.lobby; }).map(function (p) { return esc(p.name); }).join(', ');
    html = '<h2>You are in the lobby</h2>' +
      '<p class="share-line">Room code <strong>' + room.code + '</strong></p>' +
      (busy
        ? '<p class="practice-ind"><span class="dot"></span>' + (names || 'The host') + ' is practicing. You can join the next race when it is over.</p>'
        : '<p class="practice-ind idle">' + (names || 'The host') + ' finished practicing. Waiting for the next race.</p>');
    html += difficultyHtml(room, isHost && !busy);
    if (isHost && !busy) html += '<button id="start" class="btn" type="button">Start race</button>';
    else if (!isHost) html += '<p class="fine">Waiting for the host to start.</p>';
    $('resultOverlay').hidden = true;
    $('resultCard').innerHTML = '';
    $('panel').innerHTML = html;
    if ($('start')) $('start').addEventListener('click', startRace);
    document.querySelectorAll('#panel [data-difficulty]').forEach(function (button) {
      button.addEventListener('click', function () {
        socket.emit('room:difficulty', { difficulty: button.getAttribute('data-difficulty') });
      });
    });
    return;
  }

  if (room.status === 'lobby') {
    html = '<h2>' + (room.players.length === 1 ? 'Waiting for racers' : 'Ready to race') + '</h2>' +
      '<p class="share-line">Share the code <strong>' + room.code + '</strong> or tap it above to copy an invite link.</p>' +
      '<p class="fine">' + (room.ranked
        ? 'Ranked: ' + room.fee + ' coins per racer, rating changes. Leaving after the start forfeits your fee. Alone = free practice.'
        : 'Casual: free to play. No coins or rating changes.') + '</p>';
    html += difficultyHtml(room, isHost);
    if (isHost) html += '<button id="start" class="btn" type="button">' + (room.players.length === 1 ? 'Start practice' : 'Start race') + '</button>';
    else html += '<p>Waiting for the host to start.</p>';
  } else if (room.status === 'countdown') {
    html = ''; // the 3-2-1 is an overlay (#countOverlay), so the page does not jump
  } else if (room.status === 'finished') {
    if (me.forfeited) {
      html = '<h2>You forfeited this race</h2><p>You disconnected, so your ' + room.fee + '-coin entry fee stayed in the pot.';
    } else if (!me.entered) {
      html = '<h2>You watched this one</h2><p>You needed ' + room.fee + ' coins to enter.';
    } else if (practice && me.finished) {
      html = '<h2>Practice complete</h2><p>' + me.wpm + ' WPM, ' + me.accuracy +
        '% accuracy, ' + (me.finishMs / 1000).toFixed(1) + ' seconds.';
    } else if (practice) {
      html = "<h2>Time's up</h2><p>You reached " + Math.round(me.progress * 100) + '% at ' + me.wpm + ' WPM.';
    } else if (me.finished) {
      html = '<h2>You finished ' + ordinal(rank) + '</h2><p>' + me.wpm + ' WPM, ' + me.accuracy +
        '% accuracy, ' + (me.finishMs / 1000).toFixed(1) + ' seconds.';
    } else {
      html = "<h2>Time's up. You placed " + ordinal(rank) + '</h2><p>You reached ' +
        Math.round(me.progress * 100) + '% at ' + me.wpm + ' WPM.';
    }
    if (winner.finished && winner.id !== me.id) html += ' ' + esc(winner.name) + ' won at ' + winner.wpm + ' WPM.';
    html += '</p>';
    if (practice && me.entered) {
      // alone in the room: the fee is handed back and the rating stays put, so there is no payout table to show
      html += '<p class="muted">' + (room.ranked
        ? 'Practice run: it was free, and your rating did not change.'
        : 'Practice run: no coins or rating changed.') + '</p>';
    } else {
      html += resultHtml(me);
      if (!room.ranked) html += '<p class="muted">Casual race: no coins or rating changed.</p>';
    }
    html += difficultyHtml(room, isHost);
    const waitingNames = room.players.filter(function (p) { return p.lobby; }).map(function (p) { return esc(p.name); });
    if (waitingNames.length > 0) html += '<p class="muted">' + waitingNames.join(', ') + (waitingNames.length === 1 ? ' is' : ' are') + ' waiting in the lobby.</p>';
    if (isHost) html += '<button id="start" class="btn" type="button">' + (waitingNames.length > 0 ? 'Start race' : practice ? 'Practice again' : 'Race again') + '</button>';
    else html += '<p>Waiting for the host to start another race.</p>';
  }

  const finished = room.status === 'finished';
  if (!finished) state.resultDismissed = false;
  if (finished) {
    html += '<button id="closeResult" class="btn ghost result-close" type="button">Close</button>';
    $('resultCard').innerHTML = html;
    $('resultOverlay').hidden = state.resultDismissed;
    $('panel').innerHTML = state.resultDismissed
      ? '<button id="showResult" class="btn" type="button">Show results</button>' : '';
    if ($('showResult')) $('showResult').addEventListener('click', function () {
      state.resultDismissed = false;
      renderPanel(room, me, rank);
    });
    if ($('closeResult')) $('closeResult').addEventListener('click', function () {
      state.resultDismissed = true;
      renderPanel(room, me, rank);
    });
  } else {
    $('resultOverlay').hidden = true;
    $('resultCard').innerHTML = '';
    $('panel').innerHTML = html;
  }
  if ($('start')) $('start').addEventListener('click', startRace);
  document.querySelectorAll('#panel [data-difficulty], #resultCard [data-difficulty]').forEach(function (button) {
    button.addEventListener('click', function () {
      socket.emit('room:difficulty', { difficulty: button.getAttribute('data-difficulty') });
    });
  });
}

// what this race cost and paid, plus the rating change
function resultHtml(me) {
  const r = state.result;
  if (!me.entered || !r) return '';
  return '<ul class="payout">' +
    '<li><span>Entry fee</span><b class="out">' + signed(-r.fee) + '</b></li>' +
    '<li><span>Prize</span><b class="in">' + signed(r.payout) + '</b></li>' +
    '<li><span>Net coins</span><b class="' + (r.net < 0 ? 'out' : 'in') + '">' + signed(r.net) + '</b></li>' +
    '<li><span>Rating</span><b class="' + (r.ratingDelta < 0 ? 'out' : 'in') + '">' + r.ratingBefore + ' \u2192 ' + r.ratingAfter +
    ' (' + signed(r.ratingDelta) + ')</b></li></ul>';
}

$('toLobby').addEventListener('click', function () {
  socket.emit('room:lobby');
});

function startRace() {
  socket.emit('race:start');
}
