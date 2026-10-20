/**
 * Public read-only mirror page for one DSH request.
 *
 * Reachable at /api/chat/mirror/:id — the id is a 24-hex capability token,
 * so no login is needed (same trust model as the existing history route) but
 * the page exposes only what mirror-store.js recorded.
 *
 * Served under /api/ so nginx routes it to this app; see
 * docs/DSH_SESSION_MIRROR.md for the routing note.
 */
import { Router } from 'express';
import path from 'node:path';
import { getMirror, subscribeMirror } from './mirror-store.js';

const router = Router();

const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

const seconds = (from, to) => Math.max(0, Math.round((to - from) / 1000));

/**
 * Cheap change detector for a snapshot. Event count plus the newest timestamp
 * plus the done flag is enough: a step that only updates a duration still
 * changes the timestamp of its row.
 */
const signatureOf = (m) =>
  `${m.events.length}:${m.events.at(-1)?.at ?? 0}:${m.done ? 1 : 0}:${m.finishedAt ?? 0}`;

/**
 * Metrics for the header. Counts read the same way the rows do, so a reader can
 * check "3 tools, 1 failed" against what the trace shows.
 */
function metricsOf(mirror) {
  const events = mirror.events ?? [];
  const tools = events.filter((e) => e.kind === 'tool');
  const failed = tools.filter((e) => e.status === 'error').length;
  const abandoned = tools.filter((e) => e.status === 'abandoned').length;
  const thinking = events.filter((e) => e.kind === 'reasoning').length;
  const toolMs = tools.reduce((sum, e) => sum + (e.durationMs ?? 0), 0);
  const end = mirror.finishedAt ?? Date.now();
  const elapsed = Math.max(mirror.events?.length ? 1 : 0, Math.round((end - mirror.startedAt) / 1000));
  const last = events.at(-1);
  return {
    elapsed,
    tools: tools.length,
    failed,
    abandoned,
    thinking,
    toolSeconds: Math.round(toolMs / 1000),
    steps: events.length,
    waitingOn: !mirror.done && last?.status === 'running' ? last.tool : '',
  };
}

function statsHtml(mirror) {
  const m = metricsOf(mirror);
  const cell = (value, label, cls = '') =>
    `<div class="stat ${cls}"><b>${escapeHtml(String(value))}</b><span>${escapeHtml(label)}</span></div>`;
  return [
    cell(`${m.elapsed}s`, 'elapsed'),
    cell(m.tools, 'tools'),
    m.failed ? cell(m.failed, 'failed', 'bad') : '',
    m.abandoned ? cell(m.abandoned, 'cut off') : '',
    cell(m.thinking, 'thinking'),
    cell(`${m.toolSeconds}s`, 'in tools'),
  ].join('');
}

