// A fake Discord client: the adapter must work without discord.js installed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createDiscordAdapter, chunkMessage, MAX_MESSAGE_CHARS } from '../adapters/discord/index.js';

function fakeDiscord() {
  const client = new EventEmitter();
  client.user = { id: 'bot-1' };
  const sent = [];
  client.channels = {
    async fetch(id) {
      return { id, async send(chunk) { sent.push({ id, chunk }); return { id: 'msg' }; } };
    },
  };
  const emit = (overrides = {}) => {
    const message = {
      content: '!ai hello there',
      author: { id: 'user-1', username: 'haz', bot: false },
      member: { displayName: 'Haz' },
      channelId: 'chan-1',
      guildId: 'guild-1',
      mentions: { has: () => false },
      attachments: new Map(),
      ...overrides,
    };
    client.emit('messageCreate', message);
    return message;
  };
  return { client, sent, emit };
}

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('a prefixed guild message reaches the bot with the speaker', async () => {
  const { client, emit } = fakeDiscord();
  const adapter = createDiscordAdapter({ client });
  const got = [];
  await adapter.start(async (m) => got.push(m));
  emit();
  await wait();
  assert.equal(got.length, 1);
  assert.equal(got[0].conversationId, 'discord:chan-1');
  assert.equal(got[0].text, 'Haz: hello there');
  assert.equal(got[0].isGroup, true);
});

test('commands from the bot itself and other bots are ignored', async () => {
  const { client, emit } = fakeDiscord();
  const got = [];
  const adapter = createDiscordAdapter({ client });
  await adapter.start(async (m) => got.push(m));
  emit({ author: { id: 'bot-1', username: 'self', bot: false } });
  emit({ author: { id: 'other', username: 'other', bot: true } });
  await wait();
  assert.equal(got.length, 0);
});

test('a channel message with no prefix is ignored unless mentioned', async () => {
  const { client, emit } = fakeDiscord();
  const got = [];
  const adapter = createDiscordAdapter({ client });
  await adapter.start(async (m) => got.push(m));
  emit({ content: 'just chatting' });
  await wait();
  assert.equal(got.length, 0);

  // A mention carries the message itself; the trigger prefix is not required.
  emit({ content: 'look at this', mentions: { has: () => true } });
  await wait();
  assert.equal(got.length, 1);
  assert.equal(got[0].text, 'Haz: look at this');
});

test('long replies are chunked under the Discord limit', async () => {
  const { client, sent } = fakeDiscord();
  const adapter = createDiscordAdapter({ client });
  await adapter.start(async () => {});
  const long = Array.from({ length: 40 }, (_, i) => `paragraph ${i} `.repeat(12)).join('\n\n');
  await adapter.send('discord:chan-1', long);
  assert.ok(sent.length > 1, 'expected several chunks');
  for (const { chunk } of sent) assert.ok(chunk.length <= MAX_MESSAGE_CHARS, `chunk too long: ${chunk.length}`);
  assert.equal(sent.map((s) => s.chunk).join('').replace(/\s+/g, '').length, long.replace(/\s+/g, '').length);
});
