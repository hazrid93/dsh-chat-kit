/**
 * Turn a platform attachment into a file the runtime can read.
 *
 * Every chat SDK delivers images differently — base64 data URLs on WhatsApp,
 * signed URLs on Discord — but the runtime only accepts paths, because sending
 * bytes would put whole images into the session log.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/avif': '.avif',
};

/**
 * Write one attachment to `dir` and return its absolute path.
 *
 * @param {string} input a `data:` URL, an `http(s):` URL, or an existing path
 * @param {object} [options]
 * @param {string} [options.dir] where to write; defaults to the OS temp dir
 * @param {string} [options.name] filename stem; a random one is generated
 * @param {number} [options.timeoutMs] fetch timeout for remote URLs
 * @param {number} [options.maxBytes] refuse larger payloads
 * @returns {Promise<string|null>} absolute path, or null when unusable
 */
export async function materializeImage(input, options = {}) {
  const value = String(input ?? '').trim();
  if (!value) return null;

  const dir = resolve(options.dir ?? (process.env.TMPDIR || '/tmp'));
  const stem = options.name ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;

  try {
    await mkdir(dir, { recursive: true });

    if (value.startsWith('data:')) {
      const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/s.exec(value);
      if (!match) return null;
      const [, mime = 'image/jpeg', base64] = match;
      const bytes = Buffer.from(base64, 'base64');
      if (bytes.length > maxBytes) return null;
      const path = join(dir, stem + (EXT_BY_MIME[mime.toLowerCase()] ?? '.bin'));
      await writeFile(path, bytes);
      return path;
    }

    if (/^https?:\/\//i.test(value)) {
      const res = await fetch(value, { signal: AbortSignal.timeout(options.timeoutMs ?? 30_000) });
      if (!res.ok) return null;
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > maxBytes) return null;
      const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
      const fromUrl = extname(new URL(value).pathname);
      const ext = EXT_BY_MIME[mime] ?? (fromUrl.length <= 5 ? fromUrl : '.bin');
      const path = join(dir, stem + ext);
      await writeFile(path, bytes);
      return path;
    }

    // Already a file path the caller prepared.
    return resolve(value);
  } catch {
    return null;
  }
}

/**
 * Materialize several attachments, dropping the ones that fail.
 * @param {string[]} inputs
 * @param {object} [options] see {@link materializeImage}
 */
export async function materializeImages(inputs, options = {}) {
  const results = await Promise.all((inputs ?? []).map((one) => materializeImage(one, options)));
  return results.filter(Boolean);
}

export default materializeImage;
