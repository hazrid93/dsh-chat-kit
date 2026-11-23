/**
 * DSH client — drives one resident `dsh` runtime over stdio JSON-RPC.
 *
 * One process for the whole bot, one session per conversation. The runtime is
 * spawned lazily on first use and restarted if it dies.
 *
 * Why a resident process: booting dsh costs ~3s. Doing that per message would
 * add it to every reply.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

const BOOT_TIMEOUT_MS = 45_000;

/** Deterministic, filesystem-safe session id for a conversation. */
export function sessionIdFor(chatId, prefix = 'chat') {
  const safePrefix = String(prefix || 'chat').replace(/[^a-zA-Z0-9_-]/g, '') || 'chat';
  const digest = createHash('sha256').update(String(chatId)).digest('hex').slice(0, 24);
  return `${safePrefix}-${digest}`;
}

export class DshClient {
  /**
   * @param {object} options
   * @param {string} options.command dsh executable
   * @param {string} options.profile profile name under $DSH_HOME/profiles
   * @param {string} [options.dshHome] DSH_HOME for this runtime
   * @param {string[]} [options.argsPrefix] arguments placed before the profile
   *   flag, for launching through `sudo -u <worker>` etc.
   * @param {string} [options.cwd] working directory recorded on each session
   * @param {string} [options.spawnCwd] directory the process starts in
   * @param {string} [options.provider] model route provider
   * @param {string} [options.model] model name
   * @param {string} [options.reasoningEffort]
   * @param {string} [options.sessionPrefix] prefix for deterministic session ids
   * @param {object} [options.env] extra environment
   */
  constructor(options) {
    this.options = options;
    this.child = null;
    this.pending = new Map();
    this.turns = new Map(); // sessionId -> { resolve, reject, onEvent, callNames, text }
    this.childToParent = new Map(); // childSessionId -> parentSessionId
    this.queues = new Map(); // sessionId -> tail promise
    this.epochs = new Map(); // chatId -> reset counter so resetChat opens a fresh session
    this.nextId = 1;
    this.ready = null;
    this.stderrTail = [];
  }

  _sessionId(chatId) {
    const epoch = this.epochs.get(chatId) ?? 0;
    const key = epoch > 0 ? `${chatId}#${epoch}` : chatId;
    return sessionIdFor(key, this.options.sessionPrefix ?? 'chat');
  }

  /** Start future turns for this conversation in a fresh session id. */
  resetChat(chatId) {
    const prevId = this._sessionId(chatId);
    this.epochs.set(chatId, (this.epochs.get(chatId) ?? 0) + 1);
    const active = this.turns.get(prevId);
    if (active) {
      this.turns.delete(prevId);
      active.reject(new Error('dsh session cleared'));
    }
  }

  async start() {
    if (this.child && this.ready) return this.ready;
    const { command, argsPrefix = [], profile, dshHome, cwd, spawnCwd, env = {} } = this.options;

    const childEnv = { ...process.env, ...env };
    if (dshHome) childEnv.DSH_HOME = dshHome;

    this.child = spawn(command, [...argsPrefix, '--profile', profile], {
      cwd: spawnCwd ?? cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const child = this.child;
    this.stderrTail = [];

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => this._onLine(line));

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
      this.childToParent.clear();
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
      try { this.child?.kill(); } catch { /* ignore */ }
      this.child = null;
    });

