/**
 * WhatsApp bot on the chat runtime.
 *
 *   WA_TRIGGER='!ai' DATABASE_URL=… node examples/whatsapp/bot.mjs
 *
 * First run prints a QR code in the terminal; the session is kept in
 * ./.wwebjs_auth so later runs reconnect without one.
 *
 * whatsapp-web.js is an optional peer: install it only in a host that runs it.
 */
import express from 'express';
import { createWhatsAppAdapter } from '../../adapters/whatsapp/index.js';
import { ChatRuntime } from '../../packages/core/src/chat-runtime.js';
import { attachMirrorStore } from '../../packages/core/src/mirror-store.js';
import { materializeImages } from '../../packages/core/src/attachments.js';

let whatsapp;
try {
  whatsapp = await import('whatsapp-web.js');
} catch {
  console.error('install whatsapp-web.js to run this example: npm i whatsapp-web.js qrcode-terminal');
  process.exit(1);
}

if (process.env.DATABASE_URL) {
  const pg = (await import('pg')).default;
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  attachMirrorStore((sql, params) => pool.query(sql, params));
} else {
  attachMirrorStore(null);
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
  mirrorBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3300',
  mirrorPath: '/chat',
});
await bot.sweep();

const { Client, LocalAuth } = whatsapp;
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: process.env.WA_AUTH_DIR ?? './.wwebjs_auth' }),
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
});

const adapter = createWhatsAppAdapter({
  client,
  trigger: process.env.WA_TRIGGER ?? '!ai',
  onError: (error) => console.error('[whatsapp]', error?.message ?? error),
});

// Attachments arrive as data URLs; write them to disk so the runtime reads a
// file rather than carrying base64 in its session log.
await adapter.start(async (message) => {
  const imagePaths = await materializeImages(message.attachments ?? [], {
    dir: process.env.ATTACHMENT_DIR ?? '/tmp/chat-in',
  });

  const result = await bot.ask({
    conversationId: message.conversationId,
    text: message.text,
    imagePaths,
  });

  // WhatsApp stays silent on failure by design; the mirror records what happened.
  if (result.text) await adapter.send(message.conversationId, result.text);
});

if (process.env.MIRROR_PORT) {
  const app = express();
  app.use('/chat', await bot.router());
  app.listen(Number(process.env.MIRROR_PORT), () =>
    console.log(`mirror on :${process.env.MIRROR_PORT}/chat`)
  );
}

client.on('qr', async (qr) => {
  const { default: qrcode } = await import('qrcode-terminal').catch(() => ({ default: null }));
  if (qrcode) qrcode.generate(qr, { small: true });
  else console.log('scan this QR with WhatsApp:\n' + qr);
});
client.on('ready', () => console.log('[whatsapp] ready'));
client.on('auth_failure', (m) => console.error('[whatsapp] auth failed:', m));

async function shutdown() {
  await bot.close();
  await client.destroy().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await client.initialize();
