// A platform is three methods. This test is the contract, so a new adapter is
// written against something executable rather than prose.
import assert from 'node:assert/strict';
import test from 'node:test';
import { serve } from '../packages/core/src/adapter.js';

function fakeBot(reply) {
  const asks = [];
  return {
    asks,
    async ask(input) {
      asks.push(input);
      return { text: reply, mirrorUrl: 'https://x/chat/mirror/abc', sites: [] };
    },
  };
}

test('an adapter only has to send, receive and deliver', async () => {
  const bot = fakeBot('the answer');
  const sent = [];
  let deliverToBot;

  const adapter = {
    name: 'fake',
    async start(handler) { deliverToBot = handler; },
    async send(conversationId, text) { sent.push({ conversationId, text }); },
  };

  await serve(bot, adapter);
  await deliverToBot({ conversationId: 'room:1', text: 'hello', author: 'me', isGroup: false });

  assert.deepEqual(bot.asks, [{ conversationId: 'room:1', text: 'hello', imagePaths: undefined }]);
  assert.deepEqual(sent, [{ conversationId: 'room:1', text: 'the answer' }]);
});

test('a failed turn stays silent unless the adapter opts into errors', async () => {
  const bot = fakeBot('');
  const sent = [];
  let deliverToBot;
  const adapter = {
    name: 'quiet',
    async start(h) { deliverToBot = h; },
    async send(c, t) { sent.push(t); },
  };
  await serve(bot, adapter);
  await deliverToBot({ conversationId: 'room:2', text: 'hi' });
  assert.deepEqual(sent, []);

  const errorSent = [];
  const loud = {
    name: 'loud',
    async start(h) { deliverToBot = h; },
    async send(c, t) { sent.push(t); },
    async sendError(c, t) { errorSent.push(t); },
  };
  await serve(bot, loud);
  await deliverToBot({ conversationId: 'room:3', text: 'hi' });
  assert.equal(errorSent.length, 1);
});

test('serve materializes attachments, emits typing, and calls sendProgress', async () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const asks = [];
  const bot = {
    async ask(input) {
      asks.push(input);
      input.onMirrorOpened?.('https://x/chat/mirror/abc', 'abc');
      return { text: 'ok', mirrorUrl: 'https://x/chat/mirror/abc', sites: [] };
    },
  };
  let deliver;
  const typed = [];
  const progress = [];
  const sent = [];
  const adapter = {
    name: 'rich',
    async start(h) { deliver = h; },
    async typing(id) { typed.push(id); },
    async sendProgress(id, url) { progress.push({ id, url }); },
    async send(id, text) { sent.push({ id, text }); },
  };
  await serve(bot, adapter, { typingIntervalMs: 0 });
  await deliver({ conversationId: 'room:4', text: 'look', attachments: [PNG] });
  assert.equal(asks.length, 1);
  assert.equal(asks[0].imagePaths.length, 1);
  assert.match(asks[0].imagePaths[0], /\.png$/);
  assert.deepEqual(typed, ['room:4']);
  assert.deepEqual(progress, [{ id: 'room:4', url: 'https://x/chat/mirror/abc' }]);
  assert.deepEqual(sent, [{ id: 'room:4', text: 'ok' }]);
});
