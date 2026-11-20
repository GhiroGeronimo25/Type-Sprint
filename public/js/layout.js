// Clock, fixed header and phone scrolling
// ---------- clock: countdown number and time left ----------
function updateClock() {
  const room = state.room;
  if (!room) return;
  const now = Date.now() + state.offset;

  if (room.status === 'countdown' && $('count')) {
    $('count').textContent = Math.max(1, Math.ceil((state.startAt - now) / 1000));
  }
  if (room.status === 'racing') $('statTime').textContent = formatTime(state.startAt + state.limitMs - now);
  else if (room.status === 'finished') $('statTime').textContent = 'Done';
  else $('statTime').textContent = formatTime(state.limitMs);
}

setInterval(updateClock, 100);

startAuth();


// ---------- fixed header: keep the page content clear of it ----------
(function () {
  const nav = $('topnav');
  function sync() {
    const phone = window.matchMedia('(max-width: 760px)').matches;
    const space = nav.hidden ? 0 : nav.offsetHeight + (phone ? 0 : 16);
    document.documentElement.style.setProperty('--nav-space', space + 'px');
  }
  new ResizeObserver(sync).observe(nav);
  new MutationObserver(sync).observe(nav, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('resize', sync);
  sync();
})();

// ---------- phones: the top menu slides away when you scroll down and comes back when you scroll up ----------
(function () {
  const nav = $('topnav');
  const phone = window.matchMedia('(max-width: 760px)');
  let lastY = window.scrollY;
  let waiting = false;
  function update() {
    waiting = false;
    const y = Math.max(0, window.scrollY);
    if (!phone.matches || y < 40) {
      nav.classList.remove('nav-hidden');
    } else if (Math.abs(y - lastY) > 6) {
      nav.classList.toggle('nav-hidden', y > lastY);
    }
    lastY = y;
  }
  window.addEventListener('scroll', function () {
    if (!waiting) { waiting = true; requestAnimationFrame(update); }
  }, { passive: true });
})();

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && !$('resultOverlay').hidden && $('closeResult')) $('closeResult').click();
});