function renderPage(mirror, base = '') {
  const end = mirror.finishedAt ?? Date.now();
  // A row written directly (or read back from Postgres) can lack a useful
  // start time; never render a negative or zero-length duration as history.
  const elapsed = Math.max(mirror.events.length ? 1 : 0, seconds(mirror.startedAt, end));
  const rows = mirror.events
    .map((event) => {
      const offset = seconds(mirror.startedAt, event.at);

      if (event.kind === 'reasoning' || event.kind === 'thinking') {
        const trace = event.trace ? escapeHtml(event.trace) : 'Thinking…';
        return `<li class="step reasoning"><span class="dot"></span>
          <div class="body"><div class="head"><span class="who">Thinking</span><span class="at">${offset}s</span></div>
          <div class="trace">${trace}</div></div></li>`;
      }

      const took =
        event.durationMs == null ? '' : `${Math.max(1, Math.round(event.durationMs / 1000))}s`;
      const hint = event.hint ? ` <span class="hint">${escapeHtml(event.hint)}</span>` : '';
      const request = event.request
        ? `<details><summary>request</summary><pre>${escapeHtml(event.request)}</pre></details>`
        : '';
      const response = event.response
        ? `<details><summary>response</summary><pre>${escapeHtml(event.response)}</pre></details>`
        : '';
      const detail = request || response ? `<div class="io">${request}${response}</div>` : '';
      return `<li class="step tool ${escapeHtml(event.status)}">
        <span class="dot"></span>
        <div class="body">
          <div class="head">
            <code>${escapeHtml(event.tool)}</code>${hint}
            <span class="at">${escapeHtml(event.status)}${took ? ` · ${took}` : ''}</span>
          </div>
          ${detail}
        </div>
      </li>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${mirror.done ? '' : '<meta name="mirror-live" content="1">'}
<title>Request progress</title>
<style>
  :root { color-scheme: dark; --edge: #1b2430; --muted: #93a4b8; --dim: #6b7c91; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: #0b0f14; color: #e8eef6;
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }

  /* Fixed viewport: header and footer stay put, the trace scrolls between them. */
  main { height: 100dvh; display: flex; flex-direction: column;
         width: min(56rem, 100%); margin: 0 auto; }

  header { flex: none; padding: 1rem 1.25rem .75rem; border-bottom: 1px solid var(--edge); }
  h1 { margin: 0 0 .2rem; font-size: 1.05rem; font-weight: 600; }
  .q { margin: 0; color: var(--muted); font-size: .9rem; overflow: hidden;
       display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }

  .stats { display: flex; flex-wrap: wrap; gap: .4rem; margin: .7rem 0 0; }
  .stat { display: flex; align-items: baseline; gap: .35rem; padding: .2rem .55rem;
          border: 1px solid var(--edge); border-radius: 999px; background: #0f151d; }
  .stat b { font-size: .95rem; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat span { color: var(--dim); font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; }
  .stat.bad b { color: #eb5757; }
  .stat.good b { color: #27ae60; }

  .scroll { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain;
            padding: .5rem 1.25rem 1rem; scrollbar-gutter: stable; }
  .scroll:focus-visible { outline: 2px solid #2f80ed; outline-offset: -2px; }

  ol { list-style: none; margin: 0; padding: 0; }
  .step { display: flex; align-items: flex-start; gap: .75rem; padding: .55rem 0;
          border-bottom: 1px solid var(--edge); font-size: .95rem; }
  .step .dot { margin-top: .45rem; }
  .body { flex: 1; min-width: 0; }
  .head { display: flex; align-items: baseline; gap: .5rem; }
  .who { color: #9db2c8; font-size: .9rem; }
  .head .at { margin-left: auto; }
  .trace { margin: .35rem 0 0; padding: .6rem .75rem; border-left: 2px solid #2a3a4d;
           background: #0f151d; border-radius: 0 .35rem .35rem 0; color: #a9bacd;
           font-size: .88rem; white-space: pre-wrap; }
  .io { margin-top: .4rem; }
  .io details { margin-top: .3rem; }
  .io summary { cursor: pointer; color: #7f95ab; font-size: .8rem; }
  .io pre { margin: .3rem 0 0; padding: .6rem .7rem; background: #0f151d; border: 1px solid var(--edge);
            border-radius: .35rem; overflow-x: auto; font-size: .78rem; line-height: 1.45;
            white-space: pre-wrap; word-break: break-word; color: #b9c8d8; }
  .dot { width: .5rem; height: .5rem; border-radius: 50%; background: #2f80ed; flex: none; }
  .step.ok .dot { background: #27ae60; }
  .step.error .dot { background: #eb5757; }
  .step.abandoned .dot { background: #6b7c91; }
  .step.running .dot { animation: pulse 1.1s ease-in-out infinite; }
  .step.reasoning .dot { background: #7c5cff; }
  code { font: .85em/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
         background: #16202c; border: 1px solid #22303f; border-radius: .3rem; padding: .1rem .35rem; }
  .hint { color: var(--muted); font-size: .88em; }
  .label { flex: 1; }
  .at { color: var(--dim); font-size: .85rem; font-variant-numeric: tabular-nums; }
  .answer { white-space: pre-wrap; margin: .35rem 0 0; padding: 1rem; border-radius: .6rem;
            background: #121a24; border: 1px solid var(--edge); font-size: .95rem; }
  #result h2 { margin: 1.5rem 0 .5rem; font-size: 1rem; font-weight: 600; }

  footer { flex: none; padding: .6rem 1.25rem; border-top: 1px solid var(--edge);
           color: #5b6b7f; font-size: .8rem; display: flex; gap: .75rem; align-items: center; }
  footer .spacer { flex: 1; }

  /* Jump-to-latest, shown only while the reader is scrolled up. */
  #jump { position: fixed; right: 1.25rem; bottom: 4.25rem; width: 2.75rem; height: 2.75rem;
          border-radius: 50%; border: 1px solid #2a3a4d; background: #16202c; color: #e8eef6;
          font-size: 1.15rem; cursor: pointer; display: grid; place-items: center;
          box-shadow: 0 6px 20px rgba(0,0,0,.45); transition: opacity .15s, transform .15s; }
  #jump[hidden] { display: none; }
  #jump:hover { background: #1d2a38; transform: translateY(-1px); }

  @keyframes pulse { 50% { opacity: .25; } }
  @media (prefers-reduced-motion: reduce) {
    .step.running .dot { animation: none; }
    #jump { transition: none; }
  }
</style>
</head>
<body>
<main data-mirror-id="${escapeHtml(mirror.id)}" data-mirror-started="${mirror.startedAt}">
  <header>
    <h1 id="title">${mirror.done ? (mirror.error ? 'Request stopped' : 'Request finished') : 'Working on your request'}</h1>
    <p class="q">${escapeHtml(mirror.question)}</p>
    <div class="stats" id="stats">${statsHtml(mirror)}</div>
  </header>

  <div class="scroll" id="scroll" tabindex="0">
    <ol id="steps">${rows}${mirror.done ? '' : `<li class="step running"><span class="dot"></span><span class="label">Still working</span><span class="at">${elapsed}s</span></li>`}</ol>
    <div id="result">${mirror.done && mirror.answer ? `<h2>Result</h2><p class="answer">${escapeHtml(mirror.answer)}</p>` : ''}</div>
  </div>

  <footer>
    <span id="status">${mirror.done ? `Finished in ${elapsed}s.` : `Started ${elapsed}s ago.`}</span>
    <span class="spacer"></span>
    <span>Read-only · expires in 6 hours</span>
  </footer>

  <button id="jump" type="button" title="Jump to latest" aria-label="Jump to latest" hidden>↓</button>
</main>
<script src="${base}/mirror-client.js" defer></script>
</body>
</html>`;
}

/**
 * The page's client script, served as a file.
 *
 * helmet's default Content-Security-Policy is `script-src 'self'`, which blocks
 * an inline <script> outright — the page rendered but never went live. Serving
 * it here keeps the strict policy intact instead of weakening it with
 * 'unsafe-inline'.
 */
router.get('/mirror-client.js', (_req, res) => {
  res.type('application/javascript').set('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(import.meta.dirname, '..', '..', 'public', 'mirror-client.js'));
});

router.get('/mirror/:id', async (req, res) => {
  const mirror = await getMirror(req.params.id);
  if (!mirror) return res.status(404).type('html').send('<p>This progress link has expired or does not exist.</p>');
  res.type('html').set('Cache-Control', 'no-store, max-age=0').send(renderPage(mirror, req.baseUrl));
});

/**
 * Live updates for one request (server-sent events).
 *
 * The page is pushed the whole event list on every change and redraws in place.
 * A reload would jump the scroll and collapse open panels; this does not.
 * nginx already sets `proxy_buffering off` for /api/chat/, so no header games.
 */
router.get('/mirror/:id/stream', async (req, res) => {
  const mirror = await getMirror(req.params.id);
  if (!mirror) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send(mirror);
  if (mirror.done) return res.end();

  // Two sources, because they cover different processes.
  //
  // `subscribeMirror` is instant but in-process: the turn runs in the bot, whose
  // memory this server cannot see, so its notify() never reaches this stream.
  // The store flushes to Postgres every ~700ms, so polling that row is what
  // actually delivers live updates here. The subscription stays as the fast
  // path for any turn this process itself wrote.
  let signature = signatureOf(mirror);

  const push = (snapshot) => {
    const next = signatureOf(snapshot);
    if (next === signature) return false;
    signature = next;
    send(snapshot);
    return true;
  };

  const unsubscribe = subscribeMirror(mirror.id, (snapshot) => {
    const finished = push(snapshot) && snapshot.done;
    if (finished) {
      unsubscribe();
      res.end();
    }
  });

  const poll = setInterval(async () => {
    const snapshot = await getMirror(mirror.id).catch(() => null);
    if (!snapshot) return;
    const sent = push(snapshot);
    if (sent && snapshot.done) {
      clearInterval(poll);
      unsubscribe();
      res.end();
    }
  }, 1000);
  poll.unref?.();

  // Keeps proxies and browsers from dropping an otherwise idle stream.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  heartbeat.unref?.();

  req.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(poll);
    unsubscribe();
  });
});

/** JSON form, for the WhatsApp layer or a dashboard to poll. */
router.get('/mirror/:id/json', async (req, res) => {
  const mirror = await getMirror(req.params.id);
  if (!mirror) return res.status(404).json({ error: 'expired or unknown' });
  res.json(mirror);
});

export default router;
