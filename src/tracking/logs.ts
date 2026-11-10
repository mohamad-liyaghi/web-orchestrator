/**
 * MediaPipe's wasm runtime forwards its native (glog / TFLite) logging to console.log/info/warn/
 * error: "W1110 17:40:35.88 123 gl_context.cc:1118] OpenGL error checking is disabled",
 * "INFO: Created TensorFlow Lite XNNPACK delegate for CPU.", "Graph successfully started running."
 * None of it is actionable for users, and the error-level lines look like failures. While a
 * tracker is alive, drop exactly those lines and pass everything else through untouched.
 */
const NATIVE_LOG = /^(?:[IWEF]\d{4} \d\d:\d\d:\d\d\.\d+\s+\d+ [\w.-]+:\d+\]|INFO: Created TensorFlow Lite|Graph successfully started running|Graph finished closing successfully)/;

type Level = 'log' | 'info' | 'warn' | 'error' | 'debug';
const LEVELS: readonly Level[] = ['log', 'info', 'warn', 'error', 'debug'];

let users = 0;
let originals: Partial<Record<Level, (...args: unknown[]) => void>> = {};

/** Installs the filter (reference counted). Returns a function that removes it; call it once. */
export function muteRuntimeLogs(): () => void {
  if (users++ === 0) {
    originals = {};
    for (const level of LEVELS) {
      const orig = console[level];
      originals[level] = orig;
      console[level] = function filtered(this: Console, ...args: unknown[]) {
        if (typeof args[0] === 'string' && NATIVE_LOG.test(args[0])) return;
        orig.apply(this, args);
      };
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--users === 0) {
      for (const level of LEVELS) {
        const orig = originals[level];
        if (orig) console[level] = orig;
      }
      originals = {};
    }
  };
}
