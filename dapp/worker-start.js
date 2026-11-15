// Starting a module worker from a page, whatever the page's isolation.
//
// A page that is cross-origin isolated (the front page and TAC's page) is only allowed to load a worker script that is sent with its own
// embedder-policy header, and this one is not (the site's header rules name each worker). A worker started from a blob inherits the page's
// policy instead, and what it imports is an ordinary same-origin load, so there such a worker is started as a one-line module that imports
// the real one. Anywhere else the script is started directly.
// One blob per script for the page: making a blob URL waits on the browser process, and a login starts a few dozen workers of three scripts. The blob is
// a line of text and is kept, not revoked, for as long as the page lives.
const blobs = new WeakMap();
export function startWorker(url, env = globalThis) {
  if (!env.crossOriginIsolated || typeof env.Blob !== 'function' || !env.URL || typeof env.URL.createObjectURL !== 'function') return new env.Worker(url, { type: 'module' });
  const key = String(url);
  let made = blobs.get(env.URL);
  if (!made) blobs.set(env.URL, (made = new Map()));
  let blob = made.get(key);
  if (!blob) made.set(key, (blob = env.URL.createObjectURL(new env.Blob([`import ${JSON.stringify(key)};`], { type: 'text/javascript' }))));
  try { return new env.Worker(blob, { type: 'module' }); } catch (e) { made.delete(key); try { env.URL.revokeObjectURL(blob); } catch { } throw e; }
}
