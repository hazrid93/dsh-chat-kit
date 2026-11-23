#!/usr/bin/env node
/**
 * Publish one workspace site folder to a public static root.
 *
 * Safe to import as a module (`import { publishSite } from 'dsh-chat-kit/publish.js'`)
 * or run directly as a CLI:
 *   node packages/core/src/publish-site.mjs <8-hex-site-id> [--workspace <dir>] [--public-root <dir>]
 */
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SITE_ID = /^[a-f0-9]{8}$/;

async function chmodRecursive(dir) {
  await chmod(dir, 0o775);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await chmodRecursive(full);
    else if (entry.isFile()) await chmod(full, 0o664);
  }
}

async function execCmd(useSudo, cmd, args) {
  if (useSudo) return run('sudo', ['-n', cmd, ...args]);
  return run(cmd, args);
}

/**
 * Copy `<workspace>/sites/<siteId>` to `<publicRoot>/<siteId>`.
 *
 * @param {string} siteId 8-char lowercase hex id
 * @param {object} [options]
 * @param {string} [options.workspace]
 * @param {string} [options.publicRoot]
 * @param {string} [options.publicBaseUrl]
 * @param {boolean} [options.sudo] run copy/chmod via `sudo -n` (for cross-user workers)
 * @returns {Promise<{siteId: string, target: string, url: string|null}>}
 */
export async function publishSite(siteId, options = {}) {
  if (!SITE_ID.test(siteId ?? '')) {
    throw new Error('siteId must be an 8-character lowercase hex string');
  }

  const workspace = resolve(options.workspace ?? process.env.WORKSPACE_DIR ?? process.cwd());
  const publicRoot = resolve(options.publicRoot ?? process.env.SITE_PUBLIC_ROOT ?? join(workspace, 'public-sites'));
  const useSudo = options.sudo ?? (process.env.SITE_PUBLISH_SUDO === '1');
  const publicBaseUrl = (options.publicBaseUrl ?? process.env.SITE_PUBLIC_URL ?? '').replace(/\/$/, '');

  const source = join(workspace, 'sites', siteId);
  const target = join(publicRoot, siteId);

  if (useSudo) {
    await execCmd(true, 'test', ['-f', join(source, 'index.html')]);
    await execCmd(true, 'mkdir', ['-p', publicRoot]);
    await execCmd(true, 'rm', ['-rf', target]);
    await execCmd(true, 'cp', ['-r', source, target]);
    await execCmd(true, 'find', [target, '-type', 'd', '-exec', 'chmod', '775', '{}', '+']);
    await execCmd(true, 'find', [target, '-type', 'f', '-exec', 'chmod', '664', '{}', '+']);
  } else {
    const indexStat = await stat(join(source, 'index.html')).catch(() => null);
    if (!indexStat?.isFile()) {
      throw new Error(`refusing to publish ${siteId}: no index.html at ${source}`);
    }
    await mkdir(publicRoot, { recursive: true });
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true });
    await chmodRecursive(target);
  }

  const url = publicBaseUrl ? `${publicBaseUrl}/sites/${siteId}/` : null;
  return { siteId, target, url };
}

// CLI entry point only when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const argv = process.argv.slice(2);
  const siteId = argv[0];
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i > -1 ? argv[i + 1] : undefined;
  };
  try {
    const result = await publishSite(siteId, {
      workspace: flag('--workspace'),
      publicRoot: flag('--public-root'),
      publicBaseUrl: flag('--public-url'),
    });
    console.log(`published ${result.siteId} -> ${result.url ?? result.target}`);
  } catch (error) {
    console.error(error.message);
    process.exit(SITE_ID.test(siteId ?? '') ? 1 : 2);
  }
}

export default publishSite;
