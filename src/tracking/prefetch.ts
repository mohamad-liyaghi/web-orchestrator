import { FilesetResolver } from '@mediapipe/tasks-vision';
import { ASSET_BYTES, ASSETS } from '../config';
import { download } from './download';

let started = false;

/**
 * Start downloading the vision engine and both models before the player presses Start, so the
 * stage opens almost instantly. Only on desktop-class devices with a decent connection and no
 * data saver: phones download on Start, never in the background. The tracker joins these
 * downloads instead of fetching again (see download.ts).
 */
export function prefetchTrackingAssets(): void {
  if (started || !shouldPrefetch()) return;
  started = true;
  void (async () => {
    try {
      const fileset = await FilesetResolver.forVisionTasks(ASSETS.mediapipeWasm);
      await Promise.all([
        download(fileset.wasmBinaryPath, ASSET_BYTES.wasm),
        download(ASSETS.handModel, ASSET_BYTES.hand),
        download(ASSETS.faceModel, ASSET_BYTES.face),
      ]);
    } catch {
      // Best effort: Start downloads (and reports) everything again.
      started = false;
    }
  })();
}

function shouldPrefetch(): boolean {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (conn?.saveData) return false;
  if (conn?.effectiveType && /(^|-)2g$|^3g$/.test(conn.effectiveType)) return false;
  // Desktop-class: a precise pointer and no coarse primary input.
  return window.matchMedia?.('(pointer: fine)').matches === true;
}
