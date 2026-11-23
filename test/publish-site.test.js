// publish-site.mjs must be safely importable without running CLI exit paths.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publishSite } from '../packages/core/src/publish-site.mjs';

test('publishSite copies a valid site folder into publicRoot without sudo', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-pub-'));
  try {
    const ws = join(base, 'ws');
    const pub = join(base, 'pub');
    await mkdir(join(ws, 'sites', 'a1b2c3d4'), { recursive: true });
    await writeFile(join(ws, 'sites', 'a1b2c3d4', 'index.html'), '<h1>hi</h1>');

    const res = await publishSite('a1b2c3d4', {
      workspace: ws,
      publicRoot: pub,
      publicBaseUrl: 'https://example.com',
      sudo: false,
    });
    assert.equal(res.siteId, 'a1b2c3d4');
    assert.equal(res.url, 'https://example.com/sites/a1b2c3d4/');
    assert.equal(await readFile(join(pub, 'a1b2c3d4', 'index.html'), 'utf8'), '<h1>hi</h1>');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('publishSite rejects invalid ids or missing index.html', async () => {
  await assert.rejects(() => publishSite('../bad', { sudo: false }), /8-character/);
  const base = await mkdtemp(join(tmpdir(), 'dsh-pub-empty-'));
  try {
    await assert.rejects(() => publishSite('deadbeef', { workspace: base, sudo: false }), /no index\.html/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
