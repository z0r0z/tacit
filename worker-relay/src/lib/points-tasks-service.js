// Task rewards as the points service runs them (rules in lib/points-tasks.js), off unless a tasks budget and an end time are set.
//
// A person does a job's step (sends a transaction), then names its hash: `claim` reads the transaction from the chain, finds
// which steps it completed, fixes each step's reward and records it as a pending claim for the account that sent it. Each cycle
// samples a price quote and credits the pending claims to the ledger, as long as the tasks budget has room and the distributor's
// funding keeps covering the regular daily pot (a claim that waits is credited later, never dropped). The credit is an ordinary
// ledger adjustment, so the next root carries it and nothing about the daily split changes.
//
// A job's steps may be on other chains than Ethereum (`clients`: chain id -> a viem public client; `client` is Ethereum's): a claim
// names its chain, the transaction is read there, and its gas is priced from that chain's own block, in the TAC price of Ethereum
// (a chain's ether is ether). `cfg.chains[id]` may give a chain's `confirmations`, `minAgeSecs` (a block must be this old: a
// chain with fast blocks is not final in twelve of them) and `gas` (the slow-price floor and cap, in wei).
//
// deps: store, cfg, jobs (checked job files), client (a viem public client), quote(amountInWei) -> [{ venue, amountIn, amountOut }]
// (lib/tac-quote.js),
// fundingInputs() -> { heldWei, claimedWei, nextDay } | null, budgetFor(day), graceSecs, nowSec, log.
import { fundingStatus } from './points-funding.js';
import { makeTokenBucket } from './token-bucket.js';
import { deepest } from './tac-quote.js';
import { WAD, slowGasPrice, tacPerEthAt, stepReward, stepsCompleted, stepChain, jobGas, claimId, holdReason } from './points-tasks.js';

const reply = (status, body) => ({ status, body });
const ETH = WAD;
const PRICE_SIZE = WAD / 100n;             // the TAC bought with 0.01 ETH sets the price
const KEEP_QUOTES_SECS = 30 * 86400;
const HASH = /^0x[0-9a-fA-F]{64}$/;

