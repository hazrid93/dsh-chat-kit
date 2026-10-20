/**
 * WhatsApp adapter (whatsapp-web.js).
 *
 * Mirrors what the production bot already does, minus the product logic:
 * private chats and groups, a trigger prefix, attachment download, and replies
 * chunked to a safe length.
 *
 * The client is injected, not imported, so this file has no dependency on
 * whatsapp-web.js and can be tested with a fake.
 */

/** WhatsApp accepts large messages, but clients truncate long ones in practice. */
export const MAX_MESSAGE_CHARS = 4000;

/**
 * Split long text on paragraph, then line, then space boundaries.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string[]}
 */
export function chunkMessage(text, limit = MAX_MESSAGE_CHARS) {
  const value = String(text ?? '');
  if (!value) return [];
  if (value.length <= limit) return [value];

  const chunks = [];
  let rest = value;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Resolve a display name the way the production bot does: pushname, then
 * contact name/number, then the JID local part.
 */
function resolveAuthor(message, contact) {
  const direct = contact?.pushname || contact?.name || contact?.number;
  if (direct) return direct;
  const jid = message.author || message.from || '';
  return String(jid).split('@')[0] || 'Unknown';
}

/**
 * @typedef {object} WhatsAppAdapterOptions
 * @property {object} client a whatsapp-web.js Client, or a compatible fake
 * @property {string} [trigger] command prefix, default `!ai`
 * @property {boolean} [includeAttachments] download image media as data URLs
 * @property {(text: string) => string} [format] reply formatter
 * @property {(err: unknown) => void} [onError]
 * @property {(text: string) => string} [format]
 */

/**
 * Build the adapter object the runtime serves.
 *
 * The caller owns authentication: this only wires events to the handler.
 *
 * @param {WhatsAppAdapterOptions} options
 */
export function createWhatsAppAdapter(options) {
  const {
    client,
    trigger = '!ai',
    includeAttachments = true,
    format = (text) => String(text ?? '').trim(),
    onError = () => {},
  } = options;

  if (!client) throw new Error('createWhatsAppAdapter: client is required');

  const triggerRe = new RegExp(`^${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');

  /** Pull an image attachment out of a message as a data URL. */
  const readAttachment = async (message) => {
    if (!includeAttachments || !message.hasMedia) return [];
    try {
      const media = await message.downloadMedia();
      if (!media?.mimetype?.startsWith('image/') || !media.data) return [];
      const urls = [`data:${media.mimetype};base64,${media.data}`];
      // A quoted image is a second attachment the model may want to see.
      if (message.hasQuotedMsg) {
        try {
          const quoted = await message.getQuotedMessage();
          if (quoted?.hasMedia) {
            const qMedia = await quoted.downloadMedia();
            if (qMedia?.mimetype?.startsWith('image/') && qMedia.data) {
              urls.push(`data:${qMedia.mimetype};base64,${qMedia.data}`);
            }
          }
        } catch {
          /* a deleted or unavailable quote must not fail the message */
        }
      }
      return urls;
    } catch {
      return [];
    }
  };

  return {
    name: 'whatsapp',

    async start(next) {
      client.on('message', async (message) => {
        try {
          // `fromMe` covers the bot's own replies and anything the owner sends
          // from their phone; neither should be answered.
          if (!message || message.fromMe) return;
          if (message.isStatus) return;

          const body = String(message.body ?? '').trim();
          if (!triggerRe.test(body)) return;

          const text = body.replace(triggerRe, '').trim();
          if (!text) return;

          const chat = await message.getChat();
          const contact = await message.getContact();
          const isGroup = Boolean(chat?.isGroup);
          const author = resolveAuthor(message, contact);
          const attachments = await readAttachment(message);

          await next({
            conversationId: chat?.id?._serialized ?? message.from,
            // The runtime only sees text, so groups carry the speaker.
            text: isGroup ? `${author}: ${text}` : text,
            author,
            isGroup,
            attachments,
          });
        } catch (error) {
          onError(error);
        }
      });
    },

    /** Show "typing…" while a turn runs; harmless when the SDK lacks it. */
    async typing(conversationId) {
      try {
        const chat = await client.getChatById(conversationId);
        await chat?.sendStateTyping?.();
      } catch {
        /* cosmetic only */
      }
    },

    async send(conversationId, text) {
      const chunks = chunkMessage(format(text));
      let first = null;
      for (const chunk of chunks) {
        const sent = await client.sendMessage(conversationId, chunk);
        first ??= sent;
      }
      return first;
    },
  };
}

export default createWhatsAppAdapter;
