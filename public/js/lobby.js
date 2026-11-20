// Live list of open rooms
// ---------- live lobby: open rooms ----------
function watchLobby() {
  socket.emit('lobby:watch', {}, function (res) {
    if (res && res.ok) renderLobby(res.rooms);
  });
}

function renderLobby(rooms) {
  rooms = rooms || [];
  $('lobbyEmpty').hidden = rooms.length > 0;
  let html = '';
  for (let i = 0; i < rooms.length; i++) {
    const r = rooms[i];
    html += '<li class="lobby-row">' +
      '<span class="share-line">' + esc(r.code) + '</span>' +
      '<span class="lobby-host">' + esc(r.host) + '<small>' + (r.ranked ? 'Ranked \u00b7 ' + r.fee + ' coins' : 'Casual \u00b7 free') + ' \u00b7 ' + esc(capital(r.difficulty)) + (r.practicing ? ' \u00b7 <span class="badge-practice">Practicing now</span>' : '') + '</small></span>' +
      '<span class="lobby-seats">' + r.players + '/' + r.max + '</span>' +
      '<button class="btn secondary" type="button" data-code="' + esc(r.code) + '">Join</button></li>';
  }
  $('lobbyList').innerHTML = html;
}

$('lobbyList').addEventListener('click', function (event) {
  const button = event.target.closest('button[data-code]');
  if (!button) return;
  button.disabled = true;
  socket.emit('room:join', { name: $('name').value, code: button.getAttribute('data-code'), pid: pid }, function (result) {
    button.disabled = false;
    onEntered(result);
  });
});
socket.on('lobby:rooms', function (data) { renderLobby((data || {}).rooms); });