export function createTasks({ store, cfg, jobs, client, clients = {}, quote, fundingInputs, budgetFor, graceSecs, nowSec = () => Math.floor(Date.now() / 1000), log = () => {} }) {
  const enabled = cfg.budgetWei > 0n && cfg.endSec > 0 && jobs.length > 0;
  const confirmations = cfg.confirmations ?? 12;
  const byChain = { 1: client, ...clients };
  const chainCfg = (id) => cfg.chains?.[id] ?? {};
  const gasOpts = (id) => chainCfg(id).gas ?? cfg.gas;
  // Every chain a job has a step on is one the service can read.
  const wanted = [...new Set(jobs.flatMap((j) => j.steps.map((st) => stepChain(j, st))))];
  const missing = wanted.filter((id) => !byChain[id]);
  if (missing.length) throw new Error(`a job has steps on chain(s) ${missing.join(', ')}, which the tasks service has no client for`);
  const idOk = new Map();                    // chain id -> whether its client answers for that chain (a node on another chain would credit a step that never happened)
  const chainIsOwn = async (id) => { if (!idOk.has(id)) idOk.set(id, Number(await byChain[id].getChainId()) === id); return idOk.get(id); };
  const gasNow = new Map();                  // chain id -> the slow gas price at its latest block, for the estimates a page shows
  const sampleEverySecs = cfg.sampleEverySecs ?? 120;
  const allow = makeTokenBucket({ perMin: cfg.claimsPerMin ?? 12, burst: cfg.claimBurst ?? 6 });
  let lastHold = '';

  // ── price quotes ──

  // The other chains' slow gas prices, for the estimates a page shows: read from each chain's latest block every sample period (and
  // at the first cycle, even when a stored quote is recent); one that does not answer keeps its last figure.
  const gasAt = new Map();
  async function refreshGas(t) {
    await Promise.all(wanted.filter((id) => id !== 1 && t - (gasAt.get(id) ?? -Infinity) >= sampleEverySecs).map((id) => {
      gasAt.set(id, t);
      return byChain[id].getBlock({ blockTag: 'latest', includeTransactions: true }).then((b) => gasNow.set(id, slowGasPrice(b, gasOpts(id))), () => gasAt.delete(id));
    }));
  }
  // One reading: the venue that gives the most TAC for one ETH is the deepest, and the TAC that 0.01 ETH buys there is the
  // price. The slow gas price at the chain's latest block is recorded with it, for the live estimates a page shows.
  async function sample() {
    const t = nowSec();
    await refreshGas(t);
    const last = store.latestTaskQuote();
    if (last && t - last.t < sampleEverySecs) return last;
    const [deep, small, block] = await Promise.all([quote(ETH), quote(PRICE_SIZE), client.getBlock({ blockTag: 'latest', includeTransactions: true })]);
    const best = deepest(deep);
    if (!best) throw new Error('no venue quoted TAC');
    const priced = small.find((q) => q.venue === best.venue);
    if (!priced) throw new Error(`${best.venue} did not quote the small size`);
    const q = { t, venue: best.venue, tacPerEth: (priced.amountOut * ETH) / priced.amountIn, gasPrice: slowGasPrice(block, gasOpts(1)) };
    gasNow.set(1, q.gasPrice);
    store.saveTaskQuote(q, t - KEEP_QUOTES_SECS);
    return q;
  }

  const priceWindow = (t) => store.taskQuotes(t - 21600 - 7200, t + 7200);

  // ── claims ──

  // What a transaction completed, as the reply to its claim: each step with its reward, and what became of it.
  // `heads`: the chain's latest block number, read once for all the hashes of one request
  async function claimOne(hash, chain, heads = new Map()) {
    const c = byChain[chain];
    if (!c) return { txHash: hash, status: 'unknown chain', steps: [] };
    let tx, receipt, head;
    try {
      if (!heads.has(chain)) {
        const p = c.getBlockNumber({ cacheTime: 0 });
        heads.set(chain, p);
        p.catch(() => { if (heads.get(chain) === p) heads.delete(chain); });         // (a read that failed is made again for the next hash)
      }
      [tx, receipt, head] = await Promise.all([c.getTransaction({ hash }), c.getTransactionReceipt({ hash }), heads.get(chain)]);
    } catch { return { txHash: hash, status: 'not found', steps: [] }; }
    if (receipt.status !== 'success') return { txHash: hash, status: 'failed', steps: [] };
    const left = (chainCfg(chain).confirmations ?? confirmations) - Number(head - receipt.blockNumber + 1n);
    if (left > 0) return { txHash: hash, status: 'confirming', confirmationsLeft: left, steps: [] };
    const block = await c.getBlock({ blockNumber: receipt.blockNumber, includeTransactions: true });
    const blockTime = Number(block.timestamp);
    const minAge = chainCfg(chain).minAgeSecs ?? 0;
    if (minAge && nowSec() - blockTime < minAge) return { txHash: hash, status: 'confirming', confirmationsLeft: Math.max(1, Math.ceil((minAge - (nowSec() - blockTime)) / 2)), steps: [] };
    const steps = [];
    // The transaction must be on the chain the claim names: a hash is read there, and a step of a job on another chain is not it.
    if (!(await chainIsOwn(chain))) return { txHash: hash, status: 'unknown chain', steps: [] };
    for (const job of jobs) {
      const done = stepsCompleted(job, tx, receipt, chain);
      if (!done.length) continue;
      const jg = jobGas(job);
      for (const { step } of done) {
        const id = claimId(job, step);
        const have = store.taskClaim(id);
        if (have) { steps.push({ job: job.id, step: step.id, ...view1(have), status: have.status === 'credited' ? 'credited' : 'queued' }); continue; }
        if (nowSec() > cfg.endSec) { steps.push({ job: job.id, step: step.id, status: 'ended' }); continue; }
        if (!job.opensAt || blockTime < job.opensAt) { steps.push({ job: job.id, step: step.id, status: 'not open' }); continue; }
        const tacPerEth = tacPerEthAt(priceWindow(blockTime), blockTime);
        if (tacPerEth == null) { steps.push({ job: job.id, step: step.id, status: 'no price yet' }); continue; }
        const gasPriceWei = slowGasPrice(block, gasOpts(chain));
        const wei = stepReward({ gas: step.gas, jobGas: jg, gasPriceWei, tacPerEth, tipBps: cfg.tipBps, floorWei: cfg.floorWei, capWei: cfg.capWei, minWei: step.minWei, maxWei: step.maxWei });
        const quote = { gasPriceWei: String(gasPriceWei), tacPerEth: String(tacPerEth), gas: step.gas, tipBps: String(cfg.tipBps), chainId: chain };
        store.saveTaskClaim({ id, job: job.id, step: step.id, address: tx.from, txHash: hash.toLowerCase(), blockNumber: Number(receipt.blockNumber), blockTime, wei, quote });
        log(`task claim ${id}: ${tx.from} ${wei} wei from ${hash} (chain ${chain})`);
        steps.push({ job: job.id, step: step.id, ...view1(store.taskClaim(id)), status: 'queued' });
      }
    }
    return { txHash: hash, status: steps.length ? 'ok' : 'no step', steps };
  }

  const view1 = (c) => ({ address: c.address, wei: String(c.wei), txHash: c.txHash, state: c.status });

  // body: { txHashes: [0x…], chainId?: 1 }. Anyone may name any transaction: the account credited is the one that sent it.
  async function claim(body, { client: who = 'anon' } = {}) {
    if (!enabled) return reply(404, { error: 'not enabled' });
    const hashes = Array.isArray(body?.txHashes) ? body.txHashes : [];
    if (!hashes.length || hashes.length > 25 || !hashes.every((h) => HASH.test(h))) return reply(400, { error: 'txHashes: 1 to 25 transaction hashes' });
    const chain = body.chainId == null ? 1 : Number(body.chainId);
    if (!Number.isInteger(chain) || !byChain[chain]) return reply(400, { error: 'chainId: a chain the jobs are on' });
    // each hash is a read of the chain: a token for every five of them (a page names a few, so it costs one, as before)
    const distinct = [...new Set(hashes.map((x) => x.toLowerCase()))];
    if (!allow(who, Math.ceil(distinct.length / 5))) return reply(429, { error: 'slow down' });
    const results = [];
    const heads = new Map();
    for (const h of distinct) {
      try { results.push(await claimOne(h, chain, heads)); } catch (err) { log(`task claim ${h} failed:`, err?.message || err); results.push({ txHash: h, status: 'unavailable', steps: [] }); }
    }
    return reply(200, { results });
  }

  // ── crediting ──

  async function applyPending() {
    const pending = store.pendingTaskClaims();
    if (!pending.length) return;
    const inputs = await fundingInputs().catch(() => null);
    let ledger = store.allRewards().reduce((s, r) => s + BigInt(r.cumulativeWei), 0n);
    let credited = store.creditedWithPrefix('task:');
    for (const c of pending) {
      const why = holdReason({
        wei: c.wei, creditedWei: credited, budgetWei: cfg.budgetWei, nowSec: nowSec(), endSec: cfg.endSec, reserveDays: cfg.reserveDays ?? 2,
        status: (extra) => (inputs ? fundingStatus({ heldWei: inputs.heldWei, claimedWei: inputs.claimedWei, ledgerWei: ledger + extra, budgetFor, nextDay: inputs.nextDay, graceSecs }) : null),
      });
      if (why) {
        if (why !== lastHold) { lastHold = why; log(`task credits wait: ${why} (${pending.length} pending)`); }
        if (why === 'ended') break;
        continue;
      }
      if (store.creditTaskClaim(c.id)) { credited += c.wei; ledger += c.wei; lastHold = ''; log(`task credit ${c.id}: ${c.wei} wei to ${c.address}`); }
    }
  }

  async function cycle() {
    if (!enabled) return;
    try { await sample(); } catch (err) { log('task quote failed:', err?.message || err); }
    try { await applyPending(); } catch (err) { log('task credits failed:', err?.message || err); }
  }

  // ── what a page shows ──

  // The live estimate for each step, the budget, and every claim (or one account's, with `address`).
  function view({ address = null } = {}) {
    if (!enabled) return { enabled: false };
    const latest = store.latestTaskQuote();
    const t = nowSec();
    const tacPerEth = latest ? tacPerEthAt(priceWindow(latest.t), latest.t) : null;
    const claims = store.taskClaims().filter((c) => !address || c.address === address.toLowerCase());
    const credited = store.creditedWithPrefix('task:');
    const pendingWei = store.pendingTaskClaims().reduce((s, c) => s + c.wei, 0n);
    const fresh = latest && t - latest.t <= 3600 && tacPerEth != null;
    return {
      enabled: true,
      endSec: cfg.endSec,
      budget: { totalWei: String(cfg.budgetWei), creditedWei: String(credited), pendingWei: String(pendingWei), remainingWei: String(cfg.budgetWei > credited + pendingWei ? cfg.budgetWei - credited - pendingWei : 0n) },
      terms: { tipBps: String(cfg.tipBps), floorWei: String(cfg.floorWei), capWei: String(cfg.capWei) },
      quote: latest ? { t: latest.t, venue: latest.venue, tacPerEthWei: tacPerEth == null ? null : String(tacPerEth), gasPriceWei: latest.gasPrice, fresh } : null,
      jobs: jobs.map((job) => {
        const jg = jobGas(job);
        const steps = job.steps.map((s) => {
          const c = store.taskClaim(claimId(job, s));
          const price = gasNow.get(stepChain(job, s)) ?? (stepChain(job, s) === 1 ? latest.gasPrice : null);
          const estimateWei = fresh && price != null ? stepReward({ gas: s.gas, jobGas: jg, gasPriceWei: BigInt(price), tacPerEth, tipBps: cfg.tipBps, floorWei: cfg.floorWei, capWei: cfg.capWei, minWei: s.minWei, maxWei: s.maxWei }) : null;
          return { id: s.id, chainId: stepChain(job, s), estimateWei: estimateWei == null ? null : String(estimateWei), claim: c ? view1(c) : null };
        });
        return { id: job.id, estimateWei: steps.every((s) => s.estimateWei != null) ? String(steps.reduce((n, s) => n + BigInt(s.estimateWei), 0n)) : null, steps };
      }),
      claims: claims.map((c) => ({ job: c.job, step: c.step, ...view1(c), blockTime: c.blockTime })),
    };
  }

  return { enabled, cycle, claim, view, sample };
}
