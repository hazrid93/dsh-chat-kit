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
import { serve } from 'dsh-chat-kit/packages/core/src/adapter.js';

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
