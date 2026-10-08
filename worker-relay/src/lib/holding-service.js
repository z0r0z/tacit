// The holding reward as the points service runs it, off by default: reads each EVM pool's events, draws each ended day's
// snapshot, tells clients what to prove against, and credits a verified claim as points to the address it names. All rules
// live in holding-epoch.js (the draw and the binding), holding-state.js (the state at a snapshot) and holding-claims.js (what a
// claim must satisfy); this is the wiring, with its chain, clock and verifier handed in so it can be driven in tests.
//
// What the service keeps on disk is what a claim is checked against: a snapshot's root and spent-set root are stored when the day
// is drawn and cannot be derived again from the chain after the fact (the draw is, but a claim's credit is not), so the database
// is the record of both and its daily snapshot is the backup.
//
// cfg: { enabled, rate (points per ETH of bucket per day), buckets (wei, ascending), pool, poolAssets? ({ chainId: asset }, read
//        from each pool when absent), vkey, delaySecs?, windowDays?, maxPending?, claimsPerMin?, claimBurst?, allClaimsPerMin?,
//        chains: [{ chainId, deployBlock, confirmations?, span?, maxSpan? }] }
// clients: { [chainId]: viem public client }. hash: Poseidon. groth16: { verify }.
import { makeBlockAtOrBefore } from './block-at-time.js';
import { poolStateAt, emptyRootOf, HoldingStateError } from './holding-state.js';
import { scanHoldingChain } from './holding-scan.js';
import { rootSizeOf, poolState, poolAssetOf } from './evm-pool-snapshot-chain.js';
import { smtRoot } from './evm-pool-snapshot.js';
import { claimableEpochs, snapshotTime, randomnessOf, holdingTxHash, DAY, ETH } from './holding-epoch.js';
import { verifyHoldingClaim } from './holding-claims.js';
import { makeTokenBucket } from './token-bucket.js';

const reply = (status, body) => ({ status, body });
const RANDOM_BLOCKS = 32, L1_CONFIRMATIONS = 12, TAIL_SLACK = 256;

class ClaimRefused extends Error {}

