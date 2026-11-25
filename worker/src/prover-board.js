// The prover board: proofs the relay wants made, for workers that pull them. The relay posts a program input (the
// bincode SP1Stdin a page or the relay builds, dapp/sp1-stdin.js) with the class of work it is; a worker with a token for
// that class claims the oldest, proves it on its own machine and posts the proof back; the relay reads it, checks it against
// the pool (a simulated settle) and sends it, or falls back to the prover network when nobody took the job in time.
//
// Classes: 'private' carries a user's witness and goes only to workers whose token names that class (Tacit's own machines
// at first); 'public' is work whose input is public anyway and may go to any worker with a token; 'eth-state' is the
// Ethereum-state proof the Bitcoin reflection verifies inside itself (program 'eth-state', eth_prove's input), which goes to
// workers whose token names that class or 'private' (a machine trusted with users' witnesses is trusted with this). A claim
// is a lease: a worker that goes quiet past it loses the job to the next claim, with no bond and no penalty beyond the
// record. Nothing here verifies a proof; the relay does, before anything is sent or paid for.
//
// Programs: 'confidential' (the pool's settle guest, proved groth16: the proof is the hex settle() takes), 'eth-state'
// (proved compressed: the proof is the base64 of the bincode SP1ProofWithPublicValues, which eth_prove's finish mode checks) and
// 'btc-state' (the Bitcoin reflection guest, proved groth16: the proof is the hex attestBitcoinStateProven takes; its input is Bitcoin's
// blocks and a public Ethereum proof, so it is public work, large and slow: kept under its own key and leased for longer).
// 'tacit-block' (the tacit chain's block program, proved groth16: the proof is the hex TacitBlocks.land takes; its input is the block's
// spends, each already proven by its owner, and the chain's public state, so it is public work that community machines race, the leader
// checking each candidate with a simulated landing).
// A worker says which programs it proves when it claims (old workers say nothing: 'confidential'), and is offered only those.
//
// Storage (KV, portable to Cloudflare's): pb:pending (ids, oldest first), pb:job:<id>, pb:stdin:<id> (a btc-state input, kept apart like
// a proof and deleted with its job), pb:proof:<id> (a compressed proof,
// kept apart from its job so the record every claim reads stays small), pb:workers (name → record), pb:day:<day> (the UTC day's
// community proofs taken, per address, and the points they earned: GET /prover/board/credits, which the points service pays from).

export const PROVER_BOARD = Object.freeze({
  classes: Object.freeze(['private', 'public', 'eth-state']),
  programs: Object.freeze(['confidential', 'eth-state', 'btc-state', 'tacit-block']),
  // Each program's proof mode and the classes its jobs may carry.
  modes: Object.freeze({ confidential: 'groth16', 'eth-state': 'compressed', 'btc-state': 'groth16', 'tacit-block': 'groth16' }),
  programClasses: Object.freeze({ confidential: Object.freeze(['private', 'public']), 'eth-state': Object.freeze(['eth-state']), 'btc-state': Object.freeze(['public']), 'tacit-block': Object.freeze(['public']) }),
  maxCompressedProofBytes: 2 * 1024 * 1024,            // a compressed proof of the eth-reflection guest is about 1.3 MB
  leaseMs: 5 * 60_000,                                 // a claim lasts this long without a result
  leaseMsByProgram: Object.freeze({ 'btc-state': 2 * 3600_000, 'tacit-block': 15 * 60_000 }), // a Bitcoin batch is billions of cycles; a block, millions
  // Programs whose input is kept under its own key (pb:stdin:<id>) and read only for the claim that proves it, not on every read of the job.
  keptInput: Object.freeze(['btc-state']),
  keepMs: 60 * 60_000,                                 // a finished or cancelled job stays readable this long
  maxPending: 64,                                      // jobs waiting or being proved, together: a post past this is refused (the relay then goes to the network, minutes slower)
  // The list also holds the jobs that finished in the last keepMs, and every call reads the whole list; so it has a ceiling of its own, well past what a busy hour adds to it.
  // (Counting those finished jobs toward maxPending turned a board with nothing waiting into a full one once an hour's proofs reached 64.)
  maxRetained: 256,
  // Room kept past `maxPending` for a swap or liquidity proof (see urgentLabel): the pool moves under such a proof every minute or so, so a proof that cannot be posted goes to the network, minutes slower.
  urgentReserve: 16,
  maxStdinBytes: 1024 * 1024,                          // bincode SP1Stdin, uncompressed (a batch of eight ops is well under)
  // eth_prove's input carries one light-client update per sync-committee period since the last landed proof: ~120 KB a cycle,
  // 2 MB from a cold start (34 periods, measured 2026-10-26), so a run of missed landings still fits.
  maxStdinBytesByProgram: Object.freeze({ 'eth-state': 4 * 1024 * 1024, 'btc-state': 16 * 1024 * 1024 }),
  maxOpenPerWorker: 2,
  // Community provers (no token): anyone may race Tacit's own workers for 'public' jobs, whose input holds nothing secret. A community
  // claim takes the job from no one, and a community proof does not close it: it waits beside the job as a candidate, the relay checks it
  // (a simulated settle, as for any board proof; a wrap proved before its deposit is in the pool is judged by the SP1 verifier instead, and a
  // community proof for it must consume exactly the job's deposits and, for a plain wrap, have exactly its wrap's public values) and takes
  // the first that passes, while Tacit's own worker goes on with the job. So the race is open: the first sound proof wins, and a slow machine never
  // holds a user's op up. A bad proof costs the relay one check and its maker a mark, nothing more.
  // A machine is named by the address its points go to, which anyone may name, so a race is held by the place it was claimed from (the
  // worker's `client`: the network it asks from, as the relay's queue counts senders): only that place may answer it, and one place races one
  // job at a time under an address without holding up the same address elsewhere.
  // A Bitcoin batch is not raced: it is tens of minutes on a large GPU, so the machines that prove it take turns, one to a batch. A batch
  // goes to the machine longest since its last turn of those waiting for one (asked for work in the last turnSeenMs, proving nothing), and
  // a machine asking from a place whose last turn was refused, given back or not answered goes after the others for turnTroubleMs, whatever
  // address it names. A turn not answered leaves the batch to the prover network once the relay stops waiting, as a batch nobody took would.
  // Batches also go by record: bestPct of them (chosen by the batch's id) go to the fastest machines that have one, in turn among the bestOf
  // fastest waiting and in no trouble (once at least two machines with a record are waiting: until then the batch goes in turn, and a machine
  // that has never had a turn comes first, so records form among many machines and not one); a record is the batches the relay took from a machine and its usual time from turn to proof per MB of
  // input (a batch with more Bitcoin blocks has more input and takes longer), so it is earned only by proving. A machine with a record has
  // turnLeaseFactor times its usual time for a batch of that size (at least turnLeaseMinMs) to answer a turn before the batch goes on to the
  // next; one without keeps the batch's lease.
  // A Tacit chain block is wanted fast (a user is waiting on it) but should not belong to whichever machine answers first every time: in an
  // open race the fastest wins all of them (on 2026-11-16 one machine took 22 of 22 in about five seconds each, with 37 others waiting), so the
  // chain has one prover in practice, and losing it means slow blocks until another warms up. So drawPct of blocks (by the block's id) go by
  // DRAW first, as Bitcoin blocks do: a lottery among the places waiting for one, each place's odds its speed (1 / its usual seconds per block,
  // like a share of hashpower), drawNew hundredths of the odds kept for places with no record yet so new machines can earn one. Those go to a
  // few of them at a time, not to all: the drawSeats that have waited longest hold a ticket each, and a place that is drawn goes to the back of
  // the line (one that takes the block has a record from then on), so a newcomer's turn comes in order and is worth having, where spread over
  // thirty it was worth a fraction of a hundredth each. The fastest still wins most; the others win their share and stay warm. One ticket per place (its fastest machine), as in the proof pool, so more
  // addresses on one connection buy no more odds. The block waits drawOfferMs for the drawn machine to take it and then drawFactor times its
  // usual time (at least drawMinMs; drawNewMs for one with no record); one that lets it lapse, gives it back or answers wrongly opens it to the
  // race at once, and its place goes after the others for turnTroubleMs. A machine whose usual block takes over drawMaxSecs is left to the race.
  // Only machines that asked for work in the last drawFreshMs are drawn. A drawn machine that has not asked by the time the offer ends costs
  // the user the whole offer (drawOfferMs) and then the race's start: on 2026-11-17 over half the draws to machines other than the fastest ended
  // that way, a machine busy with another proof or between slow asks having been drawn because it had asked within turnSeenMs (30 s). One that asked
  // a moment ago is about to ask again and sees the block inside its offer.
  drawPrograms: Object.freeze(['tacit-block']),
  drawPct: 0,                                          // PROVER_BOARD_BLOCK_DRAW_PCT: blocks that go by draw first, in hundredths (0: all raced)
  drawNew: 15,                                         // PROVER_BOARD_BLOCK_DRAW_NEW: hundredths of the odds for places with no block record
  drawSeats: 3,                                        // PROVER_BOARD_BLOCK_DRAW_SEATS: places with no block record that hold a ticket at a time (the longest waiting)
  drawOfferMs: 15_000,
  drawFreshMs: 6_000,                                  // PROVER_BOARD_BLOCK_DRAW_FRESH_MS: a machine is drawn only if it asked for work within this long
  drawFactor: 3,
  drawMinMs: 20_000,
  drawNewMs: 45_000,
  drawMaxSecs: 60,
  offerHoldMs: 60_000,                                  // a program a machine named in a claim this recently is still one it offers (its latest claim may name fewer)
  // Past drawHedgeFactor times its usual time (at least drawHedgeMinMs; drawNewHedgeMs for a machine with no record) the drawn machine is
  // joined by the race but keeps its claim, so a slow draw costs a user little and the drawn machine still wins if it is first.
  drawHedgeFactor: 1.0,                                // was 1.5 (2026-11-18): a block drawn to a 15-30 s machine waited 22-45 s before the race joined; now it waits that machine's usual time
  drawHedgeMinMs: 10_000,
  drawNewHedgeMs: 30_000,
  communityRacers: 8,                                  // community machines racing one job at most
  communityPrograms: Object.freeze(['confidential', 'btc-state', 'tacit-block']), // what a community machine may race, when it says it proves it
  communityOpen: 1,                                    // jobs one community machine races at a time
  turnPrograms: Object.freeze(['btc-state']),          // community jobs given to one machine at a time, in turn
  turnSeenMs: 30_000,
  turnTroubleMs: 6 * 3600_000,
  bestPct: 50,                                         // PROVER_BOARD_BEST_PCT: batches that go by record, in hundredths (0: every batch in turn)
  bestOf: 3,                                           // PROVER_BOARD_BEST_OF: the fastest machines those batches go round
  bestRecordMin: 1,                                    // batches taken before a machine has a record
  turnLeaseFactor: 3,
  turnLeaseMinMs: 5 * 60_000,
  // A turn's lease is renewable: a machine that is still working checks in (beat) with a count of what it has proved so far (shards), and each check-in that
  // shows more than the last starts its lease afresh, so a batch is never cut off for being slower than its size suggested (proving time follows the
  // batch's contents, not its megabytes). The turn goes on when the check-ins stop, or at turnHardCapMs from its start. PROVER_BOARD_TURN_CAP_MS
  turnHardCapMs: 6 * 3600_000,
  // A batch's first machine, once its turn has run out and the batch has gone on to the next, may still answer: its proof is taken while the batch is open, as any sound proof is
  // (0: refused, as before). PROVER_BOARD_TURN_LATE
  turnLate: 1,
  // Community machines get first pick of public work: while one that proves a job's program is ready (asked lately, racing nothing else) or
  // is already racing the job, Tacit's own workers leave the job for this long after it was posted, then take it as before (a press keeps a
  // bound on its wait: Tacit's GPU still proves it if no community proof has come by then). Private work is never held.
  communityFirstMs: Object.freeze({ confidential: 20_000, 'tacit-block': 120_000 }), // PROVER_BOARD_FIRST_MS, PROVER_BOARD_BLOCK_FIRST_MS (0: no wait)
  communityKept: 200,                                  // community records kept on the summary (the most recently seen)
  // A community machine's ask is answered without the board's lock when a look at the open jobs, at most communityViewMs old and made before any
  // job changed, shows none it could race; its sighting is kept in memory and written to storage every communityFlushMs. PROVER_BOARD_COMMUNITY_FAST=0
  // sends every ask through the lock.
  communityFast: 1,
  communityViewMs: 1_000,                              // PROVER_BOARD_VIEW_MS
  communityFlushMs: 5_000,
  communityKeepSeenMs: 10 * 60_000,                    // a sighting kept in memory is dropped after this long unrenewed
  maxCandidatePvBytes: 16 * 1024,                      // a race candidate's public values (a wrap's or a Bitcoin batch's are a few KB)
  pointsPerProof: 20,                                  // POINTS_BOARD_PER_PROOF: for each community proof the relay takes
  // A Bitcoin batch is billions of cycles, tens of minutes on a large GPU: it earns its own.
  pointsByProgram: Object.freeze({ 'btc-state': 1000, 'tacit-block': 100 }), // POINTS_BOARD_BTC_PER_PROOF; a block, a few minutes of GPU
  proofsPerMinerDay: Infinity,                         // POINTS_BOARD_DAILY_CAP: proofs an address is credited for in a UTC day (none: every proof)
  daySecs: 40 * 86400,                                 // a day's tally outlives the campaign's reading of it
});

