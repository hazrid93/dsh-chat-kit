/**
 * Discord adapter.
 *
 * Discord is a closer fit to the adapter contract than WhatsApp: a channel is a
 * conversation, and messages carry Markdown, so replies need chunking rather
 * than transformation.
 *
 * The transport is injected rather than imported, so this file has no hard
 * dependency on discord.js and can be exercised in tests with a fake client.
 */

/** Discord rejects messages over 2,000 characters. */
export const MAX_MESSAGE_CHARS = 2000;

/**
 * Split text on paragraph, then line, then hard boundaries, so a chunk never
 * lands mid-word unless a single line is itself longer than the limit.
 *
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
    // Prefer a paragraph break, then a line break, then a space.
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
 * Format plain text for Discord.
 *
 * The runtime's persona is written for plain-text chat, so nothing is rewritten
 * here; only escaping that Discord would swallow is undone. Kept as a function
 * so a host can override it without touching the adapter.
 */
export function formatForDiscord(text) {
  return String(text ?? '').trim();
}

/**
 * @typedef {object} DiscordAdapterOptions
 * @property {object} client a discord.js Client (or a compatible fake)
 * @property {string} [trigger] prefix that addresses the bot, default `!ai`
 * @property {boolean} [requireMention] in guilds, also accept @mentions
 * @property {string|number} [botId] the bot's own user id, to ignore itself
 * @property {(text: string) => string} [format] override reply formatting
 * @property {(err: unknown) => void} [onError]
 */

/**
 * Build the adapter object the runtime serves.
 *
 * The caller owns login and intents: this only wires events to the handler.
 *
 * @param {DiscordAdapterOptions} options
 */
export function createDiscordAdapter(options) {
  const {
    client,
    trigger = '!ai',
    requireMention = true,
    botId,
    format = formatForDiscord,
    onError = () => {},
  } = options;

  if (!client) throw new Error('createDiscordAdapter: client is required');

  let handler = null;
  let selfId = botId ? String(botId) : null;

  const isAddressed = (message) => {
    const content = String(message.content ?? '');
    if (content.toLowerCase().startsWith(trigger)) return true;
    if (!requireMention) return false;
    const mentions = message.mentions;
    if (!mentions) return false;
    // discord.js: mentions.has() takes a user or id; a fake may expose a Set.
    if (typeof mentions.has === 'function') {
      return selfId ? mentions.has(selfId) : mentions.users?.size > 0 || mentions.size > 0;
    }
    return false;
  };

  const stripTrigger = (content) => {
    const text = String(content ?? '');
    if (!text.toLowerCase().startsWith(trigger)) return text.trim();
    return text.slice(trigger.length).trim();
  };

  return {
    name: 'discord',

    async start(next) {
      handler = next;
      if (!selfId && client.user?.id) selfId = String(client.user.id);

      client.on('messageCreate', async (message) => {
        try {
          if (!message || message.author?.bot) return;
          if (selfId && String(message.author?.id) === selfId) return;
          if (!isAddressed(message)) return;

          const text = stripTrigger(message.content ?? '');
          if (!text) return;

          const isGroup = Boolean(message.guildId);
          const author = message.member?.displayName ?? message.author?.username ?? 'user';

          // Discord shows who spoke via its own chrome, but the runtime only
          // sees text, so group messages carry the speaker the same way the
          // WhatsApp adapter does.
          await handler({
            conversationId: `discord:${message.channelId}`,
            text: isGroup ? `${author}: ${text}` : text,
            author,
            isGroup,
            // Attachments are URLs here; the host materializes them with
            // materializeImage before the turn if it wants them read.
            attachments: [...(message.attachments?.values?.() ?? [])].map((a) => a.url),
          });
        } catch (error) {
          onError(error);
        }
      });
    },

    async send(conversationId, text) {
      const channelId = String(conversationId).replace(/^discord:/, '');
      const channel = await client.channels.fetch(channelId);
      if (!channel) throw new Error(`discord: channel ${channelId} not found`);

      const chunks = chunkMessage(format(text));
      let first = null;
      for (const chunk of chunks) {
        const sent = await channel.send(chunk);
        first ??= sent;
      }
      return first;
    },
  };
}

export default createDiscordAdapter;