export function createHolding({ store, cfg, clients, hash, groth16, nowSec = () => Math.floor(Date.now() / 1000), log = () => {}, scan = scanHoldingChain }) {
  if (cfg.enabled && (cfg.vkey?.protocol !== 'groth16' || cfg.vkey?.nPublic !== 7)) throw new Error('the holding verification key is not a Groth16 key for seven public values');
  const delaySecs = cfg.delaySecs ?? 1800, windowDays = cfg.windowDays ?? 2, maxPending = cfg.maxPending ?? 20;
  const emptyRoot = emptyRootOf(hash);
  const atOrBefore = new Map();
  const blockAt = (chainId) => {
    if (!atOrBefore.has(chainId)) atOrBefore.set(chainId, makeBlockAtOrBefore(async (n) => (await clients[chainId].getBlock({ blockNumber: n })).timestamp));
    return atOrBefore.get(chainId);
  };
  const confirmationsOf = (c) => c.confirmations ?? 12;
  const open = () => claimableEpochs({ nowSec: nowSec(), delaySecs, windowDays });

  // Each chain's pool commits notes under its own asset field element, read from the pool the first time it is needed.
  const assets = new Map(Object.entries(cfg.poolAssets ?? {}).map(([id, a]) => [Number(id), BigInt(a)]));
  async function assetOf(chainId) {
    if (!assets.has(chainId)) assets.set(chainId, await poolAssetOf(clients[chainId], cfg.pool));
    return assets.get(chainId);
  }

  // Checks the stored events through the scan cursor whole against the pool itself: unbroken from its first insertion (so none
  // is missing from the middle) and ending at the root and leaf count the pool reports at that block (so none is missing from
  // the end). The pool's balance is not used: ETH sent to a contract without a call can raise it, and would stop the reward for good.
  // A hole or a reorg deeper than the confirmations is healed by forgetting everything after the last block that was verified and
  // reading it again; a node that cannot answer for the block yet is waited on.
  async function verifyThrough(chain) {
    const { chainId } = chain, cursor = store.loadHoldingCursor(chainId);
    if (cursor === null) return;
    const verified = store.loadHoldingVerified(chainId);
    if (verified !== null && verified >= cursor) return;
    const client = clients[chainId];
    if (Number(await client.getBlockNumber()) - cursor > confirmationsOf(chain) + TAIL_SLACK) return;       // still catching up: a node keeps recent state only
    let mismatch = null;
    try {
      const state = poolStateAt({ events: store.holdingEvents(chainId, cursor), block: cursor, hash, emptyRoot, nfRoot: false });
      const at = await poolState(client, cursor, cfg.pool);
      if (at.root !== state.root || at.nextIndex !== state.size) mismatch = `the pool reports root ${at.root.toString(16)} with ${at.nextIndex} leaves, the events give ${state.root.toString(16)} with ${state.size}`;
    } catch (err) {
      if (!(err instanceof HoldingStateError)) { log(`holding chain ${chainId}: cannot check block ${cursor} yet: ${err?.shortMessage || err?.message || err}`); return; }
      mismatch = err.message;
    }
    if (mismatch) {
      const back = verified ?? chain.deployBlock - 1;
      log(`holding chain ${chainId}: the events read through block ${cursor} do not agree with the pool (${mismatch}); reading again from block ${back + 1}`);
      store.rewindHolding(chainId, back);
      return;
    }
    store.saveHoldingVerified(chainId, cursor);
  }

  // The day's randomness: the prevRandao of the 32 Ethereum blocks ending at the last one at or before the moment the day's delay
  // runs out (final by then), kept once read. null while Ethereum has not reached that moment.
  const randomness = new Map();
  async function randomnessFor(epoch) {
    if (randomness.has(epoch)) return randomness.get(epoch);
    const t0 = (epoch + 1) * DAY + delaySecs;
    if (nowSec() < t0 + 900) return null;
    const l1 = clients[1];
    const tip = Number(await l1.getBlockNumber()) - L1_CONFIRMATIONS;
    const last = Number(await blockAt(1)(t0, tip));
    const lastBlock = await l1.getBlock({ blockNumber: BigInt(last) });
    if (Number(lastBlock.timestamp) < t0 - 120) return null;                    // Ethereum is behind: the blocks are from before the day was over
    const blocks = await Promise.all(Array.from({ length: RANDOM_BLOCKS }, (_, i) => (i === RANDOM_BLOCKS - 1 ? lastBlock : l1.getBlock({ blockNumber: BigInt(last - (RANDOM_BLOCKS - 1) + i) }))));
    const mixes = blocks.map((b) => b.mixHash);
    if (mixes.some((m) => !/^0x[0-9a-fA-F]{64}$/.test(String(m)))) throw new Error('Ethereum blocks without prevRandao: cannot draw');
    const value = randomnessOf(mixes);
    if (randomness.size > 8) randomness.clear();
    randomness.set(epoch, value);
    return value;
  }

  // The day's snapshot on one chain, drawn once the day is over and its randomness is final, and only from events checked whole
  // through the snapshot block (verifyThrough) and agreeing with the pool's own root history.
  async function draw(epoch, chain) {
    const have = store.holdingSnapshots(epoch).find((s) => s.chainId === chain.chainId);
    if (have) return have;
    const randomHash = await randomnessFor(epoch);
    if (!randomHash) return null;
    const moment = snapshotTime({ epoch, chainId: chain.chainId, randomHash });
    const client = clients[chain.chainId];
    const tip = Number(await client.getBlockNumber()) - confirmationsOf(chain);
    const block = Number(await blockAt(chain.chainId)(moment, tip));
    if (block === tip && Number((await client.getBlock({ blockNumber: BigInt(tip) })).timestamp) < Number(moment)) return null;     // the chain has not reached the moment
    const verified = store.loadHoldingVerified(chain.chainId);
    if (verified === null || verified < block) return null;                                       // the events are not all read and checked yet
    const state = poolStateAt({ events: store.holdingEvents(chain.chainId, block), block, hash, emptyRoot, nfRoot: false });
    if (state.size > 0) {
      const known = await rootSizeOf(client, state.root, cfg.pool);
      if (known !== state.size) throw new Error(`chain ${chain.chainId}: the rebuilt root at block ${block} is not one the pool held with ${state.size} leaves (${known})`);
    }
    const snap = { epoch, chainId: chain.chainId, block, moment: Number(moment), root: state.root, nfRoot: smtRoot(state.nullifiers, hash), size: state.size, nullifiers: state.nullifiers.length, takenAt: nowSec() };
    store.saveHoldingSnapshot(snap);
    log(`holding: day ${epoch} on chain ${chain.chainId}: snapshot at block ${block}, ${state.size} leaves, ${state.nullifiers.length} nullifiers`);
    return store.holdingSnapshots(epoch).find((s) => s.chainId === chain.chainId);
  }

  async function cycle() {
    if (!cfg.enabled) return;
    for (const chain of cfg.chains) {
      try {
        await scan({ store, client: clients[chain.chainId], chainId: chain.chainId, pool: cfg.pool, deployBlock: chain.deployBlock, confirmations: confirmationsOf(chain), span: chain.span ?? 2000, maxSpan: chain.maxSpan ?? chain.span ?? 2000, budgetMs: cfg.budgetMs ?? 15000, log });
      } catch (err) { log(`holding scan chain ${chain.chainId} failed: ${err?.shortMessage || err?.message || err}`); }
      try { await verifyThrough(chain); } catch (err) { log(`holding check chain ${chain.chainId} failed: ${err?.message || err}`); }
      try { await assetOf(chain.chainId); } catch (err) { log(`holding chain ${chain.chainId}: the pool's asset is not readable yet: ${err?.shortMessage || err?.message || err}`); }
      for (const epoch of open()) {
        try { await draw(epoch, chain); } catch (err) { log(`holding snapshot day ${epoch} chain ${chain.chainId} failed: ${err?.message || err}`); }
      }
    }
  }

  // Claims are verified one at a time, and a queue past maxPending is refused outright: a proof check is the costly thing a
  // caller can ask of this service. Each caller, and all callers together, are also held to a rate.
  let pending = 0, tail = Promise.resolve();
  const queued = (fn) => {
    if (pending >= maxPending) return null;
    pending += 1;
    const p = tail.then(fn).finally(() => { pending -= 1; });
    tail = p.catch(() => {});
    return p;
  };
  const callerOk = makeTokenBucket({ perMin: cfg.claimsPerMin ?? 6, burst: cfg.claimBurst ?? 6, now: () => nowSec() * 1000 });
  const allOk = makeTokenBucket({ perMin: cfg.allClaimsPerMin ?? 120, burst: cfg.allClaimsPerMin ?? 120, maxKeys: 1, now: () => nowSec() * 1000 });

  function status() {
    if (!cfg.enabled) return { enabled: false };
    return {
      enabled: true, rate: cfg.rate, buckets: cfg.buckets.map(String), assets: Object.fromEntries([...assets].map(([id, a]) => [id, String(a)])),
      epochs: open().map((epoch) => ({
        epoch, closesAt: (epoch + windowDays + 1) * DAY + delaySecs,
        chains: store.holdingSnapshots(epoch).map((s) => ({ chainId: s.chainId, block: s.block, moment: s.moment, root: s.root, nfRoot: s.nfRoot, leaves: s.size, nullifiers: s.nullifiers })),
      })),
    };
  }

  // What a client needs beyond the note tree its wallet already keeps: the spent set at the snapshot, which anyone can read.
  // A snapshot never changes, so the answer is built once.
  const nullifierBodies = new Map();
  function nullifiers(chainId, epoch) {
    if (!cfg.enabled) return reply(404, { error: 'not enabled' });
    const snap = store.holdingSnapshots(epoch).find((s) => s.chainId === chainId);
    if (!snap) return reply(404, { error: 'no snapshot for that day and chain' });
    const key = `${chainId}:${epoch}`;
    if (!nullifierBodies.has(key)) {
      const nfs = [];
      for (const e of store.holdingEvents(chainId, snap.block)) for (const nf of [e.nf0, e.nf1]) if (BigInt(nf) !== 0n) nfs.push(nf);
      if (nullifierBodies.size > 16) nullifierBodies.clear();
      nullifierBodies.set(key, { epoch, chainId, block: snap.block, root: snap.root, nfRoot: snap.nfRoot, nullifiers: nfs });
    }
    return reply(200, nullifierBodies.get(key));
  }

  // opts.client: whoever is asking, as the caller's rate is counted.
  async function claim(body, { client = 'unknown' } = {}) {
    if (!cfg.enabled) return reply(404, { error: 'not enabled' });
    const chainId = Number(body?.chainId), epoch = Number(body?.epoch);
    if (!open().includes(epoch)) return reply(409, { error: 'that day is not open for claims' });
    const chain = cfg.chains.find((c) => c.chainId === chainId);
    if (!chain) return reply(400, { error: 'unknown chain' });
    const snap = store.holdingSnapshots(epoch).find((s) => s.chainId === chainId);
    if (!snap) return reply(409, { error: 'that day\'s snapshot is not drawn yet' });
    if (!callerOk(client)) return reply(429, { error: 'too many claims from here, try again shortly' });
    // A tag already credited for the day is answered without a proof check: the same claim sent twice costs nothing.
    const tag = body?.publicSignals?.[6];
    const had = typeof tag === 'string' && /^\d{1,80}$/.test(tag) ? store.holdingClaimFor(epoch, tag) : null;
    if (had) return reply(200, { credited: false, points: had.points, bucketWei: had.bucketWei });
    if (!allOk('all')) return reply(429, { error: 'busy, try again shortly' });
    let poolAsset;
    try { poolAsset = await assetOf(chainId); } catch { return reply(503, { error: 'this chain\'s pool cannot be read right now, try again shortly' }); }
    const job = queued(() => verifyHoldingClaim({ claim: { chainId, epoch, claimAddress: body.claimAddress, proof: body.proof, publicSignals: body.publicSignals }, snapshot: snap, buckets: cfg.buckets, poolAsset, vkey: cfg.vkey, groth16 }));
    if (!job) return reply(429, { error: 'busy, try again shortly' });
    const v = await job;
    if (!v.ok) return reply(422, { error: v.reason });
    const points = (Number((v.bucketWei * 1_000_000n) / ETH) / 1e6) * cfg.rate;
    const claimAddress = String(body.claimAddress).toLowerCase();
    // The credit carries the start of the day it was claimed, not the minute: the time a claim arrived says who sent it.
    const blockTime = Math.floor(nowSec() / DAY) * DAY;
    let credited;
    try {
      credited = store.db.transaction(() => {
        if (!store.recordHoldingClaim({ epoch, chainId, retNf: v.retNf, claimAddress, bucketWei: v.bucketWei.toString(), points, claimedAt: blockTime })) return false;
        if (!store.recordDeposit({ txHash: holdingTxHash({ chainId, epoch, retNf: v.retNf }), blockNumber: snap.block, blockTime, depositor: claimAddress, amountWei: '0', priorDepositCount: 0, points, activity: 'holding', chainId })) throw new ClaimRefused('that address does not earn points');
        return true;
      })();
    } catch (err) {
      if (err instanceof ClaimRefused) return reply(422, { error: err.message });         // rolled back whole: the tag is still free to claim for another address
      throw err;
    }
    return reply(200, { credited, points, bucketWei: v.bucketWei.toString() });
  }

  return { cycle, status, nullifiers, claim, draw, open };
}
