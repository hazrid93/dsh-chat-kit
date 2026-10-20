(function () {
  var main = document.querySelector('main');
  var id = main.getAttribute('data-mirror-id');
  var startedAt = Number(main.getAttribute('data-mirror-started'));
  var steps = document.getElementById('steps');
  var result = document.getElementById('result');
  var stats = document.getElementById('stats');
  var status = document.getElementById('status');
  var title = document.getElementById('title');
  var scroll = document.getElementById('scroll');
  var jump = document.getElementById('jump');

  // ── follow tail ───────────────────────────────────────────────────────────
  // Autoscroll only while the reader is at the bottom. Scrolling up is a signal
  // that they are reading, so following stops until they return to the bottom
  // or press the jump button.
  var STICK_PX = 24;
  var following = true;
  // The browser fires a scroll event while laying out the first paint, before
  // any render has run. Treating that as "the reader scrolled up" left a live
  // page stuck at the top, so intent only counts after the first render.
  var ready = false;
  // A smooth scroll emits its own scroll events; without this flag they look
  // like the reader scrolling up and cancel the jump mid-animation.
  var jumping = false;

  function atBottom() {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= STICK_PX;
  }

  function updateJump() {
    // Hidden while following, and also when the content fits (nothing to jump to).
    var overflowing = scroll.scrollHeight > scroll.clientHeight + STICK_PX;
    jump.hidden = following || !overflowing;
  }

  function toBottom(smooth) {
    following = true;
    jumping = Boolean(smooth);
    updateJump();
    var top = scroll.scrollHeight;
    if (smooth && scroll.scrollTo) scroll.scrollTo({ top: top, behavior: 'smooth' });
    else scroll.scrollTop = top;
    if (jumping) {
      // Safety: if the animation is interrupted, resume following anyway.
      setTimeout(function () { jumping = false; updateJump(); }, 700);
    }
  }

  scroll.addEventListener('scroll', function () {
    if (!ready) return;
    var bottom = atBottom();
    if (jumping) {
      if (bottom) jumping = false;
      updateJump();
      return;
    }
    if (bottom && !following) following = true;
    else if (!bottom && following) following = false;
    updateJump();
  }, { passive: true });

  jump.addEventListener('click', function () { toBottom(true); });

  // ── details state survives a redraw ──────────────────────────────────────
  var open = new Set();
  function rememberOpen() {
    open.clear();
    steps.querySelectorAll('details[open]').forEach(function (d) {
      open.add(d.getAttribute('data-key'));
    });
  }
  function restoreOpen() {
    steps.querySelectorAll('details').forEach(function (d) {
      if (open.has(d.getAttribute('data-key'))) d.open = true;
    });
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function secs(at) { return Math.max(0, Math.round((at - startedAt) / 1000)); }

  function row(event, index) {
    var at = secs(event.at);
    if (event.kind === 'reasoning' || event.kind === 'thinking') {
      return '<li class="step reasoning"><span class="dot"></span><div class="body">' +
        '<div class="head"><span class="who">Thinking</span><span class="at">' + at + 's</span></div>' +
        '<div class="trace">' + esc(event.trace || 'Thinking…') + '</div></div></li>';
    }
    var took = event.durationMs == null ? '' : Math.max(1, Math.round(event.durationMs / 1000)) + 's';
    var hint = event.hint ? ' <span class="hint">' + esc(event.hint) + '</span>' : '';
    var io = '';
    if (event.request) io += '<details data-key="' + index + '-req"><summary>request</summary><pre>' + esc(event.request) + '</pre></details>';
    if (event.response) io += '<details data-key="' + index + '-res"><summary>response</summary><pre>' + esc(event.response) + '</pre></details>';
    return '<li class="step tool ' + esc(event.status) + '"><span class="dot"></span><div class="body">' +
      '<div class="head"><code>' + esc(event.tool) + '</code>' + hint +
      '<span class="at">' + esc(event.status) + (took ? ' &middot; ' + took : '') + '</span></div>' +
      (io ? '<div class="io">' + io + '</div>' : '') + '</div></li>';
  }

  function statsHtml(snap) {
    var events = snap.events || [];
    var tools = events.filter(function (e) { return e.kind === 'tool'; });
    var failed = tools.filter(function (e) { return e.status === 'error'; }).length;
    var abandoned = tools.filter(function (e) { return e.status === 'abandoned'; }).length;
    var thinking = events.filter(function (e) { return e.kind === 'reasoning'; }).length;
    var toolMs = tools.reduce(function (sum, e) { return sum + (e.durationMs || 0); }, 0);
    var elapsed = Math.max(events.length ? 1 : 0, Math.round(((snap.finishedAt || Date.now()) - startedAt) / 1000));
    var cell = function (value, label, cls) {
      return '<div class="stat ' + (cls || '') + '"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>';
    };
    return [
      cell(elapsed + 's', 'elapsed'),
      cell(tools.length, 'tools'),
      failed ? cell(failed, 'failed', 'bad') : '',
      abandoned ? cell(abandoned, 'cut off') : '',
      cell(thinking, 'thinking'),
      cell(Math.round(toolMs / 1000) + 's', 'in tools'),
    ].join('');
  }

  function render(snap) {
    // Capture scroll intent before the DOM changes: rewriting innerHTML can
    // otherwise move the viewport out from under the reader.
    var stick = following || atBottom();

    rememberOpen();
    var html = snap.events.map(row).join('');
    if (!snap.done) html += '<li class="step running"><span class="dot"></span><span class="label">Still working</span></li>';
    steps.innerHTML = html;
    restoreOpen();

    stats.innerHTML = statsHtml(snap);

    var elapsed = Math.max(snap.events.length ? 1 : 0, Math.round(((snap.finishedAt || Date.now()) - startedAt) / 1000));
    status.textContent = snap.done ? 'Finished in ' + elapsed + 's.' : 'Started ' + elapsed + 's ago.';

    if (snap.done) {
      if (title) title.textContent = snap.error ? 'Request stopped' : 'Request finished';
      if (snap.answer) {
        result.innerHTML = '<h2>Result</h2><p class="answer">' + esc(snap.answer) + '</p>';
      }
    }

    if (stick) toBottom(false);
    else updateJump();
    ready = true;
  }

  // A finished page has no stream, but it still scrolls: arm the handlers
  // first, otherwise scrolling up on it never reveals the jump button.
  ready = true;
  // Open at the latest state when the trace overflows: on a finished page the
  // result is at the bottom, and on a live one the newest step is too.
  toBottom(false);
  updateJump();

  if (!document.querySelector('meta[name="mirror-live"]')) return;
  if (!window.EventSource) return;

  // Derive the stream path from the page path so the same markup works whether
  // the router is mounted at /api/chat or at the root (tests, other hosts).
  var base = location.pathname;
  if (base.slice(-1) === '/') base = base.slice(0, -1);
  var es = new EventSource(base + '/stream');
  es.onmessage = function (e) {
    try { render(JSON.parse(e.data)); } catch (_) {}
  };
  window.addEventListener('pagehide', function () { es.close(); });
})();
