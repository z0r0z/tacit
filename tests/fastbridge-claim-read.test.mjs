// How a pool lock's claim is read: from the settle call that ran. A relayer transaction's calls are taken as run only when its Relayed event says all of them
// landed; a kernel is taken for a lock only when it is that lock's own; a kernel that does not open the swap is read again while the Bitcoin lock can still be
// taken; and a claim is this side's own only when its kernel is the one this side built.
//   node tests/fastbridge-claim-read.test.mjs
const S = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { makeFastBridgeEvm } = await import(`${S}/dapp/fastbridge-evm.js`);
const { makeEthereumLocker } = await import(`${S}/dapp/fastbridge-el.js`);
const { makeBitcoinLocker } = await import(`${S}/dapp/fastbridge-bl.js`);
const { makeConfidentialLockScan } = await import(`${S}/dapp/confidential-lock-scan.js`);
const { makeConfidentialPool } = await import(`${S}/dapp/confidential-pool.js`);
const { secp, keccak_256, sha256, hmac } = await import(`${S}/dapp/vendor/tacit-deps.min.js`);
const { G, SECP_N } = await import(`${S}/dapp/bulletproofs.js`);

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const lockScan = makeConfidentialLockScan({ pool });
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const bytes32 = (h) => String(h).replace(/^0x/, '').padStart(64, '0');
const encBytes = (h) => { const b = String(h).replace(/^0x/, ''); return word(b.length / 2) + b + '0'.repeat((64 - (b.length % 64)) % 64); };
const encB32Arr = (items) => word(items.length) + items.map(bytes32).join('');
const encBytesArr = (items) => { const e = items.map(encBytes); let off = items.length * 32, head = ''; for (const x of e) { head += word(off); off += x.length / 2; } return word(items.length) + head + e.join(''); };
const sel = (sig) => hex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));
const tuple = ({ publicValues, proof, memos }) => { const a = encBytes(publicValues), b = encBytes(proof), c = encBytesArr(memos); const o1 = 96, o2 = o1 + a.length / 2, o3 = o2 + b.length / 2; return word(o1) + word(o2) + word(o3) + a + b + c; };
function relaySettle(calls) {
  const tuples = calls.map(tuple); let pos = calls.length * 32; const heads = [];
  for (const t of tuples) { heads.push(word(pos)); pos += t.length / 2; }
  const arr = word(calls.length) + heads.join('') + tuples.join('');
  const fa = encB32Arr([]), mo = encB32Arr([]), rc = encB32Arr(['0x' + '11'.repeat(20)]), bp = encB32Arr([word(10000)]);
  const oC = 160, oF = oC + arr.length / 2, oM = oF + fa.length / 2, oR = oM + mo.length / 2, oB = oR + rc.length / 2;
  return '0x' + sel('relaySettle((bytes,bytes,bytes[])[],address[],uint256[],address[],uint256[])') + word(oC) + word(oF) + word(oM) + word(oR) + word(oB) + arr + fa + mo + rc + bp;
}
const settle = ({ publicValues, proof, memos }) => '0x' + sel('settle(bytes,bytes,bytes[])') + tuple({ publicValues, proof, memos });
// SettleTipForwarder.settleWithTip(bytes,bytes,bytes[],address): the deployed forwarder (0x0000008353ee…416D); a claim settled through it is not "direct"
function settleWithTip({ publicValues, proof, memos }, tipTo = '0x' + '22'.repeat(20)) {
  const a = encBytes(publicValues), b = encBytes(proof), c = encBytesArr(memos);
  const o1 = 128, o2 = o1 + a.length / 2, o3 = o2 + b.length / 2;
  return '0x70b16a7d' + word(o1) + word(o2) + word(o3) + bytes32(tipTo) + a + b + c;
}
function publicValues({ lockNullifiers, adaptorClaimS }) {
  const z32 = bytes32('0x' + '00'.repeat(32));
  const dyn = (enc) => ({ dyn: enc });
  const F = [{ st: word(1) }, { st: z32 }, { st: z32 }, dyn(encB32Arr([])), dyn(encB32Arr([])), dyn(encB32Arr([])), dyn(word(0)), dyn(word(0)), dyn(encB32Arr([])), dyn(word(0)), dyn(encB32Arr([])),
    { st: z32 }, { st: z32 }, dyn(word(0)), dyn(word(0)), { st: word(0) }, { st: z32 }, dyn(encB32Arr([])), dyn(encB32Arr(lockNullifiers)), dyn(encB32Arr(adaptorClaimS)), { st: word(0) }];
  let head = '', tail = '', pos = F.length * 32;
  for (const f of F) { if (f.st != null) head += f.st; else { head += word(pos); tail += f.dyn; pos += f.dyn.length / 2; } }
  return '0x' + word(32) + head + tail;
}

