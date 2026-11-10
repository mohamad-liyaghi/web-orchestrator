/**
 * Tracking module public API. Implementation: see the tracking brief / README.
 * - createTracker(): MediaPipe HandLandmarker + FaceLandmarker (GPU delegate, CPU fallback)
 * - openCamera()/closeCamera(): front camera stream attached to the stage <video>
 */
import type { Tracker } from '../types';

export function createTracker(): Tracker {
  throw new Error('tracking: not implemented yet');
}

/** Opens the front camera, attaches it to `video` and resolves once frames are flowing.
 *  Throws AppError with code insecure-context | no-camera-api | camera-denied | camera-not-found | camera-in-use. */
export async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  void video;
  throw new Error('tracking: not implemented yet');
}

export function closeCamera(stream: MediaStream | null, video?: HTMLVideoElement): void {
  stream?.getTracks().forEach((t) => t.stop());
  if (video) video.srcObject = null;
}
