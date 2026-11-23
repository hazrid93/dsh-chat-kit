/**
 * A platform is an object with three required methods and optional hooks.
 *
 * `ChatRuntime` never imports a chat SDK; it calls this interface. The WhatsApp
 * and Discord adapters are two implementations of it, and a new platform is a
 * third file — not a fork of the engine.
 */
import { materializeImages } from './attachments.js';

/**
 * @typedef {object} Adapter
 * @property {string} name platform id, used in logs
 * @property {(handler: (message: IncomingMessage) => Promise<void>) => Promise<void>} start
 *   connect, and call `handler` for every message addressed to the bot
 * @property {(conversationId: string, text: string) => Promise<void>} send
 *   deliver a reply into a conversation
 * @property {(conversationId: string, mirrorUrl: string) => Promise<void>} [sendProgress]
 *   optional hook called as soon as the live progress mirror opens
 * @property {(conversationId: string) => Promise<void>} [typing]
 *   optional typing indicator called while a turn is running
 * @property {(conversationId: string, text: string) => Promise<void>} [sendError]
 *   report a failure; omit to stay silent like the WhatsApp adapter does
 */

/**
 * @typedef {object} IncomingMessage
 * @property {string} conversationId stable id for the chat; keys the session
 * @property {string} text the user's message with platform syntax stripped
 * @property {string} [author] display name, for group attribution
 * @property {string[]} [imagePaths] absolute paths of attachments already on disk
 * @property {string[]} [attachments] raw data: URLs or http(s): URLs to materialize
 * @property {boolean} [isGroup]
 */

/**
 * Wire an adapter to a runtime.
 *
 * @param {import('./chat-runtime.js').ChatRuntime} bot
 * @param {Adapter} adapter
 * @param {object} [options]
 * @param {string} [options.attachmentDir] directory for materialized attachments
 * @param {number} [options.typingIntervalMs] typing refresh cadence (0 to disable)
 */
export async function serve(bot, adapter, options = {}) {
  const typingIntervalMs = options.typingIntervalMs ?? 8000;

  await adapter.start(async (message) => {
    let imagePaths = message.imagePaths;
    if (!imagePaths && Array.isArray(message.attachments) && message.attachments.length > 0) {
      imagePaths = await materializeImages(message.attachments, {
        dir: options.attachmentDir,
      });
    }

    let typingTimer = null;
    if (typeof adapter.typing === 'function') {
      adapter.typing(message.conversationId).catch(() => {});
      if (typingIntervalMs > 0) {
        typingTimer = setInterval(() => {
          adapter.typing(message.conversationId).catch(() => {});
        }, typingIntervalMs);
        typingTimer.unref?.();
      }
    }

    const askInput = {
      conversationId: message.conversationId,
      text: message.text,
      imagePaths,
    };
    if (typeof adapter.sendProgress === 'function') {
      askInput.onMirrorOpened = (url) => {
        Promise.resolve(adapter.sendProgress(message.conversationId, url)).catch(() => {});
      };
    }

    let result;
    try {
      result = await bot.ask(askInput);
    } finally {
      if (typingTimer) clearInterval(typingTimer);
    }

    if (result.text) {
      await adapter.send(message.conversationId, result.text);
    } else if (adapter.sendError) {
      await adapter.sendError(message.conversationId, 'That request failed. Please try again.');
    }
  });
  console.log(`[adapter:${adapter.name}] connected`);
}

export default serve;
