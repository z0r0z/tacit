// Sending the open board's settles while this tab is open, from a relay account kept in this browser: no wallet popup per send. A pass
// reads the board, takes the oldest settle whose tETH fee covers its gas with `marginBps` to spare, runs it first with eth_call, and sends
// it through Flashbots Protect, which never includes a transaction that would revert: a settle another sender took first costs nothing.
// One send at a time; a day's gas is capped, and a reserve stays in the account. The fee is paid to the sending account (the pool pays
// every fee leg its proof binds to msg.sender), so the ETH it earns pays for the next ones. Deps are injected so the passes are tested
// (tests/prove-autorelay.test.mjs).
import { POOL, SETTLE_GAS, ethFeeWei, feeWeiOf, feeCovers, pickSettle, settleCalldata } from '../community-ops.js';

export const AUTO_MARGIN_BPS = 2000n;                      // a fifth over the settle's cost, as worker-relay/src/open-relayer.js asks
export const AUTO_DAY_GAS_WEI = 10n ** 16n;                // at most 0.01 ETH of gas a day
export const AUTO_RESERVE_WEI = 2n * 10n ** 15n;           // 0.002 ETH stays in the account
export const PROTECT_BLOCKS = 25;                          // Protect tries a transaction this many blocks, then drops it

const day = (ms) => Math.floor(ms / 86400e3);

