/**
 * Discord bot on the chat runtime.
 *
 *   DISCORD_TOKEN=... DATABASE_URL=... node examples/discord/bot.mjs
 *
 * Discord.js is an optional peer: install it only in a host that runs Discord.
 */
import express from 'express';
import { createDiscordAdapter } from '../../adapters/discord/index.js';
import { ChatRuntime } from '../../packages/core/src/chat-runtime.js';
import { attachMirrorStore } from '../../packages/core/src/mirror-store.js';
import { materializeImages } from '../../packages/core/src/attachments.js';

let discord;
try {
  discord = await import('discord.js');
} catch {
  console.error('install discord.js to run this example: npm i discord.js');
  process.exit(1);
}

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is required');
  process.exit(1);
}

if (process.env.DATABASE_URL) {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  attachMirrorStore((sql, params) => pool.query(sql, params));
}

const bot = new ChatRuntime({
  dshBinary: process.env.DSH_BIN ?? 'dsh',
  profile: process.env.DSH_PROFILE ?? 'chat',
  dshHome: process.env.DSH_HOME_DIR,
  cwd: process.env.WORKSPACE_DIR,
  spawnCwd: process.env.DSH_SPAWN_CWD,
  provider: process.env.DSH_PROVIDER ?? 'litellm',
  model: process.env.DSH_MODEL ?? 'deepseek-v4.1-flash',
  reasoningEffort: process.env.DSH_EFFORT,
  mirrorBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3200',
  mirrorPath: '/chat',
});
await bot.sweep();

const client = new discord.Client({
  intents: [
    discord.GatewayIntentBits.Guilds,
    discord.GatewayIntentBits.GuildMessages,
    discord.GatewayIntentBits.MessageContent,
  ],
});

const adapter = createDiscordAdapter({
  client,
  trigger: process.env.DISCORD_TRIGGER ?? '!ai',
  requireMention: process.env.DISCORD_REQUIRE_MENTION !== 'false',
  onError: (error) => console.error('[discord]', error?.message ?? error),
});

// The adapter passes attachment URLs; materialize them before the turn so the
// runtime reads files rather than holding base64 in its session log.
await adapter.start(async (message) => {
  const imagePaths = await materializeImages(message.attachments ?? [], {
    dir: process.env.ATTACHMENT_DIR ?? '/tmp/chat-in',
  });

  const result = await bot.ask({
    conversationId: message.conversationId,
    text: message.text,
    imagePaths,
  });

  if (result.text) {
    await adapter.send(message.conversationId, result.text);
  } else {
    // Discord shows failures; the WhatsApp adapter stays silent instead.
    await adapter.send(message.conversationId, 'That request ended without an answer. Please try again.');
  }
});

// Progress pages need a web host; skip it when no port is configured.
if (process.env.MIRROR_PORT) {
  const app = express();
  app.use('/chat', await bot.router());
  app.listen(Number(process.env.MIRROR_PORT), () =>
    console.log(`mirror on :${process.env.MIRROR_PORT}/chat`)
  );
}

async function shutdown() {
  await bot.close();
  await client.destroy();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await client.login(token);
console.log('[discord] logged in');
