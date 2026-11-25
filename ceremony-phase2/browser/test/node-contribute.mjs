// node test/node-contribute.mjs <in file> <out file> [workers]  -- a contribution made by the browser code, in Node.
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { webcrypto } from 'node:crypto';
import { contribute, newScalar } from '../core.js';
import { createPool, createHasher } from '../pool.js';

const [, , inp, out, nw = '4'] = process.argv;
const spawn = () => {
  const w = new Worker(new URL('../worker.js', import.meta.url));
  return { post: (m, t) => w.postMessage(m, t), onmessage: (f) => w.on('message', f), onerror: (f) => w.on('error', f), terminate: () => w.terminate() };
};
const pool = createPool(spawn, Number(nw));
const hash = createHasher(spawn);
await pool.ready();
const ws = createWriteStream(out);
const write = async (b) => { if (!ws.write(b)) await once(ws, 'drain'); };
const t0 = Date.now();
const r = await contribute({
  source: createReadStream(inp, { highWaterMark: 1 << 20 }), write, pool, hash,
  scalar: newScalar((b) => webcrypto.getRandomValues(b)), chunkPoints: Number(process.env.CHUNK || 4096),
  onProgress: process.env.QUIET ? undefined : (d, t) => { if (d % 50000 < 4096) process.stderr.write(`\r${d}/${t}`); },
});
ws.end(); await once(ws, 'finish');
pool.terminate(); hash.terminate();
console.log(`\nwrote ${out}: ${r.points} points in ${Date.now() - t0} ms, challenge ${Buffer.from(r.challenge).toString('hex')}`);
