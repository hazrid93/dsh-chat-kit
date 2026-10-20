/**
 * `ChatRuntime` — the platform-neutral middle of a chat bot.
 *
 * An adapter (WhatsApp, Discord, Telegram, a CLI) does three things: hand over a
 * message, send the reply, and optionally attach a progress link. Everything
 * between those is the same everywhere, and lives here:
 *
 *   1. serialise turns per conversation so two messages never interleave
 *   2. open a progress mirror and stream the runtime's events into it
 *   3. drive DSH for one turn and return its final text
 *   4. publish any site the turn built
 *   5. close the mirror with the answer the user actually received
 *
 * The runtime has no platform imports: no WhatsApp, no Discord, no express.
 */
import { DshClient, sessionIdFor } from './dsh-client.js';
import { openMirror, recordMirrorEvent, finishMirror, sweepMirrors } from './mirror-store.js';

export class ChatRuntime {
  /**
   * @param {object} options
   * @param {string} options.dshBinary absolute path to the dsh executable
   * @param {string} [options.profile] DSH profile name
   * @param {string} [options.dshHome] DSH_HOME for the runtime
   * @param {string} [options.cwd] session working directory
   * @param {string} [options.spawnCwd] directory the child process starts in
   * @param {string[]} [options.argsPrefix] launcher arguments, e.g. sudo -u
   * @param {string} options.provider model route provider
   * @param {string} options.model model name
   * @param {string} [options.reasoningEffort]
   * @param {string} [options.mirrorBaseUrl] public origin for progress links
   * @param {string} [options.mirrorPath] router mount path, default /api/chat
   * @param {(since: number) => Promise<string[]>} [options.publishSites] run after
   *   each turn; returns the site ids it published
   * @param {number} [options.publishIntervalMs] background publish cadence
   * @param {number} [options.turnTimeoutMs]
   */
  constructor(options) {
    this.options = options;
    this.client = new DshClient({
      command: options.dshBinary ?? 'dsh',
      argsPrefix: options.argsPrefix,
      profile: options.profile ?? 'chat',
      dshHome: options.dshHome,
      cwd: options.cwd,
      spawnCwd: options.spawnCwd,
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      env: options.env,
    });
    /** conversationId -> tail promise, so a chat handles one turn at a time. */
    this.queues = new Map();
  }

  /** Close rows a previous process left behind. Call once at startup. */
  async sweep() {
    return sweepMirrors();
  }

  /**
   * Run one turn.
   *
   * @param {object} turn
   * @param {string} turn.conversationId stable id for the chat (WhatsApp jid,
   *   Discord channel id, whatever the adapter uses); it keys the DSH session.
   * @param {string} turn.text the user's message, already formatted by the adapter
   * @param {string[]} [turn.imagePaths] absolute paths the runtime may read
   * @param {boolean} [turn.mirror] false to skip the progress page
   * @returns {Promise<{text: string, mirrorUrl: string|null, sites: string[]}>}
   */
  async ask({ conversationId, text, imagePaths = [], mirror = true }) {
    const run = () => this._run({ conversationId, text, imagePaths, mirror });
    const tail = this.queues.get(conversationId) ?? Promise.resolve();
    const next = tail.then(run, run);
    this.queues.set(conversationId, next.catch(() => {}));
    return next;
  }

  async _run({ conversationId, text, imagePaths, mirror }) {
    const startedAt = Date.now();
    const mirrorId = mirror
      ? await openMirror({ chatId: conversationId, question: text })
      : null;

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
      reply = result.text ?? '';
    } catch (error) {
      failed = true;
      reply = '';
      console.error(`[chat] turn failed for ${conversationId}:`, error.message);
    } finally {
      if (tick) clearInterval(tick);
    }

    const sites = publish ? await publish(startedAt).catch(() => []) : [];

    if (mirrorId) {
      await finishMirror(mirrorId, { answer: reply, error: failed }).catch(() => {});
    }

    return {
      text: reply,
      mirrorUrl: mirrorId ? this.mirrorUrl(mirrorId) : null,
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

  async close() {
    await this.client.stop();
  }
}

export { sessionIdFor };
export default ChatRuntime;
