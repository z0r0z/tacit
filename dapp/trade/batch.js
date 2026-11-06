// Reads of the chain that a page starts in the same moment go out as one Multicall3 call, so a dozen of them cost the node one request (and a public
// node's rate limit one hit). `call({ to, data, from })` is the page's own read, and the batch is read through it. A read that is anything but a plain
// call (it names `from`, or is a Multicall3 call already) goes alone, and so does one the batch could not answer: a revert or a bad reply is asked again by
// itself, so what a caller sees of a failure is what `call` says of it.
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const AGGREGATE3 = '82ad56cb';
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();

export function encodeBatch(calls) {
  let head = '', tail = '', off = calls.length * 32;
  for (const { to, data } of calls) {
    const d = strip(data), body = strip(to).padStart(64, '0') + word(1) + word(96) + word(d.length / 2) + d.padEnd(Math.ceil(d.length / 64) * 64, '0');
    head += word(off); tail += body; off += body.length / 2;
  }
  return `0x${AGGREGATE3}${word(32)}${word(calls.length)}${head}${tail}`;
}

// What each call returned, in order: its data, or null for one that failed or came back empty. Throws on a reply that is not the batch's.
export function decodeBatch(out, n) {
  const h = strip(out), at = (i) => { if (h.length < 64 * (i + 1)) throw new Error('short batch reply'); return Number(BigInt(`0x${h.slice(64 * i, 64 * (i + 1))}`)); };
  if (at(0) !== 32 || at(1) !== n) throw new Error('not this batch');
  return Array.from({ length: n }, (_, i) => {
    const e = 2 + at(2 + i) / 32, ok = at(e) === 1, b = e + at(e + 1) / 32, len = at(b), data = h.slice(64 * (b + 1), 64 * (b + 1) + len * 2);
    if (data.length !== len * 2) throw new Error('short batch reply');
    return ok && len ? `0x${data}` : null;
  });
}

export function batchReads(call, { wait = 5, max = 24 } = {}) {
  let queue = [], timer = 0;
  const alone = ({ tx, resolve, reject }) => call(tx).then(resolve, reject);
  const flush = () => {
    clearTimeout(timer); timer = 0;
    const batch = queue; queue = [];
    if (batch.length < 2) return batch.forEach(alone);
    call({ to: MULTICALL3, data: encodeBatch(batch.map((b) => b.tx)) }).then((out) => decodeBatch(out, batch.length)).catch(() => null).then((got) => {
      batch.forEach((b, i) => (got?.[i] ? b.resolve(got[i]) : alone(b)));
    });
  };
  return (tx) => {
    if (tx.from || String(tx.to).toLowerCase() === MULTICALL3.toLowerCase()) return call(tx);
    return new Promise((resolve, reject) => {
      queue.push({ tx, resolve, reject });
      if (queue.length >= max) flush(); else timer ||= setTimeout(flush, wait);
    });
  };
}
