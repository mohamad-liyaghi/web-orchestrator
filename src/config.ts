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

/**
 * Uncompressed sizes of the tracking downloads (pinned package/model versions). Used as the
 * progress total when the server compresses a file (Content-Length is then the compressed size)
 * and to tell players up front how much the first start downloads. Later starts hit the cache.
 */
export const ASSET_BYTES = {
  wasm: 11_153_617,
  hand: 7_819_105,
  face: 3_758_596,
} as const;

export const FIRST_START_BYTES = ASSET_BYTES.wasm + ASSET_BYTES.hand + ASSET_BYTES.face;

/** "22.7 MB" */
export const formatMB = (bytes: number): string => `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;

export const APP_NAME = 'Orchestrator';
