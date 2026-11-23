// Exercises DshClient over a real stdio JSON-RPC mock child process:
// normal replies, empty-completion single retry, subagent isolation, and resetChat.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DshClient, sessionIdFor } from '../packages/core/src/dsh-client.js';

const MOCK_DSH = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let emptyAttempts = 0;

rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { ok: true } });
  if (m.method === 'session/resume') return send({ jsonrpc: '2.0', id: m.id, error: { message: 'not found' } });
  if (m.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: m.id, result: { ok: true } });
    return setTimeout(() => process.exit(0), 10);
  }
  if (m.method === 'session/prompt') {
    const sid = m.params.sessionId;
    const text = m.params.contentBlocks[0].text;
    send({ jsonrpc: '2.0', id: m.id, result: { accepted: true } });

    if (text === 'subagent-test') {
      const childId = 'child-sub-1';
      send({ jsonrpc: '2.0', method: 'subagent.started', params: { parentSessionId: sid, childSessionId: childId } });
      send({ jsonrpc: '2.0', method: 'event', params: { sessionId: childId, event: { type: 'tool/call', data: { name: 'web_search', callId: 'c1', arguments: '{"query":"hi"}' } } } });
      send({ jsonrpc: '2.0', method: 'event', params: { sessionId: childId, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'CHILD_ONLY_TEXT' }] } } } } });
      send({ jsonrpc: '2.0', method: 'event', params: { sessionId: childId, event: { type: 'turn/end', data: { reason: { kind: 'stop' } } } } });
      send({ jsonrpc: '2.0', method: 'subagent.finished', params: { parentSessionId: sid, childSessionId: childId, status: 'ok', lastAssistantMessage: [{ type: 'text', text: 'sub done' }] } });
      // Subsequent parent events MUST have child: false and parent's own text must win.
      send({ jsonrpc: '2.0', method: 'event', params: { sessionId: sid, event: { type: 'tool/call', data: { name: 'bash', callId: 'p1', arguments: '{"command":"ls"}' } } } });
      send({ jsonrpc: '2.0', method: 'event', params: { sessionId: sid, event: { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'parent thought' }, { type: 'text', text: 'PARENT_FINAL_ANSWER' }] } } } } });
      send({ jsonrpc: '2.0', method: 'event', params: { sessionId: sid, event: { type: 'turn/end', data: { reason: { kind: 'stop' } } } } });
      return;
    }

    if (text === 'empty-once') {
      emptyAttempts += 1;
      send({ jsonrpc: '2.0', method: 'event', params: { sessionId: sid, event: { type: 'turn/end', data: { reason: { kind: 'stop' } } } } });
      return;
    }
    if (text.includes('Your previous reply was empty')) {
      send({ jsonrpc: '2.0', method: 'event', params: { sessionId: sid, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'RECOVERED_ANSWER' }] } } } } });
      send({ jsonrpc: '2.0', method: 'event', params: { sessionId: sid, event: { type: 'turn/end', data: { reason: { kind: 'stop' } } } } });
      return;
    }

    send({ jsonrpc: '2.0', method: 'event', params: { sessionId: sid, event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'echo:' + sid + ':' + text }] } } } } });
    send({ jsonrpc: '2.0', method: 'event', params: { sessionId: sid, event: { type: 'turn/end', data: { reason: { kind: 'stop' } } } } });
  }
});
`;

function makeClient() {
  return new DshClient({
    command: process.execPath,
    argsPrefix: ['-e', MOCK_DSH, '--'],
    profile: 'test',
    cwd: process.cwd(),
  });
}

test('subagent events never corrupt parent child-flag, text, or turn/end', async () => {
  const client = makeClient();
  const events = [];
  try {
    const res = await client.prompt({
      chatId: 'room-sub',
      text: 'subagent-test',
      onEvent: (e) => events.push(e),
    });
    assert.equal(res.text, 'PARENT_FINAL_ANSWER');

    const childTool = events.find((e) => e.type === 'tool_start' && e.tool === 'web_search');
    const parentTool = events.find((e) => e.type === 'tool_start' && e.tool === 'bash');
    const parentThought = events.find((e) => e.type === 'reasoning' && e.text === 'parent thought');
    assert.equal(childTool?.child, true);
    assert.equal(parentTool?.child, false);
    assert.equal(parentThought?.child, false);
  } finally {
    await client.stop();
  }
});

test('empty completion triggers one retry and returns recovered text', async () => {
  const client = makeClient();
  try {
    const res = await client.prompt({ chatId: 'room-empty', text: 'empty-once' });
    assert.equal(res.text, 'RECOVERED_ANSWER');
    assert.equal(res.retried, true);
  } finally {
    await client.stop();
  }
});

test('resetChat switches the conversation to a new session id', async () => {
  const client = makeClient();
  try {
    const first = await client.prompt({ chatId: 'room-reset', text: 'hello' });
    assert.match(first.text, new RegExp(`^echo:${sessionIdFor('room-reset')}:hello$`));
    client.resetChat('room-reset');
    const second = await client.prompt({ chatId: 'room-reset', text: 'again' });
    assert.ok(!second.text.includes(sessionIdFor('room-reset')));
    assert.match(second.text, /:again$/);
  } finally {
    await client.stop();
  }
});

test('resetStatePath persists chat reset epochs across DshClient instances', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reset-'));
  const stateFile = join(dir, 'resets.json');
  try {
    const c1 = new DshClient({ command: process.execPath, profile: 'test', resetStatePath: stateFile });
    const before = c1._sessionId('chat-a');
    c1.resetChat('chat-a');
    const after = c1._sessionId('chat-a');
    assert.notEqual(before, after);
    const c2 = new DshClient({ command: process.execPath, profile: 'test', resetStatePath: stateFile });
    assert.equal(c2._sessionId('chat-a'), after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