    return Promise.race([
      this.ready,
      new Promise((_, reject) => {
        const t = setTimeout(
          () => reject(new Error(`dsh runtime did not initialize within ${BOOT_TIMEOUT_MS}ms`)),
          BOOT_TIMEOUT_MS
        );
        t.unref?.();
      }),
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

    // Keep child attribution local to this event — never mutate the parent turn
    // object, never overwrite the parent's reply text, and never settle the
    // parent turn on a child's turn/end.
    let turn = this.turns.get(sessionId);
    let isChild = false;
    if (!turn) {
      const parentId = this.childToParent.get(sessionId);
      turn = parentId ? this.turns.get(parentId) : undefined;
      if (turn) isChild = true;
    }
    if (!turn) return;

    if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content ?? [];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      if (text && !isChild) turn.text = text;
      const reasoning = blocks
        .filter((b) => b.type === 'reasoning')
        .map((b) => b.text ?? '')
        .join('')
        .trim();
      if (reasoning) {
        turn.onEvent?.({ type: 'reasoning', child: isChild, text: reasoning, step: event.data?.step, turn: event.data?.turn });
      }
      return;
    }

    if (event.type === 'tool/call') {
      const name = event.data?.name;
      if (event.data?.callId) turn.callNames.set(event.data.callId, name);
      let parsedArgs;
      if (event.data?.arguments && typeof event.data.arguments === 'string') {
        try { parsedArgs = JSON.parse(event.data.arguments); } catch { /* raw string only */ }
      } else if (event.data?.arguments && typeof event.data.arguments === 'object') {
        parsedArgs = event.data.arguments;
      }
      turn.onEvent?.({
        type: 'tool_start',
        child: isChild,
        tool: name,
        callId: event.data?.callId,
        args: parsedArgs,
        arguments: typeof event.data?.arguments === 'string'
          ? event.data.arguments
          : event.data?.arguments != null
            ? JSON.stringify(event.data.arguments)
            : '',
      });
      return;
    }

    if (event.type === 'job/registered') {
      const d = event.data ?? {};
      turn.onEvent?.({
        type: 'job_start',
        child: isChild,
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
        child: isChild,
        jobId: d.jobId,
        status: String(d.status ?? (d.exitCode === 0 ? 'ok' : d.exitCode != null ? 'error' : 'ok')),
        result: d.label ?? '',
      });
      return;
    }

    if (event.type === 'step/end') {
      if (!isChild) {
        turn.onEvent?.({ type: 'step_finish', child: false, step: event.data?.step });
      }
      return;
    }

    if (event.type === 'step/start') {
      turn.onEvent?.({ type: 'step_start', child: isChild, step: event.data?.step, turn: event.data?.turn });
      return;
    }

    if (event.type === 'tool/result') {
      const callId = event.data?.toolCallId ?? event.data?.source?.callId;
      const name = turn.callNames.get(callId) ?? '';
      const body = (event.data?.message?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const failed = /^\s*(error|error:)/i.test(body);
      turn.onEvent?.({ type: 'tool_result', child: isChild, tool: name, callId, status: failed ? 'error' : 'ok', result: body });
      return;
    }

    if (event.type === 'turn/end') {
      if (isChild) return; // child completion arrives via subagent.finished
      this.turns.delete(sessionId);
      if (event.data?.reason?.kind === 'error') {
        turn.reject(new Error(event.data.reason.error?.message ?? 'dsh turn failed'));
        return;
      }
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
   * @param {string} input.chatId conversation id
   * @param {string} input.text the question
   * @param {string[]} [input.imagePaths] absolute image paths the model may read
   * @param {number} [input.timeoutMs]
   * @param {(event: object) => void} [input.onEvent] progress callback
   */
  async prompt({ chatId, text, imagePaths = [], timeoutMs = 15 * 60 * 1000, onEvent }) {
    await this.start();
    const sessionId = this._sessionId(chatId);

    // A single retry for the one degenerate case: the turn stopped with no text.
    const first = await this._promptOnce({ sessionId, text, imagePaths, timeoutMs, onEvent });
    if (!first.empty) return first;

    onEvent?.({
      type: 'reasoning',
      text: 'The previous reply came back empty. Asking once more for the answer.',
    });

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

  async _resumeIfPersisted(sessionId) {
    try {
      await this._request('session/resume', { sessionId });
    } catch {
      // Unknown id: session/prompt creates it.
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
