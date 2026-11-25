// A whole contribution from a browser, or from Node in the tests: join the queue, wait for the turn, claim the slot, stream the
// head down while the next file is made and sent up in parts, then ask the coordinator to check it and wait for the receipt.
// `api` is the base of the coordinator's routes (the HTTPS proxy's /api/c, or a coordinator in a test). Nothing is kept on disk:
// the file is made and sent as it streams, so a part that fails is simply sent again.
import { contribute, newScalar } from './core.js';
import { createPool, createHasher } from './pool.js';

const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('stopped')); }, { once: true });
});

// the tests swap in a fetch that adds headers (a caller address)
let F = (...a) => globalThis.fetch(...a);
export const useFetch = (f) => { F = f; };

export class Refused extends Error { constructor(msg, code) { super(msg); this.code = code; } }

async function call(api, method, path, token, body, signal, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      const r = await F(api + path, {
        method, signal,
        headers: { ...(token ? { 'X-Ceremony-Token': token } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      let j = null; try { j = await r.json(); } catch {}
      if (r.status >= 500 && r.status !== 503 && i < tries - 1) { await sleep(1000 * (i + 1), signal); continue; }
      if (r.status === 429 && j?.error && /already/.test(j.error)) throw new Refused(j.error, 429);
      if (!r.ok) throw new Refused(j?.error || `the coordinator answered ${r.status}`, r.status);
      return j;
    } catch (e) {
      if (e instanceof Refused || signal?.aborted || i >= tries - 1) throw e;
      await sleep(1000 * (i + 1), signal);
    }
  }
}

// The head as a stream, resumed from the byte where it broke.
async function* download(api, index, token, size, signal, onBytes) {
  let have = 0, fails = 0;
  while (have < size) {
    let r;
    try {
      r = await F(`${api}/f/phase2-${index}`, { signal, headers: { 'X-Ceremony-Token': token, ...(have ? { Range: `bytes=${have}-` } : {}) } });
      if (!(r.status === 200 && !have) && r.status !== 206) throw new Refused(`the download answered ${r.status}`, r.status);
      const rd = r.body.getReader();
      for (;;) {
        const { value, done } = await rd.read();
        if (done) break;
        have += value.length; onBytes?.(have);
        yield value;
      }
      if (have < size) throw new Error('the download ended early');
    } catch (e) {
      if (signal?.aborted || e instanceof Refused || ++fails > 8) throw e;
      await sleep(1500 * fails, signal);
    }
  }
}

const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');

// opts: api, name, handle, spawn (a worker factory), workers, getRandom, onStatus, signal, partSize
export async function runContribution(opts) {
  const { api, name, handle = '', spawn, workers = 4, getRandom = (b) => crypto.getRandomValues(b), onStatus = () => {}, signal, partSize = 16 << 20 } = opts;
  const joined = await call(api, 'POST', '/join', null, { name, handle }, signal);
  const token = joined.token;
  let state = joined, lost = null, finished = false;
  const beat = (async () => {
    while (!finished && !signal?.aborted) {
      await sleep(Math.max(2, state.poll_seconds || 10) * 1000, signal).catch(() => {});
      if (finished || signal?.aborted) return;
      try { state = { ...state, ...(await call(api, 'GET', '/slot', token, null, signal, 1)) }; }
      catch (e) { if (e instanceof Refused && e.code === 404) { lost = e; return; } }
    }
  })();
  const leave = () => F(api + '/leave', { method: 'DELETE', headers: { 'X-Ceremony-Token': token }, keepalive: true }).catch(() => {});
  let pool, hasher;
  try {
    let last = -1;
    while (state.state !== 'claim' && state.state !== 'active') {
      if (lost) throw new Refused('the coordinator dropped this place in the queue', 404);
      if (state.ahead !== last) { onStatus({ phase: 'queue', ahead: state.ahead }); last = state.ahead; }
      await sleep(1000, signal);
    }
    const slot = await call(api, 'POST', '/claim', token, null, signal);
    onStatus({ phase: 'prepare' });
    pool = createPool(spawn, workers); hasher = createHasher(spawn);
    await pool.ready();
    const scalar = newScalar(getRandom);

    // one progress record, updated by the download/compute side and the upload side alike
    const cur = { points: 0, total: 0, downloaded: 0, size: slot.size, sent: 0 };
    const report = (u) => { Object.assign(cur, u); onStatus({ phase: 'work', ...cur }); };

    // upload in parts as the file is made
    let buf = new Uint8Array(partSize), fill = 0, sent = 0;
    const put = async (bytes) => {
      for (let i = 0; ; i++) {
        try {
          const r = await F(`${api}/upload-part?offset=${sent}`, { method: 'PUT', signal, headers: { 'X-Ceremony-Token': token }, body: bytes });
          const j = await r.json().catch(() => ({}));
          if (r.status === 409 && typeof j.have === 'number' && j.have === sent + bytes.length) { sent = j.have; return; } // it arrived, the answer did not
          if (!r.ok) throw new Refused(j.error || `the upload answered ${r.status}`, r.status);
          sent = j.have; report({ sent });
          return;
        } catch (e) {
          if (signal?.aborted || (e instanceof Refused && e.code !== 502 && e.code !== 503) || i >= 5) throw e;
          await sleep(1500 * (i + 1), signal);
        }
      }
    };
    const write = async (chunk) => {
      let o = 0;
      while (o < chunk.length) {
        const k = Math.min(chunk.length - o, partSize - fill);
        buf.set(chunk.subarray(o, o + k), fill); fill += k; o += k;
        if (fill === partSize) { await put(buf); buf = new Uint8Array(partSize); fill = 0; }
      }
    };

    let got = 0;
    const r = await contribute({
      source: download(api, slot.index, token, slot.size, signal, (n) => { got = n; }),
      write, pool, hash: hasher, scalar,
      onProgress: (done, total) => report({ points: done, total, downloaded: got }),
    });
    if (fill) await put(buf.subarray(0, fill));
    if (hex(r.challenge) !== slot.sha256) throw new Error('the download does not match the head the coordinator named; nothing was sent for checking');
    pool.terminate(); hasher.terminate(); pool = hasher = null;

    onStatus({ phase: 'check' });
    await call(api, 'POST', '/upload-finish', token, null, signal);
    for (;;) {
      await sleep(3000, signal);
      const res = await call(api, 'GET', '/upload-result', token, null, signal);
      if (res.state === 'done') { finished = true; onStatus({ phase: 'done', receipt: res.receipt }); return res.receipt; }
      if (res.state === 'refused') throw new Refused(res.error || 'the contribution was refused', res.code);
    }
  } catch (e) {
    if (!finished) leave();
    throw e;
  } finally {
    finished = true;
    pool?.terminate(); hasher?.terminate();
  }
}
