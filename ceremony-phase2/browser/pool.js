// A fixed set of workers, each a gnark-wasm instance. spawn() returns {post(msg, transfer), onmessage(fn), terminate()}.
export function createPool(spawn, n) {
  const ws = []; const waiting = []; let id = 0; const calls = new Map();
  const free = [];
  const up = Promise.all(Array.from({ length: n }, () => new Promise((res, rej) => {
    const w = spawn();
    w.onmessage((m) => {
      if (m.ready) { ws.push(w); free.push(w); res(); return; }
      const c = calls.get(m.id); calls.delete(m.id);
      free.push(c.w);
      const next = waiting.shift(); if (next) next();
      if (m.error) c.rej(new Error(m.error)); else c.res(m);
    });
    w.onerror?.(rej);
  })));
  const acquire = async () => { await up; while (!free.length) await new Promise((r) => waiting.push(r)); return free.shift(); };
  const call = async (msg, transfer) => {
    const w = await acquire();
    return new Promise((res, rej) => { const i = ++id; calls.set(i, { res, rej, w }); w.post({ ...msg, id: i }, transfer); });
  };
  return {
    size: n,
    ready: () => up,
    scale: async (buf, scalar) => new Uint8Array((await call({ op: 'scale', buf, scalar }, [buf])).buf),
    proof: async (delta, challenge, g2, dst) => (await call({ op: 'proof', delta, challenge, g2, dst })).proof,
    terminate: () => ws.forEach((w) => w.terminate()),
  };
}

// Streaming sha256 on its own worker: updates are posted in order and acknowledged in order.
export function createHasher(spawn) {
  const w = spawn(); const pend = []; let up;
  const ready = new Promise((r) => { up = r; });
  w.onmessage((m) => {
    if (m.ready) { up(); return; }
    const p = pend.shift();
    if (m.error) p.rej(new Error(m.error)); else p.res(m);
  });
  const send = (msg, transfer) => new Promise((res, rej) => { pend.push({ res, rej }); w.post({ ...msg, id: 0 }, transfer); });
  return {
    update(chunk) { const b = new Uint8Array(chunk).buffer; this.last = ready.then(() => send({ op: 'sha', buf: b }, [b])); return this.last; },
    async sum() { await ready; await this.last; return new Uint8Array((await send({ op: 'sha', sum: true })).sum); },
    reset: async () => { await ready; await send({ op: 'sha', reset: true }); },
    terminate: () => w.terminate(),
  };
}