const t = 0x1234567890abcdefn % SECP_N, T = G.multiply(t);
const sTilde = 0xabcdef0123456789n % SECP_N;
const zReal = '0x' + ((sTilde + t) % SECP_N).toString(16).padStart(64, '0');
const lockNu = '0x' + 'ab'.repeat(32);
const otherNu = '0x' + 'cd'.repeat(32);
const RELAYER = '0x000000009C28617AC88B52Eae5EFaAcdD4aC34c3';
const RELAYED = hex(keccak_256(new TextEncoder().encode('Relayed(address,address,uint256,uint256)')));
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const FORWARDER = '0x0000008353ee6Dea1236544938C546E27010416D';

const realClaim = { publicValues: publicValues({ lockNullifiers: [lockNu], adaptorClaimS: [zReal] }), proof: '0x' + 'cc'.repeat(32), memos: [] };
const filler = { publicValues: publicValues({ lockNullifiers: [], adaptorClaimS: [] }), proof: '0x' + 'dd'.repeat(32), memos: [] };   // an ordinary settle that lands
const refused = { publicValues: publicValues({ lockNullifiers: [lockNu], adaptorClaimS: ['0x' + '07'.repeat(32)] }), proof: '0x00', memos: [] };   // the pool refuses it; the relayer passes over it
const refundX = { publicValues: publicValues({ lockNullifiers: [lockNu], adaptorClaimS: [] }), proof: '0x' + 'ee'.repeat(32), memos: [] };

// txs: [{ hash, to, input, traceCalls?, landed? }] (`landed`: how many of a relayer transaction's calls landed, for its receipt; all of them when not given)
function makeEvm(txs, { relayStatus = null } = {}) {
  let traced = 0;
  const byHash = new Map(txs.map((x) => [x.hash, x]));
  const ux = {
    pool, lockScan,
    rpc: async (m, p) => {
      if (m === 'eth_getStorageAt') return '0x' + '00'.repeat(31) + '01';
      if (m === 'eth_getTransactionByHash') { const x = byHash.get(p[0]); return x ? { input: x.input, to: x.to } : null; }
      if (m === 'eth_getTransactionReceipt') {
        const x = byHash.get(p[0]);
        if (!x) return null;
        const toRelayer = x.to === RELAYER.toLowerCase(), n = toRelayer ? lockScan.decodeSettleCalls(x.input).calls.length : 0;
        return { status: '0x1', logs: toRelayer ? [{ address: RELAYER, topics: ['0x' + RELAYED, '0x' + word(0), '0x' + word(0)], data: '0x' + word(n) + word(x.landed ?? n) }] : [] };
      }
      if (m === 'eth_blockNumber') return '0x100';
      if (m === 'eth_getBlockByNumber') return { timestamp: '0x' + (1_700_000_000 + (p[0] === 'latest' ? 256 : parseInt(p[0], 16)) * 12).toString(16) };
      throw new Error('stub: ' + m);
    },
    fetchEvents: async () => txs.map((x, i) => ({ type: 'NullifiersSpent', txHash: x.hash, blockNumber: 30 + i, logIndex: 1 })),
    identity: () => ({ pubHex: '0x00' }), chainBindingHex: () => '0x' + '00'.repeat(32),
    relay: { status: async () => ({ status: relayStatus }) },
  };
  const trace = async (h) => { traced++; const x = byHash.get(h); return x && x.traceCalls ? x.traceCalls : [{ to: x.to, input: x.input }]; };
  const evm = makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256: (k, m) => hmac(sha256, k, m), walletPriv: new Uint8Array(32).fill(7), seed: new Uint8Array(32).fill(9), asset: '0x' + 'f0'.repeat(32), poolAddress: POOL, trace });
  return { evm, traced: () => traced };
}

