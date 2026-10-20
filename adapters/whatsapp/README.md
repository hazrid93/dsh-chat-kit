# WhatsApp adapter (sketch)

The production implementation lives in the WhatsApp bot repo and cannot move
verbatim: it carries quota/wallet checks, tenant DB writes, media handling and
VCC compaction. What belongs here is only the transport mapping.

```js
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

export function whatsappAdapter({ trigger = '!ai' } = {}) {
  const client = new Client({ authStrategy: new LocalAuth() });
  let handler;
  return {
    name: 'whatsapp',
    async start(h) {
      handler = h;
      client.on('message', async (msg) => {
        if (!msg.body.toLowerCase().startsWith(trigger)) return;
        const text = msg.body.slice(trigger.length).trim();
        if (!text) return;
        await handler({
          conversationId: msg.id.remote,          // @g.us or @c.us
          text,
          author: msg.author || msg.from,
          isGroup: msg.id.remote.endsWith('@g.us'),
        });
      });
      await client.initialize();
    },
    async send(conversationId, text) {
      await client.sendMessage(conversationId, text);
    },
    // Deliberately omitted: the WhatsApp bot does not surface infrastructure
    // errors to users, only to the log.
  };
}
```

Notes carried over from production:

- `conversationId` must be stable across reconnects; the DSH session is keyed on
  it, so changing the id starts a new conversation.
- Group messages should prefix the speaker name in `text`, because the runtime
  cannot see platform metadata.
- Images arrive as base64 data URLs; write them to disk first and pass
  `imagePaths`, so the runtime reads a file instead of holding bytes in its
  session log.
