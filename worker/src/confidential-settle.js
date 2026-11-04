// Confidential settle relay — a prove/settle job queue for the ConfidentialPool.
//
// The relayer POLLS the worker rather than the worker pushing to it: the dapp assembles a confidential op,
// submits the witness here, the relayer claims it via /confidential/job, Groth16-proves the settle guest,
// submits ConfidentialPool.settle(pv, proof, memos) on-chain, then /confidential/ack marks it done. Same
// poll shape as reflection-attest.js, but a multi-job QUEUE (user-initiated) rather than a single
// advancing cursor.
//
// Trust: the worker never proves and never holds funds — it only queues opaque witnesses + relays a
// proof the contract independently verifies against PROGRAM_VKEY. A bad witness just fails to prove.

// A claimed-but-unfinished job is reclaimable after this (prover crash). It outlasts the relay's own per-job limit
// (SETTLE_JOB_TIMEOUT_SECS, 15 min), so a slow proof is never handed to a second prover while the first still runs.
const CLAIM_TTL_MS = 16 * 60 * 1000;
// The open board: a job proved and waiting for any sender. A relay that takes one to send has this long before it
// goes back on the board. A relayed job stays until its own deadline (its holder asked the relay to send it, and the relay
// does once it can); a posted proof leaves after OPEN_TTL_MS if nobody sent it.
const SEND_CLAIM_TTL_MS = 5 * 60 * 1000;
const OPEN_TTL_MS = 24 * 3600 * 1000;
const MAX_OPEN_JOBS = 256;
// Op types whose settle is a plain pool.settle(publicValues, proof, memos) that any account can send. A router-embedded
// proof (wraptransfer, wraplp, wrapswap, wrapcdpmint) pulls from its sender, a bridge mint or a fast-lane exit is pinned to
// a root that moves with the reflection, and an adaptor lock, claim or refund is one leg of a swap whose other leg keys off
// when it lands (a claim's public values carry the completed kernel s), so none of those go on the board.
export const OPEN_TYPES = ['wrap', 'unwrap', 'transfer', 'swap', 'route', 'lp', 'otc', 'bid', 'bridgeburn', 'cdpmint', 'farmbond', 'farmharvest', 'farmunbond', 'cdpclose', 'cdpliquidate', 'cdptopup', 'stealthlock', 'stealthlockbatch', 'stealthclaim', 'stealthrefund', 'sendunwrap', 'lpbond', 'lpremove'];
// A proof posted from elsewhere may also be a wrap-swap whose deposit already waits in the pool (a staged deposit, or one sent first): its settle
// is then a plain pool.settle too, and verifyPosted's simulation refuses one whose deposit is not there, so a proof meant to go with its deposit
// through the router never goes on the board.
export const POSTED_TYPES = [...OPEN_TYPES, 'wrapswap'];
// KV has no compare-and-swap (real Cloudflare KV doesn't either, and this queue must stay portable to
// it — see server/kv-store.mjs), so a plain read-then-write claim races once more than one poller hits
// the same pending job. CLAIM_VERIFY_DELAY_MS narrows that window from "the whole poll interval" to
// milliseconds: see nextJob()'s claim-nonce re-read below.
const CLAIM_VERIFY_DELAY_MS = 400;
// /confidential/submit is permissionless (a bad witness just fails to prove), so the pending queue
// is bounded: each queued op costs a full prove cycle (FIFO, single-prover). New submits past the cap
// are rejected until the relayer drains the backlog; dedup of an in-flight op is unaffected.
const MAX_PENDING_JOBS = 512;
const MAX_JOB_BYTES = 256 * 1024; // op + memos, serialized; the largest real op is ~15 KB

// A relayed exit to an L2 may carry its ConfidentialRouter ExitRecipe, so the relay can call the permissionless
// activateExit(recipe) as soon as the settle lands — otherwise the user has to send it from some wallet, and that
// wallet is then linked to the exit. The worker only checks the recipe's shape; the relay checks it maps to the
// proof's own recipient (escrowAddressFor) and that the bound fee covers the activation before sending anything.
const EXIT_TYPES = ['unwrap', 'sendunwrap'];
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^\d{1,78}$/;
const DATA_RE = /^0x(?:[0-9a-fA-F]{2}){0,4096}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;
function normalizeExit(e) {
  const bad = (what) => { throw new Error(`submitJob: exit recipe has a bad ${what}`); };
  const addr = (v, what) => (ADDR_RE.test(v || '') ? v.toLowerCase() : bad(what));
  const uint = (v, what) => (UINT_RE.test(String(v ?? '')) ? BigInt(v).toString() : bad(what));
  if (!e || typeof e !== 'object' || Array.isArray(e)) bad('shape');
  if (!/^0x[0-9a-fA-F]{64}$/.test(e.exitedAsset || '')) bad('exitedAsset');
  if (!Array.isArray(e.calls) || !e.calls.length || e.calls.length > 16) bad('calls list');            // 16: a staged batch's one wrap per note
  if (!Array.isArray(e.sweepTokens) || !Array.isArray(e.minOuts) || e.sweepTokens.length !== e.minOuts.length || e.sweepTokens.length > 8) bad('sweep list');
  return {
    exitedAsset: e.exitedAsset.toLowerCase(),
    feeAsset: addr(e.feeAsset, 'feeAsset'),
    finalRecipient: addr(e.finalRecipient, 'finalRecipient'),
    deadline: uint(e.deadline, 'deadline'),
    nonce: uint(e.nonce, 'nonce'),
    calls: e.calls.map((c) => {
      if (!c || typeof c !== 'object' || typeof c.push !== 'boolean' || !DATA_RE.test(c.data || '')) bad('call');
      return { target: addr(c.target, 'call target'), value: uint(c.value, 'call value'), token: addr(c.token, 'call token'),
        amount: uint(c.amount, 'call amount'), push: c.push, data: c.data.toLowerCase() };
    }),
    sweepTokens: e.sweepTokens.map((t) => addr(t, 'sweep token')),
    minOuts: e.minOuts.map((v) => uint(v, 'minOut')),
  };
}

// Promise-chain mutex: each fn starts after the previous one settles, whether it resolved or threw.
export function makeLock() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn);
    tail = run.then(() => {}, () => {});
    return run;
  };
}