// one step of the Ethereum locker at 'offered' (`tip`: the Bitcoin tip; the lock is at height 100 with a 144-block timelock)
async function elStep(txs, { tip = 120, rec: over = {} } = {}) {
  const { evm, traced } = makeEvm(txs);
  const recs = new Map();
  const rec = { id: 'aa'.repeat(36), role: 'el', phase: 'offered', created: 1_700_000_000, lock: { lockLeaf: '0x' + '11'.repeat(32), lockNu }, deadline: 4_000_000_000, evmOffer: { presign: { sTilde: '0x' + sTilde.toString(16).padStart(64, '0') } }, offer: { T: hex(T.toRawBytes(true)), btc: {} }, csvBlocks: 144, lockHeight: 100, lockTxid: '55'.repeat(32), ...over };
  recs.set(rec.id, rec);
  const store = { get: async (id) => recs.get(id) || null, put: async (r) => { recs.set(r.id, r); } };
  const btc = { status: async () => ({ confirmations: 20, height: 100 }), tip: async () => tip };
  const el = makeEthereumLocker({ seed: new Uint8Array(32), store, policy: { minCsv: 72, refundMarginSecs: 600 }, quotes: { get: async () => null }, btc, evm: { ...evm, now: async () => 1_700_000_100 }, counter: {}, now: () => 1_700_000_100 });
  const after = await el.step(rec);
  return { after, traced: traced() };
}

let fails = 0;
const expect = (label, ok, said) => { console.log((ok ? 'ok   ' : 'FAIL ') + label + (said ? `  (${said})` : '')); if (!ok) fails++; };

// ── the Ethereum locker reads t from the claim ──
// The claim is settled through the deployed SettleTipForwarder: it is read from that call's input with the check, or by trace.
const claimTx = { hash: '0x' + '01'.repeat(32), to: FORWARDER.toLowerCase(), input: settleWithTip(realClaim), traceCalls: [{ to: FORWARDER.toLowerCase(), input: settleWithTip(realClaim) }, { to: POOL.toLowerCase(), input: settle(realClaim) }] };
// a relayer transaction in the same window: one call landed, and one the pool refused names the lock with a kernel that opens nothing
const strayTx = { hash: '0x' + '02'.repeat(32), to: RELAYER.toLowerCase(), input: relaySettle([filler, refused]), landed: 1 };
// the same with a refused call that names the lock and carries no kernel, as a refund does
const strayRefundTx = { hash: '0x' + '05'.repeat(32), to: RELAYER.toLowerCase(), input: relaySettle([filler, { ...refused, publicValues: publicValues({ lockNullifiers: [lockNu], adaptorClaimS: [] }) }]), landed: 1 };
for (const [label, txs] of [['the claim alone', [claimTx]], ['the claim and a relayer call that did not land', [claimTx, strayTx]], ['the same, in the other order', [strayTx, claimTx]], ['the claim and a relayer call with no kernel that did not land', [claimTx, strayRefundTx]]]) {
  const { after } = await elStep(txs);
  expect(`Ethereum locker, ${label} -> takes with t`, after.phase === 'taking' && after.t === '0x' + t.toString(16).padStart(64, '0'), `phase=${after.phase}, why=${after.why || ''}, err=${(after.lastError || '').slice(0, 60)}`);
}
{
  const { after } = await elStep([strayTx]);
  expect('Ethereum locker, only a call that did not land names the lock -> reads again, nothing given up', after.phase === 'offered' && /not found yet/.test(after.lastError || ''), `phase=${after.phase}, err=${(after.lastError || '').slice(0, 60)}`);
}
{
  // a call that ran with a kernel that does not give t: read again while the Bitcoin lock can still be taken, given up only near its refund
  const oddTx = { hash: '0x' + '07'.repeat(32), to: POOL.toLowerCase(), input: settle({ ...realClaim, publicValues: publicValues({ lockNullifiers: [lockNu], adaptorClaimS: ['0x' + '08'.repeat(32)] }) }) };
  const early = await elStep([oddTx]);
  expect('Ethereum locker, a kernel without t with time left -> stays and reads again later', early.after.phase === 'offered' && early.after.unread === 1 && early.after.lookAt > 1_700_000_100, `phase=${early.after.phase}, unread=${early.after.unread}`);
  const late = await elStep([oddTx], { tip: 240 });
  expect('Ethereum locker, a kernel without t with the refund near -> lost', late.after.phase === 'lost', late.after.phase);
}