// The board's points from the environment, each checked: a value out of range keeps the default, and 0 points pays nothing. A count a day of
// 0 or none is no count: the campaign's daily pot bounds what is paid.
export function proverBoardConfig(env = {}) {
  const n = (v, dflt, lo = 0) => {
    if (v === undefined || v === null || v === '') return dflt;
    const x = Number(v);
    return Number.isInteger(x) && x >= lo && x <= 100_000 ? x : dflt;
  };
  const pct = n(env.PROVER_BOARD_BEST_PCT, PROVER_BOARD.bestPct);
  return Object.freeze({
    pointsPerProof: n(env.POINTS_BOARD_PER_PROOF, PROVER_BOARD.pointsPerProof),
    proofsPerMinerDay: n(env.POINTS_BOARD_DAILY_CAP, PROVER_BOARD.proofsPerMinerDay, 1),
    pointsByProgram: Object.freeze({ 'btc-state': n(env.POINTS_BOARD_BTC_PER_PROOF, PROVER_BOARD.pointsByProgram['btc-state']), 'tacit-block': n(env.POINTS_BOARD_BLOCK_PER_PROOF, PROVER_BOARD.pointsByProgram['tacit-block']) }),
    communityFirstMs: Object.freeze({ confidential: n(env.PROVER_BOARD_FIRST_MS, PROVER_BOARD.communityFirstMs.confidential), 'tacit-block': n(env.PROVER_BOARD_BLOCK_FIRST_MS, PROVER_BOARD.communityFirstMs['tacit-block']) }),
    bestPct: pct <= 100 ? pct : PROVER_BOARD.bestPct,
    bestOf: n(env.PROVER_BOARD_BEST_OF, PROVER_BOARD.bestOf, 1),
    drawPct: Math.min(100, n(env.PROVER_BOARD_BLOCK_DRAW_PCT, PROVER_BOARD.drawPct)),
    drawNew: Math.min(90, n(env.PROVER_BOARD_BLOCK_DRAW_NEW, PROVER_BOARD.drawNew)),
    drawSeats: Math.min(50, n(env.PROVER_BOARD_BLOCK_DRAW_SEATS, PROVER_BOARD.drawSeats, 1)),
    drawFreshMs: Math.min(PROVER_BOARD.turnSeenMs, n(env.PROVER_BOARD_BLOCK_DRAW_FRESH_MS, PROVER_BOARD.drawFreshMs, 1000)),
    communityFast: n(env.PROVER_BOARD_COMMUNITY_FAST, PROVER_BOARD.communityFast) === 0 ? 0 : 1,
    turnLate: n(env.PROVER_BOARD_TURN_LATE, PROVER_BOARD.turnLate) === 0 ? 0 : 1,
    turnHardCapMs: n(env.PROVER_BOARD_TURN_CAP_MS, PROVER_BOARD.turnHardCapMs, 60_000),
    communityViewMs: n(env.PROVER_BOARD_VIEW_MS, PROVER_BOARD.communityViewMs),
  });
}
const DAY_MS = 86_400_000;
const dayOf = (t) => Math.floor(t / DAY_MS);

