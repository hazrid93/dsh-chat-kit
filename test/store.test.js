// The store must work with any table name and without a database, so a new
// platform can try it before wiring Postgres.
import assert from 'node:assert/strict';
import test from 'node:test';
import { openMirror, recordMirrorEvent, finishMirror, getMirror, attachMirrorStore } from '../packages/core/src/mirror-store.js';

test('a mirror records reasoning, requests and responses in order', async () => {
  attachMirrorStore(null); // memory only
  const id = await openMirror({ chatId: 'c1', question: 'hello' });
  recordMirrorEvent(id, { type: 'reasoning', text: 'thinking about it' });
  recordMirrorEvent(id, { type: 'tool_start', tool: 'bash', callId: 'a', arguments: '{"command":"whoami"}' });
  recordMirrorEvent(id, { type: 'tool_result', callId: 'a', status: 'ok', result: 'ubuntu' });
  await finishMirror(id, { answer: 'done' });

  const m = await getMirror(id);
  assert.equal(m.done, true);
  assert.equal(m.answer, 'done');
  assert.deepEqual(m.events.map((e) => e.kind), ['reasoning', 'tool']);
  assert.equal(m.events[1].tool, 'bash');
  assert.match(m.events[1].request, /whoami/);
  assert.equal(m.events[1].response, 'ubuntu');
});

test('secrets in tool payloads are redacted before publish', async () => {
  attachMirrorStore(null);
  const id = await openMirror({ chatId: 'c2', question: 'q' });
  recordMirrorEvent(id, { type: 'tool_start', tool: 'bash', callId: 'b', arguments: 'export KEY=sk-live-abcdef1234567890' });
  recordMirrorEvent(id, { type: 'tool_result', callId: 'b', status: 'ok', result: 'mail me@x.com or +60123456789 at /home/u/secret.js' });
  await finishMirror(id, { answer: '' });
  const m = await getMirror(id);
  const blob = JSON.stringify(m);
  assert.ok(!blob.includes('sk-live-abcdef1234567890'), 'key leaked');
  assert.ok(!blob.includes('me@x.com'), 'email leaked');
  assert.ok(!blob.includes('60123456789'), 'phone leaked');
});

test('a finished mirror survives a missing database', async () => {
  attachMirrorStore(null);
  const id = await openMirror({ chatId: 'c3', question: 'q' });
  await finishMirror(id, { answer: 'kept' });
  const m = await getMirror(id);
  assert.equal(m?.answer, 'kept');
});

test('unknown and malformed ids resolve to null', async () => {
  attachMirrorStore(null);
  assert.equal(await getMirror('nope'), null);
  assert.equal(await getMirror(''), null);
});