// `rpc(method, params)` reads and simulates; `sendPrivate(raw)` sends through Protect; `sign(tx)` → { raw, hash } for the relay account
// at `address`; `board()` and `landed(jobId, txHash)` the API's; `store` { get(), set(v) } keeps the day's figures and the send in flight;
// `taken` holds the ids of the jobs any sender on the page has in hand (the one sent from here among them), which no pass picks.
export function makeAutoRelay({ address, rpc, sign, sendPrivate, board, landed, store, prices = () => null, now = () => Date.now(), taken = new Set(), marginBps = AUTO_MARGIN_BPS, dayGasWei = AUTO_DAY_GAS_WEI, reserveWei = AUTO_RESERVE_WEI }) {
  const passed = new Map();                                // jobs the pool refused here: left alone for ten minutes
  const read = () => {
    const s = store.get() || {};
    return s.day === day(now()) ? s : { day: day(now()), gasWei: '0', earnedWei: '0', sent: 0, inFlight: s.inFlight || null };
  };
  const write = (s) => store.set(s);

  // A send still in flight: landed (counted, reported), dropped (Protect past its blocks), or waiting. → 'landed' | 'reverted' | 'dropped' | 'waiting'
  async function settleInFlight(s) {
    const f = s.inFlight;
    taken.add(f.jobId);
    const r = await rpc('eth_getTransactionReceipt', [f.hash]).catch(() => null);
    if (r) {
      const gas = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice || 0);
      s.gasWei = String(BigInt(s.gasWei) + gas); s.inFlight = null; taken.delete(f.jobId);
      if (r.status === '0x1' || r.status === 1) {
        s.earnedWei = String(BigInt(s.earnedWei) + BigInt(f.feeWei)); s.sent += 1; write(s);
        await landed(f.jobId, f.hash).catch(() => {});
        return 'landed';
      }
      write(s); passed.set(f.jobId, now());
      return 'reverted';
    }
    const head = Number(BigInt(await rpc('eth_blockNumber', [])));
    if (head > f.block + PROTECT_BLOCKS + 2) { s.inFlight = null; taken.delete(f.jobId); write(s); return 'dropped'; }
    return 'waiting';
  }

  // One pass. → { did, why, job?, hash?, bal? }: `did` 'sent' | 'landed' | 'waiting' | 'idle' | 'stopped', `why` in words for the status line,
  // `bal` the account's balance once it was read.
  async function pass() {
    const s = read();
    if (s.inFlight) {
      const hash = s.inFlight.hash, st = await settleInFlight(s);
      if (st === 'waiting') return { did: 'waiting', why: 'A settle is on its way privately; the next waits for it.' };
      if (st === 'landed') return { did: 'landed', why: 'It landed. Its fee is in the relay account.', hash };
    }
    const [balHex, gasHex, blockObj] = await Promise.all([rpc('eth_getBalance', [address, 'latest']), rpc('eth_gasPrice', []), rpc('eth_getBlockByNumber', ['latest', false])]);
    const bal = BigInt(balHex), gasPrice = BigInt(gasHex);
    // An ordinary settle at the node's price: the two stops that need neither the board nor a simulation come first (the same two are
    // asked again of the settle's own estimate below).
    if (BigInt(s.gasWei) + SETTLE_GAS * gasPrice > dayGasWei) return { did: 'stopped', why: 'Today’s gas allowance is used. It goes on tomorrow.', bal };
    if (bal < SETTLE_GAS * gasPrice + reserveWei) return { did: 'stopped', why: 'The relay account needs more ETH for gas: add a little to it.', bal };
    for (const [id, at] of passed) if (now() - at > 10 * 60e3) passed.delete(id);
    const b = await board();
    const px = await prices();
    const job = pickSettle(b.jobs, { costWei: SETTLE_GAS * gasPrice, marginBps, skip: { has: (id) => passed.has(id) || taken.has(id) }, nowMs: now(), prices: px });
    if (!job) return { did: 'idle', why: 'Nothing on the board pays its gas right now.', bal };
    taken.add(job.jobId);
    const letGo = (r) => { taken.delete(job.jobId); return { ...r, bal }; };   // a pass that ends without sending lets its job go
    const data = settleCalldata(job), call = { from: address, to: POOL, data };
    try { await rpc('eth_call', [call, 'latest']); }
    catch { passed.set(job.jobId, now()); return letGo({ did: 'idle', why: 'The next settle would not go through (another sender most likely took it).', job }); }
    const gasLimit = (BigInt(await rpc('eth_estimateGas', [call])) * 6n) / 5n;
    const tip = 10n ** 8n, maxFee = BigInt(blockObj.baseFeePerGas) * 2n + tip, worst = gasLimit * maxFee, fee = feeWeiOf(job.publicValues, px);
    // priced again at its own estimate and today's base fee, before anything is signed
    if (!feeCovers(fee, (BigInt(blockObj.baseFeePerGas) + tip) * gasLimit, marginBps)) { passed.set(job.jobId, now()); return letGo({ did: 'idle', why: 'The next settle’s fee does not cover its gas at its own estimate.', job }); }
    if (BigInt(s.gasWei) + worst > dayGasWei) return letGo({ did: 'stopped', why: 'Today’s gas allowance is used. It goes on tomorrow.' });
    if (bal < worst + reserveWei) return letGo({ did: 'stopped', why: 'The relay account needs more ETH for gas: add a little to it.' });
    const nonce = BigInt(await rpc('eth_getTransactionCount', [address, 'pending']));
    const { raw, hash } = sign({ chainId: 1n, nonce, maxPriorityFeePerGas: tip, maxFeePerGas: maxFee, gasLimit, to: POOL, value: 0n, data });
    const h = await sendPrivate(raw).catch(() => null);
    if (!h) return letGo({ did: 'idle', why: 'Flashbots Protect did not take it; the next pass tries again.', job });
    // what it earns is counted in ETH: its tETH legs only, whatever `prices` made of a TAC leg
    s.inFlight = { jobId: job.jobId, hash: String(h).toLowerCase() === String(hash).toLowerCase() ? hash : h, block: Number(BigInt(blockObj.number)), feeWei: String(ethFeeWei(job.publicValues)) };
    write(s);
    return { did: 'sent', why: 'Sent privately. Waiting for it to land…', job, hash: s.inFlight.hash, bal };
  }

  // The send in flight alone, nothing new sent (the relay off): its state as settleInFlight says it, or null with none on its way.
  async function check() { const s = read(); return s.inFlight ? settleInFlight(s) : null; }

  return { pass, check, today: () => read() };
}
