
import { makeTreeCore, LIVE_PRE } from './confidential-tree-core.js';
import { makeConfidentialProver } from './evm-confidential.js';
import { verifySchnorr, bpRangeVerify, bpClassicProofLen } from './bulletproofs.js';
import { bppRangeVerify, bytesToPoint as bppPoint, ZERO as bppZero } from './bulletproofs-plus.js';
import { txOutputScript, noteSpendsBindOutputs } from './burn-deposit-bitcoin.js';

export const TREE_DEPTH = 32;

export const LEGACY_BRIDGE_ASSETS = ['0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b'];
export function isLegacyBridgeAsset(assetId) {
  const a = (assetId instanceof Uint8Array
    ? [...assetId].map((x) => x.toString(16).padStart(2, '0')).join('')
    : String(assetId).replace(/^0x/, '')).toLowerCase();
  return LEGACY_BRIDGE_ASSETS.some((x) => x.replace(/^0x/, '').toLowerCase() === a);
}

export function makeConfidentialPool({ secp, keccak256, sha256 }) {
  const prover = makeConfidentialProver({ secp, keccak256, sha256 });
  const N = secp.CURVE.n;

  // These two are the pool's every conversion (a leaf, a hash, an id: some two hundred uses), and read a character or a byte at a time through a table where the answer is the same as the generic
  // one's: hex of even length with nothing but hex digits, and bytes in a Uint8Array. Anything else (an odd length, a character that is not a digit, '0X', a plain array) is made as it always was.
  // tests/confidential-hex.test.mjs holds the two to each other.
  const HEXB = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
  const NIB = new Int8Array(128).fill(-1);
  for (let i = 0; i < 10; i++) NIB[48 + i] = i;
  for (let i = 0; i < 6; i++) { NIB[97 + i] = 10 + i; NIB[65 + i] = 10 + i; }
  const hexToBytesSlow = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
  const hexToBytes = (h) => {
    const s = String(h).replace(/^0x/, '');
    if (s.length & 1) return hexToBytesSlow(h);       // (the generic one is given what was given, not what is left of it: it takes the 0x off itself)
    const out = new Uint8Array(s.length >> 1);
    for (let i = 0; i < out.length; i++) {
      const a = s.charCodeAt(2 * i), b = s.charCodeAt(2 * i + 1);
      const x = a < 128 ? NIB[a] : -1, y = b < 128 ? NIB[b] : -1;
      if (x < 0 || y < 0) return hexToBytesSlow(h);
      out[i] = (x << 4) | y;
    }
    return out;
  };
  const bytesToHexSlow = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const bytesToHex = (b) => {
    if (!(b instanceof Uint8Array)) return bytesToHexSlow(b);
    let s = '';
    for (let i = 0; i < b.length; i++) s += HEXB[b[i]];
    return s;
  };
  const hx = (b) => '0x' + bytesToHex(b);
  const b32 = (v) => {
    if (v instanceof Uint8Array) return v.length === 32 ? v : padL(v, 32);
    if (typeof v === 'bigint') return hexToBytes(v.toString(16).padStart(64, '0'));
    return hexToBytes(v.toString().replace(/^0x/, '').padStart(64, '0'));
  };
  const padL = (b, n) => { const o = new Uint8Array(n); o.set(b, n - b.length); return o; };
  const beBytes = (n, len = 32) => hexToBytes(BigInt(n).toString(16).padStart(len * 2, '0'));
  const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
  const keccak = (...parts) => keccak256(concat(parts.map(b32)));
  const mod = (a, m) => ((a % m) + m) % m;
  const bToBig = (b) => BigInt('0x' + bytesToHex(b));

  const ZERO32 = new Uint8Array(32);

  function commitXY(value, blinding) {
    const C = prover.commit(BigInt(value), BigInt(blinding));
    const a = C.toAffine();
    return { cx: hx(beBytes(a.x)), cy: hx(beBytes(a.y)) };
  }

  function deriveNote(seed, assetId, index) {
    const base = concat([b32(seed), new TextEncoder().encode('tacit-evm-cnote-v1'), b32(assetId), beBytes(index, 8)]);
    const secret = sha256(concat([base, new Uint8Array([0])]));
    const blinding = mod(bToBig(sha256(concat([base, new Uint8Array([1])]))), N) || 1n;
    return { secret: hx(secret), blinding };
  }

  function deriveBidSecret(seed, fundCx, fundCy) {
    return hx(sha256(concat([b32(seed), new TextEncoder().encode('tacit-evm-bid-secret-v1'), b32(fundCx), b32(fundCy)])));
  }

  const leaf = (assetId, cx, cy, owner) => hx(keccak(assetId, cx, cy, owner));
  const BTC_NOTE_DOM = new TextEncoder().encode('tacit-btc-note-v1');
  const btcNoteLeaf = (assetId, cx, cy, authKey) =>
    hx(keccak256(concat([b32(assetId), b32(cx), b32(cy), b32(authKey), BTC_NOTE_DOM])));
  const BTC_NOTE_DOM_BOUND = new TextEncoder().encode('tacit-btc-note-bound');
  const btcNoteLeafBound = (assetId, cx, cy, authKey, targetChainBinding) =>
    hx(keccak256(concat([b32(assetId), b32(cx), b32(cy), b32(authKey), b32(targetChainBinding), BTC_NOTE_DOM_BOUND])));
  const ZERO_AUTH_HEX = '0x' + '00'.repeat(32);
  const authZero = (a) => !a || (typeof a !== 'string' ? hx(b32(a)) : hx(b32(a))).toLowerCase() === ZERO_AUTH_HEX;
  const BRIDGE_BURN_ID_DOMAIN = new TextEncoder().encode('tacit-bridge-burn-source-v1');
  const PENDING_DEPOSIT_DOMAIN = new TextEncoder().encode('tacit-pending-deposit-v1');
  const pendingDepositValue = (asset, nu, dest, target) =>
    hx(keccak256(concat([PENDING_DEPOSIT_DOMAIN, b32(asset), b32(nu), b32(dest), b32(target)])));
  const BURN_SOURCE_REFLECTED = 1, BURN_SOURCE_DEPOSIT = 2;
  const bridgeBurnId = (sourceKind, spentTxid, spentVout, srcLeaf, targetChainBinding) =>
    hx(keccak256(concat([BRIDGE_BURN_ID_DOMAIN, Uint8Array.of(sourceKind & 0xff), b32(spentTxid), beBytes(spentVout, 4), b32(srcLeaf), b32(targetChainBinding)])));
  const PROTOFEE_BLIND_DOMAIN = new TextEncoder().encode('tacit-swap-protofee-blind-v1');
  const protofeeBlind = (firstInputNu, poolId, reserveAPre, reserveBPre, assetId, cut, recipientX) =>
    hx(keccak256(concat([
      PROTOFEE_BLIND_DOMAIN, b32(firstInputNu), b32(poolId),
      beBytes(reserveAPre, 8), beBytes(reserveBPre, 8), b32(assetId), beBytes(cut, 8), b32(recipientX),
    ])));
  const BTC_NOTE_SPEND_DOM = new TextEncoder().encode('tacit-btc-note-spend-v1');
  const btcNoteSpendMsg = (chainBinding, opId, inLeaf, inNu, outLeaves, fee, deadline) =>
    hx(keccak256(concat([
      BTC_NOTE_SPEND_DOM, b32(chainBinding), b32(opId), b32(inLeaf), b32(inNu),
      beBytes(outLeaves.length, 8), ...outLeaves.map(b32), beBytes(fee, 8), beBytes(deadline, 8),
    ])));
  const p2trXonly = (spk) => {
    const s = typeof spk === 'string' ? hexToBytes(spk.replace(/^0x/, '')) : spk;
    if (!s || s.length !== 34 || s[0] !== 0x51 || s[1] !== 0x20) return null;
    return hx(s.slice(2, 34));
  };
  const SPENT = new Uint8Array([0x73, 0x70, 0x65, 0x6e, 0x74]);
  const nullifier = (noteLeaf) => hx(keccak256(concat([b32(noteLeaf), SPENT])));
  const depositCommit = (cx, cy, owner) => hx(keccak(cx, cy, owner));
  const depositId = (assetId, value, cx, cy, owner) => hx(keccak256(concat([b32(assetId), beBytes(value, 32), b32(depositCommit(cx, cy, owner))])));

  const FARM_RPS_PRECISION = 1n << 64n;
  const FARM_RECEIPT_DOM = new TextEncoder().encode('tacit-farm-receipt-v3');
  const FARM_RECEIPT_NULL_DOM = new TextEncoder().encode('tacit-farm-receipt-null-v1');
  const NATIVE_OWNER_DOM = new TextEncoder().encode('tacit-native-owner-v1');
  const NATIVE_NULLIFIER_DOM = new TextEncoder().encode('tacit-native-nullifier-v1');
  const nkToOwner = (nk) => hx(keccak256(concat([b32(nk), NATIVE_OWNER_DOM])));
  const nativeNullifier = (nk, leaf) => hx(keccak256(concat([b32(nk), b32(leaf), NATIVE_NULLIFIER_DOM])));
  const ZERO_OWNER_HEX = '0x' + '0'.repeat(64);
  const nativeNu = (owner, nk, leaf) => (
    !owner || String(owner).toLowerCase() === ZERO_OWNER_HEX ? nullifier(leaf) : nativeNullifier(nk, leaf)
  );
  const LP_HARVEST_OWNER_DOM = new TextEncoder().encode('tacit-farm-harvest-owner-v1');
  const LP_UNBOND_OWNER_DOM = new TextEncoder().encode('tacit-farm-unbond-owner-v1');
  const FARM_REFUND_DOM = new TextEncoder().encode('tacit-amm-farm-refund-v1');
  const PFEE_CLAIM_DOM = new TextEncoder().encode('tacit-amm-protocol-fee-claim-v1');
  const leBytes = (n, len) => { const b = new Uint8Array(len); let v = BigInt(n); for (let i = 0; i < len; i++) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
  const farmReceiptLeaf = (farm, lpAsset, shares, owner, nonce) =>
    hx(keccak256(concat([FARM_RECEIPT_DOM, b32(farm), b32(lpAsset), leBytes(shares, 8), b32(owner), b32(nonce)])));
  const farmReceiptNullifier = (leafHex) => hx(keccak256(concat([FARM_RECEIPT_NULL_DOM, b32(leafHex)])));
  const EVM_LP_HARVEST_OWNER_DOM = new TextEncoder().encode('tacit-evm-farm-harvest-owner-v1');
  const EVM_LP_UNBOND_OWNER_DOM = new TextEncoder().encode('tacit-evm-farm-unbond-owner-v1');
  const evmLpHarvestOwnerMsg = ({ farmId, oldLeaf, reward, fee, newNonce, rewardAsset, rewardCx, rewardCy, rewardOwner }) =>
    keccak256(concat([EVM_LP_HARVEST_OWNER_DOM, b32(farmId), b32(oldLeaf), beBytes(reward, 8), beBytes(fee, 8), b32(newNonce), b32(rewardAsset), b32(rewardCx), b32(rewardCy), b32(rewardOwner)]));
  const evmLpUnbondOwnerMsg = ({ farmId, receipt, shares, fee, lpAsset, releaseCx, releaseCy, releaseOwner }) =>
    keccak256(concat([EVM_LP_UNBOND_OWNER_DOM, b32(farmId), b32(receipt), beBytes(shares, 8), beBytes(fee, 8), b32(lpAsset), b32(releaseCx), b32(releaseCy), b32(releaseOwner)]));

  const _LP_DOM = new TextEncoder().encode('lp');
  const evmPoolId = (a, b, feeBps) => {
    const [lo, hi] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
    return hx(keccak256(concat([b32(lo), b32(hi), beBytes(feeBps, 32)])));
  };
  const evmLpShareId = (pid) => hx(keccak256(concat([b32(pid), _LP_DOM])));

  const zeros = (() => {
    const z = [ZERO32];
    for (let i = 1; i < TREE_DEPTH; i++) z.push(keccak256(concat([z[i - 1], z[i - 1]])));
    return z;
  })();

  const treeCore = makeTreeCore({ keccak256, depth: TREE_DEPTH });

  class Tree {
    constructor() { this.leaves = []; this._made = null; this._ver = 0; this._preparing = null; }
    insert(leafHex) { this.leaves.push(b32(leafHex)); this._made = null; this._ver++; return this.leaves.length - 1; }

    // Makes the levels in `workers` (confidential-tree-workers.js) so that the first root or path of a tree does not hold the page's thread (about a hash for each leaf: a few
    // hundred milliseconds for a pool of seven thousand): asked before that first root, the levels are there when it comes. What comes back is put together and checked at its edges
    // here, and kept only if no leaf was inserted meanwhile; anything less (no workers, a failed or odd answer) leaves the levels to levels() as they always were, so a tree is the same
    // tree whatever the workers do. Asked again while one is under way, it waits for that one.
    async prepare(workers) {
      const n = this.leaves.length, v = this._ver;
      if (!workers || (this._made && this._made.n === n)) return this;
      if (this._preparing && this._preparing.v === v) { await this._preparing.p; return this; }
      const p = (async () => {
        let made = null;
        try {
          const packed = new Uint8Array(n * 32);
          for (let i = 0; i < n; i++) packed.set(this.leaves[i], 32 * i);
          const w = await workers(packed, n);
          if (w && treeCore.edgesHold(packed, n, w.lower, w.h)) {
            const r = treeCore.finish(packed, n, w.lower, w.h);
            const nodes = (buf, count) => Array.from({ length: count }, (_, k) => buf.subarray(32 * k, 32 * k + 32));
            made = { n, levels: r.levels.map((buf, i) => nodes(buf, r.counts[i])), top: [r.top] };
          }
        } catch { made = null; }
        if (made && this._ver === v && !(this._made && this._made.n === n)) this._made = made;
      })();
      this._preparing = { v, p };
      try { await p; } finally { if (this._preparing && this._preparing.p === p) this._preparing = null; }
      return this;
    }

    // Every level of the tree, level 0 the leaves and level i what level i-1 hashes to in pairs (the missing side of the last pair is zeros[i-1]), and
    // the top. Made once for the leaves the tree has and kept until one is inserted: the root and the path of each note were each a hash of every leaf
    // again (about fifteen thousand hashes for a pool of seven thousand), asked for once per note and once per scan.
    levels() {
      const n = this.leaves.length;
      if (this._made && this._made.n === n) return this._made;
      const levels = [];
      let level = this.leaves.slice();
      for (let i = 0; i < TREE_DEPTH; i++) {
        levels.push(level);
        const next = [];
        for (let k = 0; k * 2 < level.length; k++) {
          const l = level[2 * k];
          const r = 2 * k + 1 < level.length ? level[2 * k + 1] : zeros[i];
          next.push(keccak256(concat([l, r])));
        }
        level = next.length ? next : [zeros[i + 1] || ZERO32];
      }
      return (this._made = { n, levels, top: level });
    }

    rootAndPath(index) {
      const { levels, top } = this.levels();
      const path = [];
      for (let i = 0; i < TREE_DEPTH; i++) {
        const sib = (index >>> i) ^ 1;
        path.push(hx(sib < levels[i].length ? levels[i][sib] : zeros[i]));
      }
      return { root: hx(top[0]), path };
    }

    root() { return this.rootAndPath(0).root; }

    // what rootAndPath was before levels were kept: every level made again from the leaves. tests/confidential-tree-levels.test.mjs holds the two to each other.
    rootAndPathFresh(index) {
      let level = this.leaves.slice();
      const path = [];
      for (let i = 0; i < TREE_DEPTH; i++) {
        const pos = index >>> i;
        const sib = pos ^ 1;
        path.push(hx(sib < level.length ? level[sib] : zeros[i]));
        const next = [];
        for (let k = 0; k * 2 < level.length; k++) {
          const l = level[2 * k];
          const r = 2 * k + 1 < level.length ? level[2 * k + 1] : zeros[i];
          next.push(keccak256(concat([l, r])));
        }
        level = next.length ? next : [zeros[i + 1] || ZERO32];
      }
      return { root: hx(level[0]), path };
    }
  }

  const imtLeaf = (value, next) => hx(keccak(value, next));
  function imtRoot(links) {
    const t = new Tree();
    for (const [v, n] of links) t.insert(imtLeaf(v, n));
    return t.root();
  }
  const imtEmptyRoot = () => imtRoot([[ZERO32, ZERO32]]);

  function makeImtAccumulator() {
    const norm = (x) => hx(b32(x));
    const big = (x) => BigInt(norm(x));
    const links = [[norm(ZERO32), norm(ZERO32)]];
    const lowIndexOf = (nu) => links.findIndex(([v, n]) => big(v) < big(nu) && (big(n) === 0n || big(nu) < big(n)));
    function insert(nuIn) {
      const nu = norm(nuIn);
      if (big(nu) === 0n) throw new Error('cannot insert 0 (the min/sentinel anchor)');
      const i = lowIndexOf(nu);
      if (i < 0) throw new Error('no low link (nu out of range)');
      if (big(links[i][0]) === big(nu)) throw new Error('nullifier already spent');
      const old = links[i][1];
      links[i] = [links[i][0], nu];
      links.push([nu, old]);
      return i;
    }
    const buildTree = () => { const t = new Tree(); for (const [v, n] of links) t.insert(imtLeaf(v, n)); return t; };
    const root = () => buildTree().root();
    function nonMembershipWitness(nuIn) {
      const nu = norm(nuIn);
      const i = lowIndexOf(nu);
      if (i < 0) throw new Error('nu is a member or out of range — no non-membership witness');
      const { path } = buildTree().rootAndPath(i);
      return { lowValue: links[i][0], lowNext: links[i][1], lowIndex: i, path };
    }
    function membershipWitness(nuIn) {
      const nu = norm(nuIn);
      const i = links.findIndex(([v]) => big(v) === big(nu));
      if (i < 0) throw new Error('nu is not a member — no membership witness');
      const { path } = buildTree().rootAndPath(i);
      return { next: links[i][1], index: i, path };
    }
    const contains = (nuIn) => { const nu = norm(nuIn); return links.some(([v]) => big(v) === big(nu)); };
    function setLinks(ls) { links.length = 0; for (const [v, n] of ls) links.push([norm(v), norm(n)]); }
    return { insert, setLinks, root, nonMembershipWitness, membershipWitness, contains, links: () => links.map((l) => l.slice()) };
  }

  const utxoLeaf = (key, next, value) => hx(keccak(key, next, value));
  function makeUtxoAccumulator() {
    const norm = (x) => hx(b32(x));
    const big = (x) => BigInt(norm(x));
    const nodes = [[norm(ZERO32), norm(ZERO32), norm(ZERO32), true]];
    const lowIndexOf = (key) => nodes.findIndex(([k, n, , a]) => a && big(k) < big(key) && (big(n) === 0n || big(key) < big(n)));
    const find = (key) => nodes.findIndex(([k, , , a]) => a && big(k) === big(key));
    const predOf = (key) => nodes.findIndex(([, n, , a]) => a && big(n) === big(key));
    function insert(keyIn, valueIn) {
      const key = norm(keyIn), value = norm(valueIn);
      if (big(key) === 0n) throw new Error('cannot insert key 0 (the sentinel anchor)');
      const i = lowIndexOf(key);
      if (i < 0) throw new Error('no low link (key present or out of range)');
      if (big(nodes[i][0]) === big(key)) throw new Error('outpoint/ν already present');
      const old = nodes[i][1];
      nodes[i] = [nodes[i][0], key, nodes[i][2], true];
      nodes.push([key, old, value, true]);
      return i;
    }
    function remove(keyIn) {
      const key = norm(keyIn);
      const i = find(key); if (i < 0) throw new Error('outpoint not in the UTXO set');
      const p = predOf(key); if (p < 0) throw new Error('predecessor missing');
      nodes[p] = [nodes[p][0], nodes[i][1], nodes[p][2], true];
      nodes[i] = [nodes[i][0], nodes[i][1], nodes[i][2], false];
    }
    const leafAt = ([k, n, v, a]) => (a ? utxoLeaf(k, n, v) : hx(ZERO32));
    const buildTree = () => { const t = new Tree(); for (const nd of nodes) t.insert(leafAt(nd)); return t; };
    const root = () => buildTree().root();
    const leaves = () => nodes.map(leafAt);
    function membershipWitness(keyIn) {
      const i = find(norm(keyIn));
      if (i < 0) throw new Error('key is not a member — no membership witness');
      const { path } = buildTree().rootAndPath(i);
      return { next: nodes[i][1], value: nodes[i][2], index: i, path };
    }
    function low(keyIn) {
      const i = lowIndexOf(norm(keyIn)); if (i < 0) return null;
      return { index: i, key: nodes[i][0], next: nodes[i][1], value: nodes[i][2] };
    }
    function predecessor(keyIn) {
      const i = predOf(norm(keyIn)); if (i < 0) return null;
      return { index: i, key: nodes[i][0], value: nodes[i][2] };
    }
    const contains = (keyIn) => find(norm(keyIn)) >= 0;
    function setNodes(ns) { nodes.length = 0; for (const [k, n, v, a] of ns) nodes.push([norm(k), norm(n), norm(v), a]); }
    return { insert, remove, setNodes, root, leaves, membershipWitness, low, predecessor, contains, nodes: () => nodes.map((n) => n.slice()) };
  }

  // The 129 bytes a live-set leaf is the hash of: key ‖ asset ‖ value ‖ authKey ‖ bound. One definition, for a leaf by itself and for the batch the workers hash (LIVE_PRE bytes at `off` in `out`).
  const livePre = (key, value, asset, authKey, bound, out = new Uint8Array(LIVE_PRE), off = 0) => {
    out.set(b32(key), off); out.set(b32(asset), off + 32); out.set(b32(value), off + 64); out.set(b32(authKey), off + 96); out[off + 128] = bound & 1;
    return out;
  };
  const liveLeaf = (key, value, asset, authKey, bound) => hx(keccak256(livePre(key, value, asset, authKey, bound)));
  const NORM32 = /^0x[0-9a-f]{64}$/;
  function makeLiveUtxoSet() {
    // a value that is already 0x and 64 lower-case digits is what hx(b32(x)) gives it back, so it is kept as it is (the entries the API gives are all of this form)
    const norm = (x) => (typeof x === 'string' && NORM32.test(x) ? x : hx(b32(x)));
    const big = (x) => BigInt(norm(x));
    let entries = [];
    let keyMap = null;
    const buildKeyMap = () => { keyMap = new Map(); for (let i = 0; i < entries.length; i++) keyMap.set(entries[i][0], i); };
    const idxOf = (key) => { if (!keyMap) buildKeyMap(); const i = keyMap.get(norm(key)); return i === undefined ? -1 : i; };
    // the keys are normalized (0x and 64 lower-case digits), so their order as strings is the order of the numbers they are
    const sort = () => { entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); keyMap = null; };
    function get(keyIn) { const i = idxOf(norm(keyIn)); return i < 0 ? null : [entries[i][1], entries[i][2], entries[i][3]]; }
    function boundTag(keyIn) { const i = idxOf(norm(keyIn)); return i < 0 ? null : entries[i][4]; }
    function insert(keyIn, valueIn, assetIn, authKeyIn, boundIn) {
      const key = norm(keyIn), value = norm(valueIn), asset = norm(assetIn), authKey = norm(authKeyIn || ZERO32);
      const bound = (boundIn ? 1 : 0);
      if (big(key) === 0n) throw new Error('live set: key 0 reserved');
      if (idxOf(key) >= 0) throw new Error('live set: duplicate outpoint');
      entries.push([key, value, asset, authKey, bound]); sort();
    }
    function remove(keyIn) {
      const key = norm(keyIn), i = idxOf(key);
      if (i < 0) throw new Error('live set: outpoint not live');
      const [, v, a, ak] = entries[i]; entries.splice(i, 1); keyMap = null; return [v, a, ak];
    }
    function root() { const t = new Tree(); for (const [k, v, a, ak, b] of entries) t.insert(liveLeaf(k, v, a, ak, b)); return t.root(); }
    // The same root with the work of it (a hash for each entry and a hash for each pair above them, about two for each) done in `workers` (confidential-tree-workers.js hashed), so a set of thousands
    // does not hold the page's thread. What they give is put together and checked at its edges here (the first and last leaf of every chunk against its preimage, the first and last node of
    // every chunk at every level); anything less (too few entries, no workers, a failed or odd answer) leaves the root to root(), so it is the same root whatever the workers do.
    async function rootAsync(workers) {
      const n = entries.length;
      if (!workers || typeof workers.hashed !== 'function' || n === 0) return root();
      try {
        const pre = new Uint8Array(n * LIVE_PRE);
        entries.forEach(([k, v, a, ak, b], i) => livePre(k, v, a, ak, b, pre, i * LIVE_PRE));
        const w = await workers.hashed(pre, n);
        if (w && treeCore.leafEdgesHold(pre, n, w.leaves, w.h) && treeCore.edgesHold(w.leaves, n, w.lower, w.h)) return hx(treeCore.finish(w.leaves, n, w.lower, w.h).top);
      } catch { /* made here */ }
      return root();
    }
    const triples = () => entries.map(([k, v, a, ak, b]) => [k, v, a, ak, b]);
    function load(ts) { entries = ts.map(([k, v, a, ak, b]) => [norm(k), norm(v), norm(a), norm(ak || ZERO32), (b ? 1 : 0)]); sort(); }
    return { get, insert, remove, root, rootAsync, triples, load, boundTag, len: () => entries.length };
  }

  const commitmentHash = (cx, cy) => hx(keccak(cx, cy));
  const decompressCommitment = (compressed) => {
    const h = (typeof compressed === 'string') ? compressed.replace(/^0x/, '') : bytesToHex(compressed);
    const a = secp.ProjectivePoint.fromHex(h).toAffine();
    return { cx: hx(beBytes(a.x)), cy: hx(beBytes(a.y)) };
  };
  const compressXY = (cx, cy) => hx(secp.ProjectivePoint.fromAffine({ x: BigInt(cx), y: BigInt(cy) }).toRawBytes(true));
  const outpointKey = (txid, vout) => {
    const v = new Uint8Array(4); new DataView(v.buffer).setUint32(0, vout, true);
    return hx(keccak256(concat([b32(txid), v])));
  };
  const u64be = (n) => beBytes(n, 32);
  const SWAP_VAR_TIP_BLINDING_DOMAIN = new TextEncoder().encode('tacit-swap-var-tip-blinding-v1');

  const poolLeaf = (poolId, s) => hx(keccak(
    poolId, s.assetA, s.assetB,
    u64be(s.reserveA), u64be(s.reserveB), u64be(s.totalShares), u64be(s.c0Backed ? 1 : 0),
    u64be(s.feeBps || 0), u64be(s.protocolFeeBps || 0), beBytes(BigInt(s.kLast || 0), 32),
    u64be(s.protocolFeeAccrued || 0), u64be(s.capabilityFlags || 0),
  ));
  function makePoolReserveSet() {
    const norm = (x) => hx(b32(x));
    let map = new Map();
    const keys = () => [...map.keys()].sort();
    function set(poolId, s) { map.set(norm(poolId), s); }
    function get(poolId) { const s = map.get(norm(poolId)); return s ? { ...s } : null; }
    function poolIdsForAssets(assetA, assetB) {
      const a = norm(assetA), b = norm(assetB);
      return keys().filter((k) => { const s = map.get(k); return norm(s.assetA) === a && norm(s.assetB) === b; });
    }
    function root() { const t = new Tree(); for (const k of keys()) t.insert(poolLeaf(k, map.get(k))); return t.root(); }
    function list() {
      return keys().map((k) => { const s = map.get(k); return {
        poolId: k, assetA: norm(s.assetA), assetB: norm(s.assetB),
        reserveA: String(s.reserveA), reserveB: String(s.reserveB), totalShares: String(s.totalShares),
        c0Backed: !!s.c0Backed, feeBps: Number(s.feeBps || 0), protocolFeeBps: Number(s.protocolFeeBps || 0),
        kLast: String(s.kLast || 0), protocolFeeAccrued: String(s.protocolFeeAccrued || 0),
        capabilityFlags: Number(s.capabilityFlags || 0),
      }; });
    }
    function load(arr) {
      map = new Map();
      for (const e of (arr || [])) set(e.poolId, {
        assetA: e.assetA, assetB: e.assetB, reserveA: BigInt(e.reserveA), reserveB: BigInt(e.reserveB),
        totalShares: BigInt(e.totalShares), c0Backed: !!e.c0Backed, feeBps: Number(e.feeBps || 0),
        protocolFeeBps: Number(e.protocolFeeBps || 0),
        kLast: BigInt(e.kLast || 0), protocolFeeAccrued: BigInt(e.protocolFeeAccrued || 0),
        capabilityFlags: Number(e.capabilityFlags || 0),
      });
    }
    return { set, get, poolIdsForAssets, root, list, load, len: () => map.size };
  }

  function makeFarmRewardSet() {
    const norm = (x) => hx(b32(x));
    let map = new Map();
    const keys = () => [...map.keys()].sort();
    const has = (farmId) => map.has(norm(farmId));
    const get = (farmId) => { const s = map.get(norm(farmId)); return s ? { ...s } : null; };
    const set = (farmId, s) => map.set(norm(farmId), s);
    function accrue(s, height) {
      const h = BigInt(height);
      if (h > s.lastHeight) {
        const start = s.startHeight || 0n, end = s.endHeight || 0n;
        const from = s.lastHeight > start ? s.lastHeight : start;
        const to = end === 0n ? h : (h < end ? h : end);
        if (to > from && s.totalShares !== 0n) {
          const SAT = (1n << 128n) - 1n, sat = (x) => (x > SAT ? SAT : x);
          s.rps = sat(s.rps + sat(sat(s.rate * (to - from)) * FARM_RPS_PRECISION) / s.totalShares);
        }
        s.lastHeight = h;
      }
    }
    const ZPUB = '0x' + '00'.repeat(33);
    const farmLeaf = (k, s) => hx(keccak256(concat([b32(k), u64be(s.rate), u64be(s.totalShares), u64be(s.rps), u64be(s.totalRewardDebt || 0n), u64be(s.lastHeight), hexToBytes(s.launcherPubkey || ZPUB), b32(s.lpAsset || ZERO32), u64be(s.startHeight || 0n), u64be(s.endHeight || 0n)])));
    const root = () => { const t = new Tree(); for (const k of keys()) t.insert(farmLeaf(k, map.get(k))); return t.root(); };
    const len = () => map.size;
    const list = () => keys().map((k) => { const s = map.get(k); return { farmId: k, rate: String(s.rate), totalShares: String(s.totalShares), rps: String(s.rps), totalRewardDebt: String(s.totalRewardDebt || 0n), lastHeight: String(s.lastHeight), launcherPubkey: s.launcherPubkey || ZPUB, lpAsset: s.lpAsset || hx(ZERO32), startHeight: String(s.startHeight || 0n), endHeight: String(s.endHeight || 0n) }; });
    const load = (arr) => { map = new Map(); for (const e of (arr || [])) set(e.farmId, { rate: BigInt(e.rate), totalShares: BigInt(e.totalShares), rps: BigInt(e.rps), totalRewardDebt: BigInt(e.totalRewardDebt || 0), lastHeight: BigInt(e.lastHeight), launcherPubkey: e.launcherPubkey || ZPUB, lpAsset: e.lpAsset || hx(ZERO32), startHeight: BigInt(e.startHeight || 0), endHeight: BigInt(e.endHeight || 0) }); };
    return { has, get, set, accrue, root, len, list, load, keys };
  }

  function makeFarmEntrySet() {
    const norm = (x) => hx(b32(x));
    let map = new Map();
    const keys = () => [...map.keys()].sort();
    const get = (leaf) => { const v = map.get(norm(leaf)); return v === undefined ? null : v; };
    const stamp = (leaf, entryRps) => map.set(norm(leaf), BigInt(entryRps));
    const remove = (leaf) => map.delete(norm(leaf));
    const entryLeaf = (k, v) => hx(keccak256(concat([b32(k), u64be(v)])));
    const root = () => { const t = new Tree(); for (const k of keys()) t.insert(entryLeaf(k, map.get(k))); return t.root(); };
    const len = () => map.size;
    const list = () => keys().map((k) => ({ leaf: k, entryRps: String(map.get(k)) }));
    const load = (arr) => { map = new Map(); for (const e of (arr || [])) stamp(e.leaf, e.entryRps); };
    const snapshot = () => new Map(map);
    const restore = (m) => { map = new Map(m); };
    return { get, stamp, remove, root, len, list, load, keys, snapshot, restore };
  }

  function makeReflectionState() {
    const notes = new Tree();
    const spent = makeImtAccumulator();
    const utxo = makeUtxoAccumulator();
    const burns = makeUtxoAccumulator();
    let noteCount = 0;
    let height = 0;

    const poolRoot = () => notes.root();
    const spentCount = () => spent.links().length;
    const utxoCount = () => utxo.nodes().length;
    const burnCount = () => burns.nodes().length;

    function commit() { return { poolRoot: poolRoot(), spentRoot: spent.root(), burnRoot: burns.root(), height }; }
    function digest() {
      return hx(keccak(
        poolRoot(), u64be(noteCount),
        spent.root(), u64be(spentCount()),
        utxo.root(), u64be(utxoCount()),
        burns.root(), u64be(burnCount()),
        u64be(height),
      ));
    }

    function applyTransfer(spends, outputs, h) {
      if (h < height) throw new Error('reflection height must not decrease');
      for (const s of spends) { spent.insert(s.nu); utxo.remove(s.outpoint); }
      for (const o of outputs) { notes.insert(o.noteLeaf); noteCount++; utxo.insert(o.outpoint, o.commitmentHash); }
      height = h;
    }
    function applyBridgeOut(burn, h) {
      if (h < height) throw new Error('reflection height must not decrease');
      spent.insert(burn.nu); utxo.remove(burn.outpoint); burns.insert(burn.nu, burn.destCommitment);
      height = h;
    }

    function spendWitness(cx, cy, outpoint, asset, authKey) {
      asset = asset || hx(ZERO32); authKey = authKey || hx(ZERO32);
      const nu = nullifier(btcNoteLeaf(asset, cx, cy, authKey));
      const spentLeaves = spent.links().map(([vv, nn]) => imtLeaf(vv, nn));
      const low = spent.nonMembershipWitness(nu);
      const sInterm = spentLeaves.slice(); sInterm[low.lowIndex] = imtLeaf(low.lowValue, nu);
      const utxoLeaves = utxo.leaves();
      const node = utxo.membershipWitness(outpoint);
      const pred = utxo.predecessor(outpoint);
      const uInterm = utxoLeaves.slice(); uInterm[pred.index] = utxoLeaf(pred.key, node.next, pred.value);
      return {
        asset, authKey, cx, cy, outpoint,
        sLowValue: low.lowValue, sLowNext: low.lowNext, sLowIndex: low.lowIndex, sLowPath: low.path,
        sNewPath: merklePath(sInterm, spentLeaves.length),
        uNodeNext: node.next, uNodeValue: node.value, uNodeIndex: node.index, uNodePath: merklePath(uInterm, node.index),
        uPredKey: pred.key, uPredValue: pred.value, uPredIndex: pred.index, uPredPath: merklePath(utxoLeaves, pred.index),
      };
    }
    function outputWitness(noteLeaf, outpoint, commitmentHash) {
      const utxoLeaves = utxo.leaves();
      const low = utxo.low(outpoint);
      const interm = utxoLeaves.slice(); interm[low.index] = utxoLeaf(low.key, outpoint, low.value);
      return {
        noteLeaf, outpoint, commitmentHash,
        notePath: notes.rootAndPath(noteCount).path,
        uLowKey: low.key, uLowNext: low.next, uLowValue: low.value, uLowIndex: low.index, uLowPath: merklePath(utxoLeaves, low.index),
        uNewPath: merklePath(interm, utxoLeaves.length),
      };
    }
    function burnWitness(cx, cy, outpoint, destCommitment, asset, authKey) {
      asset = asset || hx(ZERO32); authKey = authKey || hx(ZERO32);
      const nu = nullifier(btcNoteLeaf(asset, cx, cy, authKey));
      const burnLeaves = burns.leaves();
      const low = burns.low(nu);
      const interm = burnLeaves.slice(); interm[low.index] = utxoLeaf(low.key, nu, low.value);
      return {
        spend: spendWitness(cx, cy, outpoint, asset, authKey), destCommitment,
        bLowKey: low.key, bLowNext: low.next, bLowValue: low.value, bLowIndex: low.index, bLowPath: merklePath(burnLeaves, low.index),
        bNewPath: merklePath(interm, burnLeaves.length),
      };
    }

    function witnessTransfer(spends, outputs, h) {
      if (h < height) throw new Error('reflection height must not decrease');
      const sw = [];
      for (const s of spends) { sw.push(spendWitness(s.cx, s.cy, s.outpoint, s.asset, s.authKey)); spent.insert(nullifier(btcNoteLeaf(s.asset || ZERO32, s.cx, s.cy, s.authKey || ZERO32))); utxo.remove(s.outpoint); }
      const ow = [];
      for (const o of outputs) { ow.push(outputWitness(o.noteLeaf, o.outpoint, o.commitmentHash)); notes.insert(o.noteLeaf); noteCount++; utxo.insert(o.outpoint, o.commitmentHash); }
      height = h;
      return { spends: sw, outputs: ow, height: h };
    }
    function witnessBridgeOut(burn, h) {
      if (h < height) throw new Error('reflection height must not decrease');
      const bw = burnWitness(burn.cx, burn.cy, burn.outpoint, burn.destCommitment, burn.asset, burn.authKey);
      const nu = nullifier(btcNoteLeaf(burn.asset || ZERO32, burn.cx, burn.cy, burn.authKey || ZERO32));
      spent.insert(nu); utxo.remove(burn.outpoint); burns.insert(nu, burn.destCommitment);
      height = h;
      return bw;
    }

    return {
      commit, digest, applyTransfer, applyBridgeOut,
      witnessTransfer, witnessBridgeOut,
      poolRoot, spentRoot: () => spent.root(), burnRoot: () => burns.root(), utxoRoot: () => utxo.root(),
      counts: () => ({ note: noteCount, spent: spentCount(), utxo: utxoCount(), burn: burnCount(), height }),
      _acc: { notes, spent, utxo, burns },
    };
  }

  function assembleReflectionInput(state, batch) {
    const c = state.counts();
    const prior = {
      poolRoot: state.poolRoot(), noteCount: c.note,
      spentRoot: state.spentRoot(), spentCount: c.spent,
      utxoRoot: state.utxoRoot(), utxoCount: c.utxo,
      burnRoot: state.burnRoot(), burnCount: c.burn,
      height: c.height,
    };
    const effects = [];
    for (const e of (batch.effects || [])) {
      const base = { blockIndex: e.blockIndex, txData: e.txData, txIndex: e.txIndex, txids: e.txids };
      if (e.type === 'bridge_out') {
        effects.push({ op: 1, ...base, burn: state.witnessBridgeOut(e.burn, e.height) });
      } else {
        const w = state.witnessTransfer(e.spends || [], e.outputs || [], e.height);
        effects.push({ op: 0, ...base, spends: w.spends, outputs: w.outputs.map((ow, i) => ({ ...ow, vout: e.outputs[i].vout })) });
      }
    }
    return { prior, anchorHeight: batch.anchorHeight | 0, headers: batch.headers || [], effects, newDigest: state.digest() };
  }

  const CBTC_ZK_ASSET_ID = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
  const CBTC_LOCK_DOMAIN = new TextEncoder().encode('tacit-cbtc-lock-v1');
  const CBTC_NOTE_OWNER = '0x' + '0'.repeat(64);
  const cbtcLockContext = (asset, lockTxid, lockVout) =>
    hx(keccak256(concat([CBTC_LOCK_DOMAIN, b32(asset), b32(lockTxid), u32le(lockVout)])));

  function makeScanReflectionState() {
    const notes = new Tree();
    const spent = makeImtAccumulator();
    const live = makeLiveUtxoSet();
    const burns = makeUtxoAccumulator();
    let height = 0;
    const cbtcLocks = makeLiveUtxoSet();
    let cbtcBackingSats = 0n;
    const pools = makePoolReserveSet();
    const farmRewards = makeFarmRewardSet();
    const farmEntries = makeFarmEntrySet();
    let consumedCount = 0n;
    let ethReflDigest = '0x' + '00'.repeat(32);
    const consumedCrossout = makeImtAccumulator();
    let foldedCrossoutCount = 0n;
    const honoredMsgs = makeImtAccumulator();
    const consumedOutpoints = makeImtAccumulator();
    let ethSyncCommittee = '0x' + '00'.repeat(32);
    const pendingDeposits = makeUtxoAccumulator();
    const pendingDepositRecords = new Map();

    const noteCount = () => notes.leaves.length;
    const spentCount = () => spent.links().length;
    const burnCount = () => burns.nodes().length;
    const commit = () => ({ poolRoot: notes.root(), spentRoot: spent.root(), burnRoot: burns.root(), height });
    // The 32-byte words the digest hashes, in order. The live set's root and size are words 4 and 5, so a reader holding the
    // live set and these words checks the set against the attested digest without rebuilding the rest of the state.
    function digestParts() {
      return [
        notes.root(), u64be(noteCount()),
        spent.root(), u64be(spentCount()),
        live.root(), u64be(live.len()),
        burns.root(), u64be(burnCount()),
        u64be(height),
        cbtcLocks.root(), u64be(cbtcBackingSats),
        pools.root(), u64be(pools.len()),
        u64be(consumedCount),
        ethReflDigest,
        farmRewards.root(), u64be(farmRewards.len()),
        farmEntries.root(), u64be(farmEntries.len()),
        consumedCrossout.root(), u64be(consumedCrossout.links().length),
        honoredMsgs.root(), u64be(honoredMsgs.links().length),
        u64be(foldedCrossoutCount),
        consumedOutpoints.root(), u64be(consumedOutpoints.links().length),
        ethSyncCommittee,
        pendingDeposits.root(), u64be(pendingDeposits.nodes().length),
      ].map((w) => hx(b32(w)));
    }
    function digest() { return hx(keccak(...digestParts())); }

    function foldSpent(nu) {
      if (spent.contains(nu)) {
        const m = spent.membershipWitness(nu);
        return { sLowValue: hx(b32(nu)), sLowNext: m.next, sLowIndex: m.index, sLowPath: m.path, sNewPath: m.path };
      }
      const spentLeaves = spent.links().map(([vv, nn]) => imtLeaf(vv, nn));
      const low = spent.nonMembershipWitness(nu);
      const interm = spentLeaves.slice(); interm[low.lowIndex] = imtLeaf(low.lowValue, nu);
      const w = { sLowValue: low.lowValue, sLowNext: low.lowNext, sLowIndex: low.lowIndex, sLowPath: low.path, sNewPath: merklePath(interm, spentLeaves.length) };
      spent.insert(nu);
      return w;
    }
    function foldOutput(noteLeaf, outpoint, commitmentHash, asset, authKey) {
      const w = { noteLeaf, notePath: notes.rootAndPath(noteCount()).path };
      notes.insert(noteLeaf);
      live.insert(outpoint, commitmentHash, asset, authKey || ZERO32);
      return w;
    }
    function foldOutputBound(noteLeaf, outpoint, commitmentHash, asset, authKey) {
      const w = { noteLeaf, notePath: notes.rootAndPath(noteCount()).path };
      notes.insert(noteLeaf);
      live.insert(outpoint, commitmentHash, asset, authKey || ZERO32, 1);
      return w;
    }
    function foldNoteAppend(noteLeaf) {
      const w = { noteLeaf, notePath: notes.rootAndPath(noteCount()).path };
      notes.insert(noteLeaf);
      return w;
    }
    function foldFarmInitRewards(farmId, rate, launcherPubkey, poolId, startHeight = 0n, endHeight = 0n, rewardTotal = 0n) {
      if (farmRewards.has(farmId)) return false;
      const r = BigInt(rate), s = BigInt(startHeight), e = BigInt(endHeight), rt = BigInt(rewardTotal);
      if (e === 0n) return false;
      if (e <= s) return false;
      const w = e - s;
      if (r > 0xffffffffn) return false;
      if (w > 0xffffffffn) return false;
      const rw = r * w;
      if (rw >= (1n << 63n)) return false;
      if (rw > rt) return false;
      farmRewards.set(farmId, {
        rate: BigInt(rate), totalShares: 0n, rps: 0n, totalRewardDebt: 0n, lastHeight: BigInt(height),
        launcherPubkey: launcherPubkey ? hx(hexToBytes(launcherPubkey)) : ('0x' + '00'.repeat(33)),
        lpAsset: hx(b32(ammDeriveLpAssetId(poolId))),
        startHeight: BigInt(startHeight), endHeight: BigInt(endHeight),
      });
      return true;
    }
    function foldLpBond(farmId, shares, owner, nonce, refundBlinding, refundDestXonly, refundOutpoint) {
      const st = farmRewards.get(farmId);
      if (!st) return null;
      if (BigInt(shares) === 0n) return null;
      farmRewards.accrue(st, height);
      const rpsEntry = st.rps;
      const lf = farmReceiptLeaf(farmId, st.lpAsset, shares, owner, nonce);
      const U64 = (1n << 64n) - 1n, U128 = (1n << 128n) - 1n;
      const bondDebt = BigInt(shares) * rpsEntry;
      const bondOverflows = bondDebt > U128
        || BigInt(st.totalShares) + BigInt(shares) > U64
        || BigInt(st.totalRewardDebt || 0n) + bondDebt > U128;
      if (bondOverflows || farmEntries.get(lf) !== null) {
        if (hx(b32(refundDestXonly)) === hx(ZERO32)) return null;
        const w = onboardLpRefund(st.lpAsset, shares, refundBlinding, refundDestXonly, refundOutpoint);
        return { refunded: true, receiptPath: w.notePath };
      }
      st.totalShares += BigInt(shares);
      st.totalRewardDebt = (st.totalRewardDebt || 0n) + bondDebt;
      const w = foldNoteAppend(lf);
      farmEntries.stamp(lf, rpsEntry);
      farmRewards.set(farmId, st);
      return { owner: hx(b32(owner)), nonce: hx(b32(nonce)), receiptPath: w.notePath, leaf: lf, rpsEntry: String(rpsEntry) };
    }
    function foldLpHarvest(farmId, shares, owner, nonce, reward, rewardR, destSpk, ownerSig) {
      const st = farmRewards.get(farmId);
      if (!st) return null;
      const leafH = farmReceiptLeaf(farmId, st.lpAsset, shares, owner, nonce);
      const rpsEntry = farmEntries.get(leafH);
      if (rpsEntry === null) return null;
      farmRewards.accrue(st, height);
      if (BigInt(shares) === 0n) return null;
      if (BigInt(rpsEntry) > st.rps) return null;
      { const U128 = (1n << 128n) - 1n, lhs = BigInt(reward) * FARM_RPS_PRECISION, rhs = BigInt(shares) * (st.rps - BigInt(rpsEntry)); if (lhs > U128 || rhs > U128 || lhs > rhs) return null;
        if (BigInt(st.totalRewardDebt || 0n) + rhs > U128) return null; }
      const oldLeaf = leafH;
      const hMsg = keccak256(concat([LP_HARVEST_OWNER_DOM, b32(farmId), b32(oldLeaf), beBytes(reward, 8), b32(rewardR), destSpk || new Uint8Array(0)]));
      if (!verifySchnorr(hexToBytes(String(ownerSig).replace(/^0x/, '')), hMsg, b32(owner))) return null;
      const oldIndex = notes.leaves.findIndex((l) => hx(l).toLowerCase() === oldLeaf.toLowerCase());
      if (oldIndex < 0) return null;
      const oldPath = notes.rootAndPath(oldIndex).path;
      st.totalRewardDebt = (st.totalRewardDebt || 0n) + BigInt(shares) * (st.rps - BigInt(rpsEntry));
      farmEntries.stamp(oldLeaf, st.rps);
      farmRewards.set(farmId, st);
      return { owner: hx(b32(owner)), nonce: hx(b32(nonce)),
        shares: String(shares), rpsEntry: String(rpsEntry), oldIndex, oldPath,
        leaf: oldLeaf, newEntry: String(st.rps) };
    }
    function foldFarmRefund(farmId, amount, r, viewHeight, launcherPubkey, launcherSig, destSpk, outpoint) {
      const st = farmRewards.get(farmId);
      if (!st) return null;
      const lpk = hexToBytes(String(launcherPubkey).replace(/^0x/, ''));
      if (lpk.length !== 33) return null;
      const stPk = hexToBytes(String(st.launcherPubkey || ('0x' + '00'.repeat(33))).replace(/^0x/, ''));
      if (hx(stPk).toLowerCase() !== hx(lpk).toLowerCase()) return null;
      const msg = keccak256(concat([FARM_REFUND_DOM, b32(farmId), beBytes(amount, 8), b32(r), beBytes(viewHeight, 4), destSpk || new Uint8Array(0)]));
      if (!verifySchnorr(hexToBytes(String(launcherSig).replace(/^0x/, '')), msg, lpk.slice(1))) return null;
      if (BigInt(st.totalShares || 0n) !== 0n) return null;
      return foldHarvest(farmId, amount, r, outpoint, destSpk);
    }
    function foldLpUnbond(farmId, shares, owner, nonce, lpReturnR, lpReturnOutpoint, destSpk, ownerSig) {
      const st = farmRewards.get(farmId);
      if (!st) return null;
      const lf = farmReceiptLeaf(farmId, st.lpAsset, shares, owner, nonce);
      const rpsEntry = farmEntries.get(lf);
      if (rpsEntry === null) return null;
      const uMsg = keccak256(concat([LP_UNBOND_OWNER_DOM, b32(farmId), b32(lf), beBytes(shares, 8), b32(lpReturnR), destSpk || new Uint8Array(0)]));
      if (!verifySchnorr(hexToBytes(String(ownerSig).replace(/^0x/, '')), uMsg, b32(owner))) return null;
      const oldIndex = notes.leaves.findIndex((l) => hx(l).toLowerCase() === lf.toLowerCase());
      if (oldIndex < 0) return null;
      const oldPath = notes.rootAndPath(oldIndex).path;
      const retiredDebt = BigInt(shares) * BigInt(rpsEntry);
      if (BigInt(shares) === 0n || BigInt(shares) > BigInt(st.totalShares)
        || retiredDebt > (1n << 128n) - 1n || retiredDebt > BigInt(st.totalRewardDebt || 0n)) return null;
      const retAuth = p2trXonly(destSpk);
      if (authZero(retAuth)) return null;
      if (spent.contains(farmReceiptNullifier(lf))) return null;
      const sw = foldSpent(farmReceiptNullifier(lf));
      const { cx, cy } = commitXY(BigInt(shares), mod(BigInt(lpReturnR), N));
      const rw = foldOutput(btcNoteLeaf(st.lpAsset, cx, cy, retAuth), lpReturnOutpoint, commitmentHash(cx, cy), st.lpAsset, retAuth);
      farmRewards.accrue(st, height);
      st.totalShares -= BigInt(shares);
      st.totalRewardDebt = (st.totalRewardDebt || 0n) - retiredDebt;
      farmEntries.remove(lf);
      farmRewards.set(farmId, st);
      return { oldIndex, oldPath, spentInsert: sw, lpReturnPath: rw.notePath, rpsEntry: String(rpsEntry) };
    }
    function foldBurn(burnId, destCommitment) {
      if (burns.contains(burnId)) {
        const m = burns.membershipWitness(burnId);
        return { bLowKey: hx(b32(burnId)), bLowNext: m.next, bLowValue: m.value, bLowIndex: m.index, bLowPath: m.path, bNewPath: m.path };
      }
      const burnLeaves = burns.leaves();
      const low = burns.low(burnId);
      const interm = burnLeaves.slice(); interm[low.index] = utxoLeaf(low.key, burnId, low.value);
      const w = { bLowKey: low.key, bLowNext: low.next, bLowValue: low.value, bLowIndex: low.index, bLowPath: merklePath(burnLeaves, low.index), bNewPath: merklePath(interm, burnLeaves.length) };
      burns.insert(burnId, destCommitment);
      return w;
    }
    function foldConsumed(nu, cx, cy, sourceTxid, sourceVout, chainBinding, spendRoot) {
      const key = outpointKey(sourceTxid, sourceVout);
      const hit = live.get(key);
      if (hit == null || hx(b32(hit[0])) !== commitmentHash(cx, cy)) return null;
      const bound = live.boundTag(key) === 1 ? 1 : 0;
      const srcLeaf = bound === 1
        ? btcNoteLeafBound(hit[1], cx, cy, hit[2], chainBinding || ZERO32)
        : btcNoteLeaf(hit[1], cx, cy, hit[2]);
      const computed = nullifier(srcLeaf);
      if (computed !== hx(b32(nu))) return null;
      const consumedVal = hx(keccak256(concat([b32(spendRoot || ZERO32), b32(srcLeaf)])));
      live.remove(key);
      const coLeaves = consumedOutpoints.links().map(([vv, nn]) => imtLeaf(vv, nn));
      const coLow = consumedOutpoints.nonMembershipWitness(key);
      const coInterm = coLeaves.slice(); coInterm[coLow.lowIndex] = imtLeaf(coLow.lowValue, key);
      const outpointInsert = { oLowValue: coLow.lowValue, oLowNext: coLow.lowNext, oLowIndex: coLow.lowIndex, oLowPath: coLow.path, oNewPath: merklePath(coInterm, coLeaves.length) };
      consumedOutpoints.insert(key);
      const w = foldSpent(computed);
      consumedCount += 1n;
      return { ...w, outpointInsert, bound, consumedVal };
    }
    function foldCrossout(asset, claimId, cx, cy, coSet, crossoutSetRoot, txid, vout, destAuthKey) {
      const ZW = '0x' + '00'.repeat(32);
      try { ptFromXY(cx, cy).assertValidity(); } catch { return null; }
      if (!destAuthKey || hx(b32(destAuthKey)) === hx(ZW)) return null;
      const destCommitment = btcNoteLeaf(asset, cx, cy, destAuthKey);
      const coLeaf = ethCrossoutLeaf(claimId, DEST_CHAIN_BITCOIN, destCommitment, asset);
      const bogusConsumedInsert = { sLowValue: ZW, sLowNext: ZW, sLowIndex: 0, sLowPath: Array(32).fill(ZW), sNewPath: Array(32).fill(ZW) };
      if (!coSet.contains(coLeaf)) {
        const w = coSet.nonMembershipWitness(coLeaf);
        return {
          isMember: 0, mNext: w.lowNext, mLowValue: w.lowValue, mIndex: w.lowIndex, mPath: w.path,
          notePath: notes.rootAndPath(noteCount()).path, consumedInsert: bogusConsumedInsert,
        };
      }
      const mw = coSet.membershipWitness(coLeaf);
      const presence = { isMember: 1, mNext: mw.next, mLowValue: ZW, mIndex: mw.index, mPath: mw.path };
      if (consumedCrossout.contains(claimId)) {
        const cmw = consumedCrossout.membershipWitness(claimId);
        return { ...presence, notePath: notes.rootAndPath(noteCount()).path, consumedInsert: { sLowValue: claimId, sLowNext: cmw.next, sLowIndex: cmw.index, sLowPath: cmw.path, sNewPath: cmw.path } };
      }
      const ccLeaves = consumedCrossout.links().map(([vv, nn]) => imtLeaf(vv, nn));
      const low = consumedCrossout.nonMembershipWitness(claimId);
      const interm = ccLeaves.slice(); interm[low.lowIndex] = imtLeaf(low.lowValue, claimId);
      const consumedInsert = { sLowValue: low.lowValue, sLowNext: low.lowNext, sLowIndex: low.lowIndex, sLowPath: low.path, sNewPath: merklePath(interm, ccLeaves.length) };
      consumedCrossout.insert(claimId);
      foldedCrossoutCount += 1n;
      const noteW = foldOutput(destCommitment, outpointKey(txid, vout), commitmentHash(cx, cy), asset, destAuthKey);
      return { ...presence, notePath: noteW.notePath, consumedInsert };
    }
    function foldEthMessage(msgId, record, msgSetLeaves, ethMsgSetRoot) {
      const ZW = '0x' + '00'.repeat(32);
      const bogusHonoredInsert = { sLowValue: ZW, sLowNext: ZW, sLowIndex: 0, sLowPath: Array(32).fill(ZW), sNewPath: Array(32).fill(ZW) };
      const leafHash = ethMessageLeaf(msgId, record);
      const idx = (msgSetLeaves || []).findIndex((l) => hx(b32(l)) === hx(b32(leafHash)));
      if (idx < 0 || !ethMsgSetRoot || hx(b32(ethMsgSetRoot)) === ZW) {
        return { setIndex: 0, setPath: Array(32).fill(ZW), honoredInsert: bogusHonoredInsert };
      }
      const setPath = merklePath(msgSetLeaves, idx);
      if (honoredMsgs.contains(msgId)) {
        const hmw = honoredMsgs.membershipWitness(msgId);
        return { setIndex: idx, setPath, honoredInsert: { sLowValue: msgId, sLowNext: hmw.next, sLowIndex: hmw.index, sLowPath: hmw.path, sNewPath: hmw.path } };
      }
      const hmLeaves = honoredMsgs.links().map(([vv, nn]) => imtLeaf(vv, nn));
      const low = honoredMsgs.nonMembershipWitness(msgId);
      const interm = hmLeaves.slice(); interm[low.lowIndex] = imtLeaf(low.lowValue, msgId);
      const honoredInsert = { sLowValue: low.lowValue, sLowNext: low.lowNext, sLowIndex: low.lowIndex, sLowPath: low.path, sNewPath: merklePath(interm, hmLeaves.length) };
      honoredMsgs.insert(msgId);
      return { setIndex: idx, setPath, honoredInsert };
    }
    function honoredMsgRoot() { return honoredMsgs.root(); }
    function honoredMsgCount() { return honoredMsgs.links().length; }
    function consumedCrossoutRoot() { return consumedCrossout.root(); }
    function consumedCrossoutCount() { return consumedCrossout.links().length; }
    function consumedOutpointsRoot() { return consumedOutpoints.root(); }
    function consumedOutpointsCount() { return consumedOutpoints.links().length; }
    function burnDepositCoWitness(outpointKeyHex) {
      if (consumedOutpoints.contains(outpointKeyHex)) {
        const m = consumedOutpoints.membershipWitness(outpointKeyHex);
        return { coIsMember: 1, coValue: hx(b32(outpointKeyHex)), coNext: m.next, coIndex: m.index, coPath: m.path };
      }
      const w = consumedOutpoints.nonMembershipWitness(outpointKeyHex);
      return { coIsMember: 0, coValue: w.lowValue, coNext: w.lowNext, coIndex: w.lowIndex, coPath: w.path };
    }
    function foldBurnDepositCore(burnedTxid, burnedVout, srcLeaf, dest, nu, target) {
      const spentInsert = foldSpent(nu);
      const burnId = bridgeBurnId(BURN_SOURCE_DEPOSIT, burnedTxid, burnedVout, srcLeaf, target);
      const burnFresh = !burns.contains(burnId);
      const notePath = burnFresh ? foldNoteAppend(srcLeaf).notePath : notes.rootAndPath(noteCount()).path;
      const burnInsert = foldBurn(burnId, dest);
      const co = burnDepositCoWitness(outpointKey(burnedTxid, burnedVout));
      return { spentInsert, notePath, burnInsert, ...co };
    }
    function getFoldedCrossoutCount() { return foldedCrossoutCount; }
    function setFoldedCrossoutCount(c) { foldedCrossoutCount = BigInt(c); }
    function rebase() { consumedCount = 0n; foldedCrossoutCount = 0n; ethReflDigest = hx(b32('0x' + '00'.repeat(32))); }
    function getEthSyncCommittee() { return ethSyncCommittee; }
    function setEthSyncCommittee(c) { ethSyncCommittee = hx(b32(c)); }
    function foldPendingDeposit({ burnedTxid, burnedVout, asset, nu, dest, target, ...info }) {
      const key = outpointKey(burnedTxid, burnedVout);
      const value = pendingDepositValue(asset, nu, dest, target);
      const lvs = pendingDeposits.leaves();
      const low = pendingDeposits.low(key);
      if (!low) throw new Error('pending burn-deposit already recorded for outpoint ' + hx(b32(key)));
      const interm = lvs.slice(); interm[low.index] = utxoLeaf(low.key, key, low.value);
      const w = { pLowKey: low.key, pLowNext: low.next, pLowValue: low.value, pLowIndex: low.index, pLowPath: merklePath(lvs, low.index), pNewPath: merklePath(interm, lvs.length) };
      pendingDeposits.insert(key, value);
      pendingDepositRecords.set(hx(b32(key)), {
        ...info, burnedTxid: hx(b32(burnedTxid)), burnedVout: burnedVout >>> 0,
        asset: hx(b32(asset)), nu: hx(b32(nu)), dest: hx(b32(dest)), target: hx(b32(target)), completed: false,
      });
      return w;
    }
    function pendingDepositWitness(burnedTxid, burnedVout) {
      const key = outpointKey(burnedTxid, burnedVout);
      return pendingDeposits.contains(key) ? pendingDeposits.membershipWitness(key) : null;
    }
    function setConsumedCount(c) { consumedCount = BigInt(c); }
    function getConsumedCount() { return consumedCount; }
    function setEthReflDigest(d) { ethReflDigest = hx(b32(d)); }
    function getEthReflDigest() { return ethReflDigest; }
    function setHeight(h) { if (h < height) throw new Error('reflection height must not decrease'); height = h; }

    function foldCbtcLock({ asset, cx, cy, vBtc, lockVout, lockTxid }) {
      if (vBtc == null) return null;
      if (hx(b32(asset)) !== CBTC_ZK_ASSET_ID) return null;
      if (BigInt(vBtc) === 0n) return null;
      if ((lockVout >>> 0) === 0) return null;
      try { ptFromXY(cx, cy).assertValidity(); } catch { return null; }
      const outpoint = outpointKey(lockTxid, lockVout);
      if (cbtcLocks.get(outpoint)) return null;
      cbtcLocks.insert(outpoint, u64be(BigInt(vBtc)), asset);
      { const n = cbtcBackingSats + BigInt(vBtc); cbtcBackingSats = n > 0xFFFFFFFFFFFFFFFFn ? 0xFFFFFFFFFFFFFFFFn : n; }
      return { outpoint: hx(b32(outpoint)), vBtc: BigInt(vBtc), commitment: commitmentHash(cx, cy) };
    }
    function foldCbtcLockSpends(vins) {
      let removed = 0n;
      const spent = [];
      for (const { prevTxid, vout } of (vins || [])) {
        const key = outpointKey(prevTxid, vout);
        const hit = cbtcLocks.get(key);
        if (hit) { const v = BigInt(hit[0]); cbtcBackingSats = cbtcBackingSats > v ? cbtcBackingSats - v : 0n; cbtcLocks.remove(key); removed += v; spent.push(hx(b32(key))); }
      }
      return { removed, spent };
    }
    function foldCbtcRedeem({ lockTxid, lockVout, vBtc, txVins, inOutpoints, inPoints, kernelSig }) {
      vBtc = BigInt(vBtc);
      if (vBtc === 0n) return null;
      const unlocked = (txVins || []).some(({ prevTxid, vout }) =>
        hx(b32(outpointKey(prevTxid, vout))) === hx(b32(outpointKey(lockTxid, lockVout))));
      if (!unlocked) return null;
      const key = outpointKey(lockTxid, lockVout);
      const hit = cbtcLocks.get(key);
      if (!hit) return null;
      if (BigInt(hit[0]) !== vBtc) return null;
      if (!cxferKernelVerify({ asset: CBTC_ZK_ASSET_ID, inputOutpoints: inOutpoints, inputPoints: inPoints, outsCompressed: [], kernelSig, burned: vBtc })) return null;
      cbtcBackingSats = cbtcBackingSats > vBtc ? cbtcBackingSats - vBtc : 0n;
      cbtcLocks.remove(key);
      return hx(b32(key));
    }

    function foldSwapVar(sv, inputOutpoint, inputAsset, receiptOutpoint, changeOutpoint, refundOutpoint, receiveSpk, changeSpk, refundSpk, tipOutpoint, tipSpk, height) {
      const receiptAuth = p2trXonly(receiveSpk), changeAuth = p2trXonly(changeSpk), refundAuth = p2trXonly(refundSpk);
      const onboardRefund = () => {
        const { cx, cy } = decompressCommitment(sv.cIn);
        const w = foldOutput(btcNoteLeaf(inputAsset, cx, cy, refundAuth), refundOutpoint, commitmentHash(cx, cy), inputAsset, refundAuth);
        return { notePath: w.notePath };
      };
      const isSentinel = /^(0x)?0+$/.test(String(sv.cChangeOrSentinel));
      const pool = pools.get(sv.poolId);
      if (!pool) return null;
      if (!receiveSpk || spkBytes(receiveSpk).length === 0) return null;
      if (!refundSpk || spkBytes(refundSpk).length === 0) return null;
      if (!isSentinel && (!changeSpk || spkBytes(changeSpk).length === 0)) return null;
      const intentMsg = swapVarIntentMsg({
        poolId: sv.poolId, direction: sv.direction, deltaIn: sv.deltaIn, deltaInMin: sv.deltaInMin || 0,
        deltaInMax: sv.deltaInMax || 0, minOut: sv.minOut || 0, tipAmount: sv.tipAmount || 0, tipAsset: sv.tipAsset || 0,
        expiryHeight: sv.expiryHeight || 0, traderPubkey: sv.traderPubkey, inputTxid: inputOutpoint[0], inputVout: inputOutpoint[1],
        receiveSpk, rReceipt: sv.rReceipt, cChangeOrSentinel: sv.cChangeOrSentinel,
        changeSpk: isSentinel ? new Uint8Array(0) : changeSpk, refundSpk,
      });
      if (!intentSigOk(sv.intentSig, intentMsg, sv.traderPubkey)) return null;
      if (authZero(receiptAuth)) return null;
      if (!isSentinel && authZero(changeAuth)) return null;
      if (authZero(refundAuth)) return null;
      if (BigInt(sv.expiryHeight || 0) === 0n || BigInt(sv.expiryHeight) < BigInt(height)) return onboardRefund();
      if (!pool.c0Backed) return null;
      const dir = sv.direction;
      if (dir !== 0 && dir !== 1) return null;
      const [assetIn, assetOut, rInPre, rOutPre] = dir === 0
        ? [pool.assetA, pool.assetB, BigInt(pool.reserveA), BigInt(pool.reserveB)]
        : [pool.assetB, pool.assetA, BigInt(pool.reserveB), BigInt(pool.reserveA)];
      if (hx(b32(inputAsset)) !== hx(b32(assetIn))) return null;
      const deltaInTotal = BigInt(sv.deltaIn) + BigInt(sv.tipAmount);
      if (deltaInTotal >= (1n << 64n)) return null;
      if (!swapVarKernelVerify(assetIn, inputOutpoint, sv.cIn, sv.cChangeOrSentinel, deltaInTotal, sv.kernelSig)) return null;
      if (!isSentinel) {
        const rp = hexToBytes(sv.rangeProof || '0x');
        let inRange;
        try {
          inRange = rp.length === bpClassicProofLen(1)
            ? bpRangeVerify([hexToBytes(sv.cChangeOrSentinel)], rp)
            : bppRangeVerify([bppPoint(hexToBytes(sv.cChangeOrSentinel))], rp);
        } catch { inRange = false; }
        if (!inRange) return null;
      }
      if (rInPre === 0n || rOutPre === 0n) return null;
      const deltaOut = getAmountOut(sv.deltaIn, rInPre, rOutPre, pool.feeBps || 0);
      if (deltaOut >= (1n << 64n)) return null;
      if (deltaOut === 0n || deltaOut < BigInt(sv.minOut || 0)) return onboardRefund();
      const rInPost = rInPre + BigInt(sv.deltaIn);
      if (rInPost >= (1n << 64n)) return null;
      const rOutPost = rOutPre - deltaOut;
      if (rInPost * rOutPost < rInPre * rOutPre) return null;
      const { cx, cy } = commitXY(deltaOut, mod(BigInt(sv.rReceipt), N));
      const w = foldOutput(btcNoteLeaf(assetOut, cx, cy, receiptAuth), receiptOutpoint, commitmentHash(cx, cy), assetOut, receiptAuth);
      let changePath;
      if (!isSentinel) {
        const ch = decompressCommitment(sv.cChangeOrSentinel);
        const cw = foldOutput(btcNoteLeaf(assetIn, ch.cx, ch.cy, changeAuth), changeOutpoint, commitmentHash(ch.cx, ch.cy), assetIn, changeAuth);
        changePath = cw.notePath;
      }
      let tipPath;
      if (BigInt(sv.tipAmount || 0) > 0n) {
        const tipAuth = p2trXonly(tipSpk) || ZERO_AUTH_HEX;
        const rTip = mod(BigInt(hx(keccak256(concat([SWAP_VAR_TIP_BLINDING_DOMAIN, b32(sv.rReceipt), beBytes(BigInt(sv.tipAmount), 8)])))), N);
        const { cx: tcx, cy: tcy } = commitXY(BigInt(sv.tipAmount), rTip);
        const tw = foldOutput(btcNoteLeaf(assetIn, tcx, tcy, tipAuth), tipOutpoint, commitmentHash(tcx, tcy), assetIn, tipAuth);
        tipPath = tw.notePath;
      }
      const upd = { ...pool };
      if (dir === 0) { upd.reserveA = rInPost; upd.reserveB = rOutPost; }
      else { upd.reserveB = rInPost; upd.reserveA = rOutPost; }
      pools.set(sv.poolId, upd);
      return { notePath: w.notePath, changePath, tipPath };
    }

    function foldSwapRoute(env, inputOutpoint, inputAsset, receiptOutpoint, refundOutpoint, receiveSpk, refundSpk, height) {
      const receiptAuth = p2trXonly(receiveSpk), refundAuth = p2trXonly(refundSpk);
      const onboardRefund = () => {
        const { cx, cy } = decompressCommitment(env.cIn);
        const w = foldOutput(btcNoteLeaf(inputAsset, cx, cy, refundAuth), refundOutpoint, commitmentHash(cx, cy), inputAsset, refundAuth);
        return { receiptPath: w.notePath };
      };
      if (!receiveSpk || spkBytes(receiveSpk).length === 0) return null;
      if (!refundSpk || spkBytes(refundSpk).length === 0) return null;
      if (!intentSigOk(env.intentSig, swapRouteIntentMsg(env, receiveSpk, refundSpk), env.traderPubkey)) return null;
      if (authZero(receiptAuth)) return null;
      if (authZero(refundAuth)) return null;
      if (hx(b32(inputAsset)) !== hx(b32(env.traderInputAsset))) return null;
      if (BigInt(env.expiryHeight || 0) === 0n || BigInt(env.expiryHeight) < BigInt(height)) return onboardRefund();
      const SENTINEL_HEX = '0x' + '00'.repeat(33);
      const staged = [];
      let curAsset = env.traderInputAsset, curAmount = 0n, clearedToNothing = false;
      for (let i = 0; i < env.hops.length; i++) {
        const hop = env.hops[i];
        if (staged.some(([pid]) => hx(b32(pid)) === hx(b32(hop.poolId)))) return null;
        const pool = pools.get(hop.poolId);
        if (!pool || !pool.c0Backed) return null;
        const dir = hop.direction;
        if (dir !== 0 && dir !== 1) return null;
        const [inAsset, outAsset, rIn, rOut] = dir === 0
          ? [pool.assetA, pool.assetB, BigInt(pool.reserveA), BigInt(pool.reserveB)]
          : [pool.assetB, pool.assetA, BigInt(pool.reserveB), BigInt(pool.reserveA)];
        if (hx(b32(inAsset)) !== hx(b32(curAsset))) return null;
        let inMag;
        if (i === 0) {
          inMag = dir === 0 ? BigInt(hop.deltaANetMag) : BigInt(hop.deltaBNetMag);
          if (inMag === 0n) return null;
          if (!swapVarKernelVerify(curAsset, inputOutpoint, env.cIn, SENTINEL_HEX, inMag, env.kernelSig)) return null;
        } else inMag = curAmount;
        if (rIn === 0n || rOut === 0n) return null;
        const outMag = getAmountOut(inMag, rIn, rOut, pool.feeBps || 0);
        if (outMag >= (1n << 64n)) return null;
        if (outMag === 0n) { clearedToNothing = true; break; }
        const rInPost = rIn + inMag, rOutPost = rOut - outMag;
        if (rInPost >= (1n << 64n)) return null;
        if (rInPost * rOutPost < rIn * rOut) return null;
        const upd = { ...pool };
        if (dir === 0) { upd.reserveA = rInPost; upd.reserveB = rOutPost; }
        else { upd.reserveB = rInPost; upd.reserveA = rOutPost; }
        staged.push([hop.poolId, upd]);
        curAsset = outAsset; curAmount = outMag;
      }
      if (clearedToNothing || curAmount < BigInt(env.minOut || 0)) return onboardRefund();
      if (hx(b32(curAsset)) !== hx(b32(env.traderOutputAsset))) return null;
      const { cx, cy } = commitXY(curAmount, mod(BigInt(env.rReceipt), N));
      const w = foldOutput(btcNoteLeaf(env.traderOutputAsset, cx, cy, receiptAuth), receiptOutpoint, commitmentHash(cx, cy), env.traderOutputAsset, receiptAuth);
      for (const [pid, pool] of staged) pools.set(pid, pool);
      return { receiptPath: w.notePath };
    }

    function foldHarvest(farmId, amount, rHex, outpoint, destSpk) {
      const farm = pools.get(farmId);
      if (!farm || !farm.c0Backed) return null;
      const amt = BigInt(amount);
      if (amt === 0n || amt > BigInt(farm.reserveA)) return null;
      const { cx, cy } = commitXY(amt, mod(BigInt(rHex), N));
      const auth = p2trXonly(destSpk);
      if (authZero(auth)) return null;
      const w = foldOutput(btcNoteLeaf(farm.assetA, cx, cy, auth), outpoint, commitmentHash(cx, cy), farm.assetA, auth);
      const upd = { ...farm }; upd.reserveA = BigInt(farm.reserveA) - amt;
      pools.set(farmId, upd);
      return { notePath: w.notePath };
    }

    function foldProtocolFeeClaim(poolId, claimer, feeBps, claimAmount, claimCSecp, claimBlinding, claimSig, destSpk, outpoint) {
      const pool = pools.get(poolId);
      if (!pool || !pool.c0Backed) return null;
      if (Number(pool.protocolFeeBps || 0) === 0) return null;
      const ck = hexToBytes(String(claimer).replace(/^0x/, ''));
      if (ck.length !== 33) return null;
      const derived = ammDerivePoolIdFull(pool.assetA, pool.assetB, Number(pool.feeBps || 0), Number(pool.capabilityFlags || 0), String(claimer).replace(/^0x/, ''), Number(pool.protocolFeeBps || 0));
      if (!derived || String(derived).toLowerCase() !== String(poolId).toLowerCase()) return null;
      const msg = keccak256(concat([PFEE_CLAIM_DOM, b32(poolId), beBytes(claimAmount, 8), hexToBytes(String(claimCSecp).replace(/^0x/, '')), b32(claimBlinding), destSpk || new Uint8Array(0)]));
      if (!verifySchnorr(hexToBytes(String(claimSig).replace(/^0x/, '')), msg, ck.slice(1))) return null;
      crystallizeProtocolFee(pool);
      const amt = BigInt(claimAmount);
      if (amt === 0n || amt !== BigInt(pool.protocolFeeAccrued)) return null;
      if (!verifyPedersenOpening(claimCSecp, amt, claimBlinding)) return null;
      const lpAsset = ammDeriveLpAssetId(poolId);
      const { cx, cy } = decompressCommitment(claimCSecp);
      const claimAuth = p2trXonly(destSpk);
      if (authZero(claimAuth)) return null;
      const w = foldOutput(btcNoteLeaf(lpAsset, cx, cy, claimAuth), outpoint, commitmentHash(cx, cy), lpAsset, claimAuth);
      pools.set(poolId, { ...pool, protocolFeeAccrued: 0n });
      return { notePath: w.notePath };
    }

    function foldFarmInit(farmId, rewardAsset, rewardTotal, inputOutpoint, cIn, cChangeOrSentinel, kernelSig, refundExpiry, refundBlinding, refundDestXonly, refundOutpoint) {
      const total = BigInt(rewardTotal);
      if (total === 0n) return null;
      if (!/^(0x)?0+$/.test(String(cChangeOrSentinel))) return null;
      if (!swapVarKernelVerify(rewardAsset, inputOutpoint, cIn, cChangeOrSentinel, total, kernelSig)) return null;
      const expired = Number(refundExpiry) === 0 || Number(refundExpiry) < Number(height);
      if (pools.get(farmId) || expired) {
        if (hx(b32(refundDestXonly)) === hx(ZERO32)) return null;
        const w = onboardLpRefund(rewardAsset, total, refundBlinding, refundDestXonly, refundOutpoint);
        return { registered: false, refundPath: w.notePath };
      }
      pools.set(farmId, { assetA: rewardAsset, assetB: '0x' + '00'.repeat(32), reserveA: total, reserveB: 0n, totalShares: 0n, c0Backed: true, feeBps: 0, protocolFeeBps: 0, kLast: 0n, protocolFeeAccrued: 0n, capabilityFlags: 0 });
      return { registered: true };
    }

    function foldLpRemove(lr, spendOutpoints, spendOpenings, spendAssets, recvAOutpoint, recvBOutpoint, recvAAuth, recvBAuth, refundOutpoint, refundAuth) {
      const peekPath = () => notes.rootAndPath(noteCount()).path;
      const [ca, cb] = ammCanonicalPair(lr.assetA, lr.assetB);
      if (!ca) return null;
      const swapped = hx(b32(lr.assetA)) !== ca;
      const [daC, dbC] = swapped ? [lr.deltaB, lr.deltaA] : [lr.deltaA, lr.deltaB];
      const [recvCa, recvCb] = swapped ? [lr.recvBSecp, lr.recvASecp] : [lr.recvASecp, lr.recvBSecp];
      const [rca, rcb] = swapped ? [lr.rRecvB, lr.rRecvA] : [lr.rRecvA, lr.rRecvB];
      const spendPts = spendOpenings.map((o) => secp.ProjectivePoint.fromAffine({ x: BigInt(o.cx), y: BigInt(o.cy) }));
      for (const pid of pools.poolIdsForAssets(ca, cb)) {
        const lpAsset = ammDeriveLpAssetId(pid);
        const lpIdx = spendAssets.map((a, i) => [a, i]).filter(([a]) => hx(b32(a)) === hx(b32(lpAsset))).map(([, i]) => i);
        const lpOutpoints = lpIdx.map((i) => spendOutpoints[i]);
        const lpPts = lpIdx.map((i) => spendPts[i]);
        if (!lpRemoveKernelVerify(pid, lr.shareAmount, daC, dbC, recvCa, recvCb, lpOutpoints, lpPts, refundAuth, lr.kernelSig)) continue;
        const pool = pools.get(pid);
        if (!pool || !pool.c0Backed) return null;
        if (hx(b32(refundAuth)) === hx(ZERO32)) return null;
        crystallizeProtocolFee(pool);
        const S = BigInt(pool.totalShares), sa = BigInt(lr.shareAmount);
        if (S === 0n || sa === 0n || sa > S) return null;
        if (S - sa < AMM_MINIMUM_LIQUIDITY) return null;
        const payA = (BigInt(pool.reserveA) * sa) / S, payB = (BigInt(pool.reserveB) * sa) / S;
        if (payA === 0n || payB === 0n) {
          const lpAsset = ammDeriveLpAssetId(pid);
          const wr = onboardLpRefund(lpAsset, lr.shareAmount, rca, refundAuth, refundOutpoint);
          return { recvAPath: peekPath(), recvBPath: peekPath(), refundPath: wr.notePath };
        }
        const A = commitXY(payA, mod(BigInt(rca), N)), B = commitXY(payB, mod(BigInt(rcb), N));
        const wa = foldOutput(btcNoteLeaf(pool.assetA, A.cx, A.cy, recvAAuth), recvAOutpoint, commitmentHash(A.cx, A.cy), pool.assetA, recvAAuth);
        const wb = foldOutput(btcNoteLeaf(pool.assetB, B.cx, B.cy, recvBAuth), recvBOutpoint, commitmentHash(B.cx, B.cy), pool.assetB, recvBAuth);
        const upd = { ...pool };
        upd.reserveA = BigInt(pool.reserveA) - payA;
        upd.reserveB = BigInt(pool.reserveB) - payB;
        upd.totalShares = S - sa;
        upd.kLast = upd.reserveA * upd.reserveB;
        pools.set(pid, upd);
        return { recvAPath: wa.notePath, recvBPath: wb.notePath, refundPath: peekPath() };
      }
      return null;
    }

    function foldLpAdd(la, spends, shareR, shareOutpoint, shareAuth, height, refundAXonly, refundBXonly, refundAOutpoint, refundBOutpoint) {
      const peekPath = () => notes.rootAndPath(noteCount()).path;
      const [ca, cb] = ammCanonicalPair(la.assetA, la.assetB);
      if (!ca) return null;
      const swapped = hx(b32(la.assetA)) !== ca;
      const [daC, dbC] = swapped ? [la.deltaB, la.deltaA] : [la.deltaA, la.deltaB];
      const [kaC, kbC] = swapped ? [la.kernelSigB, la.kernelSigA] : [la.kernelSigA, la.kernelSigB];
      const rxWireA = refundAXonly || ZERO32, rxWireB = refundBXonly || ZERO32;
      const [rxonlyAC, rxonlyBC] = swapped ? [rxWireB, rxWireA] : [rxWireA, rxWireB];
      const [rblindAC, rblindBC] = swapped ? [la.refundBBlinding, la.refundABlinding] : [la.refundABlinding, la.refundBBlinding];
      const [routAC, routBC] = swapped ? [refundBOutpoint, refundAOutpoint] : [refundAOutpoint, refundBOutpoint];
      const coll = (asset) => {
        const ops = [], pts = [];
        for (const s of spends) if (hx(b32(s.asset)) === asset) { ops.push(s.outpoint); pts.push(secp.ProjectivePoint.fromAffine({ x: BigInt(s.cx), y: BigInt(s.cy) })); }
        return [ops, pts];
      };
      const [aOps, aPts] = coll(ca), [bOps, bPts] = coll(cb);
      const pid = la.variant === 1
        ? ammDerivePoolIdFull(ca, cb, la.feeBps, la.capabilityFlags, la.protocolFeeAddress, la.protocolFeeBps)
        : (pools.poolIdsForAssets(ca, cb).find((p) =>
            lpAddKernelVerify(0, p, ca, daC, la.shareAmount, la.shareCsecp, aOps, aPts, kaC, la.expiryHeight, rxonlyAC, rblindAC)
            && lpAddKernelVerify(0, p, cb, dbC, la.shareAmount, la.shareCsecp, bOps, bPts, kbC, la.expiryHeight, rxonlyBC, rblindBC)) || null);
      if (!pid) return null;
      if (!lpAddKernelVerify(la.variant, pid, ca, daC, la.shareAmount, la.shareCsecp, aOps, aPts, kaC, la.expiryHeight, rxonlyAC, rblindAC)) return null;
      if (!lpAddKernelVerify(la.variant, pid, cb, dbC, la.shareAmount, la.shareCsecp, bOps, bPts, kbC, la.expiryHeight, rxonlyBC, rblindBC)) return null;
      let lpShares;
      if (la.variant === 1) {
        if (hx(b32(rxonlyAC)) === hx(ZERO32) || hx(b32(rxonlyBC)) === hx(ZERO32)) return null;
        const totalShares = (BigInt(daC) === 0n || BigInt(dbC) === 0n) ? 0n : isqrt(BigInt(daC) * BigInt(dbC));
        const founder = totalShares > AMM_MINIMUM_LIQUIDITY ? totalShares - AMM_MINIMUM_LIQUIDITY : 0n;
        const malformed = BigInt(daC) === 0n || BigInt(dbC) === 0n || totalShares > U64_MAX
          || totalShares <= AMM_MINIMUM_LIQUIDITY || BigInt(la.shareAmount) !== founder
          || Number(la.protocolFeeBps || 0) >= 10000 || Number(la.feeBps || 0) > Number(AMM_MAX_POOL_FEE_BPS);
        const expired = Number(la.expiryHeight) === 0 || Number(la.expiryHeight) < Number(height);
        if (pools.get(pid) || expired || malformed) {
          const wa = onboardLpRefund(ca, daC, rblindAC, rxonlyAC, routAC);
          const wb = onboardLpRefund(cb, dbC, rblindBC, rxonlyBC, routBC);
          return { path0: wa.notePath, path1: wb.notePath };
        }
        pools.set(pid, { assetA: ca, assetB: cb, reserveA: BigInt(daC), reserveB: BigInt(dbC), totalShares, c0Backed: true, feeBps: Number(la.feeBps || 0), protocolFeeBps: Number(la.protocolFeeBps || 0), kLast: BigInt(daC) * BigInt(dbC), protocolFeeAccrued: 0n, capabilityFlags: Number(la.capabilityFlags || 0) });
        lpShares = founder;
      } else if (la.variant === 0) {
        const pool = pools.get(pid);
        if (!pool) return null;
        if (hx(b32(pool.assetA)) !== ca || hx(b32(pool.assetB)) !== cb) return null;
        if (hx(b32(rxonlyAC)) === hx(ZERO32) || hx(b32(rxonlyBC)) === hx(ZERO32)) return null;
        const work = { ...pool };
        crystallizeProtocolFee(work);
        const minted = lpAddShares(work.totalShares, daC, dbC, work.reserveA, work.reserveB);
        if (minted > U64_MAX) return null;
        const expired = Number(la.expiryHeight) === 0 || Number(la.expiryHeight) < Number(height);
        if (expired || minted <= 0n || minted < BigInt(la.shareAmount)) {
          const wa = onboardLpRefund(ca, daC, rblindAC, rxonlyAC, routAC);
          const wb = onboardLpRefund(cb, dbC, rblindBC, rxonlyBC, routBC);
          return { path0: wa.notePath, path1: wb.notePath };
        }
        work.reserveA = BigInt(work.reserveA) + BigInt(daC);
        work.reserveB = BigInt(work.reserveB) + BigInt(dbC);
        work.totalShares = BigInt(work.totalShares) + minted;
        work.kLast = work.reserveA * work.reserveB;
        pools.set(pid, work);
        lpShares = minted;
      } else { return null; }
      const lpAsset = ammDeriveLpAssetId(pid);
      const { cx, cy } = commitXY(lpShares, mod(BigInt(shareR), N));
      const w = foldOutput(btcNoteLeaf(lpAsset, cx, cy, shareAuth), shareOutpoint, commitmentHash(cx, cy), lpAsset, shareAuth);
      return { path0: w.notePath, path1: peekPath() };
    }
    function onboardLpRefund(asset, value, blinding, auth, outpoint) {
      const { cx, cy } = commitXY(value, mod(BigInt(blinding), N));
      return foldOutput(btcNoteLeaf(asset, cx, cy, auth), outpoint, commitmentHash(cx, cy), asset, auth);
    }

    return {
      commit, digest, digestParts, foldSpent, foldOutput, foldOutputBound, foldNoteAppend, foldBurn, foldCbtcLock, foldCbtcLockSpends, foldCbtcRedeem, foldSwapVar, foldSwapRoute, foldHarvest, foldProtocolFeeClaim, foldFarmInit, foldLpRemove, foldLpAdd, foldConsumed, foldCrossout, setConsumedCount, getConsumedCount, setEthReflDigest, getEthReflDigest, setHeight, cbtcLocks, getCbtcBackingSats: () => cbtcBackingSats, setCbtcBackingSats: (n) => { cbtcBackingSats = BigInt(n); },
      foldFarmInitRewards, foldLpBond, foldLpHarvest, foldLpUnbond, foldFarmRefund, farmRewards, farmEntries,
      consumedCrossoutRoot, consumedCrossoutCount, getFoldedCrossoutCount, setFoldedCrossoutCount, rebase,
      foldEthMessage, honoredMsgRoot, honoredMsgCount, honoredMsgs,
      consumedCrossoutLinks: () => consumedCrossout.links(), setConsumedCrossoutLinks: (ls) => consumedCrossout.setLinks(ls),
      honoredMsgLinks: () => honoredMsgs.links(), setHonoredMsgLinks: (ls) => honoredMsgs.setLinks(ls),
      consumedOutpointsRoot, consumedOutpointsCount, burnDepositCoWitness,
      consumedOutpointsLinks: () => consumedOutpoints.links(), setConsumedOutpointsLinks: (ls) => consumedOutpoints.setLinks(ls),
      getEthSyncCommittee, setEthSyncCommittee,
      pendingDepositRoot: () => pendingDeposits.root(), pendingDepositCount: () => pendingDeposits.nodes().length,
      foldPendingDeposit, pendingDepositWitness,
      pendingDepositNodes: () => pendingDeposits.nodes(), setPendingDepositNodes: (ns) => pendingDeposits.setNodes(ns),
      pendingDepositRecords: () => [...pendingDepositRecords.entries()].map(([key, r]) => ({ key, ...r })),
      setPendingDepositRecords: (rs) => { pendingDepositRecords.clear(); for (const { key, ...r } of (rs || [])) pendingDepositRecords.set(hx(b32(key)), r); },
      markPendingDepositCompleted: (burnedTxid, burnedVout) => {
        const r = pendingDepositRecords.get(hx(b32(outpointKey(burnedTxid, burnedVout))));
        if (r) { r.completed = true; delete r.burnTxData; }
      },
      notePathPeek: () => notes.rootAndPath(noteCount()).path,
      spentContains: (nu) => spent.contains(nu),
      burnContains: (burnId) => burns.contains(burnId),
      burnDepositCoWitness, foldBurnDepositCore, bridgeBurnId,
      poolRoot: () => notes.root(), spentRoot: () => spent.root(), burnRoot: () => burns.root(), liveRoot: () => live.root(),
      cbtcBackingSats: () => cbtcBackingSats, cbtcLocks,
      counts: () => ({ note: noteCount(), spent: spentCount(), live: live.len(), burn: burnCount(), height }),
      live, pools, _acc: { notes, spent, live, burns },
    };
  }

  const CXFER_KERNEL_DOMAIN = new TextEncoder().encode('tacit-kernel-v1');
  const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
  const u64leBytes = (n) => { const b = new Uint8Array(8); const v = new DataView(b.buffer); v.setUint32(0, Number(BigInt(n) & 0xffffffffn), true); v.setUint32(4, Number((BigInt(n) >> 32n) & 0xffffffffn), true); return b; };
  const u16leBytes = (n) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, Number(n) & 0xffff, true); return b; };
  function cxferKernelMsg(asset, inputOutpoints, outsCompressed, burned = 0) {
    const parts = [CXFER_KERNEL_DOMAIN, b32(asset), Uint8Array.of(inputOutpoints.length & 0xff)];
    for (const [txid, vout] of inputOutpoints) { parts.push(b32(txid)); parts.push(u32le(vout)); }
    parts.push(Uint8Array.of(outsCompressed.length & 0xff));
    for (const c of outsCompressed) parts.push(hexToBytes(c));
    parts.push(u64leBytes(burned));
    return sha256(concat(parts));
  }
  const cxferOutPoints = (outsCompressed) => outsCompressed.map((c) => secp.ProjectivePoint.fromHex(c.replace(/^0x/, '')));
  function cxferKernelVerify({ asset, inputOutpoints, inputPoints, outsCompressed, kernelSig, burned = 0 }) {
    if (asset == null || kernelSig == null || !Array.isArray(outsCompressed) || outsCompressed.some((c) => c == null)) {
      throw new Error('cxfer kernel: missing asset/kernelSig/commitments');
    }
    if (inputOutpoints.length !== inputPoints.length) return false;
    if (inputOutpoints.length > 255 || outsCompressed.length > 255) return false;
    let outPoints; try { outPoints = cxferOutPoints(outsCompressed); } catch { return false; }
    const Z = secp.ProjectivePoint.ZERO;
    let P = inputPoints.reduce((a, p) => a.add(p), Z).add(outPoints.reduce((a, p) => a.add(p), Z).negate());
    if (BigInt(burned) !== 0n) P = P.add(prover.H.multiply(BigInt(burned)).negate());
    if (P.equals(Z)) return false;
    const px = P.toRawBytes(true).slice(1);
    let sig; try { sig = hexToBytes(kernelSig); } catch { return false; }
    if (sig.length !== 64) return false;
    return verifySchnorr(sig, cxferKernelMsg(asset, inputOutpoints, outsCompressed, burned), px);
  }
  function swapVarKernelVerify(asset, inputOutpoint, cInHex, cChangeHex, deltaInTotal, kernelSigHex) {
    const [txid, vout] = inputOutpoint;
    const msg = sha256(concat([CXFER_KERNEL_DOMAIN, b32(asset), Uint8Array.of(1), b32(txid), u32le(vout), Uint8Array.of(1), hexToBytes(cChangeHex), u64leBytes(deltaInTotal)]));
    let cInPt; try { cInPt = secp.ProjectivePoint.fromHex(cInHex.replace(/^0x/, '')); } catch { return false; }
    const isSentinel = /^(0x)?0*$/i.test(cChangeHex);
    const Z = secp.ProjectivePoint.ZERO;
    let cChangePt = Z;
    if (!isSentinel) { try { cChangePt = secp.ProjectivePoint.fromHex(cChangeHex.replace(/^0x/, '')); } catch { return false; } }
    let P = cInPt.add(cChangePt.negate());
    if (BigInt(deltaInTotal) !== 0n) P = P.add(prover.H.multiply(BigInt(deltaInTotal)).negate());
    if (P.equals(Z)) return false;
    const px = P.toRawBytes(true).slice(1);
    let sig; try { sig = hexToBytes(kernelSigHex); } catch { return false; }
    if (sig.length !== 64) return false;
    return verifySchnorr(sig, msg, px);
  }
  function verifyPedersenOpening(cHex, amount, rHex) {
    let C; try { C = secp.ProjectivePoint.fromHex(cHex.replace(/^0x/, '')); } catch { return false; }
    return C.equals(prover.commit(BigInt(amount), mod(BigInt(rHex), N)));
  }
  const U64_MAX = (1n << 64n) - 1n;
  function getAmountOut(amountIn, reserveIn, reserveOut, feeBps) {
    const gamma = 10000n - BigInt(feeBps);
    const ainG = BigInt(amountIn) * gamma;
    const num = BigInt(reserveOut) * ainG;
    const den = BigInt(reserveIn) * 10000n + ainG;
    return num / den;
  }
  const AMM_LP_ASSET_DOMAIN = new TextEncoder().encode('tacit-amm-lp-v1');
  const AMM_SWAP_VAR_DOM = new TextEncoder().encode('tacit-amm-swap-var-v1');
  const AMM_SWAP_ROUTE_DOM = new TextEncoder().encode('tacit-swap-route-v1');
  const spkBytes = (spk) => (!spk ? new Uint8Array(0) : (typeof spk === 'string' ? hexToBytes(spk.replace(/^0x/, '')) : spk));
  const lpSpk = (spk) => { const b = spkBytes(spk); return concat([u16leBytes(b.length), b]); };
  const hbytes = (h) => hexToBytes(String(h).replace(/^0x/, ''));
  function swapVarIntentMsg(a) {
    return sha256(concat([
      AMM_SWAP_VAR_DOM, b32(a.poolId), Uint8Array.of(a.direction & 0xff),
      u64leBytes(a.deltaIn), u64leBytes(a.deltaInMin), u64leBytes(a.deltaInMax),
      u64leBytes(a.minOut), u64leBytes(a.tipAmount), Uint8Array.of(a.tipAsset & 0xff), u32le(a.expiryHeight),
      hbytes(a.traderPubkey), b32(a.inputTxid), u32le(a.inputVout),
      lpSpk(a.receiveSpk), b32(a.rReceipt), hbytes(a.cChangeOrSentinel),
      lpSpk(a.changeSpk), lpSpk(a.refundSpk),
    ]));
  }
  function swapRouteIntentMsg(env, receiveSpk, refundSpk) {
    const hop0 = env.hops[0];
    const routeDeltaIn = hop0.direction === 0 ? BigInt(hop0.deltaANetMag) : BigInt(hop0.deltaBNetMag);
    const hopParts = [];
    for (const h of env.hops) { hopParts.push(b32(h.poolId)); hopParts.push(Uint8Array.of(h.direction & 0xff)); }
    return sha256(concat([
      AMM_SWAP_ROUTE_DOM, hbytes(env.traderPubkey), b32(env.traderInputAsset), b32(env.traderOutputAsset),
      u64leBytes(routeDeltaIn), u64leBytes(env.minOut || 0), u32le(env.expiryHeight || 0), Uint8Array.of(env.hops.length & 0xff),
      ...hopParts, hbytes(env.cIn), b32(env.rReceipt), lpSpk(receiveSpk), lpSpk(refundSpk),
    ]));
  }
  const intentSigOk = (sigHex, msg32, traderPubkeyHex) => {
    const pk = hbytes(traderPubkeyHex); if (pk.length !== 33) return false;
    try { return verifySchnorr(hbytes(sigHex), msg32, pk.slice(1, 33)); } catch { return false; }
  };
  const isqrt = (nIn) => { let n = BigInt(nIn); if (n < 2n) return n < 0n ? 0n : n; let x = n, y = (x + 1n) >> 1n; while (y < x) { x = y; y = (x + n / x) >> 1n; } return x; };
  function protocolFeeShares(sPre, kPre, kNow, feeBps) {
    const S = BigInt(sPre), kp = BigInt(kPre), kn = BigInt(kNow), bps = BigInt(feeBps);
    if (bps === 0n || S === 0n || kn <= kp) return 0n;
    const rootPre = isqrt(kp), rootNow = isqrt(kn);
    if (rootNow <= rootPre) return 0n;
    const den = (10000n - bps) * rootNow + bps * rootPre;
    if (den === 0n) return 0n;
    const r = (S * bps * (rootNow - rootPre)) / den;
    return r > U64_MAX ? U64_MAX : r;
  }
  const satU64 = (x) => (x > U64_MAX ? U64_MAX : x);
  function crystallizeProtocolFee(pool) {
    if (Number(pool.protocolFeeBps || 0) === 0) return;
    const kNow = BigInt(pool.reserveA) * BigInt(pool.reserveB);
    if (kNow <= BigInt(pool.kLast || 0)) { pool.kLast = kNow; return; }
    const shares = protocolFeeShares(pool.totalShares, pool.kLast, kNow, pool.protocolFeeBps);
    const _acc = BigInt(pool.protocolFeeAccrued || 0) + shares, _ts = BigInt(pool.totalShares || 0) + shares;
    if (_acc > 0xFFFFFFFFFFFFFFFFn || _ts > 0xFFFFFFFFFFFFFFFFn) throw new Error('crystallize: protocol-fee/totalShares overflow (mirror guest checked_add)');
    pool.protocolFeeAccrued = _acc;
    pool.totalShares = _ts;
    pool.kLast = kNow;
  }
  const ammDeriveLpAssetId = (poolId) => hx(sha256(concat([AMM_LP_ASSET_DOMAIN, b32(poolId)])));
  const AMM_FARM_INIT_DOMAIN = new TextEncoder().encode('tacit-amm-farm-init-v1');
  const ammDeriveFarmId = (poolId, launcherPubkey, rewardAsset, farmNonce) =>
    hx(sha256(concat([AMM_FARM_INIT_DOMAIN, b32(poolId), hexToBytes(launcherPubkey), b32(rewardAsset), b32(farmNonce)])));
  function ammCanonicalPair(a, b) {
    const ha = hx(b32(a)), hb2 = hx(b32(b));
    if (ha === hb2) return [null, null];
    return BigInt(ha) < BigInt(hb2) ? [ha, hb2] : [hb2, ha];
  }
  function assetScopedKernelVerify(msg, inPts, outPts, net, sigHex) {
    const Z = secp.ProjectivePoint.ZERO;
    let P = inPts.reduce((a, p) => a.add(p), Z).add(outPts.reduce((a, p) => a.add(p), Z).negate());
    if (BigInt(net) !== 0n) P = P.add(prover.H.multiply(BigInt(net)).negate());
    if (P.equals(Z)) return false;
    let sig; try { sig = hexToBytes(sigHex); } catch { return false; }
    if (sig.length !== 64) return false;
    return verifySchnorr(sig, msg, P.toRawBytes(true).slice(1));
  }
  const LP_REMOVE_KERNEL_DOMAIN = new TextEncoder().encode('tacit-amm-lp-remove-v1');
  function lpRemoveKernelVerify(poolId, shareAmount, deltaA, deltaB, recvASecp, recvBSecp, lpOutpoints, lpPts, refundDestXonly, sigHex) {
    if (lpOutpoints.length === 0 || lpOutpoints.length > 255 || lpOutpoints.length !== lpPts.length) return false;
    const parts = [LP_REMOVE_KERNEL_DOMAIN, b32(poolId), u64leBytes(shareAmount), u64leBytes(deltaA), u64leBytes(deltaB), hexToBytes(recvASecp), hexToBytes(recvBSecp), Uint8Array.of(lpOutpoints.length & 0xff)];
    for (const [txid, vout] of lpOutpoints) { parts.push(b32(txid)); parts.push(u32le(vout)); }
    parts.push(b32(refundDestXonly));
    return assetScopedKernelVerify(sha256(concat(parts)), lpPts, [], shareAmount, sigHex);
  }
  const LP_BOND_KERNEL_DOMAIN = new TextEncoder().encode('tacit-amm-lp-bond-v1');
  function lpBondKernelVerify(farmId, lpAsset, bondAmount, lpOutpoints, lpPts, sigHex) {
    if (lpOutpoints.length === 0 || lpOutpoints.length > 255 || lpOutpoints.length !== lpPts.length) return false;
    const parts = [LP_BOND_KERNEL_DOMAIN, b32(farmId), b32(lpAsset), u64leBytes(bondAmount), Uint8Array.of(lpOutpoints.length & 0xff)];
    for (const [txid, vout] of lpOutpoints) { parts.push(b32(txid)); parts.push(u32le(vout)); }
    return assetScopedKernelVerify(sha256(concat(parts)), lpPts, [], bondAmount, sigHex);
  }
  function ammFundingHash(outpoints, kernelSigHex) {
    const parts = [];
    for (const [txid, vout] of outpoints) { parts.push(b32(txid)); parts.push(u32le(vout)); }
    parts.push(sha256(hexToBytes(String(kernelSigHex).replace(/^0x/, ''))));
    return sha256(concat(parts));
  }
  const LP_ADD_KERNEL_DOMAIN = new TextEncoder().encode('tacit-amm-lp-add-v1');
  function lpAddKernelVerify(variant, poolId, assetX, deltaX, shareAmount, shareCsecp, inOutpoints, inPts, sigHex, expiryHeight = 0, refundXonly = null, refundBlinding = null) {
    if (inOutpoints.length === 0 || inOutpoints.length > 255 || inOutpoints.length !== inPts.length) return false;
    const parts = [LP_ADD_KERNEL_DOMAIN, Uint8Array.of(variant & 0xff), b32(poolId), b32(assetX), u64leBytes(deltaX), u64leBytes(shareAmount), hexToBytes(shareCsecp), Uint8Array.of(inOutpoints.length & 0xff)];
    for (const [txid, vout] of inOutpoints) { parts.push(b32(txid)); parts.push(u32le(vout)); }
    parts.push(u32le(expiryHeight)); parts.push(b32(refundXonly)); parts.push(b32(refundBlinding));
    return assetScopedKernelVerify(sha256(concat(parts)), inPts, [], deltaX, sigHex);
  }
  const AMM_POOL_ID_DOMAIN = new TextEncoder().encode('tacit-amm-pool-v1');
  function ammDerivePoolIdFull(assetA, assetB, feeBps, capabilityFlags, protocolFeeAddress, protocolFeeBps) {
    const [low, high] = ammCanonicalPair(assetA, assetB);
    if (!low) return null;
    const parts = [AMM_POOL_ID_DOMAIN, b32(low), b32(high), u16leBytes(feeBps), Uint8Array.of(Number(capabilityFlags) & 0xff)];
    if (Number(protocolFeeBps) !== 0) { parts.push(hexToBytes(protocolFeeAddress)); parts.push(u16leBytes(protocolFeeBps)); }
    return hx(sha256(concat(parts)));
  }
  function poolIdWithProtocolFee(assetA, assetB, feeBps, recipientHex, pfBps) {
    const [low, high] = ammCanonicalPair(assetA, assetB);
    if (!low) return null;
    const fee = beBytes(BigInt(feeBps), 32);
    if (Number(pfBps) === 0) return hx(keccak256(concat([b32(low), b32(high), fee])));
    const pf = beBytes(BigInt(pfBps), 32);
    const rec = hexToBytes(String(recipientHex).replace(/^0x/, ''));
    return hx(keccak256(concat([b32(low), b32(high), fee, rec, pf])));
  }
  const AMM_MINIMUM_LIQUIDITY = 1000n;
  const AMM_MAX_POOL_FEE_BPS = 1000n;
  function lpAddShares(sharesPre, dA, dB, reserveA, reserveB) {
    const sp = BigInt(sharesPre);
    const a = (sp * BigInt(dA)) / BigInt(reserveA), b = (sp * BigInt(dB)) / BigInt(reserveB);
    return a < b ? a : b;
  }
  function swapBatchAggregateIdentity(intents, receiptsCOut, assetXIsA, deltaXSign, deltaXMag, tipXCSecp, rNetX) {
    if (intents.length !== receiptsCOut.length) return false;
    const Z = secp.ProjectivePoint.ZERO;
    const pt = (h) => secp.ProjectivePoint.fromHex(String(h).replace(/^0x/, ''));
    let sum = Z;
    try {
      for (let i = 0; i < intents.length; i++) {
        const dir = intents[i].direction;
        const isInput = (assetXIsA && dir === 0) || (!assetXIsA && dir === 1);
        const isOutput = (assetXIsA && dir === 1) || (!assetXIsA && dir === 0);
        if (isInput) sum = sum.add(pt(intents[i].cInSecp));
        else if (isOutput) sum = sum.add(pt(receiptsCOut[i]).negate());
      }
      sum = sum.add(pt(tipXCSecp).negate());
    } catch { return false; }
    if (BigInt(deltaXMag) !== 0n) {
      const dh = prover.H.multiply(BigInt(deltaXMag));
      sum = deltaXSign === 0 ? sum.add(dh.negate()) : sum.add(dh);
    }
    const k = mod(BigInt(rNetX), N);
    return sum.equals(k === 0n ? Z : secp.ProjectivePoint.BASE.multiply(k));
  }
  // With a `rangeSink` ({ classic: [], plus: [] }) the range proof is not checked here but set down in it, for the caller to check
  // with every other proof it has gathered at once (bpRangeVerifyBatch, bppRangeVerifyBatch); what is checked here is the kernel.
  function verifyCxferConservation({ asset, inputOutpoints, inputPoints, outsCompressed, rangeProof, kernelSig, burned = 0, rangeSink = null }) {
    if (rangeProof == null) throw new Error('cxfer conservation: missing rangeProof');
    if (!cxferKernelVerify({ asset, inputOutpoints, inputPoints, outsCompressed, kernelSig, burned })) return false;
    let rp; try { rp = hexToBytes(rangeProof); } catch { return false; }
    if (rp.length === bpClassicProofLen(outsCompressed.length)) {
      if (rangeSink) { rangeSink.classic.push({ commitments: outsCompressed, proof: rp }); return true; }
      return bpRangeVerify(outsCompressed, rp);
    }
    let rangePts; try { rangePts = outsCompressed.map((c) => bppPoint(hexToBytes(c))); } catch { return false; }
    if (rangeSink) { rangeSink.plus.push({ commitments: rangePts, proof: rp }); return true; }
    return bppRangeVerify(rangePts, rp);
  }

  const BD_ZERO_HEX = '0x' + '00'.repeat(32);
  const BD_ZERO_PATH = Array(TREE_DEPTH).fill(BD_ZERO_HEX);
  const BD_ZERO_SPENT = { sLowValue: BD_ZERO_HEX, sLowNext: BD_ZERO_HEX, sLowIndex: 0, sLowPath: BD_ZERO_PATH, sNewPath: BD_ZERO_PATH };
  const BD_ZERO_BURN = { bLowKey: BD_ZERO_HEX, bLowNext: BD_ZERO_HEX, bLowValue: BD_ZERO_HEX, bLowIndex: 0, bLowPath: BD_ZERO_PATH, bNewPath: BD_ZERO_PATH };
  const BD_ZERO_WITNESS = {
    burnWtxidSiblings: [], burnCbTxidSiblings: [],
    etchTx: '0x', etchIndex: 0, etchSiblings: [],
    etchWtxidSiblings: [], etchCoinbase: '0x', etchCoinbaseTxidSiblings: [],
    provHeaders: [], cxfers: [], cmints: [], poolMemberships: [],
    blob: '0x',
  };
  const BD_SKIP_CTX = { valid: false, nu: BD_ZERO_HEX, dest: BD_ZERO_HEX, target: BD_ZERO_HEX, burnedTxid: BD_ZERO_HEX, burnedVout: 0, burnedCx: BD_ZERO_HEX, burnedCy: BD_ZERO_HEX, burnedNoteLeaf: BD_ZERO_HEX, witness: BD_ZERO_WITNESS };

  function foldBurnDepositTx(state, ctx, pending = null) {
    const base = { ...ctx.witness, burnedCx: ctx.burnedCx, burnedCy: ctx.burnedCy };
    const consumed = state.burnDepositCoWitness(outpointKey(ctx.burnedTxid, ctx.burnedVout)).coIsMember === 1;
    if (!ctx.valid && pending) {
      const co = state.burnDepositCoWitness(outpointKey(ctx.burnedTxid, ctx.burnedVout));
      const pendingInsert = state.foldPendingDeposit(pending);
      return { ...base, spentInsert: BD_ZERO_SPENT, notePath: BD_ZERO_PATH, burnInsert: BD_ZERO_BURN, ...co, pendingInsert, outcome: 'pending' };
    }
    if (!ctx.valid || consumed) {
      const co = state.burnDepositCoWitness(outpointKey(ctx.burnedTxid, ctx.burnedVout));
      return { ...base, spentInsert: BD_ZERO_SPENT, notePath: BD_ZERO_PATH, burnInsert: BD_ZERO_BURN, ...co, outcome: ctx.valid ? 'consumed' : 'skipped' };
    }
    return { ...base, ...state.foldBurnDepositCore(ctx.burnedTxid, ctx.burnedVout, ctx.burnedNoteLeaf, ctx.dest, ctx.nu, ctx.target), outcome: 'folded' };
  }
  function burnDepositPendingRecord(tx, height) {
    const vin0 = (tx.vins || [])[0];
    if (!vin0) return null;
    const z = (v) => (v ? hx(b32(v)) : hx(ZERO32));
    return {
      burnedTxid: vin0.prevTxid, burnedVout: vin0.vout >>> 0,
      asset: z(tx.env.assetId), nu: z(tx.env.nullifier), dest: z(tx.env.dest), target: z(tx.env.target),
      burnTxid: tx.txid, burnTxidDisplay: tx.txidDisplay || null, burnTxData: tx.txData, height,
    };
  }

  async function assembleReflectionScanInput(state, batch, coords, acknowledgedInvalidBurnsList) {
    const norm = (x) => hx(b32(x));
    const acknowledgedInvalidBurns = new Set((acknowledgedInvalidBurnsList || []).map((t) => norm(t)));
    const chainBinding = batch.chainBinding ? norm(batch.chainBinding) : hx(ZERO32);
    const c = state.counts();
    const prior = {
      poolRoot: state.poolRoot(), noteCount: c.note,
      spentRoot: state.spentRoot(), spentCount: c.spent,
      live: state.live.triples(), liveCount: c.live,
      burnRoot: state.burnRoot(), burnCount: c.burn,
      height: c.height,
      cbtcLocks: state.cbtcLocks.triples(),
      cbtcBackingSats: String(state.cbtcBackingSats()),
      pools: state.pools.list(),
      consumedCount: Number(state.getConsumedCount()),
      ethReflDigest: state.getEthReflDigest(),
      farmRewards: state.farmRewards.list(),
      farmEntries: state.farmEntries.list(),
      consumedCrossoutRoot: state.consumedCrossoutRoot(),
      consumedCrossoutCount: state.consumedCrossoutCount(),
      honoredMsgRoot: state.honoredMsgRoot(),
      honoredMsgCount: state.honoredMsgCount(),
      foldedCrossoutCount: Number(state.getFoldedCrossoutCount()),
      consumedOutpointsRoot: state.consumedOutpointsRoot(),
      consumedOutpointsCount: state.consumedOutpointsCount(),
      ethSyncCommittee: state.getEthSyncCommittee(),
      pendingDepositRoot: state.pendingDepositRoot(),
      pendingDepositCount: state.pendingDepositCount(),
    };
    let rebaseOut = null;
    if (batch.rebase) {
      const predDigest = state.digest();
      const ocConsumed = batch.rebase.predecessorConsumedCount != null
        ? BigInt(batch.rebase.predecessorConsumedCount) : state.getConsumedCount();
      const ocCrossOut = batch.rebase.predecessorCrossOutCount != null
        ? BigInt(batch.rebase.predecessorCrossOutCount) : state.getFoldedCrossoutCount();
      if (!batch.rebase.expectGuestReject) {
        if (ocConsumed !== state.getConsumedCount()) {
          throw new Error(`rebase: predecessor not drained (on-chain consumes ${ocConsumed} != folded ${state.getConsumedCount()})`);
        }
        if (state.getFoldedCrossoutCount() > ocCrossOut) {
          throw new Error(`rebase: predecessor inconsistent (folded cross-out mints ${state.getFoldedCrossoutCount()} > recorded ${ocCrossOut})`);
        }
      }
      state.rebase();
      rebaseOut = {
        rebaseMode: 1,
        predecessorDigest: predDigest,
        predecessorConsumedCount: Number(ocConsumed),
        predecessorCrossOutCount: Number(ocCrossOut),
        rebasedFromDigest: generationalRebaseAnchor(predDigest, ocConsumed, ocCrossOut),
        reflectionResumeDigest: state.digest(),
      };
    }
    const modeBIn = batch.modeB || null;
    const consumedOut = [];
    let ethPvHex = null;
    if (modeBIn) {
      for (const cons of (modeBIn.consumed || [])) {
        const srcKey = outpointKey(cons.srcTxid, cons.srcVout);
        const srcHit = state.live.get(srcKey);
        const srcBound = state.live.boundTag(srcKey) === 1 ? 1 : 0;
        const nu = srcHit
          ? nullifier(srcBound === 1 ? btcNoteLeafBound(srcHit[1], cons.cx, cons.cy, srcHit[2], chainBinding) : btcNoteLeaf(srcHit[1], cons.cx, cons.cy, srcHit[2]))
          : hx(ZERO32);
        const w = state.foldConsumed(nu, cons.cx, cons.cy, cons.srcTxid, cons.srcVout, chainBinding, cons.spendRoot);
        if (!w) throw new Error('mode-b consumed-ν fold failed (source not a live note bound to Cx,Cy): ' + norm(nu));
        coords.delete(norm(srcKey));
        consumedOut.push({
          nu: norm(nu), consumedVal: norm(w.consumedVal), spendRoot: norm(cons.spendRoot), cx: norm(cons.cx), cy: norm(cons.cy),
          srcTxid: norm(cons.srcTxid), srcVout: cons.srcVout | 0, setPath: cons.setPath.map(norm),
          spentInsert: w, outpointInsert: w.outpointInsert, bound: w.bound,
        });
      }
      const expectedCommittee = state.getEthSyncCommittee() === hx(ZERO32) ? ETH_GENESIS_SYNC_COMMITTEE : state.getEthSyncCommittee();
      ethPvHex = modeBIn.ethPv
        ? (modeBIn.ethPv.startsWith('0x') ? modeBIn.ethPv.toLowerCase() : '0x' + modeBIn.ethPv.toLowerCase())
        : buildEthPv(modeBIn.crossoutSetRoot, modeBIn.consumedSetRoot, state.getConsumedCount(), 0, null, EMPTY_ETH_SET_ROOT, 0, null, null, expectedCommittee);
      const pvWord = (i) => '0x' + ethPvHex.slice(2 + i * 64, 2 + (i + 1) * 64);
      if (ethPvHex.length !== 2 + 14 * 64) throw new Error('mode-b: eth-reflection public values must be 14 words');
      if (pvWord(8) !== expectedCommittee.toLowerCase()) {
        throw new Error(`mode-b: eth proof starts from sync committee ${pvWord(8)}, the reflection is anchored at ${expectedCommittee}`);
      }
      if (pvWord(7) === hx(ZERO32)) throw new Error('mode-b: eth proof ends on a zero sync-committee root');
      state.setEthSyncCommittee(pvWord(7));
      state.setEthReflDigest('0x' + ethPvHex.slice(2 + 64, 2 + 128));
    }
    const blocksOut = [];
    const nonConserving = [];
    const unreflectedValueEntry = [];
    const unsupportedEnvelopes = [];
    const unresolvedBurnDeposits = [];
    const unresolvedBurn = (tx, blockIndex) => {
      const target = tx.env && tx.env.target ? norm(tx.env.target) : hx(ZERO32);
      return {
        txid: tx.txid,
        height: (batch.anchorHeight | 0) + blockIndex,
        target,
        targetsThisDeployment: chainBinding !== hx(ZERO32) && target === chainBinding,
      };
    };
    const blockCount = batch.blockCount != null ? batch.blockCount : ((batch.blocks && batch.blocks.length) || 0);
    for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
      const block = batch.getBlock ? await batch.getBlock(blockIndex) : batch.blocks[blockIndex];
      state.setHeight((batch.anchorHeight | 0) + blockIndex);
      const txsOut = [];
      for (const tx of block.txs) {
        const openings = [];
        const inOutpoints = [];
        const inAssets = [];
        const inAuthKeys = [];
        const inBounds = [];
        const spentInserts = [];
        for (const { prevTxid, vout } of (tx.vins || [])) {
          const key = outpointKey(prevTxid, vout);
          const hit = state.live.get(key);
          if (hit == null) continue;
          const co = coords.get(norm(key));
          if (!co) throw new Error('live spend has no known coords: ' + norm(key));
          const bound = state.live.boundTag(key) === 1 ? 1 : 0;
          openings.push({ cx: norm(co.cx), cy: norm(co.cy) });
          inOutpoints.push([prevTxid, vout]);
          inAssets.push(norm(hit[1]));
          inAuthKeys.push(norm(hit[2]));
          inBounds.push(bound);
          const spentLeaf = bound === 1 ? btcNoteLeafBound(hit[1], co.cx, co.cy, hit[2], chainBinding) : btcNoteLeaf(hit[1], co.cx, co.cy, hit[2]);
          spentInserts.push(state.foldSpent(nullifier(spentLeaf)));
          state.live.remove(key);
          coords.delete(norm(key));
        }
        if (tx.env && tx.env.type === 'cbtc_redeem') {
          const ci = [];
          for (let i = 0; i < inAssets.length; i++) if (inAssets[i] === CBTC_ZK_ASSET_ID) ci.push(i);
          let inPts = null;
          try { inPts = ci.map((i) => ptFromXY(openings[i].cx, openings[i].cy)); } catch { inPts = null; }
          if (inPts) state.foldCbtcRedeem({
            lockTxid: tx.env.lockTxid, lockVout: tx.env.lockVout, vBtc: tx.env.vBtc,
            txVins: tx.vins || [], inOutpoints: ci.map((i) => inOutpoints[i]), inPoints: inPts, kernelSig: tx.env.kernelSig,
          });
        }
        state.foldCbtcLockSpends(tx.vins || []);
        let burnInsert = null;
        let burnDeposit = null;
        let cbtcLock = null;
        let swapVar = null;
        let swapRoute = null;
        let harvest = null;
        let protocolFee = null;
        let lpRemove = null;
        let lpAdd = null;
        let swapBatch = null;
        let crossoutMint = null;
        let ethCall = null;
        let lpBond = null;
        let lpUnbond = null;
        let farmRefund = null;
        let farmInit = null;
        if (tx.env && tx.env.type === 'burn') {
          if (openings.length === 1) {
            const srcLeaf = inBounds[0] === 1
              ? btcNoteLeafBound(inAssets[0], openings[0].cx, openings[0].cy, inAuthKeys[0], chainBinding)
              : btcNoteLeaf(inAssets[0], openings[0].cx, openings[0].cy, inAuthKeys[0]);
            const liveNu = nullifier(srcLeaf);
            if (tx.env.nullifier && norm(tx.env.nullifier) === norm(liveNu) && tx.env.assetId && norm(tx.env.assetId) === norm(inAssets[0])) {
              const burnId = bridgeBurnId(BURN_SOURCE_REFLECTED, inOutpoints[0][0], inOutpoints[0][1], srcLeaf, tx.env.target);
              burnInsert = state.foldBurn(burnId, tx.env.dest);
            }
          } else if (openings.length === 0 && tx.env.burnDeposit) {
            burnDeposit = foldBurnDepositTx(state, tx.env.burnDeposit, burnDepositPendingRecord(tx, (batch.anchorHeight | 0) + blockIndex));
            if (tx.env.burnDepositUnbundled && !acknowledgedInvalidBurns.has(norm(tx.txid))) {
              unresolvedBurnDeposits.push(unresolvedBurn(tx, blockIndex));
            }
          } else if (openings.length === 0) {
            burnDeposit = foldBurnDepositTx(state, BD_SKIP_CTX, burnDepositPendingRecord(tx, (batch.anchorHeight | 0) + blockIndex));
            if (!acknowledgedInvalidBurns.has(norm(tx.txid))) {
              unresolvedBurnDeposits.push(unresolvedBurn(tx, blockIndex));
            }
          } else {
          }
        }
        const outputs = [];
        if (tx.env && tx.env.type === 'cxfer') {
          const envAsset = norm(tx.env.assetId);
          let kIdx = inOutpoints.map((_, k) => k);
          if (tx.env.assetInputCount != null) {
            const count = Number(tx.env.assetInputCount);
            const vins = tx.vins || [];
            kIdx = [];
            if (count >= 1 && 1 + count <= vins.length) {
              for (let i = 1; i < 1 + count; i++) {
                const k = inOutpoints.findIndex(([t, vo]) => norm(t) === norm(vins[i].prevTxid) && (vo >>> 0) === (vins[i].vout >>> 0));
                if (k < 0) { kIdx = []; break; }
                kIdx.push(k);
              }
            }
          }
          const kOutpoints = kIdx.map((k) => inOutpoints[k]);
          const assetPreserving = kIdx.every((k) => inAssets[k] === envAsset);
          const destBound = !(tx.env.opcode === 0x22 || tx.env.opcode === 0x23)
            || noteSpendsBindOutputs(tx.txData, kOutpoints);
          const legacyAdmissible = (tx.env.opcode === 0x5B || tx.env.opcode === 0x5C) || isLegacyBridgeAsset(envAsset);
          const hasSpends = kOutpoints.length > 0;
          const conserves = hasSpends && destBound && assetPreserving && legacyAdmissible && verifyCxferConservation({
            asset: tx.env.assetId,
            inputOutpoints: kOutpoints,
            inputPoints: kIdx.map((k) => secp.ProjectivePoint.fromAffine({ x: BigInt(openings[k].cx), y: BigInt(openings[k].cy) })),
            outsCompressed: tx.env.outputs.map((o) => o.compressed),
            rangeProof: tx.env.rangeProof,
            kernelSig: tx.env.kernelSig,
          });
          if (conserves) {
            for (const o of tx.env.outputs) {
              const outpoint = outpointKey(tx.txid, o.vout);
              const w = state.foldOutput(o.noteLeaf, outpoint, o.commitmentHash, envAsset, p2trXonly(txOutputScript(tx.txData, o.vout)));
              outputs.push({ noteLeaf: w.noteLeaf, notePath: w.notePath, vout: o.vout });
              coords.set(norm(outpoint), { cx: o.cx, cy: o.cy, txid: tx.txid, vout: o.vout });
            }
          } else {
            nonConserving.push({ txid: tx.txid, outputs: tx.env.outputs.length, reason: !hasSpends ? 'no-live-spends' : !destBound ? 'unbound-destination' : (!legacyAdmissible ? 'non-legacy-asset' : (assetPreserving ? 'non-conserving' : 'non-asset-preserving')) });
          }
        } else if (tx.env && tx.env.type === 'cxfer_bound') {
          const envAsset = norm(tx.env.assetId);
          const assetPreserving = inAssets.every((a) => a === envAsset);
          const targetOk = norm(tx.env.target) === chainBinding;
          const destBound = noteSpendsBindOutputs(tx.txData, inOutpoints);
          const hasSpends = inOutpoints.length > 0;
          const conserves = hasSpends && destBound && assetPreserving && targetOk && verifyCxferConservation({
            asset: tx.env.assetId,
            inputOutpoints: inOutpoints,
            inputPoints: openings.map((o) => secp.ProjectivePoint.fromAffine({ x: BigInt(o.cx), y: BigInt(o.cy) })),
            outsCompressed: tx.env.outputs.map((o) => o.compressed),
            rangeProof: tx.env.rangeProof,
            kernelSig: tx.env.kernelSig,
          });
          if (conserves) {
            for (const o of tx.env.outputs) {
              const outpoint = outpointKey(tx.txid, o.vout);
              const w = state.foldOutputBound(o.noteLeaf, outpoint, o.commitmentHash, envAsset, p2trXonly(txOutputScript(tx.txData, o.vout)));
              outputs.push({ noteLeaf: w.noteLeaf, notePath: w.notePath, vout: o.vout });
              coords.set(norm(outpoint), { cx: o.cx, cy: o.cy, txid: tx.txid, vout: o.vout });
            }
          } else {
            nonConserving.push({ txid: tx.txid, outputs: tx.env.outputs.length, reason: !hasSpends ? 'no-live-spends' : !destBound ? 'unbound-destination' : (!targetOk ? 'wrong-chain-binding' : (assetPreserving ? 'non-conserving' : 'non-asset-preserving')) });
          }
        } else if (tx.env && tx.env.type === 'mint') {
          unreflectedValueEntry.push({ txid: tx.txid, assetId: tx.env.assetId || null });
        } else if (tx.env && tx.env.type === 'unsupported') {
          unsupportedEnvelopes.push({ txid: tx.txid, opcode: tx.env.opcode });
        } else if (tx.env && tx.env.type === 'eth_call') {
          const payloadOk = hx(keccak256(hexToBytes(tx.env.payload))) === hx(b32(tx.env.payloadHash));
          const destOk = tx.env.destChain === DEST_CHAIN_BITCOIN;
          const msgSetLeaves = modeBIn && modeBIn.messages ? modeBIn.messages.map((m) => ethMessageLeaf(m.msgId, m.record)) : [];
          const setRoot = modeBIn ? modeBIn.ethMsgSetRoot : null;
          const record = ethMessageRecord(tx.env.destChain, tx.env.ns, hexToBytes(tx.env.sender), tx.env.payloadHash);
          ethCall = (payloadOk && destOk)
            ? state.foldEthMessage(tx.env.msgId, record, msgSetLeaves, setRoot)
            : state.foldEthMessage(tx.env.msgId, record, [], null);
        } else if (tx.env && tx.env.type === 'cbtc_lock') {
          const w = state.foldCbtcLock({ asset: tx.env.asset, cx: tx.env.cx, cy: tx.env.cy, vBtc: tx.env.vBtc, lockVout: tx.env.lockVout, lockTxid: tx.txid, sigRx: tx.env.sigRx, sigRy: tx.env.sigRy, sigZ: tx.env.sigZ });
          cbtcLock = { tracked: !!w };
        } else if (tx.env && tx.env.type === 'swap_var') {
          const svSentinel = /^(0x)?0+$/.test(String(tx.env.cChangeOrSentinel));
          const svReceiveSpk = txOutputScript(tx.txData, 1);
          const svChangeSpk = txOutputScript(tx.txData, 2);
          const svRefundSpk = txOutputScript(tx.txData, 3);
          const svTipSpk = txOutputScript(tx.txData, 4);
          let sw = null;
          for (let k = 0; k < openings.length && !sw; k++) {
            if (compressXY(openings[k].cx, openings[k].cy).toLowerCase() !== String(tx.env.cIn).toLowerCase()) continue;
            sw = state.foldSwapVar(tx.env, inOutpoints[k], inAssets[k], outpointKey(tx.txid, 1), outpointKey(tx.txid, 2), outpointKey(tx.txid, 3), svReceiveSpk, svChangeSpk, svRefundSpk, outpointKey(tx.txid, 4), svTipSpk, (batch.anchorHeight | 0) + blockIndex);
          }
          swapVar = { receiptPath: sw ? sw.notePath : state.notePathPeek() };
          if (!svSentinel) swapVar.changePath = (sw && sw.changePath) ? sw.changePath : state.notePathPeek();
          if (BigInt(tx.env.tipAmount || 0) > 0n) swapVar.tipPath = (sw && sw.tipPath) ? sw.tipPath : state.notePathPeek();
        } else if (tx.env && tx.env.type === 'swap_route') {
          const rtReceiveSpk = txOutputScript(tx.txData, 1);
          const rtRefundSpk = txOutputScript(tx.txData, 2);
          let rw = null;
          for (let k = 0; k < openings.length && !rw; k++) {
            if (compressXY(openings[k].cx, openings[k].cy).toLowerCase() !== String(tx.env.cIn).toLowerCase()) continue;
            rw = state.foldSwapRoute(tx.env, inOutpoints[k], inAssets[k], outpointKey(tx.txid, 1), outpointKey(tx.txid, 2), rtReceiveSpk, rtRefundSpk, (batch.anchorHeight | 0) + blockIndex);
          }
          swapRoute = { receiptPath: rw ? rw.receiptPath : state.notePathPeek() };
        } else if (tx.env && tx.env.type === 'harvest') {
          const ZH = '0x' + '00'.repeat(32);
          const hDestSpk = hexToBytes(txOutputScript(tx.txData, 1) || '0x');
          const hFarmBefore = state.farmRewards.get(tx.env.farmId);
          const hEntriesBefore = state.farmEntries.snapshot();
          const hlp = state.foldLpHarvest(tx.env.farmId, tx.env.shares, tx.env.owner, tx.env.oldNonce, tx.env.amount, tx.env.r, hDestSpk, tx.env.harvesterSig);
          const hw = hlp ? state.foldHarvest(tx.env.farmId, tx.env.amount, tx.env.r, outpointKey(tx.txid, 1), hDestSpk) : null;
          if (hlp && !hw) {
            if (hFarmBefore) state.farmRewards.set(tx.env.farmId, hFarmBefore);
            state.farmEntries.restore(hEntriesBefore);
          }
          harvest = hlp
            ? { ...hlp, notePath: hw ? hw.notePath : state.notePathPeek() }
            : { owner: ZH, nonce: ZH, shares: '0', rpsEntry: '0', oldIndex: 0, oldPath: state.notePathPeek(), notePath: hw ? hw.notePath : state.notePathPeek() };
        } else if (tx.env && tx.env.type === 'farm_refund') {
          const frDestSpk = hexToBytes(txOutputScript(tx.txData, 1) || '0x');
          const fr = state.foldFarmRefund(tx.env.farmId, tx.env.amount, tx.env.r, tx.env.refundViewHeight, tx.env.launcherPubkey, tx.env.launcherSig, frDestSpk, outpointKey(tx.txid, 1));
          farmRefund = { notePath: fr ? fr.notePath : state.notePathPeek() };
        } else if (tx.env && tx.env.type === 'lp_bond') {
          const ZH = '0x' + '00'.repeat(32);
          const st = state.farmRewards.get(tx.env.farmId);
          let bondBacked = false;
          if (st && st.lpAsset) {
            const idxs = [];
            for (let i = 0; i < inAssets.length; i++) if (hx(b32(inAssets[i])).toLowerCase() === String(st.lpAsset).toLowerCase()) idxs.push(i);
            if (idxs.length) {
              const lpOps = idxs.map((i) => inOutpoints[i]);
              const lpPts = idxs.map((i) => secp.ProjectivePoint.fromAffine({ x: BigInt(openings[i].cx), y: BigInt(openings[i].cy) }));
              bondBacked = lpBondKernelVerify(tx.env.farmId, st.lpAsset, tx.env.bondAmount, lpOps, lpPts, tx.env.kernelSig);
            }
          }
          let bonderOk = false;
          try {
            const u128le = (n) => { const b = new Uint8Array(16); let x = BigInt(n); for (let i = 0; i < 16; i++) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
            const bondFundingHash = ammFundingHash(
              (st && st.lpAsset) ? inOutpoints.filter((_, i) => hx(b32(inAssets[i])).toLowerCase() === String(st.lpAsset).toLowerCase()) : [],
              tx.env.kernelSig,
            );
            const bondMsg = sha256(concat([
              new TextEncoder().encode('tacit-amm-farm-bond-v1'), b32(tx.env.farmId), hexToBytes(tx.env.bonderPubkey),
              u64leBytes(tx.env.bondAmount), u128le(tx.env.entryAcc || 0), u32le(tx.env.bondViewHeight || 0),
              b32(tx.env.owner), b32(tx.env.nonce), bondFundingHash,
              u32le(tx.env.refundExpiry || 0), b32(tx.env.refundDestXonly), b32(tx.env.refundBlinding),
            ]));
            bonderOk = verifySchnorr(hexToBytes(String(tx.env.bonderSig).replace(/^0x/, '')), bondMsg, hexToBytes(tx.env.bonderPubkey).slice(1));
          } catch { bonderOk = false; }
          const lb = (bondBacked && bonderOk) ? state.foldLpBond(tx.env.farmId, tx.env.bondAmount, tx.env.owner, tx.env.nonce, tx.env.refundBlinding, tx.env.refundDestXonly, outpointKey(tx.txid, 1)) : null;
          lpBond = lb ? { owner: lb.owner || ZH, nonce: lb.nonce || ZH, receiptPath: lb.receiptPath }
                      : { owner: ZH, nonce: ZH, receiptPath: state.notePathPeek() };
        } else if (tx.env && tx.env.type === 'lp_unbond') {
          const ZH = '0x' + '00'.repeat(32);
          const ubDestSpk = hexToBytes(txOutputScript(tx.txData, 1) || '0x');
          const ub = state.foldLpUnbond(tx.env.farmId, tx.env.shares, tx.env.owner, tx.env.nonce, tx.env.lpReturnR, outpointKey(tx.txid, 1), ubDestSpk, tx.env.unbonderSig);
          lpUnbond = ub ? { oldIndex: ub.oldIndex, oldPath: ub.oldPath, spentInsert: ub.spentInsert, lpReturnPath: ub.lpReturnPath }
                        : { oldIndex: 0, oldPath: state.notePathPeek(), spentInsert: { sLowValue: ZH, sLowNext: ZH, sLowIndex: 0, sLowPath: state.notePathPeek(), sNewPath: state.notePathPeek() }, lpReturnPath: state.notePathPeek() };
        } else if (tx.env && tx.env.type === 'protocol_fee_claim') {
          const pfDestSpk = hexToBytes(txOutputScript(tx.txData, 0) || '0x');
          const pw = state.foldProtocolFeeClaim(tx.env.poolId, tx.env.claimer, tx.env.feeBps, tx.env.amount, tx.env.cSecp, tx.env.blinding, tx.env.sig, pfDestSpk, outpointKey(tx.txid, 0));
          protocolFee = { notePath: pw ? pw.notePath : state.notePathPeek() };
        } else if (tx.env && tx.env.type === 'farm_init') {
          let fiw = null;
          for (let k = 0; k < openings.length; k++) {
            if (hx(b32(inAssets[k])) !== hx(b32(tx.env.rewardAsset))) continue;
            const cIn = compressXY(openings[k].cx, openings[k].cy);
            const farmId = ammDeriveFarmId(tx.env.poolId, tx.env.launcherPubkey, tx.env.rewardAsset, tx.env.farmNonce);
            const wOk = (() => {
              const r = BigInt(tx.env.rewardPerBlock || 0);
              const s = BigInt(tx.env.startHeight || 0), e = BigInt(tx.env.endHeight || 0);
              if (e === 0n || e <= s) return false;
              const w = e - s;
              if (r > 0xffffffffn || w > 0xffffffffn) return false;
              const rw = r * w;
              return rw < (1n << 63n) && rw <= BigInt(tx.env.rewardTotal || 0);
            })();
            let launcherOk = false;
            try {
              const initFundingHash = ammFundingHash([inOutpoints[k]], tx.env.kernelSig);
              const initMsg = sha256(concat([
                AMM_FARM_INIT_DOMAIN, b32(farmId), hexToBytes(tx.env.launcherPubkey),
                u64leBytes(tx.env.rewardTotal), u64leBytes(tx.env.rewardPerBlock),
                u32le(tx.env.startHeight || 0), u32le(tx.env.endHeight || 0), initFundingHash,
                u32le(tx.env.refundExpiry || 0), b32(tx.env.refundDestXonly), b32(tx.env.refundBlinding),
              ]));
              launcherOk = verifySchnorr(hexToBytes(String(tx.env.launcherSig).replace(/^0x/, '')), initMsg, hexToBytes(tx.env.launcherPubkey).slice(1));
            } catch { launcherOk = false; }
            if (!launcherOk) continue;
            fiw = wOk ? state.foldFarmInit(farmId, tx.env.rewardAsset, tx.env.rewardTotal, inOutpoints[k], cIn, tx.env.cChangeOrSentinel, tx.env.kernelSig, tx.env.refundExpiry, tx.env.refundBlinding, tx.env.refundDestXonly, outpointKey(tx.txid, 1)) : null;
            if (fiw && fiw.registered) state.foldFarmInitRewards(farmId, tx.env.rewardPerBlock || 0, tx.env.launcherPubkey, tx.env.poolId, tx.env.startHeight || 0, tx.env.endHeight || 0, tx.env.rewardTotal || 0);
            break;
          }
          farmInit = { refundPath: (fiw && fiw.refundPath) ? fiw.refundPath : state.notePathPeek() };
        } else if (tx.env && tx.env.type === 'lp_remove') {
          const lrBound = noteSpendsBindOutputs(tx.txData, inOutpoints);
          const lrRecvAAuth = p2trXonly(txOutputScript(tx.txData, 0)) || ZERO_AUTH_HEX;
          const lrRecvBAuth = p2trXonly(txOutputScript(tx.txData, 1)) || ZERO_AUTH_HEX;
          const lrRefundAuth = p2trXonly(txOutputScript(tx.txData, 2)) || ZERO_AUTH_HEX;
          const lw = lrBound ? state.foldLpRemove(tx.env, inOutpoints, openings, inAssets, outpointKey(tx.txid, 0), outpointKey(tx.txid, 1), lrRecvAAuth, lrRecvBAuth, outpointKey(tx.txid, 2), lrRefundAuth) : null;
          lpRemove = lw
            ? { recvAPath: lw.recvAPath, recvBPath: lw.recvBPath, refundPath: lw.refundPath }
            : { recvAPath: state.notePathPeek(), recvBPath: state.notePathPeek(), refundPath: state.notePathPeek() };
        } else if (tx.env && tx.env.type === 'lp_add') {
          const spends = openings.map((o, i) => ({ cx: o.cx, cy: o.cy, asset: inAssets[i], outpoint: inOutpoints[i] }));
          const laBound = noteSpendsBindOutputs(tx.txData, inOutpoints);
          const [laRvA, laRvB] = Number(tx.env.variant) === 1 ? [2, 3] : [1, 2];
          const laShareAuth = p2trXonly(txOutputScript(tx.txData, 0)) || ZERO_AUTH_HEX;
          const laRefundAAuth = p2trXonly(txOutputScript(tx.txData, laRvA));
          const laRefundBAuth = p2trXonly(txOutputScript(tx.txData, laRvB));
          const laHeight = (batch.anchorHeight | 0) + blockIndex;
          const aw = laBound ? state.foldLpAdd(tx.env, spends, tx.env.shareR, outpointKey(tx.txid, 0), laShareAuth, laHeight, laRefundAAuth, laRefundBAuth, outpointKey(tx.txid, laRvA), outpointKey(tx.txid, laRvB)) : null;
          lpAdd = aw ? { path0: aw.path0, path1: aw.path1 } : { path0: state.notePathPeek(), path1: state.notePathPeek() };
        } else if (tx.env && tx.env.type === 'swap_batch') {
          const n = tx.env.nIntents | 0;
          const sbHeight = (batch.anchorHeight | 0) + blockIndex;
          const sbSpends = openings.map((o, i) => ({ cx: o.cx, cy: o.cy, asset: inAssets[i], outpoint: inOutpoints[i] }));
          const receiptSpks = Array.from({ length: n }, (_, i) => txOutputScript(tx.txData, 1 + i));
          const refundSpks = Array.from({ length: n }, (_, i) => txOutputScript(tx.txData, 1 + n + i));
          let sbw = null;
          if (batch.swapBatchFold) {
            try {
              sbw = await batch.swapBatchFold(tx.env, tx.txid, sbSpends, { receiptSpks, refundSpks, height: BigInt(sbHeight) });
            } catch (e) {
              console.log(`[reflection] swap_batch fold for ${tx.txid} is unusable, treating as unfolded: ${String(e && e.message || e).slice(0, 200)}`);
              sbw = null;
            }
          }
          swapBatch = sbw
            ? { nIntents: n, receiptPaths: sbw.receiptPaths, refundPaths: sbw.refundPaths }
            : {
                nIntents: n,
                receiptPaths: Array.from({ length: n }, () => state.notePathPeek()),
                refundPaths: Array.from({ length: n }, () => state.notePathPeek()),
              };
        } else if (tx.env && tx.env.type === 'crossout_mint') {
          const ZW = '0x' + '00'.repeat(32);
          const bogusConsumedInsert = { sLowValue: ZW, sLowNext: ZW, sLowIndex: 0, sLowPath: Array(32).fill(ZW), sNewPath: Array(32).fill(ZW) };
          if (modeBIn) {
            const coDestAuth = p2trXonly(txOutputScript(tx.txData, 0));
            const w = state.foldCrossout(tx.env.asset, tx.env.claimId, tx.env.cx, tx.env.cy, modeBIn.crossoutImt, modeBIn.crossoutSetRoot, tx.txid, 0, coDestAuth);
            if (w) coords.set(norm(outpointKey(tx.txid, 0)), { cx: tx.env.cx, cy: tx.env.cy, txid: tx.txid, vout: 0 });
            crossoutMint = w
              ? { isMember: w.isMember, mNext: w.mNext, mLowValue: w.mLowValue, mIndex: w.mIndex, mPath: w.mPath.map(norm), notePath: w.notePath, consumedInsert: w.consumedInsert }
              : { isMember: 0, mNext: ZW, mLowValue: ZW, mIndex: 0, mPath: Array(32).fill(ZW), notePath: state.notePathPeek(), consumedInsert: bogusConsumedInsert };
          } else {
            crossoutMint = {
              isMember: 0, mNext: ZW, mLowValue: ZW, mIndex: 0, mPath: Array(32).fill(ZW),
              notePath: state.notePathPeek(), consumedInsert: bogusConsumedInsert,
            };
          }
        }
        txsOut.push({ txData: tx.txData, openings, spentInserts, burnInsert, outputs, burnDeposit, cbtcLock, swapVar, swapRoute, harvest, protocolFee, lpRemove, lpAdd, swapBatch, crossoutMint, ethCall, lpBond, lpUnbond, farmRefund, farmInit });
      }
      blocksOut.push({ txs: txsOut });
    }
    const depositCompletions = [];
    const droppedDepositCompletions = [];
    for (const cc of (batch.depositCompletions || [])) {
      const z = (v) => (v ? hx(b32(v)) : hx(ZERO32));
      const rec = { asset: z(cc.asset), nu: z(cc.nu), dest: z(cc.dest), target: z(cc.target) };
      const m = state.pendingDepositWitness(cc.burnedTxid, cc.burnedVout);
      if (!m || norm(m.value) !== pendingDepositValue(rec.asset, rec.nu, rec.dest, rec.target)) {
        droppedDepositCompletions.push({ burnedTxid: z(cc.burnedTxid), burnedVout: cc.burnedVout >>> 0, reason: 'not a pending deposit with these envelope fields' });
        continue;
      }
      if (!cc.valid || norm(cc.nu || ZERO32) !== rec.nu) {
        droppedDepositCompletions.push({ burnedTxid: z(cc.burnedTxid), burnedVout: cc.burnedVout >>> 0, reason: cc.reason || 'provenance does not verify' });
        continue;
      }
      const deposit = foldBurnDepositTx(state, { ...cc, dest: rec.dest, target: rec.target });
      state.markPendingDepositCompleted(cc.burnedTxid, cc.burnedVout);
      const { burnWtxidSiblings, burnCbTxidSiblings, pendingInsert, ...depositWitness } = deposit;
      depositCompletions.push({
        burnedTxid: z(cc.burnedTxid), burnedVout: cc.burnedVout >>> 0, ...rec,
        pendingNext: m.next, pendingIndex: m.index, pendingPath: m.path, deposit: depositWitness,
      });
    }
    return {
      prior, anchorHeight: batch.anchorHeight | 0, headers: batch.headers || [], blocks: blocksOut,
      chainBinding, consumedBound: consumedOut.map((x) => (x.bound ? 1 : 0)),
      depositCompletions, droppedDepositCompletions,
      newDigest: state.digest(), nonConserving, unreflectedValueEntry, unsupportedEnvelopes, unresolvedBurnDeposits,
      modeB: modeBIn ? 1 : 0, ...(modeBIn ? { ethPv: ethPvHex, consumed: consumedOut } : {}),
      ...(rebaseOut || {}),
    };
  }

  function verifyPath(leafHex, index, path, rootHex) {
    let h = b32(leafHex);
    for (let i = 0; i < TREE_DEPTH; i++) {
      const sib = b32(path[i]);
      h = ((index >>> i) & 1) ? keccak256(concat([sib, h])) : keccak256(concat([h, sib]));
    }
    return hx(h) === rootHex;
  }

  function merklePath(leaves, index) {
    const t = new Tree();
    for (const l of leaves) t.insert(l);
    return t.rootAndPath(index).path;
  }

  function merkleRootFrom(leafHex, index, path) {
    let h = b32(leafHex);
    for (let i = 0; i < TREE_DEPTH; i++) {
      const sib = b32(path[i]);
      h = ((index >>> i) & 1) ? keccak256(concat([sib, h])) : keccak256(concat([h, sib]));
    }
    return hx(h);
  }

  const DEST_CHAIN_BITCOIN = 1;
  const ETH_GENESIS_SYNC_COMMITTEE = '0xbadc9e8edde525d58ea8df0f258da9768be4f2d68add89d8c55b03c217c4f5ec';
  const be2 = (n) => Uint8Array.from([(n >> 8) & 0xff, n & 0xff]);
  function ethCrossoutLeaf(claimId, destChain, destCommitment, asset) {
    return hx(keccak256(concat([b32(claimId), be2(destChain), b32(destCommitment), b32(asset)])));
  }
  function ethConsumedLeaf(nu, spendRoot) {
    return hx(keccak256(concat([b32(nu), b32(spendRoot)])));
  }
  function ethMessageRecord(destChain, ns, sender20, payloadHash) {
    return hx(keccak256(concat([be2(destChain), b32(ns), sender20, b32(payloadHash)])));
  }
  function ethMessageLeaf(msgId, record) {
    return hx(keccak256(concat([b32(msgId), b32(record)])));
  }
  const EMPTY_ETH_SET_ROOT = '0x27ae5ba08d7291c96c8cbddcc148bf48a6d68c7974b94356f53754ef6171d757';
  function ethReflDigest(pool20, setRoot, count, consumedRoot, consumedCount, msgRoot, msgCount) {
    return hx(keccak256(concat([
      pool20, b32(setRoot), be8(count), b32(consumedRoot), be8(consumedCount), b32(msgRoot), be8(msgCount),
    ])));
  }
  function ethReflGenesisDigest(pool20) {
    return ethReflDigest(pool20, imtEmptyRoot(), 0, EMPTY_ETH_SET_ROOT, 0, EMPTY_ETH_SET_ROOT, 0);
  }
  function generationalRebaseAnchor(predDigest, consumedCount, crossOutCount) {
    return hx(keccak256(concat([b32(predDigest), u64be(BigInt(consumedCount)), u64be(BigInt(crossOutCount))])));
  }
  function ethCrossoutMember(co, index, path, setRoot) {
    return verifyPath(ethCrossoutLeaf(co.claimId, co.destChain, co.destCommitment, co.asset), index, path, setRoot);
  }
  function buildEthPv(
    crossoutSetRoot, consumedSetRoot, consumedNuCount, crossOutCount = 0, pool = null,
    msgSetRoot = EMPTY_ETH_SET_ROOT, msgCount = 0, outbox = null,
    syncCommitteeRoot = null, prevSyncCommitteeRoot = null,
  ) {
    const words = Array.from({ length: 14 }, () => new Uint8Array(32));
    const poolWord = pool ? b32(pool) : new Uint8Array(32);
    const pool20 = poolWord.slice(12, 32);
    words[0] = b32(ethReflGenesisDigest(pool20));
    words[1] = b32(ethReflDigest(
      pool20, crossoutSetRoot, crossOutCount, consumedSetRoot, consumedNuCount, msgSetRoot, msgCount,
    ));
    words[2] = poolWord;
    words[3] = b32(crossoutSetRoot);
    words[4] = u64be(BigInt(crossOutCount));
    words[8] = b32(prevSyncCommitteeRoot || ETH_GENESIS_SYNC_COMMITTEE);
    words[7] = b32(syncCommitteeRoot || prevSyncCommitteeRoot || ETH_GENESIS_SYNC_COMMITTEE);
    words[9] = b32(consumedSetRoot);
    words[10] = u64be(BigInt(consumedNuCount));
    words[11] = outbox ? b32(outbox) : new Uint8Array(32);
    words[12] = b32(msgSetRoot);
    words[13] = u64be(BigInt(msgCount));
    return hx(concat(words));
  }

  function buildModeBBatch(ethBundle, crossoutTxs, consumedSources, alreadyFoldedConsumedCount = 0) {
    const ethPv = ethBundle.ethPv.startsWith('0x') ? ethBundle.ethPv.toLowerCase() : '0x' + ethBundle.ethPv.toLowerCase();
    const pvWord = (i) => '0x' + ethPv.slice(2 + i * 64, 2 + i * 64 + 64);
    const eq = (a, b) => hx(b32(a)) === hx(b32(b));
    const crossoutSetRoot = pvWord(3), consumedSetRoot = pvWord(9), ethMsgSetRoot = pvWord(12);

    const coSet = makeImtAccumulator();
    for (const c of (ethBundle.crossouts || [])) coSet.insert(ethCrossoutLeaf(c.claimId, DEST_CHAIN_BITCOIN, c.destCommitment, c.asset));
    if (!eq(coSet.root(), crossoutSetRoot))
      throw new Error('mode-b: reconstructed crossout set root != eth proof word 3 (bundle/proof mismatch)');

    const coNuLeaves = (ethBundle.consumeds || []).map((c) => ethConsumedLeaf(c.nu, c.consumedVal));
    if (coNuLeaves.length && !eq(merkleRootFrom(coNuLeaves[0], 0, merklePath(coNuLeaves, 0)), consumedSetRoot))
      throw new Error('mode-b: reconstructed consumed set root != eth proof word 9 (bundle/proof mismatch)');
    const consumed = [];
    (ethBundle.consumeds || []).forEach((c, i) => {
      if (i < alreadyFoldedConsumedCount) return;
      const src = (consumedSources || []).find((s) => eq(s.nu, c.nu));
      if (!src) throw new Error('mode-b: consumed ν has no resolved Bitcoin source note: ' + c.nu);
      consumed.push({ cx: src.cx, cy: src.cy, srcTxid: src.srcTxid, srcVout: src.srcVout, spendRoot: c.spendRoot, setPath: merklePath(coNuLeaves, i) });
    });

    const msgLeaves = (ethBundle.messages || []).map((m) => ethMessageLeaf(m.msgId, m.record));
    if (msgLeaves.length && !eq(merkleRootFrom(msgLeaves[0], 0, merklePath(msgLeaves, 0)), ethMsgSetRoot))
      throw new Error('mode-b: reconstructed message set root != eth proof word 12 (bundle/proof mismatch)');
    const messages = (ethBundle.messages || []).map((m, i) => ({
      msgId: m.msgId, record: m.record, setIndex: i, setPath: merklePath(msgLeaves, i),
    }));

    return { modeB: { ethPv, crossoutSetRoot, consumedSetRoot, ethMsgSetRoot, consumed, messages, crossoutImt: coSet } };
  }

  const OPENING_DOMAIN = new TextEncoder().encode('tacit-open-sigma-v1');
  const be8 = (n) => { const o = new Uint8Array(8); let v = BigInt(n); for (let i = 7; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
  const compressPt = (P) => P.toRawBytes(true);
  const ptFromXY = (cx, cy) => secp.ProjectivePoint.fromAffine({ x: BigInt(cx), y: BigInt(cy) });
  const openChallenge = (amount, contextHex, C, R) =>
    mod(bToBig(keccak256(concat([OPENING_DOMAIN, be8(amount), b32(contextHex), compressPt(C), compressPt(R)]))), N);

  function intentContext(tag, chainBinding, assetA, assetB, notes, amounts) {
    const parts = [tag instanceof Uint8Array ? tag : new TextEncoder().encode(tag), b32(chainBinding), b32(assetA), b32(assetB)];
    for (const [cx, cy, owner] of notes) { parts.push(b32(cx), b32(cy), b32(owner)); }
    for (const a of amounts) { parts.push(be8(a)); }
    return hx(keccak256(concat(parts)));
  }

  function openingSigma(amount, r, contextHex, nonce) {
    const rS = mod(BigInt(r), N), kS = mod(BigInt(nonce), N);
    if (kS === 0n) throw new Error('openingSigma: zero nonce would expose the blinding r');
    const C = prover.commit(BigInt(amount), rS);
    const R = secp.ProjectivePoint.BASE.multiply(kS);
    const e = openChallenge(amount, contextHex, C, R);
    return { R: hx(compressPt(R)), z: hx(beBytes(mod(kS + e * rS, N), 32)) };
  }

  function deriveOpeningNonce(r, contextHex, role) {
    const roleB = role instanceof Uint8Array ? role : new TextEncoder().encode(role);
    const k = mod(bToBig(keccak256(concat([new TextEncoder().encode('tacit-open-nonce-v1'), beBytes(mod(BigInt(r), N), 32), b32(contextHex), roleB]))), N);
    return k === 0n ? 1n : k;
  }

  function verifyOpeningSigma(cx, cy, amount, Rhex, zHex, contextHex) {
    const C = ptFromXY(cx, cy);
    const R = secp.ProjectivePoint.fromHex(Rhex.replace(/^0x/, ''));
    const e = openChallenge(amount, contextHex, C, R);
    const amtH = BigInt(amount) === 0n ? secp.ProjectivePoint.ZERO : prover.H.multiply(BigInt(amount));
    const X = C.add(amtH.negate());
    const lhs = secp.ProjectivePoint.BASE.multiply(mod(BigInt(zHex), N));
    const rhs = R.add(X.multiply(e));
    return hx(compressPt(lhs)) === hx(compressPt(rhs));
  }

  const BLIND_OPENING_DOMAIN = new TextEncoder().encode('tacit-open-pok-blind-v1');
  const blindOpenChallenge = (contextHex, C, R) =>
    mod(bToBig(keccak256(concat([BLIND_OPENING_DOMAIN, b32(contextHex), compressPt(C), compressPt(R)]))), N);
  const hTerm = (s) => (mod(BigInt(s), N) === 0n ? secp.ProjectivePoint.ZERO : prover.H.multiply(mod(BigInt(s), N)));

  function openingPokBlind(value, r, contextHex, nonceV, nonceR) {
    const vS = mod(BigInt(value), N), rS = mod(BigInt(r), N);
    const sv = mod(BigInt(nonceV), N), sr = mod(BigInt(nonceR), N);
    if (sv === 0n || sr === 0n) throw new Error('openingPokBlind: zero nonce would expose an opening');
    const C = prover.commit(BigInt(value), rS);
    const R = hTerm(sv).add(secp.ProjectivePoint.BASE.multiply(sr));
    const e = blindOpenChallenge(contextHex, C, R);
    return { R: hx(compressPt(R)), zV: hx(beBytes(mod(sv + e * vS, N), 32)), zR: hx(beBytes(mod(sr + e * rS, N), 32)) };
  }

  function verifyOpeningPokBlind(cx, cy, Rhex, zVhex, zRhex, contextHex) {
    const C = ptFromXY(cx, cy);
    const R = secp.ProjectivePoint.fromHex(Rhex.replace(/^0x/, ''));
    const e = blindOpenChallenge(contextHex, C, R);
    const lhs = hTerm(mod(BigInt(zVhex), N)).add(secp.ProjectivePoint.BASE.multiply(mod(BigInt(zRhex), N)));
    const rhs = R.add(C.multiply(e));
    return hx(compressPt(lhs)) === hx(compressPt(rhs));
  }

  return {
    prover, TREE_DEPTH, zeros: zeros.map(hx),
    commitXY, deriveNote, deriveBidSecret, leaf, btcNoteLeaf, btcNoteLeafBound, isLegacyBridgeAsset, btcNoteSpendMsg, p2trXonly, nullifier, depositCommit, depositId, Tree, verifyPath, merklePath, merkleRootFrom,
    imtLeaf, imtRoot, imtEmptyRoot, makeImtAccumulator,
    utxoLeaf, makeUtxoAccumulator, pendingDepositValue, ETH_GENESIS_SYNC_COMMITTEE, commitmentHash, decompressCommitment, compressXY, outpointKey, getAmountOut, hx, swapVarIntentMsg, swapRouteIntentMsg, bridgeBurnId, protofeeBlind,
    makeReflectionState, assembleReflectionInput, openingSigma, verifyOpeningSigma, openingPokBlind, verifyOpeningPokBlind, deriveOpeningNonce, intentContext,
    liveLeaf, livePre, makeLiveUtxoSet, makeScanReflectionState, assembleReflectionScanInput, generationalRebaseAnchor,
    _hex: { hexToBytes, bytesToHex, hexToBytesSlow, bytesToHexSlow },     // for tests/confidential-hex.test.mjs, which holds the fast conversions to the generic ones
    farmReceiptLeaf, farmReceiptNullifier, makeFarmRewardSet, makeFarmEntrySet, FARM_RPS_PRECISION,
    evmLpHarvestOwnerMsg, evmLpUnbondOwnerMsg, evmPoolId, evmLpShareId, nkToOwner, nativeNullifier, nativeNu,
    DEST_CHAIN_BITCOIN, ethCrossoutLeaf, ethConsumedLeaf, ethCrossoutMember, buildEthPv, buildModeBBatch,
    ethMessageRecord, ethMessageLeaf,
    CBTC_ZK_ASSET_ID, CBTC_LOCK_DOMAIN, cbtcLockContext,
    cxferKernelVerify, verifyCxferConservation,
    protocolFeeShares, crystallizeProtocolFee, ammDeriveLpAssetId, ammDeriveFarmId, ammCanonicalPair, ammDerivePoolIdFull, poolIdWithProtocolFee, lpRemoveKernelVerify, lpAddKernelVerify, lpAddShares, swapBatchAggregateIdentity, verifyPedersenOpening, AMM_MINIMUM_LIQUIDITY, isqrt,
    _internal: { keccak, concat, b32, beBytes, hx },
  };
}
