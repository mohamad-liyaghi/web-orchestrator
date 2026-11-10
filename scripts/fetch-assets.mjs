#!/usr/bin/env node
/**
 * Downloads / copies every runtime asset into public/ so the app is fully self-hosted:
 *   public/mediapipe/wasm/   MediaPipe vision wasm runtime (from node_modules)
 *   public/models/           hand + face landmarker models
 *   public/samples/          instrument samples
 * Idempotent: files that already exist are skipped. Run with --force to refetch.
 */
import { fetchModels } from './assets/models.mjs';
import { fetchSamples } from './assets/samples.mjs';

const force = process.argv.includes('--force');
const started = Date.now();

try {
  await fetchModels({ force });
  await fetchSamples({ force });
  console.log(`[assets] ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
} catch (err) {
  console.error('[assets] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
