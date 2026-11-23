/**
 * WhatsApp adapter (whatsapp-web.js).
 *
 * Handles private chats and groups, a configurable trigger prefix, optional
 * access gating (`isAllowed`), attached and quoted image downloads, WhatsApp
 * Markdown formatting, and chunking under WhatsApp's practical length limit.
 *
 * The client is injected, not imported, so this file has no hard dependency on
 * whatsapp-web.js and can be tested with a fake.
 */

export const MAX_MESSAGE_CHARS = 4000;

/**
 * Convert standard Markdown to WhatsApp-compatible formatting.
 * WhatsApp supports *bold*, _italic_, ~strikethrough~, ```monospace```, lists and > quotes.
 */
export function formatForWhatsApp(text) {
  if (!text || typeof text !== 'string') return '';

  const codeBlocks = [];
  text = text.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push('```' + code.trimEnd() + '```');
    return `%%CODEBLOCK_${codeBlocks.length - 1}%%`;
  });

  const inlineCode = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    inlineCode.push('`' + code + '`');
    return `%%INLINECODE_${inlineCode.length - 1}%%`;
  });

  text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, '');
  text = text.replace(/<[^>]+>/g, '');
  text = text.replace(/\*\*(.+?)\*\*/g, '*$1*');
  text = text.replace(/__(.+?)__/g, '*$1*');
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_, content) =>
    content.startsWith('*') && content.endsWith('*') ? content : `*${content}*`
  );
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  text = text.replace(/^[-*_]{3,}\s*$/gm, '');

  text = text.replace(/%%CODEBLOCK_(\d+)%%/g, (_, i) => codeBlocks[Number(i)]);
  text = text.replace(/%%INLINECODE_(\d+)%%/g, (_, i) => inlineCode[Number(i)]);
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

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
 * @property {(ctx: {conversationId: string, isGroup: boolean, author: string, message: object}) => boolean|Promise<boolean>} [isAllowed]
 *   optional gate for group locking or allowlists
 * @property {(text: string) => string} [format] reply formatter (defaults to formatForWhatsApp)
 * @property {(err: unknown) => void} [onError]
 */

export function createWhatsAppAdapter(options) {
  const {
    client,
    trigger = '!ai',
    includeAttachments = true,
    isAllowed = null,
    format = formatForWhatsApp,
    onError = () => {},
  } = options;

  if (!client) throw new Error('createWhatsAppAdapter: client is required');

  const triggerRe = new RegExp(`^${trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');

  /** Pull image attachments from the message itself and/or a quoted message. */
  const readAttachment = async (message) => {
    if (!includeAttachments) return [];
    const urls = [];

    if (message.hasMedia) {
      try {
        const media = await message.downloadMedia();
        if (media?.mimetype?.startsWith('image/') && media.data) {
          urls.push(`data:${media.mimetype};base64,${media.data}`);
        }
      } catch {
        /* unreadable attachment must not drop the turn */
      }
    }

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
  };

  return {
    name: 'whatsapp',

    async start(next) {
      client.on('message', async (message) => {
        try {
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
          const conversationId = chat?.id?._serialized ?? message.from;

          if (typeof isAllowed === 'function') {
            const allowed = await isAllowed({ conversationId, isGroup, author, message });
            if (!allowed) return;
          }

          const attachments = await readAttachment(message);

          await next({
            conversationId,
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
