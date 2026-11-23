// A fake whatsapp-web.js client: the adapter must work without the SDK.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createWhatsAppAdapter, chunkMessage, MAX_MESSAGE_CHARS } from '../adapters/whatsapp/index.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function fakeWhatsApp() {
  const client = new EventEmitter();
  const sent = [];
  client.sendMessage = async (chatId, text) => { sent.push({ chatId, text }); return { id: 'm1' }; };
  client.getChatById = async () => ({ sendStateTyping: async () => {} });

  const emit = (overrides = {}) => {
    const message = {
      fromMe: false,
      isStatus: false,
      body: '!ai hello',
      from: 'user1@c.us',
      hasMedia: false,
      hasQuotedMsg: false,
      getChat: async () => ({ id: { _serialized: 'user1@c.us' }, isGroup: false }),
      getContact: async () => ({ pushname: 'Haz', number: '60123456789' }),
      downloadMedia: async () => null,
      ...overrides,
    };
    client.emit('message', message);
    return message;
  };
  return { client, sent, emit };
}

const wait = (ms = 25) => new Promise((r) => setTimeout(r, ms));

test('a private trigger message reaches the runtime', async () => {
  const { client, emit } = fakeWhatsApp();
  const got = [];
  await createWhatsAppAdapter({ client }).start(async (m) => got.push(m));
  emit();
  await wait();
  assert.equal(got.length, 1);
  assert.equal(got[0].conversationId, 'user1@c.us');
  assert.equal(got[0].text, 'hello');
  assert.equal(got[0].isGroup, false);
});

test('the bot ignores its own messages and status posts', async () => {
  const { client, emit } = fakeWhatsApp();
  const got = [];
  await createWhatsAppAdapter({ client }).start(async (m) => got.push(m));
  emit({ fromMe: true });
  emit({ isStatus: true });
  await wait();
  assert.equal(got.length, 0);
});

test('messages without the trigger, or with only the trigger, are ignored', async () => {
  const { client, emit } = fakeWhatsApp();
  const got = [];
  await createWhatsAppAdapter({ client }).start(async (m) => got.push(m));
  emit({ body: 'just chatting' });
  emit({ body: '!ai   ' });
  await wait();
  assert.equal(got.length, 0);
});

test('group messages carry the speaker', async () => {
  const { client, emit } = fakeWhatsApp();
  const got = [];
  await createWhatsAppAdapter({ client }).start(async (m) => got.push(m));
  emit({
    body: '!ai what is this',
    from: 'group1@g.us',
    getChat: async () => ({ id: { _serialized: 'group1@g.us' }, isGroup: true }),
    getContact: async () => ({ pushname: 'Haz' }),
  });
  await wait();
  assert.equal(got[0].conversationId, 'group1@g.us');
  assert.equal(got[0].text, 'Haz: what is this');
  assert.equal(got[0].isGroup, true);
});

test('an attached image becomes a data URL attachment', async () => {
  const { client, emit } = fakeWhatsApp();
  const got = [];
  await createWhatsAppAdapter({ client }).start(async (m) => got.push(m));
  emit({ hasMedia: true, downloadMedia: async () => ({ mimetype: 'image/png', data: PNG.split(',')[1] }) });
  await wait();
  assert.equal(got[0].attachments.length, 1);
  assert.match(got[0].attachments[0], /^data:image\/png;base64,/);
});

test('long replies are chunked under the limit', async () => {
  const { client, sent } = fakeWhatsApp();
  const adapter = createWhatsAppAdapter({ client });
  await adapter.start(async () => {});
  const long = Array.from({ length: 60 }, (_, i) => `line ${i} `.repeat(10)).join('\n');
  await adapter.send('user1@c.us', long);
  assert.ok(sent.length > 1);
  for (const { text } of sent) assert.ok(text.length <= MAX_MESSAGE_CHARS);
});

test('replying to a quoted image collects the image even when current message has no media', async () => {
  const { client, emit } = fakeWhatsApp();
  const got = [];
  await createWhatsAppAdapter({ client }).start(async (m) => got.push(m));
  emit({
    hasMedia: false,
    hasQuotedMsg: true,
    getQuotedMessage: async () => ({
      hasMedia: true,
      downloadMedia: async () => ({ mimetype: 'image/png', data: PNG.split(',')[1] }),
    }),
  });
  await wait();
  assert.equal(got.length, 1);
  assert.equal(got[0].attachments.length, 1);
  assert.match(got[0].attachments[0], /^data:image\/png;base64,/);
});

test('isAllowed gate blocks locked groups and Markdown is formatted for WhatsApp', async () => {
  const { client, sent, emit } = fakeWhatsApp();
  const got = [];
  const adapter = createWhatsAppAdapter({
    client,
    isAllowed: ({ isGroup }) => !isGroup,
  });
  await adapter.start(async (m) => got.push(m));
  emit({
    from: 'locked@g.us',
    getChat: async () => ({ id: { _serialized: 'locked@g.us' }, isGroup: true }),
  });
  await wait();
  assert.equal(got.length, 0);

  await adapter.send('user1@c.us', '## Summary\nCheck **bold** and [docs](https://example.com)');
  assert.equal(sent[0].text, '*Summary*\nCheck *bold* and docs (https://example.com)');
});
