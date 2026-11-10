#!/usr/bin/env node
/**
 * Writes a .gz next to every compressible file in the build output so nginx can serve it with
 * gzip_static instead of compressing the same multi-megabyte wasm on every request.
 * A .gz is only kept when it saves at least 10%.
 *
 *   node deploy/precompress.mjs [dir=dist]
 */
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { gzipSync, constants } from 'node:zlib';

const EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.map', '.svg', '.wasm', '.txt', '.xml', '.webmanifest']);
const MIN_BYTES = 1024;
const root = process.argv[2] ?? 'dist';

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

let files = 0;
let before = 0;
let after = 0;
for await (const path of walk(root)) {
  if (!EXTENSIONS.has(extname(path).toLowerCase())) continue;
  const { size } = await stat(path);
  if (size < MIN_BYTES) continue;
  const gz = gzipSync(await readFile(path), { level: constants.Z_BEST_COMPRESSION });
  if (gz.length > size * 0.9) continue;
  await writeFile(`${path}.gz`, gz);
  files++;
  before += size;
  after += gz.length;
}
const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(`[precompress] ${files} files, ${mb(before)} MB -> ${mb(after)} MB gzip`);