export function makeConfidentialSettler({ storage, hash, now, feeGate, priceFee, sleep, lock, verifyPosted, expiryOf, refund }) {
  // storage: { getPending()->id[], putPending(id[]), getJob(id)->job|null, putJob(id, job) }
  // feeGate({ type, op }) -> bool : OPTIONAL profitability gate for the relayed (mode:'settle') flow — reject
  //   a fee below the current gas-priced floor (relay-quote.js `passesFloor`) before burning a prove cycle.
  //   Absent ⇒ no gate (the initial relayer can run ungated / fully subsidized).
  // sleep(ms) -> Promise : OPTIONAL, for the claim-verify wait in nextJob/nextBatch. Real callers get a
  // real setTimeout; tests inject an instant resolver so the suite doesn't pay CLAIM_VERIFY_DELAY_MS
  // (real wall-clock time) on every claim.
  // lock(fn) -> Promise : OPTIONAL, runs fn exclusively with respect to every other lock(fn) call sharing the
  //   same lock. The pending list is one shared value that every mutation reads, edits and writes back across
  //   awaits, so overlapping requests would otherwise overwrite each other's edit. Callers that build a fresh
  //   settler per request must pass one lock shared by all of them (buildConfidentialSettler does).
  // verifyPosted({ type, publicValues, proof, memos }) -> { ok, error? } : OPTIONAL, checks a posted proof against the
  //   chain (a simulated settle) before it goes on the board. Absent ⇒ posted proofs are refused.
  // expiryOf({ type, op, publicValues }) -> unix seconds (0 = none) : OPTIONAL, when an open job's settle stops being
  //   valid, so the board drops it then rather than after OPEN_TTL_MS.
  // refund({ day, names }) -> Promise : OPTIONAL, gives back the allowances a job was charged (submitJob's `charge`) when it ends failed
  //   for a reason that was not the holder's: the relay's prover did not run, or the pool moved past the root the op was built on.
  const clock = now || (() => Date.now());
  const exclusive = lock || makeLock();
  const wait = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // The board's ids live apart from the pending queue, so a job waiting for a sender costs the relay's claim scan
  // nothing. A storage without its own list keeps one in memory (tests).
  let memOpen = [];
  const getOpen = storage.getOpen ? () => storage.getOpen() : async () => memOpen.slice();
  const putOpen = storage.putOpen ? (ids) => storage.putOpen(ids) : async (ids) => { memOpen = ids.slice(); };
  const expiresAt = (j) => { try { const s = expiryOf ? Number(expiryOf({ type: j.type, op: j.op, publicValues: j.publicValues })) : 0; return s > 0 ? s * 1000 : 0; } catch { return 0; } };

  // jobId = hash of the witness (type+op[+mode]) → idempotent: resubmitting the same op returns the same job.
  // `settle` uses the id over (type+op); a `prove`-only job for the same op is a DISTINCT id so the two can
  // coexist (e.g. the same deposit consume both prove-only for a router tx and relay-settled).
  function jobIdOf(type, op, mode = 'settle') {
    return hash(JSON.stringify(mode === 'settle' ? { type, op } : { type, op, mode }));
  }

  // mode:
  //   'settle' (default) — the relayer proves AND submits ConfidentialPool.settle() on-chain (the relayed flow).
  //   'prove'            — the relayer proves but does NOT submit; it acks { publicValues, proof } which the
  //                        dapp embeds into a USER-SENT ConfidentialRouter tx (wrapAndSettle* / zapETHToPayment /
  //                        farm bond). The router pulls from msg.sender, so only the user can send it.
  // `mode: 'sealed'`: the page sends no op, only the program input it built encrypted to one prover-board worker's key
  // (dapp/sealed-input.js, `sealed: { worker, epk, iv, ct }`) and the memos. The job is a relayed settle whose witness
  // the API and the relay never read: the relay hands the ciphertext to that worker, checks the proof against the pool
  // and the memos, prices the fee from the proof's own fee legs, and sends. No other prover can take it, so while that
  // worker is away the job fails rather than going elsewhere.
  const SEALED_SHAPE = (x) => x && typeof x === 'object' && typeof x.worker === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(x.worker)
    && typeof x.epk === 'string' && /^0x0[23][0-9a-fA-F]{64}$/.test(x.epk) && typeof x.iv === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(x.iv) && x.iv.length === 16
    && typeof x.ct === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(x.ct) && x.ct.length >= 24 && x.ct.length <= 1_400_000;
  // `charge`: { day, names } — the daily allowances the caller spends on this job once it is accepted. Kept on the job so they can be
  // given back if the relay fails it on its own account (see ackJobLocked); nothing else reads it.
  const chargeOf = (c) => (c && typeof c === 'object' && /^\d{4}-\d{2}-\d{2}$/.test(String(c.day)) && Array.isArray(c.names)
    ? { day: String(c.day), names: c.names.map(String).slice(0, 6) } : null);
  async function submitJob({ type, op, memos, mode = 'settle', feeAsset = null, exit = null, publicValues = null, proof = null, paid = false, sealed = null, charge = null, early = false }) {
    if (mode === 'preproven') return postProven({ type, memos, publicValues, proof, exit });
    if (mode === 'sealed') {
      if (!type || !SEALED_SHAPE(sealed)) throw new Error('submitJob: a sealed job needs type + sealed { worker, epk, iv, ct }');
      if (!OPEN_TYPES.includes(type)) throw new Error(`submitJob: a ${type} cannot be sent sealed (its settle is not a plain pool.settle)`);
      if (exit != null) throw new Error('submitJob: a sealed job cannot carry an exit recipe');
      return submitSealed({ type, sealed, memos: memos || [], feeAsset });
    }
    if (!type || !op) throw new Error('submitJob: type + op required');
    // Drop a caller-supplied feeUsd FIRST, before anything derives from `op`.
    //
    // Position matters as much as the deletion: `jobIdOf(type, op, mode)` hashes the op, so stripping this
    // after the id was computed would let a field the guest never reads vary the job id for an identical op.
    // Removing it here means the id is taken over the op the guest will actually see.
    if (typeof op === 'object' && 'feeUsd' in op) delete op.feeUsd;
    if (!['wrap', 'unwrap', 'transfer', 'swap', 'route', 'lp', 'otc', 'bid', 'bridgeburn', 'cdpmint', 'farmbond', 'farmharvest', 'farmunbond', 'adaptorlock', 'adaptorclaim', 'adaptorrefund', 'cdpclose', 'cdpliquidate', 'cdptopup', 'bridgemint', 'cbtcmint', 'stealthlock', 'stealthlockbatch', 'stealthclaim', 'stealthrefund', 'bridgestealthmint', 'wraptransfer', 'sendunwrap', 'lpbond', 'lpremove', 'batchtransfer', 'wraplp', 'wrapswap', 'wrapcdpmint', 'fastlane'].includes(type)) throw new Error(`submitJob: unknown type ${type}`);
    if (!['settle', 'prove'].includes(mode)) throw new Error(`submitJob: unknown mode ${mode}`);
    // A stored job is re-read and re-serialized on every relay poll and outlives a restart, so its size is
    // bounded at submit. Real ops are ~15 KB.
    if (JSON.stringify({ op, memos: memos || [] }).length > MAX_JOB_BYTES) throw new Error(`submitJob: op + memos exceed ${MAX_JOB_BYTES} bytes`);
    if (exit != null && (mode !== 'settle' || !EXIT_TYPES.includes(type))) {
      throw new Error('submitJob: an exit recipe rides only on a relayed unwrap or sendunwrap');
    }
    const recipe = exit == null ? null : normalizeExit(exit);
    // Profitability gate (relayed flow only): a fee below the current gas-priced floor is rejected BEFORE it
    // costs a prove cycle. `prove` jobs are user-sent (the user pays gas), so they're never gated.
    // Awaited: a real feeGate reads live gas price over RPC, so it can't be synchronous.
    if (mode === 'settle' && feeGate && !(await feeGate({ type, op }))) {
      throw new Error('submitJob: relay fee below the current floor — re-quote higher or self-settle');
    }
    const id = jobIdOf(type, op, mode);
    // A live duplicate needs no pricing; the authoritative dedupe below runs under the lock.
    const seen = await storage.getJob(id);
    const skipPricing = !!seen && seen.status !== 'failed';
    // What this op actually pays us, DERIVED from the op's own fee legs — never taken from the caller.
    //
    // `op` is client JSON and is never trusted for the fee: the value is derived here and the client's copy
    // is dropped before the op is stored.
    let priced = null;
    if (mode === 'settle' && priceFee && !skipPricing) {
      try { priced = await priceFee({ type, op }); }
      catch { priced = null; } // pricing is advisory; never fail a submit because an oracle blinked
    }

    const job = {
      id, type, op, mode, memos: memos || [],
      // Derived fee, for the relay's profitability gate. null feeUsd = "we could not price it", which the
      // relay treats as unpaid work rather than as free permission.
      feeUnits: priced?.feeUnits ?? null,
      feeUsd: priced?.feeUsd ?? null,
      // The public token the fee leg pays out in, from the asset row the pricer resolved (null = unpriced or unknown): what the
      // relay's books count the fee by.
      feeToken: priced?.feeToken ?? null,
      // A prove-only wrap whose deposit tipped the relay: paid work, proved whatever the credit (the relay reads it).
      ...(paid === true ? { paid: true } : {}),
      ...(chargeOf(charge) ? { charge: chargeOf(charge) } : {}),
      // feeAsset: the public ERC20/ETH address of this op's relay FeePayment (native ETH = the zero
      // address / null). The relayer needs it for the relaySettle path so TacitRelayer forwards the right
      // token to the ops fee recipient; the direct-settle path ignores it (fee → msg.sender in-kind).
      feeAsset: feeAsset || null,
      exit: recipe, activateTx: null, activateError: null,
      // `early`: a proof asked for ahead of its press (a form that has settled): taken only once no job someone has pressed is waiting
      ...(early && mode === 'prove' ? { early: true } : {}),
      status: 'pending', createdAt: clock(), claimedAt: 0, txHash: null, error: null,
      publicValues: null, proof: null,
    };
    // Dedupe, backpressure, record and queue entry are one step: the record is what makes a later submit
    // read as a duplicate, so it is only ever left behind together with its queue entry.
    return exclusive(async () => {
      const existing = await storage.getJob(id);
      const pend = await storage.getPending();
      if (existing && existing.status !== 'failed') {
        // A live job that is missing from the queue can never be claimed; queue it again so the duplicate
        // resolves to a job that will actually run.
        const live = existing.status === 'pending' || existing.status === 'proving';
        if (live && !pend.includes(id)) {
          if (pend.length >= MAX_PENDING_JOBS) throw new Error('submitJob: queue full, retry later');
          pend.push(id);
          await storage.putPending(pend);
        }
        return { jobId: id, status: existing.status, deduped: true };
      }
      // Backpressure: bound the unauthenticated queue (a new, non-deduped op only).
      if (!pend.includes(id) && pend.length >= MAX_PENDING_JOBS) {
        throw new Error('submitJob: queue full, retry later');
      }
      await storage.putJob(id, job);
      if (!pend.includes(id)) {
        pend.push(id);
        try { await storage.putPending(pend); }
        catch (e) {
          // Not queued, so not accepted: mark the record failed (resubmittable) rather than leave it as a duplicate.
          try { await storage.putJob(id, { ...job, status: 'failed', error: 'could not be queued' }); } catch { /* the retry path re-queues it */ }
          throw e;
        }
      }
      return { jobId: id, status: 'pending' };
    });
  }

  // A proof made elsewhere (a holder's own prover account) goes straight on the board: there is no witness and nothing to
  // prove. Its id is taken over its public values, so the same proof posted twice is one job, and verifyPosted
  // simulates its settle first, so the board carries only proofs the pool would take at the time they were posted.
  // `exit`: an unwrap proved on the holder's own machine may carry its ConfidentialRouter recipe, which the relay that sends it
  // activates as it does a relayed exit's (it checks there that the recipe's escrow is the recipient the proof pays).
  async function postProven({ type, memos, publicValues, proof, exit = null }) {
    if (!POSTED_TYPES.includes(type)) throw new Error(`submitJob: a ${type} proof cannot be posted for any sender`);
    if (exit != null && !EXIT_TYPES.includes(type)) throw new Error('submitJob: an exit recipe rides only on an unwrap or sendunwrap');
    const recipe = exit == null ? null : normalizeExit(exit);
    if (typeof verifyPosted !== 'function') throw new Error('submitJob: posted proofs are not taken here');
    const pv = String(publicValues || '').toLowerCase(), pf = String(proof || '').toLowerCase();
    const ms = Array.isArray(memos) ? memos.map((m) => String(m).toLowerCase()) : null;
    if (!pv || !pf || !ms) throw new Error('submitJob: a posted proof needs publicValues, proof and memos');
    if (JSON.stringify({ pv, pf, ms }).length > MAX_JOB_BYTES) throw new Error(`submitJob: proof + memos exceed ${MAX_JOB_BYTES} bytes`);
    const id = jobIdOf(type, { publicValues: pv }, 'preproven');
    const seen = await storage.getJob(id);
    if (seen && seen.status !== 'failed') return { jobId: id, status: seen.status, deduped: true };
    const v = await verifyPosted({ type, publicValues: pv, proof: pf, memos: ms });
    if (!v || !v.ok) throw new Error(`submitJob: the pool would not take this proof now${v && v.error ? ` (${v.error})` : ''}`);
    return exclusive(async () => {
      const existing = await storage.getJob(id);
      if (existing && existing.status !== 'failed') return { jobId: id, status: existing.status, deduped: true };
      const open = await getOpen();
      if (open.length >= MAX_OPEN_JOBS) throw new Error('submitJob: the open board is full, retry later');
      const t = clock();
      const job = { id, type, op: null, mode: 'preproven', memos: ms, feeUnits: null, feeUsd: null, feeAsset: null, exit: recipe, activateTx: null, activateError: null,
        status: 'open', createdAt: t, claimedAt: 0, openSince: t, posted: true, txHash: null, error: null, publicValues: pv, proof: pf };
      job.expiresAt = expiresAt(job);
      await storage.putJob(id, job);
      await putOpen([...open.filter((x) => x !== id), id]);
      return { jobId: id, status: 'open' };
    });
  }

  const isOpen = (j) => j.status === 'open' || (j.status === 'sending' && clock() - (j.sendClaimAt || 0) > SEND_CLAIM_TTL_MS);
  const ranOut = (j) => (j.posted && clock() - (j.openSince || j.createdAt || 0) > OPEN_TTL_MS) || (j.expiresAt > 0 && clock() >= j.expiresAt);
  const openView = (id, j) => ({ jobId: id, type: j.type, status: isOpen(j) ? 'open' : 'sending', posted: !!j.posted,
    publicValues: j.publicValues, proof: j.proof, memos: j.memos || [], openSince: j.openSince || j.createdAt || 0,
    expiresAt: j.expiresAt || 0, feeUsd: j.feeUsd ?? null, feeAsset: j.feeAsset || null });

  // The board as anyone reads it, oldest first. A job that ran out (its own deadline, or a day on the board) leaves it as
  // failed; one settled or failed meanwhile is only dropped from the list.
  async function openList({ limit = 32 } = {}) {
    const ids = await getOpen();
    const out = [], gone = [];
    for (const id of ids) {
      const j = await storage.getJob(id);
      if (!j || !(j.status === 'open' || j.status === 'sending')) { gone.push(id); continue; }
      if (ranOut(j)) {
        gone.push(id);
        await exclusive(async () => {
          const cur = await storage.getJob(id);
          if (!cur || !(cur.status === 'open' || cur.status === 'sending') || !ranOut(cur)) return;
          cur.status = 'failed';
          cur.error = cur.expiresAt > 0 && clock() >= cur.expiresAt ? 'expired: nobody sent it before its deadline' : 'expired: nobody sent it within a day';
          await storage.putJob(id, cur);
        });
        continue;
      }
      if (out.length < limit) out.push(openView(id, j));
    }
    if (gone.length) await exclusive(async () => putOpen((await getOpen()).filter((x) => !gone.includes(x))));
    return out;
  }

  // A relay takes one open job to send: the one it names, or the oldest it may take. The job reads 'sending' while that
  // relay has it, and goes back on the board if no ack comes within SEND_CLAIM_TTL_MS. Same claim-nonce narrowing as
  // nextJob().
  async function nextOpen({ id = null } = {}) {
    const ids = id ? [id] : await getOpen();
    for (const jid of ids) {
      const claim = await exclusive(async () => {
        const j = await storage.getJob(jid);
        if (!j || !isOpen(j) || ranOut(j) || !j.publicValues || !j.proof) return null;
        const nonce = crypto.randomUUID();
        j.status = 'sending'; j.sendClaimAt = clock(); j.claimNonce = nonce;
        await storage.putJob(jid, j);
        return { j, nonce };
      });
      if (!claim) continue;
      await wait(CLAIM_VERIFY_DELAY_MS);
      const won = await storage.getJob(jid);
      if (!won || won.claimNonce !== claim.nonce) continue;
      const j = claim.j;
      return { jobId: jid, type: j.type, op: j.op || null, memos: j.memos, mode: 'open', posted: !!j.posted, publicValues: j.publicValues,
        proof: j.proof, feeAsset: j.feeAsset || null, exit: j.exit || null, feeUnits: j.feeUnits ?? null, feeUsd: j.feeUsd ?? null };
    }
    return null;
  }

  // A settled job has no further use for its op (the user's witness) or a sealed input's ciphertext: its id, memos and transaction stay.
  const forgetWitness = (j) => { delete j.op; if (j.sealed) j.sealed = { worker: j.sealed.worker }; };

  // A settle sent outside the relay (by the holder's own account, or another relayer from the board) closes its job once
  // verify(job, txHash) has seen it on chain. Only a job whose public values are known can be checked: open, sending, or
  // proven for its page to send.
  async function landedJob(jobId, txHash, verify) {
    const j = await storage.getJob(jobId);
    if (!j) return { ok: false, reason: 'unknown job' };
    if (j.status === 'settled') return ackView(j);
    if (!j.publicValues || !['open', 'sending', 'proven'].includes(j.status)) return { ok: false, reason: `a ${j.status} job is not closed by a transaction` };
    const v = await verify(j, txHash);
    if (!v || !v.ok) return { ok: false, reason: (v && v.error) || 'that transaction did not settle this job' };
    return exclusive(async () => {
      const cur = await storage.getJob(jobId);
      if (!cur) return { ok: false, reason: 'unknown job' };
      if (cur.status === 'settled') return ackView(cur);
      cur.status = 'settled'; cur.txHash = String(txHash).toLowerCase(); cur.error = null;
      delete cur.broadcastHashes;
      forgetWitness(cur);
      await storage.putJob(jobId, cur);
      // The same proof can sit on the board twice (relayed, and posted by its holder): one landing settles both.
      const ids = await getOpen(), closed = [jobId], pv = String(cur.publicValues).toLowerCase();
      for (const id of ids) {
        if (id === jobId) continue;
        const o = await storage.getJob(id);
        if (!o || !(o.status === 'open' || o.status === 'sending') || String(o.publicValues || '').toLowerCase() !== pv) continue;
        o.status = 'settled'; o.txHash = cur.txHash; o.error = null;
        forgetWitness(o);
        await storage.putJob(id, o);
        closed.push(id);
      }
      await putOpen(ids.filter((x) => !closed.includes(x)));
      const pend = await storage.getPending();
      if (pend.includes(jobId)) await storage.putPending(pend.filter((x) => x !== jobId));
      return ackView(cur);
    });
  }

  // The relayer claims the oldest provable job (FIFO). Claiming flips it to 'proving' so a second poller
  // won't double-prove; a stale claim (crashed prover) is reclaimable after CLAIM_TTL_MS.
  //
  // With more than one poller, a plain read-then-write
  // claim can race: two pollers both read 'pending' before either write lands, both flip it, both prove
  // it. That never risks funds — the contract's own nullifier/deposit-status checks make a duplicate
  // settle a no-op revert, not a double-spend — but it wastes a full proof (real $PROVE cost). Since KV
  // has no compare-and-swap to close the window outright, narrow it with a claim nonce: write it, then
  // re-read after CLAIM_VERIFY_DELAY_MS. Concurrent writes to one key still land in some final order, so
  // exactly one claimant's nonce survives that wait — the other sees a foreign nonce and backs off to try
  // the next candidate instead of also proving this one.
  // `mode`, when given, takes only jobs of that mode ('prove' or 'settle'), oldest first; others stay queued.
  // `openable` takes only a relayed job that may go on the board once proved (the relay proves those while it cannot
  // pay for settles, so a sender can take them).
  async function submitSealed({ type, sealed, memos, feeAsset }) {
    const id = hash(JSON.stringify({ type, sealed: sealed.ct }));
    return exclusive(async () => {
      const seen = await storage.getJob(id);
      if (seen && seen.status !== 'failed') return { jobId: id, status: seen.status, deduped: true };
      const job = {
        id, type, op: null, mode: 'settle', sealed: { worker: sealed.worker, epk: sealed.epk, iv: sealed.iv, ct: sealed.ct }, memos,
        feeUnits: null, feeUsd: null, feeToken: null, feeAsset: feeAsset || null, exit: null, activateTx: null, activateError: null,
        status: 'pending', createdAt: clock(), claimedAt: 0, txHash: null, error: null,
      };
      await storage.putJob(id, job);
      const pend = await storage.getPending();
      if (!pend.includes(id)) { pend.push(id); await storage.putPending(pend); }
      return { jobId: id, status: 'pending' };
    });
  }

  async function nextJob({ mode = null, openable = false } = {}) {
    const pend = await storage.getPending();
    // two passes: every job someone has pressed first, in order, then the proofs asked for ahead of a press
    for (const [i, id] of [...pend, ...pend].entries()) {
      const earlyPass = i >= pend.length;
      // Read-check-write of the job record is one step, so an ack or another claim cannot land between them.
      const claim = await exclusive(async () => {
        const j = await storage.getJob(id);
        if (!j) return null;
        if (mode && (j.mode || 'settle') !== mode) return null;
        if (!!j.early !== earlyPass) return null;
        if (openable && ((j.mode || 'settle') !== 'settle' || !OPEN_TYPES.includes(j.type) || j.exit)) return null;
        const claimable = j.status === 'pending' || (j.status === 'proving' && clock() - (j.claimedAt || 0) > CLAIM_TTL_MS);
        if (!claimable) return null;
        if (j.retryAfter && clock() < j.retryAfter) return null;                // a job the relay failed on its own account waits a little before its one more try
        const nonce = crypto.randomUUID();
        j.status = 'proving'; j.claimedAt = clock(); j.claimNonce = nonce;
        await storage.putJob(id, j);
        return { j, nonce };
      });
      if (!claim) continue;
      const { j, nonce } = claim;
      await wait(CLAIM_VERIFY_DELAY_MS);
      const won = await storage.getJob(id);
      if (!won || won.claimNonce !== nonce) continue; // lost the race — another poller's write landed after ours
      // `mode` tells the relayer whether to submit on-chain ('settle') or just return the proof ('prove').
      // feeUnits/feeUsd are the worker-DERIVED fee (see submitJob). They must ride along or the relay's
      // profitability gate sees undefined and treats every job as unpaid work.
      return { jobId: id, type: j.type, op: j.op, sealed: j.sealed || null, memos: j.memos, mode: j.mode || 'settle', feeAsset: j.feeAsset || null, exit: j.exit || null, feeUnits: j.feeUnits ?? null, feeUsd: j.feeUsd ?? null };
    }
    return null;
  }

  // Claim up to `max` settle-mode jobs that can share ONE settle. The guest proves a batch against one header of
  // roots, so only jobs whose roots agree (and the same chain binding) can travel together — true for anything
  // queued between two settles. Batching splits the settle's gas across its members and stops each settle
  // transaction from being a one-user event. FIFO order is preserved; a job that doesn't fit the batch's roots is
  // simply left for the next round rather than reordered around.
  // Job types that can share one settle. This is NOT a tuning knob: the relay proves a claimed batch as
  // `batchtransfer`, a transfer-specific guest op, so anything added here without a matching guest batch
  // type would be folded by a circuit that does not understand it. Swaps have their own answer — intent
  // batching through OP_SWAP, which amortises the PROOF rather than the gas — and it lives in the dapp
  // coordinator, not here. The relay re-checks this at the point it builds the op.
  const BATCHABLE_TYPES = ['transfer'];
  // `mixed`: every op whose settle is a plain pool.settle may share one (OPEN_TYPES: the same rule as the open board),
  // proved by the relay from one program input over all of them (dapp/sp1-stdin.js batchStdin). Each root an op names
  // must equal what the batch already carries; a root an op leaves out (a wrap has none) fits any batch. A relayed exit
  // stays on its own, since its activation follows its own settle.
  const ROOTS = ['spendRoot', 'bitcoinSpentRoot', 'bitcoinBurnRoot', 'lockSetRoot', 'cdpPositionRoot'];
  const isZero = (v) => !v || /^(0x)?0*$/.test(String(v));

  async function nextBatch({ max = 8, types = BATCHABLE_TYPES, mixed = false } = {}) {
    if (mixed) types = OPEN_TYPES;
    const pend = await storage.getPending();
    const claimed = []; // { id, j, nonce } — verified in one shared wait below, not per-job
    let binding = null;
    const roots = {};
    for (const id of pend) {
      if (claimed.length >= max) break;
      const c = await exclusive(async () => {
        const j = await storage.getJob(id);
        if (!j) return null;
        const claimable = j.status === 'pending' || (j.status === 'proving' && clock() - (j.claimedAt || 0) > CLAIM_TTL_MS);
        if (!claimable) return null;
        if (j.retryAfter && clock() < j.retryAfter) return null;                // a job the relay failed on its own account waits a little before its one more try
        if ((j.mode || 'settle') !== 'settle') return null; // prove-only jobs are user-sent, never batched
        if (!types.includes(j.type)) return null;
        if (mixed && j.exit) return null;
        const op = j.op || {}, b = op.chainBinding;
        if (!b || (!mixed && isZero(op.spendRoot))) return null;
        if (binding === null) binding = b;
        else if (b !== binding) return null;
        const named = ROOTS.filter((k) => !isZero(op[k]));
        if (!mixed && named.some((k) => k !== 'spendRoot')) return null;
        if (named.some((k) => roots[k] !== undefined && String(roots[k]).toLowerCase() !== String(op[k]).toLowerCase())) return null;
        for (const k of named) roots[k] = op[k];
        const nonce = crypto.randomUUID();
        j.status = 'proving'; j.claimedAt = clock(); j.claimNonce = nonce;
        await storage.putJob(id, j);
        return { id, j, nonce };
      });
      if (c) claimed.push(c);
    }
    if (!claimed.length) return [];
    // Same claim-nonce race-narrowing as nextJob() (see its comment) — one shared wait for the whole
    // batch rather than per-job, since a settle-batch call is itself a single latency-sensitive round trip.
    await wait(CLAIM_VERIFY_DELAY_MS);
    const picked = [];
    for (const { id, j, nonce } of claimed) {
      const won = await storage.getJob(id);
      if (!won || won.claimNonce !== nonce) continue; // lost the race for this one — leave it for the next round
      picked.push({ jobId: id, type: j.type, op: j.op, memos: j.memos, mode: 'settle', feeAsset: j.feeAsset || null, exit: j.exit || null, feeUnits: j.feeUnits ?? null, feeUsd: j.feeUsd ?? null });
    }
    return picked;
  }

  // The relayer reports the outcome. 'settle' jobs ack { txHash }; 'prove' jobs ack { publicValues, proof } (no
  // on-chain submit) → status 'proven'. Idempotent: re-acking a terminal-success job returns its artifacts.
  // A settled exit that carries a recipe later acks { activateTx } or { activateError } for its activateExit; a
  // recorded activation tx is final, while a recorded error can still be followed by a tx.
  function recordActivation(j, activateTx, activateError) {
    if (j.status !== 'settled' || !j.exit || j.activateTx) return false;
    if (activateTx && TX_RE.test(String(activateTx))) { j.activateTx = String(activateTx).toLowerCase(); j.activateError = null; return true; }
    if (activateError) { j.activateError = String(activateError).slice(0, 300); return true; }
    return false;
  }
  const ackView = (j) => ({ ok: true, status: j.status, txHash: j.txHash, publicValues: j.publicValues, proof: j.proof, activateTx: j.activateTx || null });

  function ackJob(jobId, ack = {}) { return exclusive(() => ackJobLocked(jobId, ack)); }
  // A failed job sent again as it was, for a failure that was the relay's and not the op's (a prover that could not run, a
  // board that was away): back to pending with the op or sealed input it kept, so the relay takes it once more and a page that
  // asks after it finds it proving, then proven or settled. A job in any other state, or one that kept nothing to prove, is left.
  async function requeueJob(jobId) {
    return exclusive(async () => {
      const j = await storage.getJob(jobId);
      if (!j) return { ok: false, error: 'unknown job' };
      if (j.status !== 'failed') return { ok: false, error: `the job is ${j.status}, not failed` };
      if (!j.op && !(j.sealed && j.sealed.ct)) return { ok: false, error: 'the job keeps nothing to prove again' };
      Object.assign(j, { status: 'pending', claimedAt: 0, error: null, txHash: null, broadcastHashes: null, requeuedAt: clock() });
      await storage.putJob(jobId, j);
      const pend = await storage.getPending();
      if (!pend.includes(jobId)) { pend.push(jobId); await storage.putPending(pend); }
      return { ok: true, jobId, status: 'pending', type: j.type, mode: j.mode || 'settle' };
    });
  }

  // `lane`: where the settle's proof was made, as the relay reports it ('board': Tacit's own machine, the input never left
  // Tacit; 'network-private' or 'network-public': the prover network, with the input readable by the whitelisted prover
  // only or by anyone). Kept on the job so a page can say so.
  const LANES = ['board', 'network-private', 'network-public'];
  // The relay's own words for a proof that did not get made for reasons on its side, and never for reasons in the op.
  const RELAY_SIDE_FAILURE = (m) => /produced no proof|could not make this proof|prover is not available|sealed prover|GPU server|no worker|board_miss|ECONNREFUSED|ETIMEDOUT/i.test(m)
    && !/unexecutable|execution failed|failed to execute|exceeded cycle limit|VKEY|stale|feeGate|reverted|fee below|did not pass/i.test(m);
  const RETRY_DELAY_MS = 3 * 60_000;
  // A failure that was not the holder's: the relay's own, as above, or the pool's burn root moving past the one a bridge mint was built
  // on while it waited, or its deadline passing in the relay's queue, or the relay declining to prove an op that could only revert (it says
  // so: "not proved", "nothing was spent"). The day of free settles was spent on a settle that did not happen, so it is given back (`refund`),
  // once: the charge leaves the job as it is refunded. It also keeps ops that were never going to be proved from using up the allowances.
  const NOT_THE_HOLDERS = (m) => RELAY_SIDE_FAILURE(m) || /moved on while this mint was waiting|0x8a98f245|waited in the queue past its deadline| not proved: |nothing was spent|nothing was taken/i.test(m);
  async function ackJobLocked(jobId, { txHash, error, publicValues, proof, activateTx, activateError, broadcastHashes, settledBy, open, requeue, release, lane }) {
    const j = await storage.getJob(jobId);
    if (!j) return { ok: false, reason: 'unknown job' };
    if (j.status === 'settled' || j.status === 'proven') {
      if (recordActivation(j, activateTx, activateError)) await storage.putJob(jobId, j);
      return ackView(j);
    }
    if (j.status === 'open' || j.status === 'sending') return ackOpenLocked(jobId, j, { txHash, error, settledBy, requeue, release, broadcastHashes });
    if (open && !error && !settledBy) {
      // The relay proved a relayed job it cannot send yet. It goes on the board, where any account may send it (the
      // holder's own included) and is paid its fee; the relay sends it itself once it can. A job that carries an exit
      // recipe, or whose settle is not a plain pool.settle, stays the relay's.
      if ((j.mode || 'settle') !== 'settle' || !OPEN_TYPES.includes(j.type) || j.exit || !publicValues || !proof) return { ok: false, reason: 'this job does not go on the open board' };
      const ids = await getOpen();
      if (ids.length >= MAX_OPEN_JOBS) return { ok: false, reason: 'the open board is full' };
      j.status = 'open'; j.publicValues = publicValues; j.proof = proof; j.openSince = clock(); j.expiresAt = expiresAt(j);
      await storage.putJob(jobId, j);
      await storage.putPending((await storage.getPending()).filter((x) => x !== jobId));
      if (!ids.includes(jobId)) await putOpen([...ids, jobId]);
      return ackView(j);
    }
    // A failure that was the relay's and not the op's (its prover did not run, the board went quiet, a sealed prover was away) is
    // given one more try a few minutes later, when the job still has what it needs to prove: a hiccup then costs the holder a wait,
    // not a press. A failure that names the op (it cannot execute, its root is stale, its fee is short) is final, and so is the second.
    if (error && !j.retried && RELAY_SIDE_FAILURE(String(error)) && (j.op || (j.sealed && j.sealed.ct))) {
      Object.assign(j, { status: 'pending', claimedAt: 0, error: null, retried: true, retryAfter: clock() + RETRY_DELAY_MS, lastError: String(error).slice(0, 300) });
      await storage.putJob(jobId, j);
      const pend = await storage.getPending();
      if (!pend.includes(jobId)) { pend.push(jobId); await storage.putPending(pend); }
      return ackView(j);
    }
    let owed = null;
    if (error) {
      j.status = 'failed'; j.error = String(error);
      if (j.charge && refund && NOT_THE_HOLDERS(String(error))) { owed = j.charge; j.charge = null; }
      // A settle can be given up on and still be included: a private endpoint keeps re-submitting an
      // accepted bundle long after the relay stops waiting. Keeping the hashes on the job is what makes
      // that recoverable at all — the relay's own memory of them dies with the process, and afterwards
      // nobody, including the payer, has a handle on the transaction that may yet land. A later ack
      // carrying a txHash promotes this job to settled; 'failed' is not one of the short-circuits above.
      if (Array.isArray(broadcastHashes) && broadcastHashes.length) {
        j.broadcastHashes = broadcastHashes.slice(0, 8).map((h) => String(h));
      }
    } else if (settledBy) {
      forgetWitness(j);
      // What the job consumes was consumed by a settle found on chain (a deposit settled from elsewhere, by the page
      // itself or another settler): the job is done by that transaction, whichever mode it was asked in.
      j.status = 'settled'; j.txHash = String(settledBy);
      delete j.broadcastHashes;
    } else if ((j.mode || 'settle') === 'prove') {
      if (!publicValues || !proof) { j.status = 'failed'; j.error = 'prove-only ack missing publicValues/proof'; }
      else { j.status = 'proven'; j.publicValues = publicValues; j.proof = proof; }
    } else {
      j.status = 'settled'; j.txHash = txHash || null;
      if (LANES.includes(lane)) j.lane = lane;
      delete j.broadcastHashes; // resolved: the one that landed is j.txHash
      forgetWitness(j);
      recordActivation(j, activateTx, activateError);
    }
    await storage.putJob(jobId, j);
    // Any terminal outcome leaves the pending queue (the job record is kept for status lookups).
    const pend = (await storage.getPending()).filter((x) => x !== jobId);
    await storage.putPending(pend);
    if (owed) { try { await refund(owed); } catch { /* the allowances are approximate by design; a refund that fails is not worth failing the ack for */ } }
    return ackView(j);
  }

  // A job on the board closes when it lands (txHash, or settledBy for a copy found on chain), goes back on the board when
  // the relay that took it chooses not to send it (release), is proved again when its proof no longer fits the chain
  // and the relay holds its witness (error + requeue), and fails otherwise.
  async function ackOpenLocked(jobId, j, { txHash, error, settledBy, requeue, release, broadcastHashes }) {
    const dropOpen = async () => putOpen((await getOpen()).filter((x) => x !== jobId));
    if (txHash || settledBy) {
      j.status = 'settled'; j.txHash = String(txHash || settledBy); j.error = null; forgetWitness(j);
      delete j.broadcastHashes;
      await storage.putJob(jobId, j);
      await dropOpen();
    } else if (release) {
      j.status = 'open'; j.sendClaimAt = 0;
      await storage.putJob(jobId, j);
    } else if (error && requeue && j.op) {
      j.status = 'pending'; j.publicValues = null; j.proof = null; j.claimedAt = 0; j.openSince = 0; j.error = null;
      await storage.putJob(jobId, j);
      await dropOpen();
      const pend = await storage.getPending();
      if (!pend.includes(jobId)) { pend.push(jobId); await storage.putPending(pend); }
    } else if (error) {
      j.status = 'failed'; j.error = String(error);
      if (Array.isArray(broadcastHashes) && broadcastHashes.length) j.broadcastHashes = broadcastHashes.slice(0, 8).map((h) => String(h));
      await storage.putJob(jobId, j);
      await dropOpen();
    } else return { ok: false, reason: 'an open job is closed by txHash, settledBy, release or error' };
    return ackView(j);
  }

  async function jobStatus(jobId) {
    const j = await storage.getJob(jobId);
    if (!j) return null;
    // A 'proven' job carries the artifacts the dapp embeds into the user-sent router tx (publicValues, proof);
    // both are public (they go on-chain in the settle call anyway).
    // `activation` is null for a job without an exit recipe; otherwise 'pending' until the relay reports its
    // activateExit as 'done' (activateTx) or 'failed' (activateError — the user activates it themselves).
    // A proven job's memos are the ones its proof commits to: the settle must carry exactly these, and a page that
    // asks again for the same op (a reload, a second press) sealed different ones. They are sealed to their
    // recipients and go on chain with the settle.
    // A send a relay took and never finished reads open again once its claim lapses.
    const status = j.status === 'sending' && isOpen(j) ? 'open' : j.status;
    // a job waiting its turn: how many are ahead of it in the queue (proving or waiting; a proof asked for ahead of its press waits for
    // the pressed ones, so it does not count ahead of them), so its page can say so
    let ahead = -1;
    if (status === 'pending') {
      const pend = await storage.getPending(), before = pend.slice(0, Math.max(0, pend.indexOf(jobId)));
      ahead = j.early ? before.length : (await Promise.all(before.map((id) => storage.getJob(id)))).filter((x) => x && !x.early).length;
    }
    return { jobId, type: j.type, mode: j.mode || 'settle', status, txHash: j.txHash, error: j.error, lane: j.lane || null, sealed: !!j.sealed,
      createdAt: j.createdAt, ...(ahead >= 0 ? { ahead } : {}), publicValues: j.publicValues || null, proof: j.proof || null,
      // An open job's memos are public for the same reason: any sender needs them, and they go on chain with the settle.
      memos: (j.status === 'proven' || j.status === 'open' || j.status === 'sending') && Array.isArray(j.memos) ? j.memos : null,
      ...(j.status === 'open' || j.status === 'sending' ? { openSince: j.openSince || 0, expiresAt: j.expiresAt || 0, posted: !!j.posted } : {}),
      activation: j.exit ? (j.activateTx ? 'done' : j.activateError ? 'failed' : 'pending') : null,
      activateTx: j.activateTx || null, activateError: j.activateError || null,
      // Published deliberately: on a failed settle these are the only handles on a transaction that may
      // still be included, and they are public the moment they are broadcast. With them the payer can
      // settle the question themselves instead of asking us.
      broadcastHashes: j.broadcastHashes || null };
  }

  // A read-only picture of the queue for the operator: how many jobs are waiting, how many are being proved, and
  // how long the oldest of each has been in that state. Ages, not job details — nothing about any op leaves here.
  // This is what tells "the relay is idle" apart from "the relay has stopped and users are waiting": a queue whose
  // oldest pending job keeps getting older is the signature of a dead or hung settle service.
  async function queueStats() {
    const pend = await storage.getPending();
    const t = clock();
    let pending = 0, proving = 0, oldestPendingMs = 0, oldestProvingMs = 0, pendingSettle = 0, oldestPendingSettleMs = 0;
    for (const id of pend) {
      const j = await storage.getJob(id);
      if (!j) continue;
      if (j.status === 'pending') {
        pending++; oldestPendingMs = Math.max(oldestPendingMs, t - (j.createdAt || t));
        // Only a relayed settle can share a settle with another: a prove-only job is handed back to its page and is never batched.
        if ((j.mode || 'settle') === 'settle' && !j.exit && !(j.retryAfter && t < j.retryAfter)) { pendingSettle++; oldestPendingSettleMs = Math.max(oldestPendingSettleMs, t - (j.createdAt || t)); }
      }
      else if (j.status === 'proving') { proving++; oldestProvingMs = Math.max(oldestProvingMs, t - (j.claimedAt || t)); }
    }
    // `open`: proved jobs waiting on the board for a sender (they are not in the pending queue).
    const open = (await getOpen()).length;
    return { pending, proving, open, pendingSettle, oldestPendingSec: Math.round(oldestPendingMs / 1000), oldestPendingSettleSec: Math.round(oldestPendingSettleMs / 1000), oldestProvingSec: Math.round(oldestProvingMs / 1000) };
  }

  async function pendingCount() {
    const pend = await storage.getPending();
    let n = 0;
    for (const id of pend) { const j = await storage.getJob(id); if (j && (j.status === 'pending' || j.status === 'proving')) n++; }
    return n;
  }

  // A bridge mint waiting for its proof, made current: the op's public half read again (see bridge-armed.js), the holder's half and the memos
  // untouched. `renew(op)` → { ok, op } is called outside the queue's lock (it reads the chain); the job is written only if it is still the
  // one that was read. → { ok, op } | { ok: false, code, error }
  const HOLDERS_HALF = (op) => JSON.stringify([op.chainBinding, op.asset, op.sourceClass, op.spentTxid, op.spentVout, op.input && [op.input.cx, op.input.cy, op.input.owner], op.output, op.rangeProof, op.fee, op.kernel]);
  async function renewJobOp(jobId, renew) {
    const j = await storage.getJob(jobId);
    if (!j) return { ok: false, error: 'unknown job' };
    if (j.type !== 'bridgemint' || !j.op || !['pending', 'proving'].includes(j.status)) return { ok: false, error: 'not a bridge mint waiting for a proof' };
    const r = await renew(j.op);
    if (!r || !r.ok || !r.op) return { ok: false, code: r && r.code, error: (r && r.error) || 'could not be renewed' };
    if (HOLDERS_HALF(r.op) !== HOLDERS_HALF(j.op)) return { ok: false, code: 'bad_renewal', error: 'a renewal may not change the holder\'s half' };
    return exclusive(async () => {
      const now_ = await storage.getJob(jobId);
      if (!now_ || !now_.op || !['pending', 'proving'].includes(now_.status) || JSON.stringify(now_.op) !== JSON.stringify(j.op)) return { ok: false, error: 'the job changed while it was renewed' };
      now_.op = r.op;
      await storage.putJob(jobId, now_);
      return { ok: true, op: r.op };
    });
  }

  return { submitJob, nextJob, nextBatch, ackJob, requeueJob, renewJobOp, jobStatus, pendingCount, queueStats, jobIdOf, openList, nextOpen, landedJob };
}

