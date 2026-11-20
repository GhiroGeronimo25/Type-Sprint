// The socket connection and the tiny $ helper
// The socket stays disconnected until the player is logged in. Every (re)connect sends a fresh access token,
// and the server uses it to decide who this is.
const socket = io({
  autoConnect: false,
  auth: function (cb) {
    getAccessToken().then(function (token) { cb({ token: token }); });
  },
});

function $(id) {
  return document.getElementById(id);
}
