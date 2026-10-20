#!/usr/bin/env node
/**
 * Publish one workspace site folder to the public nginx path.
 *
 * The DSH runtime runs as its own OS user inside its workspace, so a skill
 * builds `sites/<id>/` there and this script copies it to the directory nginx
 * serves at `/sites/<id>/`.
 *
 * Files the agent writes arrive mode 0600 owned by that user, so the copy runs
 * through `sudo` — reading them as the app user is not possible and asking the
 * agent to chmod its own output proved unreliable in practice.
 *
 * Usage: node scripts/publish-site.mjs <siteId> [--workspace <dir>]
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const run = promisify(execFile);
const SITE_ID = /^[a-f0-9]{8}$/;
const DEFAULT_WORKSPACE = resolve(import.meta.dirname, '..');
const PUBLIC_ROOT = process.env.SITE_PUBLIC_ROOT ?? '/home/ubuntu/ephemeral-sites';
// Copying may need elevation when the runtime writes as another user.
const SUDO = process.env.SITE_PUBLISH_SUDO === '0' ? [] : ['sudo', '-n'];

const argv = process.argv.slice(2);
const siteId = argv[0];
const wsFlag = argv.indexOf('--workspace');
const workspace = resolve(wsFlag > -1 ? argv[wsFlag + 1] : DEFAULT_WORKSPACE);

if (!SITE_ID.test(siteId ?? '')) {
  console.error('usage: publish-site.mjs <8-hex-site-id> [--workspace <dir>]');
  process.exit(2);
}

const source = join(workspace, 'sites', siteId);
const target = join(PUBLIC_ROOT, siteId);

// Reject anything without a real page before touching the public path.
try {
  await run(SUDO[0] ?? 'test', [...SUDO.slice(1), 'test', '-f', join(source, 'index.html')]);
} catch {
  console.error(`refusing to publish ${siteId}: no index.html at ${source}`);
  process.exit(1);
}

try {
  // rm + mkdir + cp in one shell keeps the staging step atomic enough for a
  // static folder, and makes the permission fix part of the same operation.
  const S = SUDO.join(' ');
  await run('bash', [
    '-c',
    `set -e
     ${S} rm -rf '${target}'
     ${S} cp -r '${source}' '${target}'
     ${S} find '${target}' -type d -exec chmod 775 {} +
     ${S} find '${target}' -type f -exec chmod 664 {} +`,
  ]);
} catch (error) {
  console.error(`publish failed for ${siteId}: ${error.stderr || error.message}`);
  process.exit(1);
}

console.log(`published ${siteId} -> https://neyobytes.com/sites/${siteId}/`);
