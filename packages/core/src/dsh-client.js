/**
 * DSH client — drives one resident `dsh` runtime over stdio JSON-RPC.
 *
 * One process for the whole bot, one session per WhatsApp chat. The runtime is
 * spawned lazily on first use and restarted if it dies.
 *
 * Why a resident process: booting dsh costs ~3s. Doing that per message would
 * add it to every reply.
 *
 * What this returns: the final assistant text plus the tool events the caller
 * may mirror. Media tools (generate_image) are not mounted in this profile —
 * `!image` covers that path.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

const BOOT_TIMEOUT_MS = 45_000;

/** Deterministic, filesystem-safe session id for a WhatsApp chat. */
export function sessionIdFor(chatId) {
  const digest = createHash('sha256').update(String(chatId)).digest('hex').slice(0, 24);
  return `wa-${digest}`;
}

export class DshClient {
  /**
   * @param {object} options
   * @param {string} options.command dsh executable
   * @param {string} options.profile profile name under $DSH_HOME/profiles
   * @param {string} options.dshHome DSH_HOME for this runtime
   * @param {string[]} [options.argsPrefix] arguments placed before the profile
   *   flag, for launching through `sudo -u <worker>` etc.
   * @param {string} options.cwd working directory recorded on each session, and
   *   the directory the model's file tools resolve against
   * @param {string} [options.spawnCwd] directory the process starts in. Must be
   *   readable by the launching user, which the session cwd may not be when the
   *   runtime runs as a separate account; defaults to `cwd`.
   * @param {string} options.provider model route provider
   * @param {string} options.model model name
   * @param {string} [options.reasoningEffort]
   * @param {object} [options.env] extra environment
   */
  constructor(options) {
    this.options = options;
    this.child = null;
    this.pending = new Map();
    this.turns = new Map(); // sessionId -> { resolve, events, text }
    this.childToParent = new Map(); // childSessionId -> parentSessionId
    this.queues = new Map(); // sessionId -> tail promise
    this.nextId = 1;
    this.ready = null;
    this.stderrTail = [];
  }