// Whether a batch goes by record: a fixed hundredth from its id (FNV-1a), under `pct`.
export function goesByRecord(id, pct) {
  if (!(pct > 0)) return false;
  let h = 2166136261;
  for (const ch of `best|${id}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h % 100 < pct;
}
// A 32-bit hash of a string (FNV-1a, then a finalizer so near-identical inputs land far apart).
function hash32(s) {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b) >>> 0; h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}
// Whether a block goes by draw: a fixed hundredth from its id, under `pct`.
export function goesByDraw(id, pct) {
  return pct > 0 && hash32(`draw|${id}`) % 100 < pct;
}
// The draw for one job: each ticket [key, weight] gets -ln(u)/weight with u from (job, key), and the least wins, so a ticket wins with odds
// in proportion to its weight. Fixed by the job's id: every machine asking about the job reads the same winner, and it cannot be known before
// the job exists. Returns the winning key, or null.
export function drawWinner(jobId, tickets) {
  let best = null, bestV = Infinity;
  for (const [key, weight] of tickets) {
    if (!(weight > 0)) continue;
    const u = (hash32(`draw|${jobId}|${key}`) + 0.5) / 4294967296;
    const v = -Math.log(u) / weight;
    if (v < bestV || (v === bestV && key < best)) { bestV = v; best = key; }
  }
  return best;
}

// PROVER_WORKER_TOKENS: "name:token[:class+class],name:token" — each worker's name, its bearer token and the classes it may
// claim (default: public only). A token under 16 characters is ignored, so a typo cannot open the board.
export function parseWorkerTokens(raw) {
  const out = [];
  for (const part of String(raw || '').split(',')) {
    const [name, token, classes] = part.trim().split(':');
    if (!name || !token || token.length < 16 || !/^[A-Za-z0-9_.-]{1,40}$/.test(name)) continue;
    const cls = (classes || 'public').split('+').map((c) => c.trim()).filter((c) => PROVER_BOARD.classes.includes(c));
    // A token trusted with users' witnesses may prove the Ethereum-state input too, and public work, which is less.
    if (cls.includes('private') && !cls.includes('eth-state')) cls.push('eth-state');
    if (cls.includes('private') && !cls.includes('public')) cls.push('public');
    out.push({ name, token, classes: cls.length ? cls : ['public'] });
  }
  return out;
}
// The worker a bearer token names, or null. Constant-time per token, so a token cannot be guessed letter by letter.
export function workerOf(authorization, raw) {
  const m = /^Bearer (.+)$/.exec(String(authorization || ''));
  if (!m) return null;
  for (const w of parseWorkerTokens(raw)) {
    if (w.token.length !== m[1].length) continue;
    let diff = 0;
    for (let i = 0; i < w.token.length; i++) diff |= w.token.charCodeAt(i) ^ m[1].charCodeAt(i);
    if (diff === 0) return { name: w.name, classes: w.classes };
  }
  return null;
}

const isHex = (s, bytes) => typeof s === 'string' && /^0x[0-9a-fA-F]*$/.test(s) && (bytes == null || s.length === 2 + 2 * bytes);
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const b64len = (s) => Math.floor(s.length * 3 / 4) - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);

// One thing at a time over a board's storage. Every post, claim, result and cancel waits behind it, and a pass under it used to take about a second (it read
// every retained job, up to four times over, one after another), while ~150 community machines and the house workers ask every few seconds: on 2026-11-22 a
// post waited ~14 s at the median (p90 20 s: the relay's own 20 s limit sent those jobs to the network instead) and so did a house worker's claim.
// Calls with `{ first: true }` (the relay's post, cancel and verdict, a house worker's claim, anyone's result) go ahead of the community's asks that are waiting; a
// community ask that has waited `agingMs` is taken before them, so a steady stream of urgent calls cannot starve the community's racing. Each class is first in, first out.
export function makeBoardLock({ agingMs = 1500, now = Date.now } = {}) {
  const urgent = [], rest = [];
  let busy = false;
  const next = () => {
    if (busy) return;
    const oldest = rest[0];
    const turn = oldest && now() - oldest.at >= agingMs ? rest.shift() : (urgent.shift() || rest.shift());
    if (!turn) return;
    busy = true;
    Promise.resolve().then(turn.fn).then(turn.res, turn.rej).then(() => { busy = false; next(); });
  };
  return (fn, { first = false } = {}) => new Promise((res, rej) => { (first ? urgent : rest).push({ fn, res, rej, at: now() }); next(); });
}
const makeLock = makeBoardLock;

// The input is a user's witness: it stays on a record only while a worker may still need it (queued or claimed) and is
// dropped the moment the job is over, and a record leaves storage when it leaves the list.
// storage: { getPending()->id[], putPending(id[]), getJob(id)->job|null, putJob(id, job), deleteJob?(id), getWorkers()->{}, putWorkers({}),
// getDay?(day)->rec|null, putDay?(day, rec), getTrouble?()->{ place: at }, putTrouble?({}) } (without the day records nothing is tallied for
// points; without the trouble record no place waits behind the others for a turn that went wrong).
// What a board keeps in memory beside its storage: a count of changes to jobs, the last look at the open jobs, the community machines' sightings
// not yet written, and the names of machines it has seen. buildProverBoard makes a board for every request, so this is kept per storage, as the lock is.
export const newBoardMemory = () => ({ epoch: 0, view: null, presence: new Map(), known: new Set(), flushedAt: 0, pending: null,
  asks: { fast: 0, rechecked: 0, first: 0, stale: 0, maybe: { open: 0, turn: 0, draw: 0 } } });

// The storage with its writes to jobs and to the pending list counted in `mem.epoch`: a look at the open jobs is out of date once the count has moved.
// The pending list written again as it was last written changes nothing, and is not counted.
function counted(raw, mem) {
  const s = { ...raw };
  for (const name of ['putJob', 'deleteJob']) if (raw[name]) s[name] = (...args) => { mem.epoch++; return raw[name](...args); };
  if (raw.putPending) s.putPending = (ids) => {
    const text = JSON.stringify(ids);
    if (text !== mem.pending) { mem.epoch++; mem.pending = text; }
    return raw.putPending(ids);
  };
  return s;
}

export function makeProverBoard({ storage: raw, hash, now, lock, memory, cfg = PROVER_BOARD } = {}) {
  if (!raw) throw new Error('prover-board: storage is required');
  const mem = memory || newBoardMemory();
  const storage = counted(raw, mem);
  const clock = now || (() => Date.now());
  const pay = { pointsPerProof: cfg.pointsPerProof ?? PROVER_BOARD.pointsPerProof, proofsPerMinerDay: cfg.proofsPerMinerDay ?? PROVER_BOARD.proofsPerMinerDay,
    pointsByProgram: cfg.pointsByProgram ?? PROVER_BOARD.pointsByProgram };
  const pointsFor = (program) => pay.pointsByProgram[program] ?? pay.pointsPerProof;
  const firstMs = cfg.communityFirstMs ?? PROVER_BOARD.communityFirstMs;
  const best = { pct: cfg.bestPct ?? PROVER_BOARD.bestPct, of: cfg.bestOf ?? PROVER_BOARD.bestOf };
  const byRecord = (j) => goesByRecord(j.id, best.pct);
  const draw = { pct: cfg.drawPct ?? PROVER_BOARD.drawPct, fresh: cfg.drawNew ?? PROVER_BOARD.drawNew, seats: Math.max(1, cfg.drawSeats ?? PROVER_BOARD.drawSeats), freshMs: cfg.drawFreshMs ?? PROVER_BOARD.drawFreshMs };
  // Whether a machine offers a program: it named it in a claim within offerHoldMs, or (a record from before offers were kept) its latest claim does.
  const offers = (w, program) => (w.offered && w.offered[program] != null ? clock() - w.offered[program] < PROVER_BOARD.offerHoldMs : (w.programs || []).includes(program));
  // The draw is open to the race from `at`: the time a racer's wait for the block is counted from, if it was not the machine drawn.
  const openDraw = (j, at = clock()) => { j.drawOpen = true; if (!j.drawOpenAt) j.drawOpenAt = at; };
  // A machine's usual time for a block, as the draw reads it: the whole wait (the block posted, or opened to the race, to its proof arriving),
  // so a machine that is slow to ask, or busy with another proof when a block is posted, weighs less than one with the same GPU that is not;
  // a record from before it was kept falls back to the time spent proving. Infinity: no record.
  const usualSecs = (w) => (w.blocks && w.blockSecs > 0 ? (w.blockFelt > 0 ? w.blockFelt : w.blockSecs) : Infinity);
  // a block still held for its draw: one that goes by draw and has not been opened to the race
  const drawHeld = (j) => PROVER_BOARD.drawPrograms.includes(j.program) && !j.drawOpen && goesByDraw(j.id, draw.pct);
  const hasRecord = (w) => !!w && (w.batches || 0) >= PROVER_BOARD.bestRecordMin && w.batchRate > 0;
  // a batch's size in MB of input, which its proving time follows (more Bitcoin blocks, more input)
  const sizeOf = (j) => Math.max(0.001, (j.inputBytes || 1e6) / 1e6);
  const exclusive = lock || makeLock();
  // The relay's calls and the workers' answers go first (see makeBoardLock); a lock handed in by a test may take only the function.
  const urgent = (fn) => exclusive(fn, { first: true });
  // Every job on the list read at once, kept in `recs` for the rest of the pass (a pass changes the records it holds in place and writes them back, and holds
  // the lock, so what it read is what is stored): one round of reads where there were up to four rounds of one-by-one reads.
  // (Sixteen at a time: the store behind it is a pooled database, and a pass should not take every connection.)
  const loadJobs = async (ids, recs = new Map()) => {
    const need = ids.filter((x) => !recs.has(x));
    for (let i = 0; i < need.length; i += 16) await Promise.all(need.slice(i, i + 16).map(async (x) => { recs.set(x, await storage.getJob(x)); }));
    return recs;
  };
  const id = hash || ((s) => 'pb_' + s.length.toString(36) + '_' + Array.from(s).reduce((a, c) => ((a * 33) ^ c.charCodeAt(0)) >>> 0, 5381).toString(36));
  const fast = (cfg.communityFast ?? PROVER_BOARD.communityFast) !== 0;
  const viewMs = cfg.communityViewMs ?? PROVER_BOARD.communityViewMs;
  const turnLate = (cfg.turnLate ?? PROVER_BOARD.turnLate) !== 0;
  // The stored records with the community machines' latest sightings laid over them, so every reader sees a machine as seen when it last asked.
  const workers = async () => seen((await storage.getWorkers()) || {});
  function seen(ws) {
    if (!mem.presence.size) return ws;
    for (const [name, p] of mem.presence) {
      const w = ws[name] || (ws[name] = { proved: 0, failed: 0, bad: 0, lapsed: 0, lastSeen: 0, firstSeen: p.first, community: true });
      if (p.at < (w.lastSeen || 0)) continue;                 // a record written later (by another process) is newer than the sighting
      w.lastSeen = p.at; w.programs = p.programs;
      w.offered = { ...(w.offered || {}) };
      for (const [pr, at] of Object.entries(p.offered)) if (at > (w.offered[pr] || 0)) w.offered[pr] = at;
      if (p.client) w.client = p.client;
    }
    return ws;
  }
  // A community machine asked: kept in memory (the most recently seen communityKept of them), written out by the next bump.
  function sighted(worker, programs) {
    const t = clock(), p = mem.presence.get(worker.name);
    const offered = { ...(p ? p.offered : {}) };
    for (const pr of programs) offered[pr] = t;
    mem.presence.set(worker.name, { at: t, programs, offered, client: worker.client || (p && p.client) || null, first: p ? p.first : t });
    if (mem.presence.size > PROVER_BOARD.communityKept) {
      let oldest = null;
      for (const [name, x] of mem.presence) if (oldest === null || x.at < mem.presence.get(oldest).at) oldest = name;
      mem.presence.delete(oldest);
    }
  }

  // Finished and cancelled jobs are dropped from the pending list once kept long enough; the list is read on every call.
  let retainAt = Infinity;                       // when the soonest finished job still kept will leave the list, as the last sweep read it
  async function sweep(pend, recs = new Map()) {
    const keep = [];
    let soonest = Infinity;
    await loadJobs(pend, recs);
    for (const jid of pend) {
      const j = recs.get(jid);
      if (!j) continue;
      if (j.status === 'queued' || j.status === 'claimed') {
        if (j.deadline && clock() > j.deadline * 1000) { j.status = 'expired'; await end(j); await storage.putJob(jid, j); }
        else if (j.status === 'claimed' && clock() > j.leaseUntil) { j.status = 'queued'; j.worker = null; j.leaseUntil = 0; j.lapsed = (j.lapsed || 0) + 1; await storage.putJob(jid, j); }
      }
      if (['queued', 'claimed'].includes(j.status) || clock() - (j.endedAt || 0) < PROVER_BOARD.keepMs) {
        keep.push(jid);
        if (!['queued', 'claimed'].includes(j.status)) soonest = Math.min(soonest, (j.endedAt || 0) + PROVER_BOARD.keepMs);
      } else {
        if (storage.deleteJob) await storage.deleteJob(jid);
        if (j.proofKept && storage.deleteProof) await storage.deleteProof(jid);
        if (j.stdinKept && storage.deleteStdin) await storage.deleteStdin(jid);
      }
    }
    retainAt = soonest;
    return keep;
  }
  const over = (j) => { j.stdin = null; j.sealed = null; j.endedAt = clock(); };
  // over, and a kept input deleted with it
  const end = async (j) => {
    over(j);
    if (j.stdinKept && storage.deleteStdin) { await storage.deleteStdin(j.id); j.stdinKept = false; }
    // Who made a Bitcoin batch's proof, under the batch's new digest (public-value word 6), for the cross-chain block it lands as
    // (index.js recordCrossBlock): the job itself is gone by then.
    if (j.status === 'proved' && j.program === 'btc-state' && storage.putNote && typeof j.publicValues === 'string' && j.publicValues.length >= 2 + 64 * 7) {
      const digest = '0x' + j.publicValues.slice(2 + 64 * 6, 2 + 64 * 7);
      await storage.putNote(`btc:${digest}`, { worker: j.worker || null, at: clock() }).catch(() => {});
    }
  };
  const inputOf = async (j) => (j.stdinKept && storage.getStdin ? await storage.getStdin(j.id) : j.stdin);
  const leaseFor = (j) => PROVER_BOARD.leaseMsByProgram[j.program] || PROVER_BOARD.leaseMs;
  // How long a machine has to answer a turn: turnLeaseFactor times its usual time once it has a record (at least turnLeaseMinMs), else the batch's lease.
  const turnLeaseMs = (w, j) => (hasRecord(w)
    ? Math.min(leaseFor(j), Math.max(PROVER_BOARD.turnLeaseMinMs, PROVER_BOARD.turnLeaseFactor * w.batchRate * sizeOf(j) * 1000)) : leaseFor(j));
  // A compressed proof lives under its own key when the storage has one (buildProverBoard's KV does), else on the record.
  const putProof = async (j, proof) => { if (storage.putProof) { await storage.putProof(j.id, proof); j.proof = null; j.proofKept = true; } else j.proof = proof; };
  const proofOf = async (j) => (j.proofKept && storage.getProof ? await storage.getProof(j.id) : j.proof);

  // The relay posts work. The same input posted twice is one job (its id is the hash of what the worker proves). A job
  // carries either `stdin` (the input, for any worker of its class) or `sealed` (dapp/sealed-input.js: the input encrypted
  // to one named worker's key, which only that worker is offered; the board itself cannot read it).
  // A proof whose op pins the pool's reserves (a swap, a wrapped swap, an add or a removal of liquidity, or a batch the relay named `mixed(n)`, which may hold one): the public AMM moves those reserves every minute or so, so
  // the longer such a proof waits behind prove-only wraps and free relays the likelier it is stale when it lands. The relay's label for the job is its op type.
  const urgentLabel = (label) => /^(route|swap|wrapswap|wraplp|lp|lpbond|lpremove|mixed\(\d+\))$/.test(String(label || ''));
  async function post({ class: cls, program = 'confidential', mode = null, stdin, sealed, cycleLimit, gasLimit, deadline, label = null } = {}) {
    if (!PROVER_BOARD.classes.includes(cls)) throw new Error(`class must be one of ${PROVER_BOARD.classes.join(', ')}`);
    if (!PROVER_BOARD.programs.includes(program)) throw new Error(`program must be one of ${PROVER_BOARD.programs.join(', ')}`);
    if (!PROVER_BOARD.programClasses[program].includes(cls)) throw new Error(`a ${program} job's class is ${PROVER_BOARD.programClasses[program].join(' or ')}`);
    if (mode != null && mode !== PROVER_BOARD.modes[program]) throw new Error(`a ${program} job is proved ${PROVER_BOARD.modes[program]}`);
    if (program !== 'confidential' && sealed != null) throw new Error('only a confidential job can be sealed');
    const sealedOk = sealed && typeof sealed === 'object' && typeof sealed.worker === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(sealed.worker)
      && typeof sealed.epk === 'string' && /^0x0[23][0-9a-fA-F]{64}$/.test(sealed.epk) && typeof sealed.iv === 'string' && B64.test(sealed.iv) && b64len(sealed.iv) === 12
      && typeof sealed.ct === 'string' && B64.test(sealed.ct) && b64len(sealed.ct) > 16 && b64len(sealed.ct) <= PROVER_BOARD.maxStdinBytes + 16;
    if (sealed != null && !sealedOk) throw new Error('sealed must be { worker, epk (compressed secp256k1 hex), iv (12 bytes base64), ct (base64) }');
    const maxIn = PROVER_BOARD.maxStdinBytesByProgram[program] || PROVER_BOARD.maxStdinBytes;
    if (!sealedOk && (typeof stdin !== 'string' || !stdin || !B64.test(stdin) || b64len(stdin) > maxIn)) throw new Error(`stdin must be base64 of at most ${maxIn} bytes`);
    const cyc = Number(cycleLimit), gas = Number(gasLimit), dl = Number(deadline);
    if (!Number.isFinite(cyc) || cyc <= 0 || !Number.isFinite(gas) || gas <= 0) throw new Error('cycleLimit and gasLimit must be positive');
    if (!Number.isFinite(dl) || dl * 1000 <= clock()) throw new Error('deadline must be a unix time in the future');
    if (label != null && (typeof label !== 'string' || label.length > 80)) throw new Error('label must be a short string');
    return urgent(async () => {
      const recs = new Map();
      const pend = await sweep(await storage.getPending(), recs);
      const jobId = id(`${program}|${cls}|${sealedOk ? `sealed:${sealed.ct}` : stdin}`);
      const have = await storage.getJob(jobId);
      if (have && ['queued', 'claimed'].includes(have.status)) return { jobId, status: have.status, deduped: true };
      const others = pend.filter((x) => x !== jobId);
      const live = others.filter((x) => ['queued', 'claimed'].includes(recs.get(x)?.status)).length;
      if (live >= PROVER_BOARD.maxPending + (urgentLabel(label) ? PROVER_BOARD.urgentReserve : 0) || others.length >= PROVER_BOARD.maxRetained) throw Object.assign(new Error('the board is full'), { code: 'full' });
      if (have && have.proofKept && storage.deleteProof) await storage.deleteProof(jobId); // the same input again: the old proof goes
      const job = { id: jobId, class: cls, program, mode: PROVER_BOARD.modes[program], stdin: sealedOk ? null : stdin, sealed: sealedOk ? { worker: sealed.worker, epk: sealed.epk, iv: sealed.iv, ct: sealed.ct } : null,
        cycleLimit: cyc, gasLimit: gas, deadline: dl, label, status: 'queued', postedAt: clock(), inputBytes: sealedOk ? null : b64len(stdin),
        worker: null, leaseUntil: 0, claimedAt: 0, endedAt: 0, publicValues: null, proof: null, error: null, lapsed: 0 };
      if (job.stdin && PROVER_BOARD.keptInput.includes(program) && storage.putStdin) { await storage.putStdin(jobId, job.stdin); job.stdin = null; job.stdinKept = true; }
      await storage.putJob(jobId, job);
      await storage.putPending([...pend.filter((x) => x !== jobId), jobId]);
      return { jobId, status: 'queued' };
    });
  }

  // What the relay reads: never the input again, only where the job stands and the proof when there is one.
  async function status(jobId) {
    const j = await storage.getJob(String(jobId || ''));
    if (!j) return null;
    const live = j.status === 'claimed' && clock() > j.leaseUntil ? 'queued' : j.status === 'queued' && j.deadline && clock() > j.deadline * 1000 ? 'expired' : j.status;
    return { jobId: j.id, class: j.class, program: j.program, mode: j.mode || PROVER_BOARD.modes[j.program] || 'groth16', status: live, sealedTo: j.sealed ? j.sealed.worker : null, worker: live === 'claimed' ? j.worker : j.status === 'proved' || j.status === 'failed' ? j.worker : null,
      postedAt: j.postedAt, claimedAt: j.claimedAt || null, endedAt: j.endedAt || null, publicValues: j.publicValues, proof: j.status === 'proved' ? await proofOf(j) : j.proof, error: j.error, lapsed: j.lapsed || 0,
      race: ['queued', 'claimed'].includes(j.status) ? (j.race || []).map(({ worker, publicValues, proof }) => ({ worker, publicValues, proof })) : [] };
  }

  // The relay's check of a community candidate: one that passed becomes the job's proof (the job is done, whoever had claimed it); one that
  // did not is dropped and counts against the machine that made it.
  async function raceVerdict({ jobId, worker, ok } = {}) {
    return urgent(async () => {
      const j = await storage.getJob(String(jobId || ''));
      if (!j) return { ok: false, error: 'no such job' };
      const c = (j.race || []).find((x) => x.worker === worker);
      if (!c) return { ok: false, error: 'no such candidate' };
      j.race = j.race.filter((x) => x !== c);
      if (ok === true && ['queued', 'claimed'].includes(j.status)) {
        j.status = 'proved'; j.worker = c.worker; j.publicValues = c.publicValues; j.proof = c.proof; j.race = []; j.racers = []; await end(j);
        if (!j.claimedAt) j.claimedAt = c.at;
        await storage.putJob(j.id, j);
        await bump(c.worker, 'proved', null, null, true);
        if (PROVER_BOARD.turnPrograms.includes(j.program)) await noteBatch(c.worker, c.secs, sizeOf(j));
        if (PROVER_BOARD.drawPrograms.includes(j.program)) {
          // the whole wait: from the posting for the machine drawn (or when nothing was drawn), from the opening to the race for any other
          const start = j.drawPick === c.worker || !j.drawOpenAt ? j.postedAt : j.drawOpenAt;
          await noteBlock(c.worker, c.secs, start && c.at > start ? (c.at - start) / 1000 : null);
          if (j.drawPick && j.drawPick !== c.worker && j.postedAt && c.at > j.postedAt) await noteMissed(j.drawPick, (c.at - j.postedAt) / 1000);
        }
        await credit(c.worker, j.program || 'confidential');
        return { ok: true, status: 'proved' };
      }
      // the drawn machine's answer did not pass: the block is the race's now
      if (ok === false && j.drawn === c.worker && !j.drawOpen) openDraw(j);
      await storage.putJob(j.id, j);
      if (ok === false) { await bump(c.worker, 'bad', null, null, true); await troubled(c.client); }
      return { ok: true, status: j.status };
    });
  }

  // The relay gives a job up (it went to the network, or the proof that came back did not pass): a result after this is
  // ignored, and `reason` 'bad' counts against the worker that made it.
  async function cancel({ jobId, reason = null } = {}) {
    return urgent(async () => {
      const j = await storage.getJob(String(jobId || ''));
      if (!j) return { ok: false, error: 'no such job' };
      if (!['queued', 'claimed', 'proved'].includes(j.status)) return { ok: true, status: j.status };
      if (reason === 'bad' && j.worker) await bump(j.worker, 'bad');
      // a turn the relay stopped waiting for counts against the machine whose turn it was, and the place it was claimed from
      if (PROVER_BOARD.turnPrograms.includes(j.program) && ['queued', 'claimed'].includes(j.status)) {
        for (const r of liveRacers(j)) { await mark(r, 'lapsed'); await troubled((j.racedBy || {})[r]); }
      }
      j.status = 'cancelled'; await end(j); j.cancelReason = reason;
      await storage.putJob(j.id, j);
      return { ok: true, status: 'cancelled' };
    });
  }

  // A community proof the relay took counts for its address on the day it was taken, with points up to the day's cap. Only `c-0x…`
  // names are community machines; Tacit's own workers never prove through a race.
  async function credit(name, program = 'confidential') {
    const m = /^c-(0x[0-9a-f]{40})$/.exec(String(name));
    if (!m || !storage.putDay) return;
    const d = dayOf(clock()), r = (storage.getDay && await storage.getDay(d)) || {};
    const rec = { done: 0, points: 0, miners: {}, ...r };
    const mr = rec.miners[m[1]] || (rec.miners[m[1]] = { proofs: 0, credited: 0, points: 0 });
    const points = mr.credited < pay.proofsPerMinerDay ? pointsFor(program) : 0;
    rec.done++; mr.proofs++;
    if (points > 0) { mr.credited++; mr.points += points; rec.points += points; }
    await storage.putDay(d, rec);
  }

  // A UTC day's tally, for the points service's mining campaign, in the proof pool's shape (worker/src/proof-pool.js credits): each
  // address's proofs taken and the points they earned, `over` once the day has ended.
  async function credits(day) {
    const t = clock();
    if (!Number.isSafeInteger(day) || day < 0 || day > dayOf(t)) return { status: 400, body: { ok: false, error: 'day must be a UTC day number, today or before' } };
    const rec = (storage.getDay && await storage.getDay(day)) || { miners: {} };
    const miners = Object.entries(rec.miners || {}).filter(([, m]) => m.points > 0).map(([miner, m]) => ({ miner, proofs: m.proofs, points: m.points }))
      .sort((a, b) => (a.miner < b.miner ? -1 : 1));
    return { status: 200, body: { day, over: t >= (day + 1) * DAY_MS, pointsPerProof: pay.pointsPerProof, miners } };
  }

  // A mark on a machine's record that does not count as seeing it (a turn it let lapse is not a sign it is there).
  async function mark(name, field) {
    const ws = await workers(), w = ws[name];
    if (!w) return;
    w[field] = (w[field] || 0) + 1;
    await storage.putWorkers(ws);
  }
  // A machine drawn for a block: counted on its record, and one with no block record yet has had its turn at the newcomers' share and goes to the
  // back of their line (whether or not it takes the block: one that does has a record from then on).
  async function markDraw(name) {
    const ws = await workers(), w = ws[name];
    if (!w) return;
    w.draws = (w.draws || 0) + 1;
    if (!(w.blocks && w.blockSecs > 0)) w.sliceAt = clock();
    await storage.putWorkers(ws);
  }
  // a turn's lease runs from its start or its last check-in, whichever is later
  const liveRacers = (j) => (j.racers || []).filter((r) => clock() - Math.max((j.racedAt || {})[r] || 0, (j.beatAt || {})[r] || 0) < ((j.racerLease || {})[r] ?? leaseFor(j)));
  // A batch the relay took: the machine's record (the batches taken from it, and as running averages its usual time from turn to proof and
  // its time per MB of input, which ranks it and sets how long it has for a turn).
  async function noteBatch(name, secs, mb) {
    const ws = await workers(), w = ws[name];
    if (!w || !(secs > 0)) return;
    const avg = (was, x) => (w.batches && was > 0 ? 0.7 * was + 0.3 * x : x);
    w.batchSecs = avg(w.batchSecs, secs);
    w.batchRate = avg(w.batchRate, secs / mb);
    w.batches = (w.batches || 0) + 1;
    await storage.putWorkers(ws);
  }
  // A block the relay took: the machine's block record (how many, and as a running average its usual time from claim to proof), which sets
  // its odds in the draw and how long it has when drawn.
  // A block taken from `name`: `secs` is its proving time (the job claimed to its answer: what its lease and hedge are set by), `felt` the whole
  // wait (the block posted, or opened to the race when the machine was not the one drawn, to its answer arriving: what a user waits and what the draw
  // weighs). Both are running averages (0.7 old, 0.3 new); a record from before `felt` was kept starts its average at its proving time.
  async function noteBlock(name, secs, felt = null) {
    const ws = await workers(), w = ws[name];
    if (!w || !(secs > 0)) return;
    const prior = w.blockFelt > 0 ? w.blockFelt : w.blocks && w.blockSecs > 0 ? w.blockSecs : null;
    if (felt > 0) w.blockFelt = prior != null ? 0.7 * prior + 0.3 * felt : felt;
    w.blockSecs = w.blocks && w.blockSecs > 0 ? 0.7 * w.blockSecs + 0.3 * secs : secs;
    w.blocks = (w.blocks || 0) + 1;
    await storage.putWorkers(ws);
  }
  // A block that was drawn for a machine with a record and taken from another (it did not come for it in time, or was slow): the wait the user had
  // is counted against the machine, as if it had been its own. A machine with no record has none to count it against.
  async function noteMissed(name, felt) {
    const ws = await workers(), w = ws[name];
    if (!w || !(w.blocks && w.blockSecs > 0) || !(felt > 0)) return;
    const prior = w.blockFelt > 0 ? w.blockFelt : w.blockSecs;
    w.blockFelt = 0.7 * prior + 0.3 * felt;
    await storage.putWorkers(ws);
  }
  // The place a racer claimed a job from (a race claimed before places were kept holds none, and is anyone's under its name).
  const placeOf = (j, name, dflt) => (j.racedBy || {})[name] ?? dflt;

  // A place whose turn was refused, given back or let lapse: it goes after the others for turnTroubleMs (nextTurn), under any name.
  async function troubled(place) {
    if (!place || !storage.putTrouble) return;
    const t = clock(), was = (storage.getTrouble && await storage.getTrouble()) || {};
    await storage.putTrouble({ ...Object.fromEntries(Object.entries(was).filter(([, at]) => t - at < PROVER_BOARD.turnTroubleMs)), [place]: t });
  }

  async function bump(name, field, pubkey = null, programs = null, community = false, client = null) {
    const ws = await workers();
    const mergedAt = clock();
    const w = ws[name] || (ws[name] = { proved: 0, failed: 0, bad: 0, lapsed: 0, lastSeen: 0, firstSeen: clock(), ...(community ? { community: true } : {}) });
    if (field) w[field] = (w[field] || 0) + 1;
    if (field === 'bad') w.lastBadAt = clock();   // the count is lifetime; the monitor warns on a recent one
    if (pubkey && /^0x0[23][0-9a-fA-F]{64}$/.test(pubkey)) w.pubkey = pubkey.toLowerCase();
    if (programs) {
      w.programs = programs;
      // when each program was last named: the latest claim may name fewer (a second worker under the same address that offers less, or a
      // moment between starts), and a machine that offered blocks a few seconds ago still holds its ticket for them
      w.offered = w.offered || {};
      for (const pr of programs) w.offered[pr] = clock();
    }
    if (client) w.client = client;
    w.lastSeen = clock();
    if (community) {
      // The machines with a standing (a proof taken, a turn, a mark) are kept before those that have only asked, and then the most recently seen. By when a machine was last
      // seen alone, a machine proving a batch (it asks for nothing for tens of minutes) was the first dropped once more than communityKept machines were asking, and with it
      // its record, so no machine kept a record, and a batch went to the first address in order every time.
      const standing = (x) => ((x.proved || 0) + (x.failed || 0) + (x.bad || 0) + (x.lapsed || 0) + (x.turns || 0) + (x.batches || 0) + (x.blocks || 0) + (x.draws || 0) + (x.drawMissed || 0) > 0 ? 1 : 0);
      const crowd = Object.entries(ws).filter(([, x]) => x.community).sort((a, b) => standing(b[1]) - standing(a[1]) || b[1].lastSeen - a[1].lastSeen);
      for (const [n] of crowd.slice(PROVER_BOARD.communityKept)) delete ws[n];
    }
    await storage.putWorkers(ws);
    // a sighting is dropped only once a write has carried it, and when it is old
    for (const [n, p] of mem.presence) if (p.at < mergedAt - PROVER_BOARD.communityKeepSeenMs) mem.presence.delete(n);
  }

  // A worker takes the oldest job of a class it may prove, and holds it for the lease. `{}` when there is nothing.
  // `pubkey`: the key inputs may be sealed to (prover-worker/src/main.rs), shown on the summary.
  // `warming`: the worker is starting (building its prover, warming the GPU) and takes nothing yet; it is counted as seen, so the relay
  // keeps posting jobs here for the minute it takes instead of sending them to the network, and the jobs wait for it.
  // `programs`: what the worker can prove (a worker that predates them proves 'confidential' only); recorded for the summary.
  async function claim({ worker, classes, pubkey = null, warming = false, programs = null } = {}) {
    if (!worker || !Array.isArray(classes) || !classes.length) throw new Error('worker and classes are required');
    const can = Array.isArray(programs) && programs.length ? programs.filter((p) => PROVER_BOARD.programs.includes(p)) : ['confidential'];
    if (worker.community) return communityClaim(worker, Array.isArray(programs) && programs.length ? can : ['confidential']);
    return urgent(async () => {
      await bump(worker.name, null, pubkey, warming ? null : can); // a warming ping names no programs: what it proved last stands
      if (warming) return null;
      const recs = new Map();
      const pend = await sweep(await storage.getPending(), recs);
      await storage.putPending(pend);
      let open = 0;
      for (const jid of pend) { const j = recs.get(jid); if (j && j.status === 'claimed' && j.worker === worker.name) open++; }
      if (open >= PROVER_BOARD.maxOpenPerWorker) return null;
      let ws = null, live = null;
      // the pool's own proofs first: a tacit chain block (public work community machines race too) is taken only when no other job waits; and among them a proof that pins the pool's reserves (urgentLabel) goes before the rest, each kind first in, first out
      const order = [...pend.filter((jid) => urgentLabel(recs.get(jid)?.label)), ...pend.filter((jid) => !urgentLabel(recs.get(jid)?.label))];
      for (const pass of [0, 1]) for (const jid of order) {
        const j = recs.get(jid);
        if (!j || j.status !== 'queued' || !classes.includes(j.class) || !worker.classes.includes(j.class) || !can.includes(j.program || 'confidential')) continue;
        if (Number((j.program || 'confidential') === 'tacit-block') !== pass) continue;
        if (j.sealed && j.sealed.worker !== worker.name) continue; // sealed to another worker: not even offered
        // first pick for the community: a fresh public job a community machine is racing, or one a ready machine can take, waits its window
        const first = j.class === 'public' && !j.sealed ? Number(firstMs[j.program || 'confidential']) || 0 : 0;
        if (first > 0 && clock() - (j.postedAt || 0) < first) {
          if (liveRacers(j).length) continue;
          ws = ws || await workers();
          live = live || pend.map((id) => recs.get(id)).filter((x) => x && ['queued', 'claimed'].includes(x.status));
          if (readyFor(ws, live, j)) continue;
        }
        j.status = 'claimed'; j.worker = worker.name; j.claimedAt = clock(); j.leaseUntil = clock() + leaseFor(j);
        await storage.putJob(jid, j);
        return { jobId: j.id, class: j.class, program: j.program, mode: j.mode || PROVER_BOARD.modes[j.program], stdin: await inputOf(j), sealed: j.sealed ? { epk: j.sealed.epk, iv: j.sealed.iv, ct: j.sealed.ct } : null, cycleLimit: j.cycleLimit, gasLimit: j.gasLimit, deadline: j.deadline, leaseUntil: j.leaseUntil, label: j.label };
      }
      return null;
    });
  }

  // A community machine joins the race for the oldest public job it is not already racing (unsealed, groth16, a program it says it proves:
  // the pool's settle guest unless it names others). Its answer is taken in `result` while the job is open, whoever else has claimed it.
  // A Bitcoin batch (turnPrograms) is one machine's at a time: it is offered only to the machine whose turn it is (nextTurn).
  // The part of an open job the first checks of a community ask read, kept by a look at the open jobs.
  const lookAt = (j) => ({ class: j.class, program: j.program, sealed: !!j.sealed, input: !!(j.stdin || j.stdinKept), raced: (j.raced || []).slice(),
    racers: (j.racers || []).slice(), racedAt: { ...(j.racedAt || {}) }, racerLease: { ...(j.racerLease || {}) }, racedBy: { ...(j.racedBy || {}) },
    held: drawHeld(j), postedAt: j.postedAt || 0, drawPick: j.drawPick || null, drawn: j.drawn || null, candidates: (j.race || []).map((c) => c.worker) });
  // A look is good while no job has changed since it was made, it is at most viewMs old (jobs written by another process are read within that), and no open
  // job has reached its deadline or the end of its claim, and no finished job is due to leave the list (the sweep an ask makes first would end, open or drop it).
  const lookIsFresh = (v) => !!v && v.epoch === mem.epoch && clock() >= v.at && clock() - v.at < viewMs && clock() <= v.until;
  // Whether the look shows no job this machine could race: the conditions an ask tries first, read from the look. Any job it cannot rule out goes to the full ask.
  function nothingToRace(v, worker, races) {
    const here = (j) => liveRacers(j).includes(worker.name) && placeOf(j, worker.name, worker.client) === worker.client;
    if (v.open.filter(here).length >= PROVER_BOARD.communityOpen) return true;
    const t = clock();
    for (const j of v.open) {
      if (j.class !== 'public' || j.sealed || !races.includes(j.program || 'confidential') || !j.input) continue;
      const racers = liveRacers(j);
      if (j.raced.includes(worker.name) || racers.length >= PROVER_BOARD.communityRacers) continue;
      if (j.held) {                                                    // a block still held for its draw
        if (j.drawn) {
          if (j.candidates.includes(j.drawn)) continue;                // its answer waits on the relay's check
          const waiting = t - (j.racedAt[j.drawn] || 0) < j.hedgeMs;   // the drawn machine is proving it, inside its time
          if (!racers.includes(j.drawn) || !waiting) return false;     // otherwise the ask changes the job
          continue;
        }
        if (t - j.postedAt >= PROVER_BOARD.drawOfferMs || !j.drawPick || j.drawPick === worker.name) return false;   // the offer has ended, no one is drawn yet, or this is the one drawn
        continue;                                                      // drawn: another machine's
      }
      if (PROVER_BOARD.turnPrograms.includes(j.program)) { if (racers.length) continue; return false; }   // another machine's turn
      return false;
    }
    return true;
  }
  // Which kind of job kept the look from ruling an ask out (for the counts): the first one the opening checks leave.
  function undecidedKind(v, worker, races) {
    for (const j of v.open) {
      if (j.class !== 'public' || j.sealed || !races.includes(j.program || 'confidential') || !j.input) continue;
      if (j.raced.includes(worker.name) || liveRacers(j).length >= PROVER_BOARD.communityRacers) continue;
      return j.held ? 'draw' : PROVER_BOARD.turnPrograms.includes(j.program) ? 'turn' : 'open';
    }
    return 'open';
  }
  // Whether the look rules the ask out. This only saves work, so whatever the look holds it never fails an ask: an error here sends it to the board.
  function rulesOut(worker, races) {
    try { return lookIsFresh(mem.view) && nothingToRace(mem.view, worker, races); } catch { return false; }
  }
  async function communityClaim(worker, can = ['confidential']) {
    const races = can.filter((p) => PROVER_BOARD.communityPrograms.includes(p));
    // A machine's first ask is written out at once, so its record exists in storage.
    const first = fast && !mem.known.has(worker.name);
    if (fast) {
      try {
        mem.known.add(worker.name);
        if (mem.known.size > 5000) mem.known.delete(mem.known.values().next().value);
        sighted(worker, races);
        if (first) mem.asks.first++;
        else if (!lookIsFresh(mem.view)) mem.asks.stale++;
        else if (nothingToRace(mem.view, worker, races)) { mem.asks.fast++; return null; }
        else mem.asks.maybe[undecidedKind(mem.view, worker, races)]++;
      } catch { /* the board answers */ }
    }
    return exclusive(async () => {
      if (fast && !first && rulesOut(worker, races)) { mem.asks.rechecked++; return null; }   // an ask ahead of this one has just looked
      if (!fast || first || clock() - mem.flushedAt >= PROVER_BOARD.communityFlushMs) { mem.flushedAt = clock(); await bump(worker.name, null, null, races, true, worker.client); }
      const recs = new Map();
      const pend = await sweep(await storage.getPending(), recs);
      await storage.putPending(pend);
      const open = [];
      for (const jid of pend) { const j = recs.get(jid); if (j && ['queued', 'claimed'].includes(j.status)) open.push(j); }
      if (fast) {
        const epoch = mem.epoch, looks = open.map(lookAt);
        let known = null;                                              // the drawn machine's record sets how long it is left alone with its block
        for (let i = 0; i < open.length; i++) {
          if (!looks[i].held || !open[i].drawn) continue;
          known = known || await workers();
          const d = known[open[i].drawn];
          looks[i].hedgeMs = d && d.blocks && d.blockSecs > 0 ? Math.max(PROVER_BOARD.drawHedgeMinMs, PROVER_BOARD.drawHedgeFactor * d.blockSecs * 1000) : PROVER_BOARD.drawNewHedgeMs;
        }
        const until = open.reduce((m, j) => Math.min(m, j.deadline ? j.deadline * 1000 : Infinity, j.status === 'claimed' && j.leaseUntil ? j.leaseUntil : Infinity), Infinity);
        mem.view = { epoch, at: clock(), until: Math.min(until, retainAt), open: looks };
      }
      const here = (j) => liveRacers(j).includes(worker.name) && placeOf(j, worker.name, worker.client) === worker.client;
      if (open.filter(here).length >= PROVER_BOARD.communityOpen) return null;
      let ws = null, trouble = null;
      for (const j of open) {
        if (j.class !== 'public' || j.sealed || !races.includes(j.program || 'confidential') || !(j.stdin || j.stdinKept)) continue;
        // a racer that took the job and never answered gives its place up once the job's lease time has passed
        const since = j.racedAt || {};
        const racers = liveRacers(j);
        // racing now, or raced it before (answered or dropped out): offered once
        if ((j.raced || []).includes(worker.name) || racers.length >= PROVER_BOARD.communityRacers) continue;
        let turnMs = null;
        if (drawHeld(j)) {
          if (j.drawn) {
            // its answer waits on the relay's check: no one else's yet
            if ((j.race || []).some((c) => c.worker === j.drawn)) continue;
            if (racers.includes(j.drawn)) {
              // its machine is proving it: alone until drawHedgeFactor times its usual time, then the race joins it (a user is waiting)
              // while it keeps its claim and is paid if it answers first. Slow is not a lapse: its place keeps its standing.
              ws = ws || await workers();
              const d = ws[j.drawn];
              const hedge = d && d.blocks && d.blockSecs > 0 ? Math.max(PROVER_BOARD.drawHedgeMinMs, PROVER_BOARD.drawHedgeFactor * d.blockSecs * 1000) : PROVER_BOARD.drawNewHedgeMs;
              if (clock() - ((j.racedAt || {})[j.drawn] || 0) < hedge) continue;
              openDraw(j);
            } else {
              // its time ran out unanswered: the race's, and the place goes after the others
              openDraw(j);
              await mark(j.drawn, 'lapsed');
              await troubled(placeOf(j, j.drawn));
            }
          } else if (clock() - (j.postedAt || 0) >= PROVER_BOARD.drawOfferMs) {
            openDraw(j, (j.postedAt || clock()) + PROVER_BOARD.drawOfferMs);   // the drawn machine never came for it: open from the end of its offer
            if (j.drawPick) await mark(j.drawPick, 'drawMissed');        // counted on its record: drawn, and not there
          } else {
            // The draw is made ONCE, by the first machine to ask after the block is posted, and kept on the job. Drawn afresh at each
            // ask, the winner moved as machines came and went (the odds of new places depend on how many there are), so a machine drawn at
            // one ask was not the winner at its own, and the machine that asks most often took the block whenever the draw passed over it:
            // the race again. On 2026-11-16 it went to one machine 10 times of 10 within 12.5 s.
            if (!j.drawPick) {
              ws = ws || await workers();
              trouble = trouble || (storage.getTrouble && await storage.getTrouble()) || {};
              const pick = drawPick(ws, open, j, trouble);
              if (pick == null) openDraw(j, j.postedAt || clock());      // no one to draw: raced as before, open since it was posted
              else { j.drawPick = pick; await storage.putJob(j.id, j); await markDraw(pick); }   // how often each machine is drawn, on its record
            }
            if (j.drawOpen) { /* raced below */ }
            else if (j.drawPick !== worker.name) continue;
            else {
              ws = ws || await workers();
              const w = ws[worker.name];
              turnMs = w && w.blocks && w.blockSecs > 0
                ? Math.min(PROVER_BOARD.drawNewMs, Math.max(PROVER_BOARD.drawMinMs, PROVER_BOARD.drawFactor * w.blockSecs * 1000)) : PROVER_BOARD.drawNewMs;
              j.drawn = worker.name;
            }
          }
        }
        if (PROVER_BOARD.turnPrograms.includes(j.program)) {
          if (racers.length) continue;                                   // another machine's turn
          ws = ws || await workers();
          trouble = trouble || (storage.getTrouble && await storage.getTrouble()) || {};
          if (nextTurn(ws, open, j, trouble) !== worker.name) continue;
          // a turn that ran past its machine's time unanswered counts against that machine and the place it was claimed from
          for (const r of (j.racers || []).filter((x) => !racers.includes(x))) {
            if (ws[r]) ws[r].lapsed = (ws[r].lapsed || 0) + 1;
            await troubled(placeOf(j, r));
          }
          ws[worker.name].lastTurnAt = clock(); ws[worker.name].turns = (ws[worker.name].turns || 0) + 1;
          turnMs = turnLeaseMs(ws[worker.name], j);
          await storage.putWorkers(ws);
        }
        j.racers = [...racers, worker.name];
        if (turnMs != null) j.racerLease = { [worker.name]: turnMs };
        j.raced = [...(j.raced || []), worker.name].slice(-4 * PROVER_BOARD.communityRacers);
        // when and from where each machine took the job, kept for every machine that raced it: a turn that has gone on to another machine is still timed and placed
        // when its late answer comes
        const tookIt = new Set(j.raced), ofThose = (o) => Object.fromEntries(Object.entries(o).filter(([r]) => tookIt.has(r)));
        j.racedAt = ofThose({ ...since, [worker.name]: clock() });
        j.beatAt = ofThose(j.beatAt || {}); j.beatN = ofThose(j.beatN || {}); delete j.beatAt[worker.name]; delete j.beatN[worker.name];
        j.racedBy = ofThose({ ...(j.racedBy || {}), ...(worker.client != null ? { [worker.name]: worker.client } : {}) });
        await storage.putJob(j.id, j);
        return { jobId: j.id, class: j.class, program: j.program || 'confidential', mode: 'groth16', stdin: await inputOf(j), sealed: null, cycleLimit: j.cycleLimit, gasLimit: j.gasLimit,
          deadline: j.deadline, leaseUntil: turnMs != null ? Math.min(j.deadline * 1000, clock() + turnMs) : j.deadline * 1000, label: j.label, race: true,
          ...(turnMs != null ? { beatMs: Math.max(1000, Math.floor(turnMs / 3)) } : {}) };
      }
      return null;
    });
  }

  // Whether a community machine could take this job now: one that proves its program, asked for work in the last turnSeenMs, is racing nothing
  // (communityOpen is one) and has not raced the job already.
  function readyFor(ws, open, j) {
    const t = clock(), busy = new Set(open.flatMap(liveRacers)), prog = j.program || 'confidential';
    return Object.entries(ws).some(([n, w]) => w.community && (w.programs || ['confidential']).includes(prog) && t - (w.lastSeen || 0) < PROVER_BOARD.turnSeenMs
      && !busy.has(n) && !(j.raced || []).includes(n));
  }

  // Who a block is drawn for: of the machines that prove its program, asked for work in the last drawFreshMs, are proving nothing, have not had
  // this block and ask from a place in no trouble, one ticket per place (its fastest machine). A place with a record (usual time at most
  // drawMaxSecs) weighs 1 / its usual seconds; places with none share drawNew hundredths of the odds, but only the drawSeats of them that
  // have waited longest (since their last draw, or since the board first saw them) hold a ticket; all of them if no place has a record.
  // `line` is every such place in that order, for a machine to read its place in it. drawWinner picks by the job's id.
  function drawTickets(ws, open, j, troubles = {}) {
    const t = clock(), busy = new Set(open.flatMap(liveRacers));
    const usual = usualSecs;
    // A machine with no block record draws only once the board has taken a proof from it: a ticket costs a waiting user time when it is not
    // answered, and an address that has proved nothing (one of a swarm of connections, say) has shown no machine behind it.
    const ok = ([n, w]) => w.community && offers(w, j.program) && t - (w.lastSeen || 0) < Math.min(PROVER_BOARD.turnSeenMs, draw.freshMs)
      && !busy.has(n) && !(j.raced || []).includes(n) && !(w.client && troubles[w.client] != null && t - troubles[w.client] < PROVER_BOARD.turnTroubleMs)
      && (usual(w) < Infinity || (w.proved || 0) >= 1);
    const byPlace = new Map();
    for (const [n, w] of Object.entries(ws).filter(ok)) {
      const p = w.client || n, had = byPlace.get(p);
      if (!had || usual(w) < usual(had[1]) || (usual(w) === usual(had[1]) && n < had[0])) byPlace.set(p, [n, w]);
    }
    const rec = [], line = [];
    for (const [p, [n, w]] of byPlace) {
      if (usual(w) === Infinity) line.push([p, n, w]);
      else if (usual(w) <= PROVER_BOARD.drawMaxSecs) rec.push([p, n, 1 / usual(w)]);
    }
    // in order of waiting: the place drawn longest ago (one never drawn: the one the board saw first) goes first, and the name breaks a tie
    line.sort(([pa, , a], [pb, , b]) => (a.sliceAt || 0) - (b.sliceAt || 0) || (a.firstSeen || 0) - (b.firstSeen || 0) || (pa < pb ? -1 : pa > pb ? 1 : 0));
    const fresh = draw.fresh > 0 ? line.slice(0, draw.seats) : [];
    const sum = rec.reduce((s, r) => s + r[2], 0);
    const each = !rec.length ? 1 : fresh.length ? (draw.fresh / (100 - draw.fresh)) * sum / fresh.length : 0;
    return { tickets: [...rec.map(([p, , w]) => [p, w]), ...fresh.map(([p]) => [p, each])], byPlace, line: line.map(([p]) => p), seats: draw.seats };
  }
  function drawPick(ws, open, j, troubles = {}) {
    const { tickets, byPlace } = drawTickets(ws, open, j, troubles);
    const won = drawWinner(j.id, tickets);
    return won == null ? null : byPlace.get(won)[0];
  }

  // Whose turn a batch is: of the machines that prove its program, asked for work in the last turnSeenMs, are proving nothing and have not
  // had this batch, the one longest since its last turn; one asking from a place with a refused, given-back or unanswered turn in the last
  // turnTroubleMs (`troubles`, by place) after the rest, and the name breaks a tie. A batch that goes by record (byRecord) goes, in the same
  // order, to the bestOf fastest of those with a record and no trouble, and in turn to all when fewer than two of them are waiting (a lane of
  // one is no ranking: it would hand every such batch to whichever machine happened to take the first, however slow, and a faster machine could
  // not earn a record; in turn, a machine that has never had a turn comes first, which is how the others earn theirs).
  function nextTurn(ws, open, j, troubles = {}) {
    const t = clock(), busy = new Set(open.flatMap(liveRacers));
    const trouble = (w) => { const at = w.client ? troubles[w.client] : null; return at != null && t - at < PROVER_BOARD.turnTroubleMs ? 1 : 0; };
    const waiting = Object.entries(ws).filter(([n, w]) => w.community && (w.programs || []).includes(j.program) && t - (w.lastSeen || 0) < PROVER_BOARD.turnSeenMs
      && !busy.has(n) && !(j.raced || []).includes(n));
    const inTurn = ([na, a], [nb, b]) => trouble(a) - trouble(b) || (a.lastTurnAt || 0) - (b.lastTurnAt || 0) || (na < nb ? -1 : na > nb ? 1 : 0);
    if (byRecord(j)) {
      const fastest = waiting.filter(([, w]) => !trouble(w) && hasRecord(w))
        .sort(([na, a], [nb, b]) => a.batchRate - b.batchRate || (na < nb ? -1 : na > nb ? 1 : 0)).slice(0, best.of);
      if (fastest.length >= Math.min(best.of, 2)) return fastest.sort(inTurn)[0][0];
    }
    waiting.sort(inTurn);
    return waiting.length ? waiting[0][0] : null;
  }

  // The worker's answer: the proof with its public values (hex), or why it could not prove the job. A groth16 proof is the hex
  // settle() takes; a compressed one is the base64 of the bincode SP1ProofWithPublicValues.
  // A check-in from the machine whose turn it is: `progress` is a whole number of what it has proved so far (shards), and a check-in that shows more
  // than the last one (the first needs only to be a number) starts its lease afresh, until turnHardCapMs after its turn began. A check-in that shows
  // no more, from a machine that no longer holds the turn, or for a batch that is done is refused, and the lease runs on as it was.
  const hardCap = cfg.turnHardCapMs ?? PROVER_BOARD.turnHardCapMs;
  async function beat({ worker, jobId, progress } = {}) {
    if (!worker || !worker.community) throw new Error('community worker is required');
    return urgent(async () => {
      const j = await storage.getJob(String(jobId || ''));
      if (!j) return { ok: false, error: 'no such job' };
      const name = worker.name, t = clock();
      if (!PROVER_BOARD.turnPrograms.includes(j.program)) return { ok: false, code: 'no_beat', error: 'this job has no renewable turn' };
      if (!['queued', 'claimed'].includes(j.status) || !liveRacers(j).includes(name)) return { ok: false, code: 'not_your_turn', error: 'this turn is no longer yours' };
      if (placeOf(j, name, worker.client) !== worker.client) return { ok: false, code: 'other_place', error: 'check in from the connection that claimed the job' };
      const n = Number(progress);
      if (!Number.isSafeInteger(n) || n < 0) return { ok: false, code: 'bad_progress', error: 'progress must be a whole number' };
      const last = (j.beatN || {})[name];
      if (last !== undefined && n <= last) return { ok: false, code: 'no_progress', error: 'no more proved than at the last check-in' };
      if (t - ((j.racedAt || {})[name] || t) >= hardCap) return { ok: false, code: 'hard_cap', error: 'this turn has reached its longest time' };
      j.beatAt = { ...(j.beatAt || {}), [name]: t }; j.beatN = { ...(j.beatN || {}), [name]: n };
      await storage.putJob(j.id, j);
      const lease = (j.racerLease || {})[name] ?? leaseFor(j);
      return { ok: true, leaseUntil: Math.min(t + lease, ((j.racedAt || {})[name] || t) + hardCap + lease), beatMs: Math.max(1000, Math.floor(lease / 3)) };
    });
  }

  async function result({ worker, jobId, publicValues = null, proof = null, error = null } = {}) {
    if (!worker) throw new Error('worker is required');
    return urgent(async () => {
      const j = await storage.getJob(String(jobId || ''));
      if (!j) return { ok: false, error: 'no such job' };
      if (worker.community) {
        // a racer's answer, from the place that claimed the race: kept beside the open job for the relay to check; one that could not prove it
        // simply drops out. Each way an answer is turned away says which it is: 'not racing this job' is only for a machine the job was never given to.
        const name = worker.name, turnJob = PROVER_BOARD.turnPrograms.includes(j.program), slot = (j.racers || []).includes(name);
        if (!slot && !(j.raced || []).includes(name)) return { ok: false, error: 'not racing this job' };
        if (placeOf(j, name, worker.client) !== worker.client) {
          return { ok: false, code: 'other_place', error: 'this job was claimed from a different network address than this answer came from: answer from the connection that claimed it (a changed IP, a VPN or a line that switches between IPv4 and IPv6 does this)' };
        }
        // an answer sent again (the first one's reply lost on the way) is told what the first was told
        const held = (j.race || []).find((c) => c.worker === name);
        if (error == null && held && typeof proof === 'string' && held.proof === proof.toLowerCase()) return { ok: true, status: 'candidate', duplicate: true };
        if (j.status === 'proved' && j.worker === name) return { ok: true, status: 'proved', duplicate: true };
        if (!['queued', 'claimed'].includes(j.status)) return { ok: false, code: `job_${j.status}`, error: `job is ${j.status}` };
        // A batch is one machine's turn at a time, and a turn that ran past its time goes on to the next machine. Its first machine's proof, made late, is still a
        // sound proof of the same batch, and the relay takes the first sound proof: the work is kept (its answer is read like any racer's) while the batch is open and
        // it has not answered. (`turnLate` 0 returns to refusing it.) A race's racer that is no longer in the race is as before: not racing.
        const late = !slot;
        if (late) {
          if (!turnJob) return { ok: false, error: 'not racing this job' };
          if ((j.answered || []).includes(name)) return { ok: false, code: 'answered', error: 'this machine has already answered this job' };
          if (!turnLate) return { ok: false, code: 'turn_over', error: 'this machine\'s turn on the batch ended and the batch went on to another machine' };
        }
        j.racers = (j.racers || []).filter((x) => x !== name);
        j.answered = [...(j.answered || []).filter((x) => x !== name), name].slice(-4 * PROVER_BOARD.communityRacers);
        // a turn given back: the next machine's, and this place waits behind the others for a while (a turn that had already ended was counted when it did)
        if (error != null && turnJob && !late) { await mark(worker.name, 'lapsed'); await troubled(worker.client); }
        // a drawn block given back: the race's at once, and this place waits behind the others for a while
        if (error != null && j.drawn === worker.name && !j.drawOpen) { openDraw(j); await mark(worker.name, 'lapsed'); await troubled(worker.client); }
        if (error == null) {
          if (!isHex(publicValues) || publicValues.length < 2 + 64 * 2 || publicValues.length > 2 + 2 * PROVER_BOARD.maxCandidatePvBytes) return { ok: false, error: 'publicValues must be the hex of the proof\'s public values' };
          if (!isHex(proof) || proof.length < 2 + 2 * 4 || proof.length > 2 + 2 * 4096) return { ok: false, error: 'proof must be the hex of the groth16 proof bytes' };
          const since = (j.racedAt || {})[worker.name];
          j.race = [...(j.race || []).filter((c) => c.worker !== worker.name), { worker: worker.name, publicValues: publicValues.toLowerCase(), proof: proof.toLowerCase(), at: clock(),
            ...(worker.client ? { client: worker.client } : {}), ...(since ? { secs: (clock() - since) / 1000 } : {}) }]
            .slice(-PROVER_BOARD.communityRacers);
        }
        await storage.putJob(j.id, j);
        return { ok: true, status: error == null ? 'candidate' : 'dropped' };
      }
      if (j.status !== 'claimed' || j.worker !== worker.name) return { ok: false, error: j.status === 'claimed' ? 'claimed by another worker' : `job is ${j.status}` };
      if (error != null) {
        j.status = 'failed'; j.error = String(error).slice(0, 300); await end(j);
        await storage.putJob(j.id, j);
        await bump(worker.name, 'failed');
        return { ok: true, status: 'failed' };
      }
      if (!isHex(publicValues) || publicValues.length < 2 + 64 * 2 || publicValues.length > 2 + 2 * 65536) return { ok: false, error: 'publicValues must be the hex of the proof\'s public values' };
      if ((j.mode || PROVER_BOARD.modes[j.program]) === 'compressed') {
        if (typeof proof !== 'string' || !B64.test(proof) || b64len(proof) < 1024 || b64len(proof) > PROVER_BOARD.maxCompressedProofBytes) return { ok: false, error: 'proof must be the base64 of the saved compressed proof' };
        j.status = 'proved'; j.publicValues = publicValues.toLowerCase(); await putProof(j, proof); await end(j);
      } else {
        if (!isHex(proof) || proof.length < 2 + 2 * 4 || proof.length > 2 + 2 * 4096) return { ok: false, error: 'proof must be the hex of the groth16 proof bytes' };
        j.status = 'proved'; j.publicValues = publicValues.toLowerCase(); j.proof = proof.toLowerCase(); await end(j);
      }
      await storage.putJob(j.id, j);
      await bump(worker.name, 'proved');
      return { ok: true, status: 'proved' };
    });
  }

  // For anyone: how much is waiting, and who is proving. No inputs, no proofs.
  async function summary() {
    const pend = await storage.getPending();
    const counts = { queued: 0, claimed: 0, proved: 0, failed: 0 };
    const waits = [], proves = [], racing = new Map();
    const recs = await loadJobs(pend);
    for (const jid of pend) {
      const j = recs.get(jid);
      if (!j) continue;
      const live = j.status === 'claimed' && clock() > j.leaseUntil ? 'queued' : j.status;
      if (counts[live] != null) counts[live]++;
      if (['queued', 'claimed'].includes(j.status)) for (const r of liveRacers(j)) racing.set(r, j.program || 'confidential');
      if (j.status === 'proved' && j.postedAt && j.claimedAt && j.endedAt) { waits.push((j.claimedAt - j.postedAt) / 1000); proves.push((j.endedAt - j.claimedAt) / 1000); }
    }
    const ws = await workers();
    const list = Object.entries(ws).map(([name, w]) => ({ name, proved: w.proved || 0, failed: w.failed || 0, bad: w.bad || 0, lastBadSeconds: w.lastBadAt ? Math.max(0, Math.floor((clock() - w.lastBadAt) / 1000)) : null, lastSeenSeconds: w.lastSeen ? Math.max(0, Math.floor((clock() - w.lastSeen) / 1000)) : null, pubkey: w.pubkey || null, programs: w.programs || ['confidential'],
      // a community machine: the program it is proving now (it asks for nothing meanwhile), the turns it has had, and its batch record
      ...(w.community ? { community: true, racing: racing.get(name) || null, turns: w.turns || 0, lapsed: w.lapsed || 0,
        ...(w.batches ? { batches: w.batches, batchSecs: Math.round(w.batchSecs) } : {}),
        ...(w.blocks ? { blocks: w.blocks, blockSecs: Math.round(w.blockSecs * 10) / 10, ...(w.blockFelt > 0 ? { blockFelt: Math.round(w.blockFelt * 10) / 10 } : {}) } : {}),
        // how many blocks it was drawn for, and of those how many it never came to take (taken ones show in `blocks`)
        ...(w.draws ? { draws: w.draws, drawMissed: w.drawMissed || 0 } : {}) } : {}) }))
      .sort((a, b) => b.proved - a.proved || a.name.localeCompare(b.name));
    // How the jobs finished in the last hour fared (a job stays readable that long), in seconds: the wait for a claim, which is a worker busy with other
    // work (the proof pool's stock, an Ethereum-state proof), and the time to prove. On 2026-10-30 the wait was 1 s at the median and 24 s at the 90th
    // percentile, every wait over five seconds behind work that was not a board job, so the 90th percentile is what a second worker would move.
    const pct = (xs, p) => (xs.length ? Math.round([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]) : null);
    const recent = { n: waits.length, waitP50: pct(waits, 0.5), waitP90: pct(waits, 0.9), proveP50: pct(proves, 0.5), proveP90: pct(proves, 0.9) };
    return { ...counts, recent, workers: list, lease: PROVER_BOARD.leaseMs / 1000, pay: { pointsPerProof: pay.pointsPerProof, pointsByProgram: pay.pointsByProgram },
      asks: { ...mem.asks, maybe: { ...mem.asks.maybe } } };
  }

  // One machine's standing, for its owner: its records, whether it holds a ticket in the block draw now and, if not, the reason in words, and
  // the odds it would have (its place's share of the tickets, as a block drawn this moment would use them). The same tickets as the draw:
  // drawTickets. Everything here is already public on the summary; this only puts one address's row, and what follows from it, in one place.
  async function standing(address) {
    const addr = String(address || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return { ok: false, error: 'address must be a 0x address' };
    const name = `c-${addr}`, ws = await workers(), w = ws[name], t = clock();
    if (!w || !w.community) return { ok: true, found: false, name, text: `The board has not seen ${addr.slice(0, 6)}...${addr.slice(-4)} yet. Its machine appears here a few seconds after it first asks for work.` };
    const seen = w.lastSeen ? Math.max(0, Math.floor((t - w.lastSeen) / 1000)) : null;
    const rec = w.blocks && w.blockSecs > 0;
    const trouble = (storage.getTrouble && await storage.getTrouble()) || {};
    const { tickets, byPlace, line, seats } = drawTickets(ws, [], { program: 'tacit-block', raced: [] }, trouble);
    const place = w.client || name, mine = tickets.find(([p]) => p === place), here = byPlace.get(place);
    const spot = !rec && here && here[0] === name ? line.indexOf(place) : -1;      // its place in the newcomers' line, from 0
    const total = tickets.reduce((s, [, x]) => s + x, 0);
    // why not: in the order a machine can fix them
    let why = null;
    if (seen == null || seen * 1000 >= PROVER_BOARD.turnSeenMs) why = 'It is not asking for work right now. Start it and it joins within seconds.';
    else if (!offers(w, 'tacit-block')) why = 'It has not offered Tacit chain blocks in the last minute (TACIT_BLOCK=0 on the worker, its block key check failed, or a second worker under the same address that does not offer them is the one asking).';
    else if (!rec && !((w.proved || 0) >= 1)) why = 'It needs one accepted proof of any kind first (a wrap for the pool counts). Then it joins the draw.';
    else if (w.client && trouble[w.client] != null && t - trouble[w.client] < PROVER_BOARD.turnTroubleMs) why = 'Its connection missed a turn recently, so it waits behind the others for a while.';
    else if (rec && usualSecs(w) > PROVER_BOARD.drawMaxSecs) why = `Its usual block time (${Math.round(usualSecs(w))} s) is over ${PROVER_BOARD.drawMaxSecs} s, so blocks stay with faster machines; its batches and wraps are unaffected.`;
    else if (mine && here && here[0] !== name) why = 'Another machine on the same connection holds this connection\'s one ticket (its faster one).';
    else if (seen * 1000 >= draw.freshMs) why = `It last asked for work ${seen} s ago. Blocks are drawn only among machines that asked in the last ${Math.round(draw.freshMs / 1000)} s, so one that is busy with another proof, or asks less often than that, is out of the draw at this moment and in it when it happens to have asked a moment before.`;
    else if (!mine && spot >= seats) why = `Machines with no block record yet take turns at a set-aside share of the blocks: ${seats} hold a ticket at a time, the ones that have waited longest, and a machine goes to the back of the line once it is drawn. This one is number ${spot + 1} in line, so ${spot - seats + 1} ${spot - seats + 1 === 1 ? 'machine' : 'machines'} must be drawn before it holds a ticket.`;
    else if (!mine) why = 'No ticket right now.';
    const odds = !why && mine && total > 0 ? mine[1] / total : null;
    const lines = [];
    lines.push(`${name.slice(0, 10)}...${name.slice(-4)}: ${w.proved || 0} proofs taken by the board${seen != null ? `, last asked ${seen} s ago` : ''}.`);
    const felt = rec && w.blockFelt > 0 ? w.blockFelt : null;
    if (rec && felt != null) lines.push(`Tacit chain blocks: ${w.blocks} taken, usually ${Math.round(felt * 10) / 10} s from the block being posted to this machine's proof arriving (${Math.round(w.blockSecs * 10) / 10} s of that proving it).`);
    else if (rec) lines.push(`Tacit chain blocks: ${w.blocks} taken, usually ${Math.round(w.blockSecs * 10) / 10} s each.`);
    else lines.push('Tacit chain blocks: none taken yet.');
    if (felt != null && felt - w.blockSecs >= 4) lines.push(`About ${Math.round(felt - w.blockSecs)} s of that is the block waiting: for this machine to ask for it, or for the machine drawn first to give up on it. The odds count the whole wait, so asking for work every few seconds and not being busy with another proof when a block is posted lifts them.`);
    if (w.draws) lines.push(`Drawn for ${w.draws} block${w.draws === 1 ? '' : 's'}${w.drawMissed ? `, ${w.drawMissed} not taken in time (it had not asked for the block within ${PROVER_BOARD.drawOfferMs / 1000} s of its being posted)` : ', all taken'}.`);
    if (odds != null) lines.push(`In the block draw now: ${odds >= 0.995 ? 'about every block' : odds < 0.01 ? 'less than 1 in 100 of the blocks' : 'about ' + Math.round(odds * 100) + ' in 100 of the blocks'} drawn this minute would be this machine's${rec ? '' : ' (a machine with no block record yet takes turns at a set-aside share of the blocks: it goes to the back of the line once it is drawn, and a block taken gives it a record, which sets its odds by speed from then on)'}.`);
    else lines.push(`Not in the block draw: ${why}`);
    return { ok: true, found: true, name, proved: w.proved || 0, blocks: w.blocks || 0, blockSecs: rec ? Math.round(w.blockSecs * 10) / 10 : null, blockFelt: felt != null ? Math.round(felt * 10) / 10 : null, draws: w.draws || 0, drawMissed: w.drawMissed || 0,
      lastSeenSeconds: seen, inDraw: odds != null, oddsPct: odds != null ? Math.round(odds * 1000) / 10 : null,
      line: spot >= 0 ? { position: spot + 1, seats, ahead: Math.max(0, spot - seats + 1), of: line.length } : null, why, text: lines.join('\n') };
  }

  return { post, status, cancel, claim, beat, result, raceVerdict, summary, credits, standing };
}

const kvLocks = new WeakMap(), kvMemory = new WeakMap();
export function buildProverBoard(env, { hash } = {}) {
  const KV = env.CONFIDENTIAL_KV || env.REGISTRY_KV;
  if (!KV) return null;
  if (!kvLocks.has(KV)) kvLocks.set(KV, makeLock());
  if (!kvMemory.has(KV)) kvMemory.set(KV, newBoardMemory());
  const storage = {
    getPending: async () => { const s = await KV.get('pb:pending'); return s ? JSON.parse(s) : []; },
    putPending: async (ids) => KV.put('pb:pending', JSON.stringify(ids)),
    getJob: async (id) => { const s = await KV.get('pb:job:' + id); return s ? JSON.parse(s) : null; },
    putJob: async (id, job) => KV.put('pb:job:' + id, JSON.stringify(job)),
    deleteJob: async (id) => KV.delete('pb:job:' + id),
    putProof: async (id, proof) => KV.put('pb:proof:' + id, proof),
    getProof: async (id) => KV.get('pb:proof:' + id),
    deleteProof: async (id) => KV.delete('pb:proof:' + id),
    putNote: async (k, v) => KV.put('pb:note:' + k, JSON.stringify(v), { expirationTtl: 3 * 86400 }),
    putStdin: async (id, stdin) => KV.put('pb:stdin:' + id, stdin),
    getStdin: async (id) => KV.get('pb:stdin:' + id),
    deleteStdin: async (id) => KV.delete('pb:stdin:' + id),
    getWorkers: async () => { const s = await KV.get('pb:workers'); return s ? JSON.parse(s) : {}; },
    putWorkers: async (ws) => KV.put('pb:workers', JSON.stringify(ws)),
    getDay: async (d) => { const s = await KV.get('pb:day:' + d); return s ? JSON.parse(s) : null; },
    putDay: async (d, rec) => KV.put('pb:day:' + d, JSON.stringify(rec), { expirationTtl: PROVER_BOARD.daySecs }),
    getTrouble: async () => { const s = await KV.get('pb:trouble'); return s ? JSON.parse(s) : {}; },
    putTrouble: async (m) => KV.put('pb:trouble', JSON.stringify(m), { expirationTtl: Math.ceil(PROVER_BOARD.turnTroubleMs / 1000) }),
  };
  return makeProverBoard({ storage, hash, lock: kvLocks.get(KV), memory: kvMemory.get(KV), cfg: { ...PROVER_BOARD, ...proverBoardConfig(env) } });
}
