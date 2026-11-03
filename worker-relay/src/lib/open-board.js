// The open board, from the relay's side (the board itself lives on the API: worker/src/confidential-open.js and the
// board half of worker/src/confidential-settle.js). A proof on the board can be sent by any account, which is paid the
// fee legs the proof binds. While the settle wallet cannot pay for a settle, the relay still proves the relayed jobs a
// sender could take and puts them there; once it can pay again it sends those first, then any posted proof whose fee
// covers the settle. Pure, so the choices are unit-tested (worker-relay/tests/open-board.test.mjs).

// Kept equal to worker/src/confidential-settle.js OPEN_TYPES (a test pins the two together): the op types whose settle
// is a plain pool.settle(publicValues, proof, memos). A router-embedded proof pulls from its sender, a bridge mint or a
// fast-lane exit is pinned to a root that moves with the reflection, and an adaptor leg's landing is part of a swap.
export const OPEN_TYPES = ['wrap', 'unwrap', 'transfer', 'swap', 'route', 'lp', 'otc', 'bid', 'bridgeburn', 'cdpmint', 'farmbond', 'farmharvest', 'farmunbond', 'cdpclose', 'cdpliquidate', 'cdptopup', 'stealthlock', 'stealthlockbatch', 'stealthclaim', 'stealthrefund', 'sendunwrap', 'lpbond', 'lpremove'];
// And a posted proof may be a wrap-swap whose deposit already waits in the pool (POSTED_TYPES there, kept equal by the same test).
export const POSTED_TYPES = [...OPEN_TYPES, 'wrapswap'];

// Reverts that mean the proof no longer fits the chain rather than the op being wrong: proved again from the witness.
export const STALE_PROOF_SELECTORS = ['0x8a98f245' /* StaleBitcoinBurnRoot */, '0xb14b466c' /* StaleBitcoinSpentRoot */, '0xe677decb' /* StaleReflectionDigest */];

// A relayed job proved while the settle wallet is short goes on the board only when any account could send it.
export function openable(job) {
  return !!job && (job.mode || 'settle') === 'settle' && OPEN_TYPES.includes(job.type) && !job.exit;
}

// The fee legs a proof binds: [{ assetId, value }] (abi.encode(PublicValues): word 0 the tuple offset, head word 8 the
// offset of `fees`, each FeePayment two words).
export function pvFees(publicValues) {
  const h = String(publicValues || '').replace(/^0x/i, '').toLowerCase();
  const word = (i) => {
    const w = h.slice(i * 64, i * 64 + 64);
    if (w.length !== 64) throw new Error('public values too short');
    return BigInt('0x' + w);
  };
  if (word(0) !== 32n) throw new Error('public values do not start with a tuple offset');
  const off = word(8);
  if (off % 32n !== 0n) throw new Error('fees offset not word aligned');
  const at = 1 + Number(off / 32n), n = Number(word(at));
  if (n > 64) throw new Error('too many fee legs');
  const out = [];
  for (let i = 0; i < n; i++) out.push({ assetId: '0x' + h.slice((at + 1 + 2 * i) * 64, (at + 2 + 2 * i) * 64), value: word(at + 2 + 2 * i) });
  return out;
}

// What a posted proof pays its sender in ETH: the tETH legs at the asset's unit scale. Other assets are not priced here,
// so a proof paid only in them is left for a sender that values them.
export function ethFeeWei(publicValues, { ethAssetId, ethUnitScale }) {
  try {
    const id = String(ethAssetId).toLowerCase();
    return pvFees(publicValues).filter((f) => f.assetId === id).reduce((a, f) => a + f.value * BigInt(ethUnitScale), 0n);
  } catch { return 0n; }
}

// Which open job to send next, or null. The relay's own first (it proved them while it could not send, and their holders
// were told a relay sends them), oldest first; then a posted proof whose tETH fee covers its settle at today's gas with
// `marginBps` to spare. A job that expires within `expiryMarginMs` is left alone: it could not land in time.
export function pickOpen(jobs, { settleCostWei, ethAssetId, ethUnitScale, marginBps = 2000n, nowMs = Date.now(), expiryMarginMs = 120_000 } = {}) {
  const live = (jobs || []).filter((j) => j && j.status === 'open' && j.publicValues && j.proof && (j.posted ? POSTED_TYPES : OPEN_TYPES).includes(j.type)
    && !(j.expiresAt > 0 && j.expiresAt - nowMs < expiryMarginMs));
  const byAge = (a, b) => (a.openSince || 0) - (b.openSince || 0);
  const own = live.filter((j) => !j.posted).sort(byAge);
  if (own.length) return own[0];
  const need = settleCostWei == null ? null : (BigInt(settleCostWei) * (10000n + BigInt(marginBps))) / 10000n;
  if (need == null) return null;
  return live.filter((j) => j.posted && ethFeeWei(j.publicValues, { ethAssetId, ethUnitScale }) >= need).sort(byAge)[0] || null;
}