  async start() {
    if (this.child && this.ready) return this.ready;
    const { command, argsPrefix = [], profile, dshHome, cwd, spawnCwd, env = {} } = this.options;

    this.child = spawn(command, [...argsPrefix, '--profile', profile], {
      cwd: spawnCwd ?? cwd,
      env: { ...process.env, ...env, DSH_HOME: dshHome },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const child = this.child;
    this.stderrTail = [];

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this._onLine(line));

    // Stdout is the protocol; diagnostics belong on stderr. Keep a short tail
    // so a boot failure can be explained instead of hanging until timeout.
    const errRl = createInterface({ input: child.stderr });
    errRl.on('line', (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });

    child.on('exit', (code) => {
      this.child = null;
      this.ready = null;
      const reason = this.stderrTail.slice(-5).join('\n') || `exit ${code}`;
      for (const [, entry] of this.pending) entry.reject(new Error(`dsh runtime exited: ${reason}`));
      this.pending.clear();
      for (const [, turn] of this.turns) turn.reject(new Error('dsh runtime exited mid-turn'));
      this.turns.clear();
    });

    this.ready = (async () => {
      await this._request('initialize', {
        cwd,
        provider: this.options.provider,
        model: this.options.model,
        ...(this.options.reasoningEffort ? { reasoningEffort: this.options.reasoningEffort } : {}),
      });
      return true;
    })();

    this.ready.catch(() => {
      // A failed boot must not leave a half-dead process holding stdin.
      try { this.child?.kill(); } catch { /* ignore */ }
      this.child = null;
    });

    return Promise.race([
      this.ready,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`dsh runtime did not initialize within ${BOOT_TIMEOUT_MS}ms`)), BOOT_TIMEOUT_MS)
      ),
    ]);
  }

  _onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // not a protocol frame
    }

    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message ?? 'dsh request failed'));
      else entry.resolve(message.result);
      return;
    }

    // Subagent lifecycle arrives as its own notification, not as a session event.
    if (message.method === 'subagent.started') {
      const parent = this.turns.get(message.params?.parentSessionId);
      if (message.params?.childSessionId && message.params?.parentSessionId) {
        this.childToParent.set(message.params.childSessionId, message.params.parentSessionId);
      }
      parent?.onEvent?.({
        type: 'subagent_start',
        childSessionId: message.params?.childSessionId,
      });
      return;
    }

    if (message.method === 'subagent.finished') {
      const parent = this.turns.get(message.params?.parentSessionId);
      const text = (message.params?.lastAssistantMessage ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();
      if (message.params?.childSessionId) this.childToParent.delete(message.params.childSessionId);
      parent?.onEvent?.({
        type: 'subagent_finish',
        childSessionId: message.params?.childSessionId,
        status: message.params?.status,
        result: text,
      });
      return;
    }

    const event = message.params?.event;
    const sessionId = message.params?.sessionId;
    if (!event || !sessionId) return;

    let turn = this.turns.get(sessionId);

    // A child session reports under its own id, which no turn owns. Attribute it
    // to the parent that delegated it, otherwise subagent work is invisible.
    if (!turn) {
      const parentId = this.childToParent.get(sessionId);
      turn = parentId ? this.turns.get(parentId) : undefined;
      if (turn) turn.child = true;
    }
    if (!turn) return;

    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content ?? [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (text) turn.text = text;
      // Reasoning arrives as its own block. It is forwarded so a caller can show
      // it; whether that is public is the caller's decision, not the wire's.
      const reasoning = blocks
        .filter((b) => b.type === 'reasoning')
        .map((b) => b.text ?? '')
        .join('')
        .trim();
      if (reasoning) {
        turn.onEvent?.({ type: 'reasoning', child: turn.child === true, text: reasoning, step: event.data?.step, turn: event.data?.turn });
      }
      return;
    }

    if (event.type === 'tool/call') {
      const name = event.data?.name;
      if (event.data?.callId) turn.callNames.set(event.data.callId, name);
      turn.onEvent?.({
        type: 'tool_start',
        child: turn.child === true,
        tool: name,
        callId: event.data?.callId,
        arguments: event.data?.arguments,
      });
      return;
    }

    if (event.type === 'job/registered') {
      // A bash call may background long work; the job notification is the only
      // place that work is visible.
      // Real shape: { jobId, kind, label, startedAt, toolCall }.
      const d = event.data ?? {};
      turn.onEvent?.({
        type: 'job_start',
        child: turn.child === true,
        jobId: d.jobId,
        command: d.label ?? '',
        description: d.kind ? `${d.kind} job` : '',
      });
      return;
    }

    if (event.type === 'job/settled') {
      const d = event.data ?? {};
      turn.onEvent?.({
        type: 'job_finish',
        child: turn.child === true,
        jobId: d.jobId,
        status: String(d.status ?? (d.exitCode === 0 ? 'ok' : d.exitCode != null ? 'error' : 'ok')),
        result: d.label ?? '',
      });
      return;
    }

    if (event.type === 'step/end') {
      turn.onEvent?.({ type: 'step_finish', child: turn.child === true, step: event.data?.step });
      return;
    }

    if (event.type === 'step/start') {
      turn.onEvent?.({ type: 'step_start', child: turn.child === true, step: event.data?.step, turn: event.data?.turn });
      return;
    }

    if (event.type === 'tool/result') {
      // Result events carry only the call id, so the name comes from the call.
      const callId = event.data?.toolCallId ?? event.data?.source?.callId;
      const name = turn.callNames.get(callId) ?? '';
      const body = (event.data?.message?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const failed = /^\s*(error|error:)/i.test(body);
      turn.onEvent?.({ type: 'tool_result', child: turn.child === true, tool: name, callId, status: failed ? 'error' : 'ok', result: body });
      return;
    }

    if (event.type === 'turn/end') {
      this.turns.delete(sessionId);
      if (event.data?.reason?.kind === 'error') {
        turn.reject(new Error(event.data.reason.error?.message ?? 'dsh turn failed'));
        return;
      }
      // A turn can stop cleanly without producing any text — the model returned
      // an empty completion. Reporting that as success is how a chat goes silent
      // while the progress page claims "Request finished".
      turn.resolve({
        text: turn.text,
        reason: event.data?.reason?.kind,
        empty: turn.text.length === 0,
      });
    }
  }

  _request(method, params) {
    if (!this.child) return Promise.reject(new Error('dsh runtime is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** Serialize prompts per session: the runtime queues them anyway, we order them. */
  _enqueue(sessionId, task) {
    const tail = this.queues.get(sessionId) ?? Promise.resolve();
    const next = tail.then(task, task);
    this.queues.set(sessionId, next.catch(() => {}));
    return next;
  }

  /**
   * Send one user message and resolve with the turn's final text.
   *
   * @param {object} input
   * @param {string} input.chatId WhatsApp chat id
   * @param {string} input.text the question
   * @param {string[]} [input.imagePaths] absolute image paths the model may read
   * @param {number} [input.timeoutMs]
   * @param {(event: object) => void} [input.onEvent] progress callback
   */
  async prompt({ chatId, text, imagePaths = [], timeoutMs = 15 * 60 * 1000, onEvent }) {
    await this.start();
    const sessionId = sessionIdFor(chatId);

    // A single retry for the one degenerate case: the turn stopped with no text.
    // Anything else (error, timeout) propagates as before.
    const first = await this._promptOnce({ sessionId, text, imagePaths, timeoutMs, onEvent });
    if (!first.empty) return first;

    const retryEvent = {
      type: 'reasoning',
      text: 'The previous reply came back empty. Asking once more for the answer.',
    };
    onEvent?.(retryEvent);

    const second = await this._promptOnce({
      sessionId,
      text:
        'Your previous reply was empty, so the user saw nothing. ' +
        'Answer their last message now, in plain text, using what you already found.',
      imagePaths: [],
      timeoutMs,
      onEvent,
    });
    return second.text ? { ...second, retried: true } : first;
  }

  async _promptOnce({ sessionId, text, imagePaths, timeoutMs, onEvent }) {
    return this._enqueue(sessionId, async () => {
      await this._resumeIfPersisted(sessionId);

      const turn = { text: '', onEvent, callNames: new Map() };
      const done = new Promise((resolve, reject) => {
        this.turns.set(sessionId, { ...turn, resolve, reject, callNames: turn.callNames });
      });

      // Images travel as file paths, not bytes: the runtime's read_image tool
      // opens them, so a large photo never enters the session log as base64.
      const composed = imagePaths.length
        ? `${text}\n\n[The user attached ${imagePaths.length === 1 ? 'an image' : `${imagePaths.length} images`}. Read it with the read tool:\n${imagePaths.map((p) => `  ${p}`).join('\n')}\nThen answer the question above.]`
        : text;

      await this._request('session/prompt', {
        sessionId,
        contentBlocks: [{ type: 'text', text: composed }],
      });

      let timer;
      try {
        return await Promise.race([
          done,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`dsh turn exceeded ${Math.round(timeoutMs / 1000)}s`)),
              timeoutMs
            );
            timer.unref?.();
          }),
        ]);
      } finally {
        clearTimeout(timer);
        this.turns.delete(sessionId);
      }
    });
  }

  /** Resume a session left on disk by a previous process, if one exists. */
  async _resumeIfPersisted(sessionId) {
    try {
      await this._request('session/resume', { sessionId });
    } catch {
      // Unknown id: session/prompt creates it. Occupied or broken ids surface
      // on the prompt itself, where the caller can report them.
    }
  }

  async stop() {
    if (!this.child) return;
    try {
      await this._request('shutdown', {});
    } catch {
      /* ignore */
    }
    try {
      this.child.kill();
    } catch {
      /* ignore */
    }
    this.child = null;
    this.ready = null;
  }
}

export default DshClient;
