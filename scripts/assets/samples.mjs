/**
 * Instrument samples. Owned by the music module.
 *
 * The processed samples are committed in public/samples/ (built by scripts/build-samples.mjs from
 * the FluidR3_GM soundfont), so this step downloads nothing: it only checks that the manifest and
 * every file it lists are present and fails loudly if not.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'samples');

export async function fetchSamples({ force = false } = {}) {
  void force; // nothing to refetch: run `node scripts/build-samples.mjs` to rebuild
  const manifestPath = join(DIR, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`samples: ${manifestPath} is missing. Run \`node scripts/build-samples.mjs\` (needs ffmpeg).`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const missing = [];
  let files = 0;
  let bytes = 0;
  for (const [id, entry] of Object.entries(manifest)) {
    for (const note of entry.notes ?? []) {
      const file = join(DIR, id, `${note}.mp3`);
      if (!existsSync(file) || statSync(file).size === 0) missing.push(`${id}/${note}.mp3`);
      else {
        files++;
        bytes += statSync(file).size;
      }
    }
  }
  if (missing.length) {
    throw new Error(`samples: ${missing.length} file(s) missing, e.g. ${missing.slice(0, 5).join(', ')}. Run \`node scripts/build-samples.mjs\`.`);
  }
  console.log(`[assets] samples ok: ${Object.keys(manifest).length} instruments, ${files} files, ${(bytes / 1048576).toFixed(1)} MB`);
}