// ── whether this side's claim landed ──
const ownS = zReal;
const refundTx = { hash: '0x' + '03'.repeat(32), to: POOL.toLowerCase(), input: settle(refundX) };
const batchedTx = { hash: '0x' + '04'.repeat(32), to: RELAYER.toLowerCase(), input: relaySettle([{ publicValues: publicValues({ lockNullifiers: [lockNu, otherNu], adaptorClaimS: ['0x' + '09'.repeat(32)] }), proof: '0x' + 'ff'.repeat(32), memos: [] }]) };
const ownClaimTx = { hash: '0x' + '06'.repeat(32), to: RELAYER.toLowerCase(), input: relaySettle([filler, realClaim]) };
const ownClaimRefusedTx = { ...ownClaimTx, hash: '0x' + '09'.repeat(32), landed: 1 };
async function claimLanded(txs) {
  const { evm } = makeEvm(txs, { relayStatus: 'unknown' });
  return evm.jobStatus('job1', { type: 'adaptorclaim', bundle: { op: { lockNullifier: lockNu, kernelS: ownS } }, sinceSecs: 1_700_000_000 });
}
expect('claim status: the lock refunded -> failed', (await claimLanded([refundTx])) === 'failed');
expect('claim status: the lock refunded, and a relayer call that did not land names it -> failed', (await claimLanded([refundTx, strayTx])) === 'failed');
expect('claim status: the lock refunded in one call with another lock\'s claim -> failed', (await claimLanded([batchedTx])) === 'failed');
expect('claim status: this side\'s claim in a relayer call that did not land, then the lock refunded -> failed', (await claimLanded([ownClaimRefusedTx, refundTx])) === 'failed');
expect('claim status: this side\'s claim landed through the relayer -> settled', (await claimLanded([ownClaimTx])) === 'settled');

// the Bitcoin locker's 'claimed' phase with its timelock run: done only when the pool shows this side's own claim, else the Bitcoin is refunded
{
  const cases = [
    ['refund only', [refundTx], 'refund'], ['refund and a call that did not land', [refundTx, strayTx], 'refund'], ['refund batched with another lock\'s claim', [batchedTx], 'refund'],
    ['this side\'s claim did not land, then a refund', [ownClaimRefusedTx, refundTx], 'refund'], ['this side\'s claim', [ownClaimTx], 'done'],
  ];
  for (const [label, txs, want] of cases) {
    const { evm } = makeEvm(txs);
    let refundTried = false;
    const recs = new Map();
    const rec = { v: 1, role: 'bl', id: 'bb'.repeat(36), phase: 'claimed', created: 1, asset: '00'.repeat(32), amount: '120000', csvBlocks: 144, counterClaimPub: '02' + '33'.repeat(32), lock: { txid: '44'.repeat(32), vout: 0, value: 120000 }, evmOffer: { lockLeaf: '11'.repeat(32) }, claimStartedAt: 1_700_000_000, claim: { op: { op: { lockNullifier: lockNu, kernelS: ownS } }, jobId: 'job1' } };
    recs.set(rec.id, rec);
    const store = { get: async (id) => recs.get(id) || null, put: async (r) => { recs.set(r.id, r); } };
    const btc = { status: async () => ({ confirmations: 300, height: 100 }), outspend: async () => null, tip: async () => 400, feeRate: async () => { refundTried = true; throw new Error('stop: the refund was being built'); } };
    const bl = makeBitcoinLocker({ seed: new Uint8Array(32).fill(5), store, policy: {}, btc, evm: { ...evm, lockNullifier: () => lockNu }, counter: {}, now: () => 1_800_000_000 });
    // (the stubbed btc has no wallet: reaching the refund's build throws, which is how a refund being made is seen here)
    const after = await bl.step(rec);
    const tried = refundTried || (after.phase === 'claimed' && !!after.lastError);
    const got = after.phase === 'done' && !tried ? 'done' : tried ? 'refund' : after.phase;
    expect(`Bitcoin locker claimed and due, ${label} -> ${want}`, got === want, `phase=${after.phase}, why=${after.why || ''}, err=${(after.lastError || '').slice(0, 60)}`);
  }
}
if (fails) { console.error(`${fails} expectation(s) failed`); process.exit(1); }
console.log('all claim reads hold');
