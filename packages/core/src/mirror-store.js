/**
 * Read-only session mirror, persisted in Postgres (or memory when no DB is attached).
 *
 * Keeps a sanitized projection of one turn's activity — reasoning traces, tool
 * calls with requests/responses, status and duration, advisor notes, and the
 * final answer — addressed by an unguessable 24-hex id, expiring after 6 hours.
 *
 * Credentials, tokens, emails, phone numbers, and absolute paths are redacted
 * at write time so stored payloads are safe to serve.
 */
import { randomBytes } from 'node:crypto';

const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;
const MAX_ANSWER_CHARS = 4000;
const MAX_HINT_CHARS = 80;
const MAX_TRACE_CHARS = 6000;
const MAX_EVENTS = 200;
const FLUSH_MS = 700;
const STALE_MS = 65 * 60 * 1000;
const DEFAULT_TABLE = 'request_mirrors';
const SAFE_TABLE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const BOOT_SWEEP_NOTE = 'Interrupted when the bot restarted before this request finished.';

function clip(text, limit = MAX_TRACE_CHARS) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…[${value.length - limit} more characters cut]`;
}

/** id -> entry while live (and retained in memory until TTL/eviction). */
const live = new Map();
const flushTimers = new Map();
/** id -> Set of listeners for live SSE push. */
const subscribers = new Map();

let query = null;
let tableName = DEFAULT_TABLE;

/**
 * Inject a Postgres `query(sql, params)` function (or `null` for memory-only).
 * Pass `{ tableName }` if an existing deployment uses a custom table name.
 */
export function attachMirrorStore(poolQuery, options = {}) {
  query = poolQuery;
  if (options.tableName !== undefined) {
    if (!SAFE_TABLE.test(String(options.tableName))) {
      throw new Error(`Invalid mirror tableName: ${options.tableName}`);
    }
    tableName = String(options.tableName);
  } else if (poolQuery === null) {
    tableName = DEFAULT_TABLE;
  }
}

export function getMirrorTableName() {
  return tableName;
}

const db = () => query;

const SAFE_TOOL = /^[A-Za-z0-9_.:-]{1,60}$/;

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
  job: 'job',
};

const displayName = (tool) => DISPLAY_NAMES[tool] ?? tool;

function scrub(value) {
  let text = String(value).replace(/\s+/g, ' ').trim();
  text = text.replace(/\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, '[redacted]');
  text = text.replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]');
  text = text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]');
  text = text.replace(/\+?\d[\d\s()-]{7,}\d/g, '[number]');
  text = text.replace(/(?:^|\s)(\/(?:[\w.@-]+\/){1,}[\w.@-]*)/g, ' [path]');
  if (text.length > MAX_HINT_CHARS) text = `${text.slice(0, MAX_HINT_CHARS - 1)}…`;
  return text;
}

function hintFrom(args) {
  if (!args || typeof args !== 'object') return '';
  const first = Array.isArray(args.urls) ? args.urls[0] : Array.isArray(args.queries) ? args.queries[0] : '';
  const candidate = [
    args.query, args.url, first, args.title, args.prompt, args.project_name, args.name,
    args.summary, args.description, args.skill, args.pattern,
  ].find((value) => typeof value === 'string' && value.trim());
  if (!candidate) return '';
  return scrub(candidate);
}

async function flush(id, pending) {
  const timer = flushTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    flushTimers.delete(id);
  }
  const entry = pending ?? live.get(id);
  if (!entry || !db()) return;
  try {
    await db()(
      `UPDATE ${tableName}
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
  flushTimers.get(id).unref?.();
}

