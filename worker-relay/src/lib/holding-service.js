// The holding reward as the points service runs it, off by default: reads each EVM pool's events, draws each ended day's
// snapshot, tells clients what to prove against, and credits a verified claim as points to the address it names. All rules
// live in holding-epoch.js (the draw and the binding), holding-state.js (the state at a snapshot) and holding-claims.js (what a
// claim must satisfy); this is the wiring, with its chain, clock and verifier handed in so it can be driven in tests.
//
// cfg: { enabled, rate (points per ETH of bucket per day), buckets (wei, ascending), pool, poolAsset, vkey, delaySecs?, windowDays?,
//        maxPending?, chains: [{ chainId, deployBlock, confirmations?, span?, maxSpan? }] }
// clients: { [chainId]: viem public client }. hash: Poseidon. groth16: { verify }.
import { makeBlockAtOrBefore } from './block-at-time.js';
import { poolStateAt, emptyRootOf } from './holding-state.js';
import { scanHoldingChain } from './holding-scan.js';
import { rootSizeOf } from './evm-pool-snapshot-chain.js';
import { claimableEpochs, snapshotTime, holdingTxHash, DAY, ETH } from './holding-epoch.js';
import { verifyHoldingClaim } from './holding-claims.js';

const reply = (status, body) => ({ status, body });

export function createHolding({ store, cfg, clients, hash, groth16, nowSec = () => Math.floor(Date.now() / 1000), log = () => {}, scan = scanHoldingChain }) {
  const delaySecs = cfg.delaySecs ?? 1800, windowDays = cfg.windowDays ?? 2, maxPending = cfg.maxPending ?? 20;
  const emptyRoot = emptyRootOf(hash);
  const atOrBefore = new Map();
  const blockAt = (chainId) => {
    if (!atOrBefore.has(chainId)) atOrBefore.set(chainId, makeBlockAtOrBefore(async (n) => (await clients[chainId].getBlock({ blockNumber: n })).timestamp));
    return atOrBefore.get(chainId);
  };
  const confirmationsOf = (c) => c.confirmations ?? 12;
  const open = () => claimableEpochs({ nowSec: nowSec(), delaySecs, windowDays });

  // The day's snapshot on one chain, drawn once the day is over and its randomness block is final, and only from events read
  // through the snapshot block and agreeing with the pool's own root history.
  async function draw(epoch, chain) {
    const have = store.holdingSnapshots(epoch).find((s) => s.chainId === chain.chainId);
    if (have) return have;
    const t0 = (epoch + 1) * DAY + delaySecs;
    if (nowSec() < t0 + 900) return null;
    const l1 = clients[1];
    const randomBlock = await blockAt(1)(t0, Number(await l1.getBlockNumber()) - 12);
    const randomHash = (await l1.getBlock({ blockNumber: randomBlock })).hash;
    const moment = snapshotTime({ epoch, chainId: chain.chainId, randomHash });
    const client = clients[chain.chainId];
    const block = Number(await blockAt(chain.chainId)(moment, Number(await client.getBlockNumber()) - confirmationsOf(chain)));
    const cursor = store.loadHoldingCursor(chain.chainId);
    if (cursor === null || cursor < block) return null;                                   // the events are not all read yet
    const state = poolStateAt({ events: store.holdingEvents(chain.chainId, block), block, hash, emptyRoot });
    if (state.size > 0) {
      const known = await rootSizeOf(client, state.root, cfg.pool);
      if (known !== state.size) throw new Error(`chain ${chain.chainId}: the rebuilt root at block ${block} is not one the pool held with ${state.size} leaves (${known})`);
    }
    const snap = { epoch, chainId: chain.chainId, block, moment: Number(moment), root: state.root, nfRoot: state.nfRoot, size: state.size, nullifiers: state.nullifiers.length, takenAt: nowSec() };
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
      for (const epoch of open()) {
        try { await draw(epoch, chain); } catch (err) { log(`holding snapshot day ${epoch} chain ${chain.chainId} failed: ${err?.message || err}`); }
      }
    }
  }

  // Claims are verified one at a time, and a queue past maxPending is refused outright: a proof check is the costly thing a
  // caller can ask of this service.
  let pending = 0, tail = Promise.resolve();
  const queued = (fn) => {
    if (pending >= maxPending) return null;
    pending += 1;
    const p = tail.then(fn).finally(() => { pending -= 1; });
    tail = p.catch(() => {});
    return p;
  };

  function status() {
    if (!cfg.enabled) return { enabled: false };
    return {
      enabled: true, rate: cfg.rate, buckets: cfg.buckets.map(String), asset: String(cfg.poolAsset),
      epochs: open().map((epoch) => ({
        epoch, closesAt: (epoch + windowDays + 1) * DAY + delaySecs,
        chains: store.holdingSnapshots(epoch).map((s) => ({ chainId: s.chainId, block: s.block, moment: s.moment, root: s.root, nfRoot: s.nfRoot, leaves: s.size, nullifiers: s.nullifiers })),
      })),
    };
  }

  // What a client needs beyond the note tree its wallet already keeps: the spent set at the snapshot, which anyone can read.
  function nullifiers(chainId, epoch) {
    if (!cfg.enabled) return reply(404, { error: 'not enabled' });
    const snap = store.holdingSnapshots(epoch).find((s) => s.chainId === chainId);
    if (!snap) return reply(404, { error: 'no snapshot for that day and chain' });
    const nfs = [];
    for (const e of store.holdingEvents(chainId, snap.block)) for (const nf of [e.nf0, e.nf1]) if (BigInt(nf) !== 0n) nfs.push(nf);
    return reply(200, { epoch, chainId, block: snap.block, root: snap.root, nfRoot: snap.nfRoot, nullifiers: nfs });
  }

  async function claim(body) {
    if (!cfg.enabled) return reply(404, { error: 'not enabled' });
    const chainId = Number(body?.chainId), epoch = Number(body?.epoch);
    if (!open().includes(epoch)) return reply(409, { error: 'that day is not open for claims' });
    const chain = cfg.chains.find((c) => c.chainId === chainId);
    if (!chain) return reply(400, { error: 'unknown chain' });
    const snap = store.holdingSnapshots(epoch).find((s) => s.chainId === chainId);
    if (!snap) return reply(409, { error: 'that day\'s snapshot is not drawn yet' });
    const job = queued(() => verifyHoldingClaim({ claim: { chainId, epoch, claimAddress: body.claimAddress, proof: body.proof, publicSignals: body.publicSignals }, snapshot: snap, buckets: cfg.buckets, poolAsset: cfg.poolAsset, vkey: cfg.vkey, groth16 }));
    if (!job) return reply(429, { error: 'busy, try again shortly' });
    const v = await job;
    if (!v.ok) return reply(422, { error: v.reason });
    const points = (Number((v.bucketWei * 1_000_000n) / ETH) / 1e6) * cfg.rate;
    const claimAddress = String(body.claimAddress).toLowerCase();
    const credited = store.db.transaction(() => {
      if (!store.recordHoldingClaim({ epoch, chainId, retNf: v.retNf, claimAddress, bucketWei: v.bucketWei.toString(), points, claimedAt: nowSec() })) return false;
      store.recordDeposit({ txHash: holdingTxHash({ chainId, epoch, retNf: v.retNf }), blockNumber: snap.block, blockTime: nowSec(), depositor: claimAddress, amountWei: '0', priorDepositCount: 0, points, activity: 'holding', chainId });
      return true;
    })();
    return reply(200, { credited, points, bucketWei: v.bucketWei.toString() });
  }

  return { cycle, status, nullifiers, claim, draw, open };
}
