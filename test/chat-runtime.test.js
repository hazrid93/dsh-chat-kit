// ChatRuntime tests: pluggable client, per-chat serialization, mirror lifecycle,
// onMirrorOpened hook, resetChat, and graceful turn draining.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ChatRuntime } from '../packages/core/src/chat-runtime.js';
import { attachMirrorStore, getMirror } from '../packages/core/src/mirror-store.js';

test('ChatRuntime serialises per-conversation turns and supports pluggable clients', async () => {
  attachMirrorStore(null);
  const order = [];
  let resetCalls = [];

  const mockClient = {
    async prompt({ chatId, text, onEvent }) {
      order.push(`start:${text}`);
      onEvent?.({ type: 'tool_start', tool: 'web_search', callId: text, args: { query: text } });
      await new Promise((r) => setTimeout(r, text === 'first' ? 60 : 10));
      onEvent?.({ type: 'tool_result', callId: text, status: 'ok', result: 'ok' });
      order.push(`end:${text}`);
      return { text: `reply:${text}` };
    },
    resetChat(id) { resetCalls.push(id); },
    async stop() {},
  };

  const bot = new ChatRuntime({
    client: mockClient,
    mirrorBaseUrl: 'https://example.com',
    mirrorPath: '/chat',
  });

  const openedUrls = [];
  const p1 = bot.ask({
    conversationId: 'c1',
    text: 'first',
    onMirrorOpened: (url) => openedUrls.push(url),
  });
  const p2 = bot.ask({ conversationId: 'c1', text: 'second' });

  // While p1 is running, drain() must wait for both turns to settle.
  assert.ok(bot.activeTurns() >= 1);
  const [r1, r2] = await Promise.all([p1, p2]);
  const stranded = await bot.drain(1000);

  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
  assert.equal(r1.text, 'reply:first');
  assert.equal(r2.text, 'reply:second');
  assert.equal(openedUrls.length, 1);
  assert.equal(openedUrls[0], r1.mirrorUrl);
  assert.deepEqual(stranded, []);

  const id = r1.mirrorUrl.split('/').pop();
  const mirror = await getMirror(id);
  assert.equal(mirror.done, true);
  assert.equal(mirror.answer, 'reply:first');

  await bot.resetChat('c1');
  assert.deepEqual(resetCalls, ['c1']);
  await bot.close();
});
