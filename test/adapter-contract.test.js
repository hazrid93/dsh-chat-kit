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