// KV-backed wiring for the worker runtime. KV keys: cps:pending (id[]), cps:open (id[]), cps:job:<id> (job).
// The worker builds a settler per request, so the queue lock lives per KV namespace, not per settler.
const kvLocks = new WeakMap();
// A job record lives thirty days from its last write: far past the day an open job can wait and the hours a settle takes, and it is gone after.
const JOB_TTL_SECS = 30 * 86400;
export function buildConfidentialSettler(env, { hash, feeGate, priceFee, verifyPosted, expiryOf, refund }) {
  const KV = env.CONFIDENTIAL_KV || env.REGISTRY_KV;
  if (KV && !kvLocks.has(KV)) kvLocks.set(KV, makeLock());
  const storage = {
    getPending: async () => { const s = await KV.get('cps:pending'); return s ? JSON.parse(s) : []; },
    putPending: async (ids) => KV.put('cps:pending', JSON.stringify(ids)),
    getJob: async (id) => { const s = await KV.get('cps:job:' + id); return s ? JSON.parse(s) : null; },
    putJob: async (id, job) => KV.put('cps:job:' + id, JSON.stringify(job), { expirationTtl: JOB_TTL_SECS }),
    getOpen: async () => { const s = await KV.get('cps:open'); return s ? JSON.parse(s) : []; },
    putOpen: async (ids) => KV.put('cps:open', JSON.stringify(ids)),
  };
  return makeConfidentialSettler({ storage, hash, feeGate, priceFee, verifyPosted, expiryOf, refund, lock: kvLocks.get(KV) });
}
