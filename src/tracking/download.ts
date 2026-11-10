/**
 * fetch() with byte-level progress, used for the wasm runtime and the two models so the boot
 * screen shows real numbers instead of a spinner.
 */
export type ProgressFn = (loaded: number, total: number) => void;

export async function fetchWithProgress(url: string, onProgress: ProgressFn, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  // Content-Length is the encoded size; only trust it when the body is not compressed.
  const encoded = res.headers.get('content-encoding');
  const total = encoded && encoded !== 'identity' ? 0 : Number(res.headers.get('content-length') || 0);
  onProgress(0, total);

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress(buf.byteLength, total || buf.byteLength);
    return buf;
  }

  const reader = res.body.getReader();
  // Known size: write straight into one buffer. Unknown: collect chunks and join once.
  let out: Uint8Array<ArrayBuffer> | null = total > 0 ? new Uint8Array(total) : null;
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
      onProgress(loaded, total);
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
  onProgress(loaded, total || loaded);
  return result;
}
