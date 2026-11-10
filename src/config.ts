/**
 * Asset locations. Everything is self-hosted (see scripts/fetch-assets.mjs) so the app works
 * without third-party CDNs at runtime and no camera data ever leaves the device.
 * Paths are relative to the page so the build can be served from any base path.
 */
const base = import.meta.env.BASE_URL;

export const ASSETS = {
  /** Directory holding the MediaPipe vision wasm files (copied from node_modules). */
  mediapipeWasm: `${base}mediapipe/wasm`,
  handModel: `${base}models/hand_landmarker.task`,
  faceModel: `${base}models/face_landmarker.task`,
  /** Sample root: `${samples}/<instrumentId>/<Note>.mp3`, e.g. samples/grand-piano/C4.mp3 */
  samples: `${base}samples`,
} as const;

export const APP_NAME = 'Orchestrator';
