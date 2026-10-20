// WhatsApp sends base64 data URLs, Discord sends links: both must become paths.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, rm } from 'node:fs/promises';
import { materializeImage } from '../packages/core/src/attachments.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a base64 data URL becomes a readable png', async () => {
  const path = await materializeImage(PNG, { name: 'wa-test' });
  assert.ok(path, 'expected a path');
  assert.match(path, /wa-test\.png$/);
  const bytes = await readFile(path);
  assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  await rm(path, { force: true });
});

test('junk input yields null instead of throwing', async () => {
  assert.equal(await materializeImage('data:image/png,notbase64'), null);
  assert.equal(await materializeImage(''), null);
});

test('an oversized payload is refused', async () => {
  assert.equal(await materializeImage(PNG, { maxBytes: 10 }), null);
});
