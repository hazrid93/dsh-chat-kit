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

  var STICK_PX = 24;
  var following = true;
  var ready = false;
  var jumping = false;

  function atBottom() {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= STICK_PX;
  }

  function updateJump() {
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
    if (event.kind === 'advice') {
      return '<li class="step advice"><span class="dot"></span><div class="body">' +
        '<div class="head"><span class="who">Advisor &middot; ' + esc(event.hint || 'note') + '</span><span class="at">' + at + 's</span></div>' +
        '<div class="trace">' + esc(event.trace || '') + '</div></div></li>';
    }
    if (event.kind === 'followup') {
      return '<li class="step followup"><span class="dot"></span><div class="body">' +
        '<div class="head"><span class="who">Follow-up after advice</span><span class="at">' + at + 's</span></div>' +
        '<div class="trace">' + esc(event.trace || '') + '</div></div></li>';
    }
    if (event.kind === 'reasoning' || event.kind === 'thinking') {
      var who = event.child ? 'Subagent thinking' : 'Thinking';
      return '<li class="step reasoning"><span class="dot"></span><div class="body">' +
        '<div class="head"><span class="who">' + who + '</span><span class="at">' + at + 's</span></div>' +
        '<div class="trace">' + esc(event.trace || 'Thinking…') + '</div></div></li>';
    }
    var took = event.durationMs == null ? '' : Math.max(1, Math.round(event.durationMs / 1000)) + 's';
    var hint = event.hint ? ' <span class="hint">' + esc(event.hint) + '</span>' : '';
    var child = event.child ? '<span class="child">subagent</span>' : '';
    var io = '';
    if (event.request) io += '<details data-key="' + index + '-req"><summary>request</summary><pre>' + esc(event.request) + '</pre></details>';
    if (event.response) io += '<details data-key="' + index + '-res"><summary>response</summary><pre>' + esc(event.response) + '</pre></details>';
    return '<li class="step tool ' + esc(event.status) + '"><span class="dot"></span><div class="body">' +
      '<div class="head">' + child + '<code>' + esc(event.tool) + '</code>' + hint +
      '<span class="at">' + esc(event.status) + (took ? ' &middot; ' + took : '') + '</span></div>' +
      (io ? '<div class="io">' + io + '</div>' : '') + '</div></li>';
  }

  function statsHtml(snap) {
    var events = snap.events || [];
    var tools = events.filter(function (e) { return e.kind === 'tool'; });
    var failed = tools.filter(function (e) { return e.status === 'error'; }).length;
    var abandoned = tools.filter(function (e) { return e.status === 'abandoned'; }).length;
    var thinking = events.filter(function (e) { return e.kind === 'reasoning'; }).length;
    var advice = events.filter(function (e) { return e.kind === 'advice'; }).length;
    var childSteps = events.filter(function (e) { return e.child; }).length;
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
      advice ? cell(advice, 'advisor') : '',
      cell(Math.round(toolMs / 1000) + 's', 'in tools'),
      childSteps ? cell(childSteps, 'by subagents') : '',
    ].join('');
  }

  function render(snap) {
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
      } else {
        result.innerHTML = '<h2>No reply</h2><p class="answer">The turn ended without producing an answer, so nothing was sent to the chat.</p>';
      }
    }

    if (stick) toBottom(false);
    else updateJump();
    ready = true;
  }

  ready = true;
  toBottom(false);
  updateJump();

  if (!document.querySelector('meta[name="mirror-live"]')) return;
  if (!window.EventSource) return;

  var base = location.pathname;
  if (base.slice(-1) === '/') base = base.slice(0, -1);
  var es = new EventSource(base + '/stream');
  es.onmessage = function (e) {
    try { render(JSON.parse(e.data)); } catch (_) {}
  };
  window.addEventListener('pagehide', function () { es.close(); });
})();
