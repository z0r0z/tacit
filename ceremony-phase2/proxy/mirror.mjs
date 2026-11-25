// Copies every accepted contribution, and the transcript, from the coordinator to an S3 bucket (Filebase, which also
// pins each object on IPFS), so the chain outlives the coordinator's machine and has a second place to download from.
// A file is streamed through (never held), hashed on the way, and recorded only if its SHA-256 is the one in the
// coordinator's transcript, whose receipts are checked against the pinned coordinator key and chained from the pinned
// base (trustedFiles); a mismatch is reported and retried later.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { s3 } from './s3.mjs';
import { verifyReceipt, brokenLink, BASE_INDEX, BASE_SHA256, COORDINATOR_KEY } from '../../dapp/praxis/receipt.js';

// The receipts that may be copied: from the pinned base, each linked to the one before and signed by the pinned key.
// The link to the coordinator is plain HTTP, so nothing it says is believed without these checks.
export async function trustedFiles(t, key = COORDINATOR_KEY) {
  if (t.base_index !== BASE_INDEX || t.base_sha256 !== BASE_SHA256 || t.coordinator_pubkey !== key) return { files: [], why: 'the transcript is not the pinned chain' };
  const rs = t.receipts || [];
  const bad = brokenLink(t);
  const upto = bad === -1 ? rs.length : bad;
  const files = [{ index: t.base_index, file_sha256: t.base_sha256 }];
  for (const r of rs.slice(0, upto)) {
    if ((await verifyReceipt(r, key)) !== true) return { files, why: `receipt ${r.index} is not signed by the pinned key` };
    files.push(r);
  }
  return { files, why: bad === -1 ? null : `receipt ${rs[bad]?.index ?? 'head'} does not link to the one before` };
}

export function startMirror({ upstream, endpoint, key, secret, bucket, everyMs = 60_000, log = console.log }) {
  const c = s3({ endpoint, key, secret });
  const done = new Map();                      // index -> { sha256, cid }
  const failed = new Map();                    // index -> time of the last failed copy (retried after 30 minutes)
  let lastTranscript = '';
  let busy = false;

  function get(path) {
    const u = new URL(upstream + path);
    const lib = u.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const r = lib.get(u, { timeout: 120_000 }, resolve);
      r.on('timeout', () => r.destroy(new Error('upstream timeout')));
      r.on('error', reject);
    });
  }

  async function copyFile(index, want, size) {
    const name = `phase2-${index}`;
    // Only the marker, written after a file's streamed hash matched, says a copy is good.
    const mark = await c.get(bucket, `verified/${name}.sha256`);
    if (mark.status === 200 && mark.body.trim() === want) {
      const h = await c.head(bucket, name);
      if (h.status === 200) { done.set(index, { sha256: want, cid: h.headers['x-amz-meta-cid'] || null }); return; }
    }
    const res = await get(`/f/${name}`);
    if (res.statusCode !== 200 || Number(res.headers['content-length']) !== size) {
      res.resume();
      throw new Error(`${name}: upstream ${res.statusCode} length ${res.headers['content-length']}`);
    }
    const hash = crypto.createHash('sha256');
    const tap = new Transform({ transform(chunk, _e, cb) { hash.update(chunk); cb(null, chunk); } });
    res.on('error', (e) => tap.destroy(e));
    const put = await c.put(bucket, name, res.pipe(tap), size, { 'content-type': 'application/octet-stream' });
    const got = hash.digest('hex');
    if (put.status !== 200) throw new Error(`${name}: put ${put.status} ${put.body.slice(0, 200)}`);
    if (got !== want) {
      await c.del(bucket, name);
      throw new Error(`${name}: streamed sha256 ${got} is not the transcript's ${want}`);
    }
    const m = await c.put(bucket, `verified/${name}.sha256`, want + '\n', want.length + 1, { 'content-type': 'text/plain' });
    if (m.status !== 200) throw new Error(`${name}: marker put ${m.status}`);
    const after = await c.head(bucket, name);
    done.set(index, { sha256: want, cid: after.headers['x-amz-meta-cid'] || null });
    log(`mirror: ${name} copied (${size} bytes, cid ${done.get(index).cid})`);
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const tr = await (await fetch(upstream + '/api/transcript', { signal: AbortSignal.timeout(15_000) })).text();
      const t = JSON.parse(tr);
      const head = await (await fetch(upstream + '/api/head', { signal: AbortSignal.timeout(15_000) })).json();
      const { files, why } = await trustedFiles(t);
      if (why) log(`mirror: ${why}; copying the ${files.length} file(s) before it`);
      for (const r of files) {
        if (!Number.isInteger(r.index) || !/^[0-9a-f]{64}$/.test(r.file_sha256 || '')) continue;
        if (done.get(r.index)?.sha256 === r.file_sha256) continue;
        if (Date.now() - (failed.get(r.index) || 0) < 30 * 60_000) continue;
        try { await copyFile(r.index, r.file_sha256, head.size); failed.delete(r.index); }
        catch (e) { failed.set(r.index, Date.now()); log(`mirror: ${e.message}`); }
      }
      if (tr !== lastTranscript) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        for (const k of ['transcript.json', `transcripts/${stamp}.json`]) {
          const p = await c.put(bucket, k, tr, Buffer.byteLength(tr), { 'content-type': 'application/json' });
          if (p.status !== 200) throw new Error(`${k}: put ${p.status}`);
        }
        lastTranscript = tr;
      }
    } catch (e) {
      log(`mirror: ${e.message}`);
    } finally {
      busy = false;
    }
  }

  tick();
  setInterval(tick, everyMs).unref();
  return { status: () => Object.fromEntries([...done].sort((a, b) => a[0] - b[0])) };
}
