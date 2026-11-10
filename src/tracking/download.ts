/**
 * fetch() with byte-level progress for the wasm runtime and the two models, so the boot screen
 * shows real megabytes instead of a spinner. Downloads are shared: a prefetch started on the
 * landing page and the tracker's own request use the same in-flight job, so nothing is fetched
 * twice.
 */
export type ProgressFn = (loaded: number, total: number) => void;

interface Job {
  promise: Promise<Uint8Array<ArrayBuffer>>;
  loaded: number;
  total: number;
  listeners: Set<ProgressFn>;
}

const jobs = new Map<string, Job>();

/**
 * Download `url` once (shared with any download already running for it) and report progress to
 * `onProgress`. `expectedBytes` is the uncompressed size, used as the total when the server
 * compresses the body and Content-Length no longer matches what the stream yields.
 */
export function download(url: string, expectedBytes: number, onProgress?: ProgressFn): Promise<Uint8Array<ArrayBuffer>> {
  let job = jobs.get(url);
  if (!job) {
    const created: Job = { promise: Promise.resolve(new Uint8Array(0)), loaded: 0, total: expectedBytes, listeners: new Set() };
    created.promise = fetchWithProgress(url, expectedBytes, (loaded, total) => {
      created.loaded = loaded;
      created.total = total;
      for (const fn of created.listeners) fn(loaded, total);
    });
    // A failed download must be retryable on the next start.
    created.promise.catch(() => {
      if (jobs.get(url) === created) jobs.delete(url);
    });
    jobs.set(url, created);
    job = created;
  }
  if (onProgress) {
    job.listeners.add(onProgress);
    onProgress(job.loaded, job.total);
    const fn = onProgress;
    const j = job;
    void j.promise.then(
      () => j.listeners.delete(fn),
      () => j.listeners.delete(fn),
    );
  }
  return job.promise;
}

/** Drop the in-memory copy once the tracker has consumed it (the HTTP cache keeps the file). */
export function releaseDownload(url: string): void {
  jobs.delete(url);
}

export async function fetchWithProgress(
  url: string,
  expectedBytes: number,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  // Content-Length is the encoded size; only trust it when the body is not compressed.
  const encoded = res.headers.get('content-encoding');
  const announced = encoded && encoded !== 'identity' ? 0 : Number(res.headers.get('content-length') || 0);
  const total = announced || expectedBytes;
  onProgress(0, total);

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(buf.byteLength, buf.byteLength);
    return buf;
  }

  const reader = res.body.getReader();
  // Known size: write straight into one buffer. Otherwise collect chunks and join once.
  let out: Uint8Array<ArrayBuffer> | null = announced > 0 ? new Uint8Array(announced) : null;
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (out && loaded + value.byteLength <= out.byteLength) {
      out.set(value, loaded);
    } else {
      if (out) {
        // The server sent more than announced: fall back to chunk collection.
        chunks.push(out.subarray(0, loaded));
        out = null;
      }
      chunks.push(value);
    }
    loaded += value.byteLength;
    const now = performance.now();
    if (now - lastReport > 50) {
      lastReport = now;
      // An estimate can be a little off: never report more than 99 % before the end.
      onProgress(Math.min(loaded, total * 0.99), total);
    }
  }

  let result: Uint8Array<ArrayBuffer>;
  if (out) {
    result = loaded === out.byteLength ? out : out.slice(0, loaded);
  } else {
    result = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) {
      result.set(c, offset);
      offset += c.byteLength;
    }
  }
  onProgress(loaded, loaded);
  return result;
}
