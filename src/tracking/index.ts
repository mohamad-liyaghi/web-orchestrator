/**
 * Tracking module public API.
 * - createTracker(): MediaPipe HandLandmarker + FaceLandmarker (GPU delegate, CPU fallback)
 * - openCamera()/closeCamera(): front camera stream attached to the stage <video>
 *
 * Frames passed to onFrame are reused: each TrackingFrame (and the HandState / FaceState objects
 * inside it) stays valid until the next-but-one frame. Copy values you need to keep longer.
 */
import type { Tracker } from '../types';
import { MediaPipeTracker } from './tracker';

export { openCamera, closeCamera } from './camera';

export function createTracker(): Tracker {
  return new MediaPipeTracker();
}
