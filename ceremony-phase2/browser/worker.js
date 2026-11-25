// One gnark-wasm instance behind a message port. Same file for a browser Worker and a Node worker_thread.
const node = typeof process !== 'undefined' && !!process.versions?.node && typeof WorkerGlobalScope === 'undefined';
let port, wasmBytes;
if (node) {
  const wt = await import('node:worker_threads');
  const fs = await import('node:fs/promises');
  port = { on: (f) => wt.parentPort.on('message', f), post: (m, t) => wt.parentPort.postMessage(m, t) };
  wasmBytes = await fs.readFile(new URL('./g.wasm', import.meta.url));
} else {
  port = { on: (f) => { self.onmessage = (e) => f(e.data); }, post: (m, t) => self.postMessage(m, t) };
}
await import('./wasm_exec.js');
// streaming needs the application/wasm type; a host that serves it as something else still works through the buffer
async function fetchWasm(url, imports) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`the wasm answered ${r.status}`);
  try { return await WebAssembly.instantiateStreaming(r.clone(), imports); } catch { return WebAssembly.instantiate(await r.arrayBuffer(), imports); }
}
const go = new Go();
const inst = node
  ? await WebAssembly.instantiate(wasmBytes, go.importObject)
  : await fetchWasm(new URL('./g.wasm', import.meta.url), go.importObject);
go.run(inst.instance);
await new Promise((r) => setTimeout(r, 20));
const G = globalThis.tacitGo;
port.on((m) => {
  try {
    if (m.op === 'scale') {
      const r = G.scaleG1(new Uint8Array(m.buf), m.scalar);
      if (r instanceof Error) throw r;
      port.post({ id: m.id, buf: r.buffer }, [r.buffer]);
    } else if (m.op === 'proof') {
      const r = G.deltaProof(m.delta, m.challenge, m.g2, m.dst);
      if (r instanceof Error) throw r;
      port.post({ id: m.id, proof: { commitment: r.commitment, pok: r.pok, g2delta: r.g2delta } });
    } else if (m.op === 'sha') {
      if (m.reset) G.shaReset();
      if (m.buf) G.shaUpdate(new Uint8Array(m.buf));
      port.post({ id: m.id, sum: m.sum ? G.shaSum() : null });
    }
  } catch (e) {
    port.post({ id: m.id, error: String(e.message || e) });
  }
});
port.post({ ready: true });