/** Open a mirror for one request. Returns the 24-hex id used in the public URL. */
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
        `INSERT INTO ${tableName} (id, chat_id, question, expires_at)
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
 * Record one sanitized event onto a mirror.
 *
 * Accepted shapes:
 *  - { type: 'reasoning', text, child }
 *  - { type: 'tool_start' | 'tool/call', tool, callId, args, arguments, child }
 *  - { type: 'tool_result', tool, callId, status, durationMs, result, child }
 *  - { type: 'job_start' | 'job_finish', jobId, command, description, status, result }
 *  - { type: 'subagent_start' | 'subagent_finish', childSessionId, status, result }
 *  - { type: 'step_finish' }
 *  - { type: 'advice' | 'followup', id, severity, text, child } (also accepted post-finish)
 */
export function recordMirrorEvent(id, event) {
  const entry = live.get(id);
  if (!entry || !event) return;
  if (entry.done && event.type !== 'advice' && event.type !== 'followup') return;
  if (entry.events.length >= MAX_EVENTS) return;

  const at = Date.now();
  let changed = false;

  if (event.type === 'advice') {
    const text = clip(redact(String(event.text ?? '').trim()));
    if (!text) return;
    if (event.id && entry.events.some((row) => row.kind === 'advice' && row.callId === event.id)) return;
    entry.events.push({
      kind: 'advice',
      child: Boolean(event.child),
      tool: '',
      callId: event.id ?? null,
      hint: String(event.severity ?? 'nit'),
      status: 'ok',
      at,
      durationMs: null,
      trace: text,
      request: '',
      response: '',
    });
    changed = true;
  } else if (event.type === 'followup') {
    const text = clip(redact(String(event.text ?? '').trim()));
    if (!text) return;
    entry.events.push({
      kind: 'followup',
      child: Boolean(event.child),
      tool: '',
      callId: null,
      hint: '',
      status: 'ok',
      at,
      durationMs: null,
      trace: text,
      request: '',
      response: '',
    });
    changed = true;
  } else if (event.type === 'job_start' || event.type === 'job_finish') {
    if (event.type === 'job_start') {
      entry.events.push({
        kind: 'tool',
        tool: 'job',
        child: Boolean(event.child),
        callId: event.jobId ?? null,
        hint: scrub(String(event.description ?? event.command ?? '')).slice(0, 60),
        status: 'running',
        at,
        durationMs: null,
        request: clip(redact(String(event.command ?? ''))),
        response: '',
      });
    } else {
      for (let i = entry.events.length - 1; i >= 0; i -= 1) {
        const row = entry.events[i];
        if (row.tool === 'job' && row.status === 'running') {
          row.status = event.status === 'error' ? 'error' : 'ok';
          row.durationMs = at - row.at;
          row.response = clip(redact(String(event.result ?? '')));
          break;
        }
      }
    }
    changed = true;
  } else if (event.type === 'step_finish') {
    for (const row of entry.events) {
      if (row.status === 'running' && row.kind === 'tool' && !row.child && row.tool !== 'subagent') {
        row.status = 'abandoned';
        row.durationMs = at - row.at;
      }
    }
    changed = true;
  } else if (event.type === 'subagent_start') {
    const open = [...entry.events].reverse().find((row) => row.tool === 'subagent' && row.status === 'running');
    if (open) {
      open.childSessionId = event.childSessionId ?? null;
      open.hint = open.hint || 'child agent started';
    } else {
      entry.events.push({
        kind: 'tool',
        tool: 'subagent',
        child: false,
        callId: null,
        hint: 'child agent started',
        status: 'running',
        at,
        durationMs: null,
        request: '',
        response: '',
      });
    }
    changed = true;
  } else if (event.type === 'subagent_finish') {
    for (let i = entry.events.length - 1; i >= 0; i -= 1) {
      const row = entry.events[i];
      if (row.tool === 'subagent' && row.status === 'running') {
        row.status = event.status === 'error' ? 'error' : 'ok';
        row.durationMs = at - row.at;
        row.response = clip(redact(String(event.result ?? '')));
        changed = true;
        break;
      }
    }
  } else if (event.type === 'reasoning') {
    const text = clip(redact(String(event.text ?? '').trim()));
    if (!text) return;
    entry.events.push({
      kind: 'reasoning',
      child: Boolean(event.child),
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
    entry.events.push({
      kind: 'tool',
      tool: displayName(tool),
      child: Boolean(event.child),
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

  if (changed) {
    notify(id);
    scheduleFlush(id);
  }
}

export function finishMirror(id, { answer, error = false } = {}) {
  const entry = live.get(id);
  if (!entry || entry.done) return;
  const at = Date.now();
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
  const written = flush(id, entry);
  notify(id);
  return written.then(() => id);
}

function normalizeId(value) {
  const match = String(value ?? '').toLowerCase().match(/[a-f0-9]{24}/);
  return match ? match[0] : null;
}

export async function getMirror(id) {
  const key = normalizeId(id);
  if (!key) return null;

  const entry = live.get(key);
  if (entry) return shape(entry);
  if (!db()) return null;

  try {
    const { rows } = await db()(
      `SELECT id, question, events, answer, done, error, started_at, finished_at
         FROM ${tableName}
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
    events: entry.events.map(({ kind, tool, child, hint, status, at, durationMs, trace, request, response }) => ({
      kind,
      tool,
      child: Boolean(child),
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

/** Settle rows a dead process left behind, explaining why the turn stopped. */
export async function sweepMirrors() {
  if (!db()) return 0;
  try {
    const { rowCount } = await db()(
      `UPDATE ${tableName}
          SET done = TRUE,
              error = TRUE,
              answer = CASE WHEN length(answer) = 0 THEN $1 ELSE answer END,
              finished_at = COALESCE(finished_at, NOW()),
              events = COALESCE((
                SELECT jsonb_agg(
                         CASE WHEN e->>'status' = 'running'
                              THEN jsonb_set(e, '{status}', '"abandoned"')
                              ELSE e END)
                  FROM jsonb_array_elements(events) AS e
              ), '[]'::jsonb)
        WHERE done = FALSE`,
      [BOOT_SWEEP_NOTE]
    );
    return rowCount ?? 0;
  } catch (error) {
    console.error('[Mirror] sweep failed:', error.message);
    return 0;
  }
}

export async function pruneMirrors() {
  if (!db()) return 0;
  try {
    const { rowCount } = await db()(`DELETE FROM ${tableName} WHERE expires_at < NOW()`);
    return rowCount ?? 0;
  } catch (error) {
    console.error('[Mirror] prune failed:', error.message);
    return 0;
  }
}

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

export const mirrorConfig = { TTL_MS, MAX_ENTRIES, MAX_EVENTS, FLUSH_MS, DEFAULT_TABLE };
