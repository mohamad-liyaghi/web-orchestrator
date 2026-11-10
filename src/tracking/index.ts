/**
 * Tracking module public API.
 * - createTracker(): MediaPipe HandLandmarker + FaceLandmarker (GPU delegate, CPU fallback)
 * - openCamera()/closeCamera(): camera stream (default front, or a picked device) on the stage <video>
 * - listCameras(): the video inputs to choose from (after permission)
 *
 * Frames passed to onFrame are reused: each TrackingFrame (and the HandState / FaceState objects
 * inside it) stays valid until the next-but-one frame. Copy values you need to keep longer.
 */
import type { Tracker } from '../types';
import { MediaPipeTracker } from './tracker';

export { openCamera, closeCamera, listCameras, cameraIdOf } from './camera';
export { prefetchTrackingAssets } from './prefetch';

export function createTracker(): Tracker {
  return new MediaPipeTracker();
}
