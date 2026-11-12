// The fast-bridge LP reads what the pool did with its lock from the settle calls in a relayer batch: every call that names the lock is read,
// and the claim that landed is found whatever else the batch carries.
const S = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const { makeFastBridgeEvm } = await import(`${S}/dapp/fastbridge-evm.js`);
const { makeEthereumLocker } = await import(`${S}/dapp/fastbridge-el.js`);
const { makeConfidentialLockScan } = await import(`${S}/dapp/confidential-lock-scan.js`);
const { makeConfidentialPool } = await import(`${S}/dapp/confidential-pool.js`);
const { secp, keccak_256, sha256, hmac } = await import(`${S}/dapp/vendor/tacit-deps.min.js`);
const adaptor = await import(`${S}/dapp/adaptor-signature.js`);
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
  const tuples = calls.map(tuple); let pos = calls.length * 32, heads = [];
  for (const t of tuples) { heads.push(word(pos)); pos += t.length / 2; }
  const arr = word(calls.length) + heads.join('') + tuples.join('');
  const fa = encB32Arr([]), mo = encB32Arr([]), rc = encB32Arr(['0x' + '11'.repeat(20)]), bp = encB32Arr([word(10000)]);
  const oC = 160, oF = oC + arr.length / 2, oM = oF + fa.length / 2, oR = oM + mo.length / 2, oB = oR + rc.length / 2;
  return '0x' + sel('relaySettle((bytes,bytes,bytes[])[],address[],uint256[],address[],uint256[])') + word(oC) + word(oF) + word(oM) + word(oR) + word(oB) + arr + fa + mo + rc + bp;
}
// PublicValues: fields 0..20 as ConfidentialPool.sol orders them (3 nullifiers, 4 leaves, 17 lockLeaves, 18 lockNullifiers, 19 adaptorClaimS, 20 refundNotBefore)
function publicValues({ lockNullifiers, adaptorClaimS }) {
  const z32 = bytes32('0x' + '00'.repeat(32));
  const dyn = (enc) => ({ dyn: enc });
  const F = [{ st: word(1) }, { st: z32 }, { st: z32 }, dyn(encB32Arr([])), dyn(encB32Arr([])), dyn(encB32Arr([])), dyn(word(0)), dyn(word(0)), dyn(encB32Arr([])), dyn(word(0)), dyn(encB32Arr([])),
    { st: z32 }, { st: z32 }, dyn(word(0)), dyn(word(0)), { st: word(0) }, { st: z32 }, dyn(encB32Arr([])), dyn(encB32Arr(lockNullifiers)), dyn(encB32Arr(adaptorClaimS)), { st: word(0) }];
  let head = '', tail = '', pos = F.length * 32;
  for (const f of F) { if (f.st != null) head += f.st; else { head += word(pos); tail += f.dyn; pos += f.dyn.length / 2; } }
  return '0x' + word(32) + head + tail;
}

// ── the swap, from the LP's side ──
const t = 0x1234567890abcdefn % SECP_N, T = G.multiply(t);
const sTilde = 0xabcdef0123456789n % SECP_N;
const z = (sTilde + t) % SECP_N;                          // what the user's honest claim publishes
const zHex = '0x' + z.toString(16).padStart(64, '0');
const lockNu = '0x' + 'ab'.repeat(32);                    // the lock's nullifier (pool.nullifier(lockLeaf))
const RELAYER = '0x000000009C28617AC88B52Eae5EFaAcdD4aC34c3';
const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';

function makeLp(txInput, txTo) {
  const ux = {
    pool, lockScan,
    rpc: async (m, p) => {
      if (m === 'eth_getStorageAt') return '0x' + '00'.repeat(31) + '01';            // the pool says the lock is spent
      if (m === 'eth_getTransactionByHash') return { input: txInput, to: txTo };
      if (m === 'eth_blockNumber') return '0x20';
      if (m === 'eth_getBlockByNumber') return { timestamp: '0x' + (1_700_000_000 + parseInt(p[0], 16) * 12).toString(16) };
      throw new Error('stub: ' + m);
    },
    fetchEvents: async () => [{ type: 'NullifiersSpent', txHash: '0xclaimtx', blockNumber: 30, logIndex: 1 }],
    identity: () => ({ pubHex: '0x00' }), chainBindingHex: () => '0x' + '00'.repeat(32), relay: {},
  };
  return makeFastBridgeEvm({ ux, secp, keccak256: keccak_256, hmacSha256: (k, m) => hmac(sha256, k, m), walletPriv: new Uint8Array(32).fill(7), seed: new Uint8Array(32).fill(9), asset: '0x' + 'f0'.repeat(32), poolAddress: POOL });
}

async function run(label, txInput, txTo) {
  const evm = makeLp(txInput, txTo);
  const recs = new Map();
  const rec = { id: 'aa'.repeat(36), role: 'el', phase: 'offered', created: 1_700_000_000, lock: { lockLeaf: '0x' + '11'.repeat(32), lockNu }, deadline: 4_000_000_000, evmOffer: { presign: { sTilde: '0x' + sTilde.toString(16).padStart(64, '0') } }, offer: { T: hex(T.toRawBytes(true)), btc: {} }, csvBlocks: 144 };
  recs.set(rec.id, rec);
  const store = { get: async (id) => recs.get(id) || null, put: async (r) => { recs.set(r.id, r); } };
  const el = makeEthereumLocker({ seed: new Uint8Array(32), store, policy: { minCsv: 72, refundMarginSecs: 600 }, quotes: { get: async () => null }, btc: {}, evm: { ...evm, now: async () => 1_700_000_100 }, counter: {}, now: () => 1_700_000_100 });
  const after = await el.step(rec);
  console.log(label.padEnd(58), '-> phase:', after.phase, after.t ? '(t recovered)' : '', after.why ? `[${after.why}]` : '');
  return after;
}

const real = { publicValues: publicValues({ lockNullifiers: [lockNu], adaptorClaimS: [zHex] }), proof: '0x' + 'cc'.repeat(32), memos: [] };
const otherEmpty = { publicValues: publicValues({ lockNullifiers: [lockNu], adaptorClaimS: [] }), proof: '0x00', memos: [] };
const otherValue = { publicValues: publicValues({ lockNullifiers: [lockNu], adaptorClaimS: ['0x' + '07'.repeat(32)] }), proof: '0x00', memos: [] };

const refund = { publicValues: publicValues({ lockNullifiers: [lockNu], adaptorClaimS: [] }), proof: '0x' + 'cc'.repeat(32), memos: [] };
let fails = 0;
const expect = (label, got, phase) => { if (got.phase !== phase) { fails++; console.error('FAIL', label, 'got', got.phase, 'want', phase); } };
expect('honest claim', await run('honest claim [real]', relaySettle([real]), RELAYER), 'taking');
expect('other call first (no values)', await run('batch: [other call (no values), claim]', relaySettle([otherEmpty, real]), RELAYER), 'taking');
expect('other call first (a value)', await run('batch: [other call (a value), claim]', relaySettle([otherValue, real]), RELAYER), 'taking');
expect('other call last', await run('batch: [claim, other call]', relaySettle([real, otherValue]), RELAYER), 'taking');
expect('a refund alone', await run('refund [empty]', relaySettle([refund]), RELAYER), 'done');
if (fails) process.exit(1);
console.log('ok');
