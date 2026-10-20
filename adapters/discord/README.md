# Discord adapter (sketch)

Discord fits the interface closely: channels are conversations, and threads are
separate ones.

```js
import { Client, GatewayIntentBits } from 'discord.js';

export function discordAdapter({ token, trigger = '!ai' }) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  let handler;
  return {
    name: 'discord',
    async start(h) {
      handler = h;
      client.on('messageCreate', async (msg) => {
        if (msg.author.bot) return;
        const mentioned = msg.mentions.has(client.user);
        const text = msg.content.replace(trigger, '').trim();
        if (!mentioned && !msg.content.startsWith(trigger)) return;
        if (!text) return;
        await handler({
          conversationId: `discord:${msg.channelId}`,
          text: msg.member ? `${msg.member.displayName}: ${text}` : text,
          author: msg.author.username,
          isGroup: msg.guildId !== null,
        });
      });
      await client.login(token);
    },
    async send(conversationId, text) {
      const channelId = conversationId.replace('discord:', '');
      const channel = await client.channels.fetch(channelId);
      // Discord caps a message at 2000 characters.
      for (let i = 0; i < text.length; i += 1900) {
        await channel.send(text.slice(i, i + 1900));
      }
    },
  };
}
```

Discord differs from WhatsApp in two ways that matter:

- **Length**: 2,000 characters per message, so replies must be chunked.
- **Markup**: it renders Markdown, so the runtime's plain-text persona can be
  relaxed by passing a different persona to the DSH profile.
