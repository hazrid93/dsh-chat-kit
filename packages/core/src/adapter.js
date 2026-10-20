/**
 * A platform is an object with three methods.
 *
 * `ChatRuntime` never imports a chat SDK; it calls this interface. The WhatsApp
 * and Discord adapters are two implementations of it, and a new platform is a
 * third file — not a fork of the engine.
 */

/**
 * @typedef {object} Adapter
 * @property {string} name platform id, used in logs
 * @property {(handler: (message: IncomingMessage) => Promise<void>) => Promise<void>} start
 *   connect, and call `handler` for every message addressed to the bot
 * @property {(conversationId: string, text: string) => Promise<void>} send
 *   deliver a reply into a conversation
 * @property {(conversationId: string, text: string) => Promise<void>} [sendError]
 *   report a failure; omit to stay silent like the WhatsApp adapter does
 */

/**
 * @typedef {object} IncomingMessage
 * @property {string} conversationId stable id for the chat; keys the DSH session
 * @property {string} text the user's message with platform syntax stripped
 * @property {string} [author] display name, for group attribution
 * @property {string[]} [imagePaths] absolute paths of attachments to read
 * @property {boolean} [isGroup]
 */

/**
 * Wire an adapter to a runtime.
 *
 * @param {import('./chat-runtime.js').ChatRuntime} bot
 * @param {Adapter} adapter
 */
export async function serve(bot, adapter) {
  await adapter.start(async (message) => {
    const result = await bot.ask({
      conversationId: message.conversationId,
      text: message.text,
      imagePaths: message.imagePaths,
    });
    if (result.text) {
      await adapter.send(message.conversationId, result.text);
    } else if (adapter.sendError) {
      await adapter.sendError(message.conversationId, 'That request failed. Please try again.');
    }
  });
  console.log(`[adapter:${adapter.name}] connected`);
}

export default serve;
