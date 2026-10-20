# dsh-chat-kit

A platform-neutral chat runtime on **DeepSeek Harness**. One turn engine, one
DSH session per conversation, live progress pages, and adapters that are ~100
lines each. WhatsApp is one adapter; Discord is another; a CLI is a third.

Extracted from a production WhatsApp bot after the same machinery kept being
rewritten per platform.

## What is reusable, and what is not

| Piece | Portable? |
| --- | --- |
| `chat-runtime.js` — turn queue, mirror, publish, finish | **Yes**, no platform imports |
| `dsh-client.js` — stdio JSON-RPC client, per-chat sessions | **Yes** |
| `mirror-store.js` — progress records, redaction, SSE fan-out | **Yes**, needs Postgres |
| `mirror-routes.js` + `public/mirror-client.js` — progress page | **Yes**, any express host |
| `publish-site.mjs` — copy a built site to a public root | **Yes**, paths configurable |
| WhatsApp bot, quota/wallet, VCC compaction, tenant DB | **No** — stays in the app |

The point of the split: a new platform supplies *transport*, not logic.

## Install

```bash
git clone <this repo> && cd dsh-chat-kit
npm install
createdb chat_kit && psql chat_kit -f sql/mirrors.sql
```

Requirements: Node 20+, a `dsh` binary, and Postgres for progress mirrors
(optional — the store runs in memory without it).

## The adapter interface

A platform is one object:

```js
{
  name: 'discord',
  async start(handler) { /* call handler(message) per addressed message */ },
  async send(conversationId, text) { /* deliver a reply */ },
  async sendError(conversationId, text) {}, // optional; omit to stay silent
}
```

An incoming message is:

```js
{
  conversationId: 'discord:1234567890', // stable; keys the DSH session
  text: 'build me a page',
  author: 'Hazrid',
  imagePaths: ['/tmp/upload.png'],      // optional
  isGroup: false,
}
```

Then:

```js
import { ChatRuntime } from 'dsh-chat-kit';
import { serve } from 'dsh-chat-kit/adapter.js';
import { materializeImage } from 'dsh-chat-kit/attachments.js';

const bot = new ChatRuntime({
  dshBinary: '/usr/local/bin/dsh',
  profile: 'chat',
  provider: 'litellm',
  model: 'deepseek-v4.1-flash',
  mirrorBaseUrl: 'https://example.com',
});

await serve(bot, discordAdapter);
```

`bot.ask({ conversationId, text })` returns
`{ text, mirrorUrl, sites }`, and a turn that fails returns `text: ''` — the
adapter decides whether to say anything (the WhatsApp adapter stays silent on
purpose).

## Attachments

Chat SDKs deliver media in different shapes; the runtime only takes paths.
`materializeImage` normalises both common ones:

```js
// WhatsApp: base64 data URL
const path = await materializeImage(msg.dataUrl, { dir: '/tmp/chat-in' });
// Discord: attachment URL
const path2 = await materializeImage(msg.attachments.first().url, { dir: '/tmp/chat-in' });

await bot.ask({ conversationId, text, imagePaths: [path] });
```

## Progress pages

Every turn gets an unguessable URL showing the thinking trace, each tool call
with its request and response, live metrics, follow-tail scrolling, and the
final answer. It updates over server-sent events and never reloads.

Mount the router:

```js
app.use('/chat', await bot.router());
```

`sql/mirrors.sql` creates the table. Set `mirrorBaseUrl` to the public origin so
the links an adapter posts are absolute.

**Why a mirror and not the DSH web GUI:** that GUI's launch token is an
owner-level credential for the whole host — every session, the file system, and
shell. It is fine for the operator on their own machine and wrong to hand to a
chat user. The mirror shows one request, sanitized.

## Running the runtime as a different OS user

Optional, and the strongest boundary available: the runtime gets shell access,
so run it as an account that cannot read your app's secrets.

```js
new ChatRuntime({
  dshBinary: '/usr/bin/sudo',
  argsPrefix: ['-n', '-u', 'chatworker', 'env', 'PATH=…', 'HOME=/srv/chat',
               '/path/to/node', '/path/to/dsh/lib/bin.js'],
  spawnCwd: '/tmp',           // the app user may not be able to enter the workspace
  cwd: '/srv/chat-workspace',
})
```

Two constraints learned the hard way:

- A `.env` file setting `DSH_*` makes `dsh` refuse to boot. Use your own prefixes
  (`WA_*`, `BOT_*`) for host settings.
- `bwrap` must be installed for `workspace-write` to confine writes; without it
  the sandbox fails closed and bash does not run.

## Examples

- `examples/echo/bot.mjs` — HTTP transport, proving the engine needs no chat SDK.
- `examples/discord/bot.mjs` — a working Discord bot: `npm i discord.js`, then
  `DISCORD_TOKEN=… DATABASE_URL=… PUBLIC_BASE_URL=… node examples/discord/bot.mjs`.

### Discord specifics

The adapter does not import `discord.js`; the client is injected, so it is
tested with a fake. What it handles for you:

| Concern | Behaviour |
| --- | --- |
| Addressing | `!ai` prefix, plus @mention in guilds (`DISCORD_REQUIRE_MENTION=false` to disable) |
| Self/bot messages | Ignored, including the bot's own replies |
| 2,000-character cap | Split on paragraph, then line, then space boundaries |
| Conversations | One per channel: `discord:<channelId>` |
| Attachments | URLs collected for `materializeImages`; the runtime reads files |
| Empty answers | Reports a failure, unlike the WhatsApp adapter which stays silent |

## Licence

MIT.

## Migrating the existing WhatsApp app

The production bot still carries its own copies of `dsh-client`, `mirror-store`
and the routes. That is drift waiting to happen. Two options:

1. **Depend on this repo** — add it as a `file:` dependency, delete the local
   copies, and keep only the WhatsApp adapter (`src/index.js`) in the app.
2. **Keep both** — acceptable only short term; every fix lands twice.

Option 1 is the honest end state: the app becomes transport + tenancy, and this
repo owns the runtime.

## Known limits

- One DSH process per host; sessions are keyed per conversation but share the
  process. Dozens of chats are fine; thousands need per-tenant runtimes.
- Progress mirrors expire (6h default) and are capability URLs, not accounts.
  Anyone with a link can read that one request.
- The mirror shows reasoning; do not enable it where reasoning must stay private.

## Is it ready for a new platform?

| Need | State |
| --- | --- |
| Turn engine, per-chat sessions, queueing | **Ready**, tested |
| Progress mirror (page, live stream, client) | **Ready**, tested end to end |
| Attachment normalisation (data URL or link → path) | **Ready**, tested |
| Adapter contract | **Ready**, covered by a test |
| Postgres storage | **Ready**; memory works without it |
| WhatsApp adapter | **Sketch** — transport mapping only; tenancy, quota and VCC stay in the host app |
| Discord adapter | **Ready** — `adapters/discord/index.js`, chunking and mention handling covered by tests |
| Site publishing | **Ready** but optional; needs `SITE_PUBLIC_ROOT` and a sudo rule |

What you must supply for either platform:

1. A DSH **profile** with the tools you want (the kit does not ship one).
2. A **DSH_HOME** and workspace directory the runtime may write.
3. For a hardened setup, a **separate OS user** for the runtime.
4. An **express** host with a mount path for the mirror router.
