// Starting a module worker from a page, whatever the page's isolation.
//
// A page that is cross-origin isolated (the front page and TAC's page) is only allowed to load a worker script that is sent with its own
// embedder-policy header, and this one is not (the site's header rules name each worker). A worker started from a blob inherits the page's
// policy instead, and what it imports is an ordinary same-origin load, so there such a worker is started as a one-line module that imports
// the real one. Anywhere else the script is started directly.
export function startWorker(url, env = globalThis) {
  if (!env.crossOriginIsolated || typeof env.Blob !== 'function' || !env.URL || typeof env.URL.createObjectURL !== 'function') return new env.Worker(url, { type: 'module' });
  const blob = env.URL.createObjectURL(new env.Blob([`import ${JSON.stringify(String(url))};`], { type: 'text/javascript' }));
  let w;
  try { w = new env.Worker(blob, { type: 'module' }); } catch (e) { env.URL.revokeObjectURL(blob); throw e; }
  const end = w.terminate.bind(w);
  w.terminate = () => { try { end(); } finally { env.URL.revokeObjectURL(blob); } };
  return w;
}
