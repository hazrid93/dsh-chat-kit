// The progress page is part of the library, so prove it serves: page, client
// asset, and a live event stream — with no platform and no database.
import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { Router } from 'express';
import { openMirror, recordMirrorEvent, finishMirror, attachMirrorStore } from '../packages/core/src/mirror-store.js';
import mirrorRoutes from '../packages/core/src/mirror-routes.js';

let server, base, id;

test.before(async () => {
  attachMirrorStore(null);
  const app = express();
  app.use('/chat', mirrorRoutes);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  id = await openMirror({ chatId: 'c', question: 'does the page render' });
  recordMirrorEvent(id, { type: 'reasoning', text: 'first thought' });
});

test.after(() => server?.close());

test('page renders with the live client wired in', async () => {
  const res = await fetch(`${base}/chat/mirror/${id}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /data-mirror-id=/);
  assert.match(html, /src="\/chat\/mirror-client\.js"/);
  assert.match(html, /first thought/);
  assert.doesNotMatch(html, /<script>/); // CSP-safe: external script only
});

test('client asset is served', async () => {
  const res = await fetch(`${base}/chat/mirror-client.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.ok((await res.text()).length > 1000);
});

test('the stream pushes an event as it happens', async () => {
  const res = await fetch(`${base}/chat/mirror/${id}/stream`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /event-stream/);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const seen = [];
  const deadline = Date.now() + 8000;

  setTimeout(() => {
    recordMirrorEvent(id, { type: 'tool_start', tool: 'bash', callId: 'x', arguments: '{"command":"echo hi"}' });
    recordMirrorEvent(id, { type: 'tool_result', callId: 'x', status: 'ok', result: 'hi' });
    finishMirror(id, { answer: 'done' });
  }, 200);

  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ value: undefined }), 500)),
    ]);
    if (chunk.value) buf += dec.decode(chunk.value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (frame.startsWith('data: ')) seen.push(JSON.parse(frame.slice(6)));
    }
    if (seen.some((s) => s.done)) break;
  }
  assert.ok(seen.length >= 2, `expected pushes, saw ${seen.length}`);
  const last = seen.at(-1);
  assert.equal(last.done, true);
  assert.equal(last.answer, 'done');
  assert.ok(last.events.some((e) => e.tool === 'bash'));
});
