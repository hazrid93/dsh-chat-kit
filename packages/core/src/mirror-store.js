/**
 * Read-only session mirror, persisted in Postgres.
 *
 * DSH's own web GUI cannot be linked to a WhatsApp user: its launch token mints
 * an owner credential over every session on the host. This module keeps a small
 * projection instead — one turn's tool activity, addressed by an unguessable id,
 * expiring.
 *
 * What is stored, to make the page read like the DSH web session view: the
 * thinking trace, every tool call with its request and response, status and
 * duration, and the final answer.
 * What is still removed: credentials, tokens, emails, phone numbers, absolute
 * paths, and anything from another chat.
 *
 * Writes are coalesced: tool events arrive in bursts, and one UPDATE per event
 * would be chatter against the shared pool. A row is written at open, flushed at
 * most once per FLUSH_MS, and always on finish.
 */
import { randomBytes } from 'node:crypto';

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const MAX_ANSWER_CHARS = 4000;
const MAX_HINT_CHARS = 80;
const MAX_TRACE_CHARS = 6000;
const MAX_EVENTS = 200;

/**
 * Budget for one request or response body. The session view wants the payload,
 * not a summary, but a fetched page can be hundreds of kilobytes, so the tail
 * is cut and the cut is stated.
 */
function clip(text, limit = MAX_TRACE_CHARS) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…[${value.length - limit} more characters cut]`;
}

const FLUSH_MS = 700;
// Must exceed the turn hard cap (LLM_HARD_CAP_MS, 1h) so a live turn is never stale.
const STALE_MS = 65 * 60 * 1000;

/** id -> entry, only while the request is live. Finished rows live in Postgres. */
const live = new Map();
const flushTimers = new Map();
/** id -> Set of listeners, for pages watching a request live. */
const subscribers = new Map();

/** Injected by the host so this module never owns a pool. */
let query = null;
let TABLES = { mirrors: 'request_mirrors' };

/**
 * Give the store a query function and optional table names.
 *
 * @param {(sql: string, params?: unknown[]) => Promise<{rows: any[], rowCount: number|null}>} poolQuery
 * @param {{mirrors?: string}} [tables]
 */
export function attachMirrorStore(poolQuery, tables = {}) {
  query = poolQuery;
  TABLES = { ...TABLES, ...tables };
}

const db = () => query;

const SAFE_TOOL = /^[A-Za-z0-9_.:-]{1,60}$/;

/**
 * Wire names are historical (`ollama_web_search` predates the provider
 * abstraction) and mean nothing to a WhatsApp user, who only cares what the
 * agent did. Show intent, not the tool's internal name.
 */
const DISPLAY_NAMES = {
  ollama_web_search: 'web_search',
  web_fetch_all: 'web_fetch',
  web_fetch: 'web_fetch',
  write_website_file: 'write_file',
  edit_website_file: 'edit_file',
  read_website_file: 'read_file',
  list_website_files: 'list_files',
  conversation_recall: 'recall_conversation',
  research_recall: 'recall_research',
};

const displayName = (tool) => DISPLAY_NAMES[tool] ?? tool;

/**
 * Remove what must not appear on a public page: credentials, emails, phone
 * numbers, and absolute paths. Long values are clipped.
 */
function scrub(value) {
  let text = String(value).replace(/\s+/g, ' ').trim();
  text = text.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]');
  text = text.replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]');
  text = text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]');
  text = text.replace(/\+?\d[\d\s()-]{7,}\d/g, '[number]');
  // Absolute filesystem paths only. A URL such as example.com/review stays read-
  // able, because "what page was read" is the point of the hint.
  text = text.replace(/(?:^|\s)(\/(?:[\w.@-]+\/){1,}[\w.@-]*)/g, ' [path]');
  if (text.length > MAX_HINT_CHARS) text = `${text.slice(0, MAX_HINT_CHARS - 1)}…`;
  return text;
}

/**
 * A one-line hint a person may read. Raw arguments are never stored; this keeps
 * only the field that says what the call was about, then scrubs it.
 */
function hintFrom(args) {
  if (!args || typeof args !== 'object') return '';
  // Only fields that describe the call. File paths are deliberately absent:
  // "what was read" does not need the location, and locations leak.
  const first = Array.isArray(args.urls) ? args.urls[0] : Array.isArray(args.queries) ? args.queries[0] : '';
  const candidate =
    args.query ?? args.url ?? first ?? args.title ?? args.prompt ?? args.project_name ?? args.name ?? '';
  if (typeof candidate !== 'string' || !candidate.trim()) return '';
  return scrub(candidate);
}

async function flush(id, pending) {
  const timer = flushTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(id);
  }
  // `pending` lets the caller flush an entry it is about to evict; reading from
  // `live` alone would skip the final write after a delete.
  const entry = pending ?? live.get(id);
  if (!entry || !db()) return;
  try {
    await db()(
      `UPDATE ${TABLES.mirrors}
          SET events = $2::jsonb, answer = $3, done = $4, error = $5, finished_at = $6
        WHERE id = $1`,
      [
        entry.id,
        JSON.stringify(entry.events),
        entry.answer,
        entry.done,
        entry.error,
        entry.finishedAt ? new Date(entry.finishedAt) : null,
      ]
    );
  } catch (error) {
    console.error('[Mirror] flush failed:', error.message);
  }
}

/**
 * Wake every page watching this request.
 *
 * The page is updated by push, not by reloading: a reload resets scroll and
 * collapses the panels the reader just opened.
 */
function notify(id) {
  const listeners = subscribers.get(id);
  if (!listeners) return;
  const entry = live.get(id);
  if (!entry) return;
  const snapshot = shape(entry);
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch {
      /* a dead page must not break the turn */
    }
  }
}

/** Watch one live request. Returns an unsubscribe function. */
export function subscribeMirror(id, listener) {
  const key = String(id ?? '');
  if (!/^[a-f0-9]{24}$/.test(key)) return () => {};
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key).add(listener);
  return () => {
    const set = subscribers.get(key);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) subscribers.delete(key);
  };
}

function scheduleFlush(id) {
  if (flushTimers.has(id)) return;
  flushTimers.set(
    id,
    setTimeout(() => {
      flushTimers.delete(id);
      flush(id);
    }, FLUSH_MS)
  );
  // Never hold the process open for a status page.
  flushTimers.get(id).unref?.();
}

/** Open a mirror for one request. Returns the id used in the public URL. */
export async function openMirror({ chatId, question }) {
  prune();
  const id = randomBytes(12).toString('hex');
  const entry = {
    id,
    chatId: chatId ? String(chatId) : null,
    question: String(question ?? '').slice(0, 300),
    startedAt: Date.now(),
    finishedAt: null,
    events: [],
    answer: '',
    done: false,
    error: false,
  };

  if (db()) {
    try {
      await db()(
        `INSERT INTO ${TABLES.mirrors} (id, chat_id, question, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '6 hours')`,
        [id, entry.chatId, entry.question]
      );
    } catch (error) {
      console.error('[Mirror] insert failed:', error.message);
    }
  }

  live.set(id, entry);
  return id;
}

/**
 * Record one event. Every tool call is kept under its real name — someone
 * watching a long turn wants to know what actually ran, not a category.
 *
 * Accepted shapes:
 *  - { type: 'tool_start',  tool, args }               → new running row
 *  - { type: 'tool_result', tool, status, durationMs } → settle the newest row
 *  - { type: 'step_start' } | { type: 'step/start' }   → "Thinking"
 *  - { type: 'tool/call', name }                       → DSH-shaped call
 * Anything else is dropped here, so reasoning never reaches the store.
 */
export function recordMirrorEvent(id, event) {
  const entry = live.get(id);
  if (!entry || entry.done || !event) return;
  if (entry.events.length >= MAX_EVENTS) return;

  const at = Date.now();
  let changed = false;

  if (event.type === 'reasoning') {
    const text = clip(redact(String(event.text ?? '').trim()));
    if (!text) return;
    // Reasoning is per step; keep it as its own trace row so the page reads in
    // order alongside the calls it produced.
    entry.events.push({
      kind: 'reasoning',
      tool: '',
      hint: '',
      status: 'ok',
      at,
      durationMs: null,
      trace: text,
    });
    changed = true;
  } else if (event.type === 'tool_start' || event.type === 'tool/call') {
    const tool = String(event.tool ?? event.name ?? '').trim();
    if (!SAFE_TOOL.test(tool)) return;
    // Each call is its own row: repeats are facts, not noise to collapse.
    entry.events.push({
      kind: 'tool',
      tool: displayName(tool),
      callId: event.callId ?? null,
      hint: hintFrom(event.args),
      status: 'running',
      at,
      durationMs: null,
      request: clip(redact(String(event.arguments ?? ''))),
      response: '',
    });
    changed = true;
  } else if (event.type === 'tool_result') {
    const tool = String(event.tool ?? '').trim();
    for (let i = entry.events.length - 1; i >= 0; i -= 1) {
      const row = entry.events[i];
      const matches = event.callId ? row.callId === event.callId : !tool || row.tool === displayName(tool);
      if (row.kind === 'tool' && row.status === 'running' && matches) {
        row.status = event.status === 'error' ? 'error' : 'ok';
        row.durationMs = Number.isFinite(event.durationMs) ? event.durationMs : at - row.at;
        if (event.result !== undefined) row.response = clip(redact(String(event.result)));
        changed = true;
        break;
      }
    }
  }
  // step_start is deliberately not recorded: it used to add an empty
  // "Thinking…" row, and real reasoning blocks now follow it. The running page
  // already says "Still working" at the tail.

  if (changed) {
    notify(id);
    scheduleFlush(id);
  }
}

/** Close the mirror with the answer the user already received. */
export function finishMirror(id, { answer, error = false } = {}) {
  const entry = live.get(id);
  if (!entry || entry.done) return;
  const at = Date.now();
  // A tool still marked running never reported back. Say so; never invent a result.
  for (const row of entry.events) {
    if (row.status === 'running') {
      row.status = error ? 'error' : 'abandoned';
      row.durationMs = at - row.at;
    }
  }
  entry.done = true;
  entry.error = Boolean(error);
  entry.finishedAt = at;
  entry.answer = String(answer ?? '').slice(0, MAX_ANSWER_CHARS);
  // Final state always reaches the database, even if a flush is pending. The
  // entry stays resident until TTL or the entry cap reclaims it: deleting it
  // here made a finished page vanish whenever the database was unavailable.
  const written = flush(id, entry);
  notify(id);
  return written.then(() => id);
}

/**
 * Accept the id as people actually paste it. Chat clients glue trailing
 * punctuation to a link (`…69dd_`, `…69dd.`, `…69dd)`), and a copied address
 * must keep working rather than 404 on one stray character.
 */
function normalizeId(value) {
  const match = String(value ?? '').toLowerCase().match(/[a-f0-9]{24}/);
  return match ? match[0] : null;
}

/**
 * Read one mirror for display. Live requests come from memory; finished ones
 * come from Postgres, so a link survives a restart. The unguessable id is the
 * credential, the same trust model as the existing web-chat history route.
 */
export async function getMirror(id) {
  const key = normalizeId(id);
  if (!key) return null;

  const entry = live.get(key);
  if (entry) return shape(entry);
  if (!db()) return null;

  try {
    const { rows } = await db()(
      `SELECT id, question, events, answer, done, error, started_at, finished_at
         FROM ${TABLES.mirrors}
        WHERE id = $1 AND expires_at > NOW()`,
      [key]
    );
    const row = rows[0];
    if (!row) return null;
    const startedAt = new Date(row.started_at).getTime();
    let events = Array.isArray(row.events) ? row.events : [];
    let done = row.done;
    let error = row.error;
    let finishedAt = row.finished_at ? new Date(row.finished_at).getTime() : null;

    // Fallback for a writer that died before sweepMirrors could run: a request
    // older than the turn hard cap cannot still be running. Show it as stopped
    // instead of a page that refreshes forever.
    if (!done && Date.now() - startedAt > STALE_MS) {
      done = true;
      error = true;
      finishedAt = finishedAt ?? events.at(-1)?.at ?? startedAt;
      events = events.map((event) =>
        event.status === 'running' ? { ...event, status: 'abandoned' } : event
      );
    }

    return {
      id: row.id,
      question: row.question,
      startedAt,
      finishedAt,
      events,
      answer: row.answer,
      done,
      error,
    };
  } catch (error) {
    console.error('[Mirror] read failed:', error.message);
    return null;
  }
}

function shape(entry) {
  return {
    id: entry.id,
    question: entry.question,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    events: entry.events.map(({ kind, tool, hint, status, at, durationMs, trace, request, response }) => ({
      kind,
      tool,
      hint,
      status,
      at,
      durationMs,
      trace: trace ?? '',
      request: request ?? '',
      response: response ?? '',
    })),
    answer: entry.answer,
    done: entry.done,
    error: entry.error,
  };
}

/**
 * Settle rows a dead process left behind.
 *
 * A turn killed mid-flight (restart, crash, OOM) never reaches finishMirror, so
 * its row keeps done=false and leaves tool rows stuck on "running" forever.
 * Called once at bot startup, when nothing can still be running: this process
 * is the only writer.
 */
export async function sweepMirrors() {
  if (!db()) return 0;
  try {
    const { rowCount } = await db()(
      `UPDATE ${TABLES.mirrors}
          SET done = TRUE,
              error = TRUE,
              finished_at = COALESCE(finished_at, NOW()),
              events = COALESCE((
                SELECT jsonb_agg(
                         CASE WHEN e->>'status' = 'running'
                              THEN jsonb_set(e, '{status}', '"abandoned"')
                              ELSE e END)
                  FROM jsonb_array_elements(events) AS e
              ), '[]'::jsonb)
        WHERE done = FALSE`
    );
    return rowCount ?? 0;
  } catch (error) {
    console.error('[Mirror] sweep failed:', error.message);
    return 0;
  }
}

/** Drop expired rows. One cron call a day is enough. */
export async function pruneMirrors() {
  if (!db()) return 0;
  try {
    const { rowCount } = await db()(`DELETE FROM ${TABLES.mirrors} WHERE expires_at < NOW()`);
    return rowCount ?? 0;
  } catch (error) {
    console.error('[Mirror] prune failed:', error.message);
    return 0;
  }
}

/** Trim the in-memory map if a turn crashed before finishMirror ran. */
/**
 * Redact secrets from a payload before it is published.
 *
 * The page now shows arguments and results, so this runs on every trace. It is
 * deliberately blunt: a missed token on a public URL is worse than a redacted
 * harmless id.
 */
function redact(text) {
  let out = String(text ?? '');
  out = out.replace(/\b(sk|pk|rk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{8,}/g, '[redacted-key]');
  out = out.replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [redacted]');
  out = out.replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted-token]');
  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]');
  out = out.replace(/\+?\d[\d\s()-]{7,}\d/g, '[number]');
  out = out.replace(/(?:^|\s)(\/(?:[\w.@-]+\/){1,}[\w.@-]*)/g, ' [path]');
  return out;
}

function prune() {
  const now = Date.now();
  for (const [id, entry] of live) {
    if (now - entry.startedAt > TTL_MS) {
      live.delete(id);
      flushTimers.delete(id);
    }
  }
  while (live.size > MAX_ENTRIES) {
    const oldest = live.keys().next().value;
    live.delete(oldest);
    flushTimers.delete(oldest);
  }
}

export const mirrorConfig = { TTL_MS, MAX_ENTRIES, MAX_EVENTS, FLUSH_MS };
