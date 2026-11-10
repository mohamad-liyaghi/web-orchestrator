import { AppError } from '../types';

/** How long we wait for the first decoded frame once permission is granted. */
const FIRST_FRAME_TIMEOUT_MS = 10_000;

const PREFERRED: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: 'user',
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30 },
  },
};

const FALLBACK: MediaStreamConstraints = { audio: false, video: true };

function errorName(e: unknown): string {
  if (e && typeof e === 'object' && 'name' in e && typeof e.name === 'string') return e.name;
  return '';
}

function errorMessage(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string') return e.message;
  return '';
}

/** Maps a getUserMedia / play() failure to an AppError the landing page can explain. */
export function cameraError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const name = errorName(e);
  const detail = errorMessage(e);
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      // Chrome on macOS/Windows reports an OS-level block as "Permission denied by system".
      if (/system/i.test(detail)) {
        return new AppError(
          'camera-denied',
          'Your operating system is blocking the camera for this browser. Allow it in the system privacy settings (Camera), then reload the page.',
          { cause: e },
        );
      }
      return new AppError(
        'camera-denied',
        'Camera access was blocked. Allow the camera for this site (the camera icon in the address bar or the site settings), then try again.',
        { cause: e },
      );
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return new AppError('camera-not-found', 'No camera was found. Connect a camera (or enable the built-in one) and try again.', {
        cause: e,
      });
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return new AppError(
        'camera-in-use',
        'The camera could not be started. It may be in use by another app or browser tab; close it and try again.',
        { cause: e },
      );
    default:
      return new AppError('unknown', `The camera could not be started${detail ? `: ${detail}` : '.'}`, { cause: e });
  }
}

async function requestStream(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(PREFERRED);
  } catch (e) {
    // Some devices reject the ideal size/rate combination outright; any camera beats none.
    const name = errorName(e);
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      return navigator.mediaDevices.getUserMedia(FALLBACK);
    }
    throw e;
  }
}

/** Resolves once the element has decoded a frame with a real size, or rejects after `ms`. */
function waitForFrames(video: HTMLVideoElement, ms: number): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'playing', 'resize', 'timeupdate'] as const;
    let poll = 0;
    const done = (err?: AppError) => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      for (const ev of events) video.removeEventListener(ev, check);
      if (err) reject(err);
      else resolve();
    };
    const check = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) done();
    };
    const timer = window.setTimeout(
      () =>
        done(
          new AppError(
            'camera-in-use',
            'The camera did not send any video. It may be in use by another app, or covered by a privacy shutter; check it and try again.',
          ),
        ),
      ms,
    );
    for (const ev of events) video.addEventListener(ev, check);
    // Some WebKit builds fire no event when the size becomes known; poll as a safety net.
    poll = window.setInterval(check, 100);
    check();
  });
}

function waitForMetadata(video: HTMLVideoElement, ms: number): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      video.removeEventListener('loadedmetadata', finish);
      resolve();
    };
    // Not fatal on its own: waitForFrames enforces the real deadline.
    const timer = window.setTimeout(finish, ms);
    video.addEventListener('loadedmetadata', finish);
  });
}

/**
 * Opens the front camera, attaches it to `video` and resolves once frames are flowing.
 * Throws AppError: insecure-context | no-camera-api | camera-denied | camera-not-found | camera-in-use.
 */
export async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!window.isSecureContext) {
    throw new AppError('insecure-context', 'The camera only works on a secure connection. Open this page over https (or on localhost).');
  }
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new AppError(
      'no-camera-api',
      'This browser cannot use the camera. Try the latest Chrome, Safari, Edge or Firefox (in-app browsers often block it).',
    );
  }

  let stream: MediaStream;
  try {
    stream = await requestStream();
  } catch (e) {
    throw cameraError(e);
  }

  try {
    // iOS Safari only autoplays inline, muted video, and checks the attributes, not just the properties.
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('autoplay', '');
    video.disablePictureInPicture = true;
    video.srcObject = stream;

    await waitForMetadata(video, FIRST_FRAME_TIMEOUT_MS);
    try {
      await video.play();
    } catch (e) {
      // AbortError: a newer load interrupted play(); autoplay keeps it running.
      const name = errorName(e);
      if (name === 'NotAllowedError') {
        // Autoplay policy (e.g. iOS Low Power Mode), not a camera permission problem.
        throw new AppError('unknown', 'The browser paused the camera preview. Tap Start again to resume.', { cause: e });
      }
      if (name !== 'AbortError') throw e;
    }
    await waitForFrames(video, FIRST_FRAME_TIMEOUT_MS);
    return stream;
  } catch (e) {
    closeCamera(stream, video);
    throw cameraError(e);
  }
}

/** Stops every track and detaches the stream. Safe to call with null or twice. */
export function closeCamera(stream: MediaStream | null, video?: HTMLVideoElement): void {
  stream?.getTracks().forEach((t) => t.stop());
  if (video) {
    video.pause();
    video.srcObject = null;
  }
}
