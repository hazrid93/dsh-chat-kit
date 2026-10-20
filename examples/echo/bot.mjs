/**
 * Example host: any transport that can call `bot.ask()`.
 *
 * This file is the whole integration surface a new platform needs — the
 * adapter only decides how a message arrives and how the reply leaves.
 */
import express from 'express';
import { ChatRuntime } from '../../packages/core/src/chat-runtime.js';
import { attachMirrorStore } from '../../packages/core/src/mirror-store.js';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
attachMirrorStore((sql, params) => pool.query(sql, params));

const bot = new ChatRuntime({
  dshBinary: process.env.DSH_BIN ?? 'dsh',
  profile: process.env.DSH_PROFILE ?? 'whatsapp',
  dshHome: process.env.DSH_HOME_DIR,
  cwd: process.env.WORKSPACE_DIR,
  provider: process.env.DSH_PROVIDER ?? 'litellm',
  model: process.env.DSH_MODEL ?? 'deepseek-v4.1-flash',
  reasoningEffort: process.env.DSH_EFFORT ?? 'high',
  mirrorBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3100',
  mirrorPath: '/chat',
});

await bot.sweep();

const app = express();
app.use('/chat', await bot.router());

// Any transport posts here; the reply comes back with its progress link.
app.post('/ask', express.json(), async (req, res) => {
  const { conversationId, text } = req.body ?? {};
  if (!conversationId || !text) return res.status(400).json({ error: 'conversationId and text are required' });
  const result = await bot.ask({ conversationId, text });
  res.json(result);
});

app.listen(3100, () => console.log('echo adapter on http://localhost:3100'));
