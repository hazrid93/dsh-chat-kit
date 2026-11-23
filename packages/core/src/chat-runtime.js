/**
 * `ChatRuntime` — the platform-neutral middle of a chat bot.
 *
 * An adapter (WhatsApp, Discord, Telegram, a CLI) does three things: hand over a
 * message, send the reply, and optionally attach a progress link. Everything
 * between those is the same everywhere, and lives here:
 *
 *   1. serialise turns per conversation so two messages never interleave
 *   2. open a progress mirror and stream the runtime's events into it
 *   3. drive the agent client (DSH by default, or any injected client) for one turn
 *   4. publish any site the turn built
 *   5. close the mirror with the answer the user actually received
 *   6. track in-flight turns so graceful shutdown waits before exiting
 *
 * The runtime has no platform imports: no WhatsApp, no Discord, no express.
 */
import { DshClient, sessionIdFor } from './dsh-client.js';
import { openMirror, recordMirrorEvent, finishMirror, sweepMirrors } from './mirror-store.js';
import { createTurnDrain } from './turn-drain.js';

export class ChatRuntime {
  /**
   * @param {object} options
   * @param {{prompt: Function, stop?: Function, resetChat?: Function}} [options.client]
   *   Optional pluggable agent client (e.g. a Droid or custom harness adapter).
   *   When omitted, a DshClient is constructed from the DSH options below.
   * @param {string} [options.dshBinary] absolute path to the dsh executable
   * @param {string} [options.profile] DSH profile name
   * @param {string} [options.dshHome] DSH_HOME for the runtime
   * @param {string} [options.cwd] session working directory
   * @param {string} [options.spawnCwd] directory the child process starts in
   * @param {string[]} [options.argsPrefix] launcher arguments, e.g. sudo -u
   * @param {string} [options.provider] model route provider
   * @param {string} [options.model] model name
   * @param {string} [options.reasoningEffort]
   * @param {string} [options.sessionPrefix] deterministic session id prefix
   * @param {string} [options.mirrorBaseUrl] public origin for progress links
   * @param {string} [options.mirrorPath] router mount path, default /api/chat
   * @param {(since: number) => Promise<string[]>} [options.publishSites] run after
   *   each turn; returns the site ids it published
   * @param {number} [options.publishIntervalMs] background publish cadence
   * @param {number} [options.turnTimeoutMs]
   */
  constructor(options = {}) {
    this.options = options;
    this.client = options.client ?? new DshClient({
      command: options.dshBinary ?? 'dsh',
      argsPrefix: options.argsPrefix,
      profile: options.profile ?? 'chat',
      dshHome: options.dshHome,
      cwd: options.cwd,
      spawnCwd: options.spawnCwd,
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      sessionPrefix: options.sessionPrefix,
      env: options.env,
    });
    /** conversationId -> tail promise, so a chat handles one turn at a time. */
    this.queues = new Map();
    this.turnDrain = createTurnDrain();
  }

  /** Close rows a previous process left behind. Call once at startup. */
  async sweep() {
    return sweepMirrors();
  }

  /** Number of turns currently in flight across all conversations. */
  activeTurns() {
    return this.turnDrain.count();
  }

  /** Wait up to `limitMs` for in-flight turns to finish before shutdown. */
  async drain(limitMs = 30_000) {
    return this.turnDrain.wait(limitMs);
  }

  /** Reset the underlying agent session for one conversation, if supported. */
  async resetChat(conversationId) {
    if (typeof this.client.resetChat === 'function') {
      await this.client.resetChat(conversationId);
    }
  }

  /**
   * Run one turn.
   *
   * @param {object} turn
   * @param {string} turn.conversationId stable id for the chat (WhatsApp jid,
   *   Discord channel id, whatever the adapter uses); it keys the session.
   * @param {string} turn.text the user's message, already formatted by the adapter
   * @param {string[]} [turn.imagePaths] absolute paths the runtime may read
   * @param {boolean} [turn.mirror] false to skip the progress page
   * @param {(mirrorUrl: string, mirrorId: string) => void} [turn.onMirrorOpened]
   *   called immediately once the mirror exists, so an adapter can post the link
   *   while the turn is still running
   * @returns {Promise<{text: string, mirrorUrl: string|null, sites: string[]}>}
   */
  async ask({ conversationId, text, imagePaths = [], mirror = true, onMirrorOpened }) {
    const drainKey = `${conversationId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
    this.turnDrain.begin(drainKey, conversationId);
    const run = () => this._run({ conversationId, text, imagePaths, mirror, onMirrorOpened, drainKey });
    const tail = this.queues.get(conversationId) ?? Promise.resolve();
    const next = tail.then(run, run);
    this.queues.set(conversationId, next.catch(() => {}));
    return next;
  }

  async _run({ conversationId, text, imagePaths, mirror, onMirrorOpened, drainKey }) {
    const startedAt = Date.now();
    const mirrorId = mirror
      ? await openMirror({ chatId: conversationId, question: text })
      : null;

    const url = mirrorId ? this.mirrorUrl(mirrorId) : null;
    if (mirrorId && typeof onMirrorOpened === 'function') {
      try { onMirrorOpened(url, mirrorId); } catch { /* callback errors must not break the turn */ }
    }

    const publish = this.options.publishSites;
    let tick = null;
    if (publish && this.options.publishIntervalMs !== 0) {
      // Publish while the turn runs: a model that checks its own URL otherwise
      // sees 404 and debugs a publish that is waiting for it to finish.
      tick = setInterval(() => {
        publish(startedAt).catch(() => {});
      }, this.options.publishIntervalMs ?? 5000);
      tick.unref?.();
    }

    let reply = '';
    let failed = false;
    try {
      const result = await this.client.prompt({
        chatId: conversationId,
        text,
        imagePaths,
        timeoutMs: this.options.turnTimeoutMs,
        onEvent: mirrorId ? (event) => recordMirrorEvent(mirrorId, event) : undefined,
      });
      reply = result?.text ?? '';
    } catch (error) {
      failed = true;
      reply = '';
      console.error(`[chat] turn failed for ${conversationId}:`, error.message);
    } finally {
      if (tick) clearInterval(tick);
    }

    let sites = [];
    try {
      sites = publish ? await publish(startedAt).catch(() => []) : [];
      if (mirrorId) {
        await finishMirror(mirrorId, { answer: reply, error: failed }).catch(() => {});
      }
    } finally {
      this.turnDrain.end(drainKey);
    }

    return {
      text: reply,
      mirrorUrl: url,
      sites,
    };
  }

  /** Public link for one mirror, for an adapter to post in the chat. */
  mirrorUrl(mirrorId) {
    const base = (this.options.mirrorBaseUrl ?? '').replace(/\/$/, '');
    const path = (this.options.mirrorPath ?? '/api/chat').replace(/\/$/, '');
    return `${base}${path}/mirror/${mirrorId}`;
  }

  /** Express router serving mirror pages, their stream and their client. */
  async router() {
    const { default: routes } = await import('./mirror-routes.js');
    return routes;
  }

  async close({ drainMs = 0 } = {}) {
    if (drainMs > 0) await this.drain(drainMs);
    if (typeof this.client.stop === 'function') {
      await this.client.stop();
    }
  }
}

export { sessionIdFor };
export default ChatRuntime;
