#!/usr/bin/env node
// TacVault keeper.
//
// With ORACLE set (one or more venue oracles, comma separated), it records their intervals: every interval within
// an oracle's longest window that is not yet recorded (so a first run fills the history at once), each proven at its
// sample block, which the following block's mixHash picks. RPC must serve `eth_getProof` for blocks as old as the
// longest window (an archive endpoint); the keeper checks this at start and exits if not. When both venues need the
// same interval it records them in one transaction (through Multicall3, when the chain has it), and it looks at the
// newest intervals every RECORD_POLL_SECONDS (a full sweep of the window every FULL_SWEEP_SECONDS), because a record
// that lands more than GRACE blocks after its interval ends pauses borrowing. Records pay at most MAX_GWEI, and at
// most URGENT_MAX_GWEI once a needed interval is URGENT_AFTER_BLOCKS old; above the cap they are skipped and anyone
// can fill the interval later, for about 21 hours. A transaction offers a fee cap of FEE_HEADROOM (3) times the base fee plus the tip, or the policy cap
// when that is less, so the wallet needs gasLimit x that to send (a few thousandths of an ETH at today's base fee), not gasLimit x MAX_GWEI; when it holds
// less, the keeper raises an ALERT naming what it holds and what the send needs instead of failing at the node on every cycle.
//
// RECORD_MODE=demand (needs VAULTS) stops the round-the-clock recording, which is the keeper's only running cost. Recording an interval later proves the
// same storage the same way (the ring keeps about 21 hours), so a late record is as good as a prompt one and nothing is lost by waiting; a borrower who
// finds prices missing records them in their own transaction (the router), and so does a withdrawal with a debt; a liquidator records first. The keeper then records only
// while a borrower is within RISK_COVER_BPS (28000, that is 280%) of its debt at the lower of the venues' spot and newest recorded price, or in an auction,
// so that prices are on the record before a vault can reach the liquidation line; it reads only what an unrecorded oracle still answers (spot, latest and the
// vault's feed), which costs no gas. With every vault far from the line the wallet spends nothing.
//
// With VAULTS set, it reads each vault's borrowers from its Borrowed events (in chunks, remembering them) and:
//   - calls `liquidate` on a vault with debt that is below the liquidation line (not while the owner has paused
//     auctions), and `cancel` on an auction whose vault has recovered;
//   - once an auction has run AUCTION_DURATION, calls `absorb` when it can, and otherwise reports the vault.
//
// Every call is simulated first and sent only if it would succeed, with a gas limit 30% above the estimate. Vault
// actions pay at most ACTION_MAX_GWEI, since a liquidation must not wait out a gas spike. A transaction that mines
// but reverts is reported. Anyone can run one.
//
// Lines starting ALERT report what an operator may want to act on: an auction opened on a vault (its owner can repay
// or add TAC until the owner window ends), a venue's price more than 40% under its longest window's upper median or
// 60% over its lower one, an oracle the vault's owner has announced or put in place whose venues are not recorded
// here, and intervals that could not be recorded. With ALERT_WEBHOOK set, each is also posted there as {"text": "..."}.
//
// Usage:
//   KEEPER_ACCOUNT=<cast keystore name> [KEEPER_PASSWORD_FILE=..] RPC=<archive endpoint>
//   [ORACLE=0xvenue1,0xvenue2] [VAULTS=0xusd,0xeth FROM_BLOCK=<vault deploy block>] [SEND_RPC=https://...]
//   [MAX_GWEI=1] [RECORD_TIP_GWEI=0.001] [URGENT_MAX_GWEI=25] [URGENT_TIP_GWEI=0.1] [URGENT_AFTER_BLOCKS=5]
//   [ACTION_MAX_GWEI=100] [ACTION_TIP_GWEI=0.1] [RECORD_POLL_SECONDS=12] [FULL_SWEEP_SECONDS=300] [SCAN_SECONDS=60]
//   [LOG_CHUNK=5000] [ALERT_WEBHOOK=https://...] [ONCE=1] [FEE_HEADROOM=3] [RECORD_MODE=always|demand] [RISK_COVER_BPS=28000]
//   node tools/tac-vault-keeper.mjs
// KEEPER_PRIV=0x.. works too, but the key is then visible to every local process in the command line of each send.

import { execFileSync } from 'node:child_process';

const KEEPER_PRIV = process.env.KEEPER_PRIV;
const KEEPER_ACCOUNT = process.env.KEEPER_ACCOUNT;
const ORACLES = (process.env.ORACLE || '').split(',').map((s) => s.trim()).filter(Boolean);
const VAULTS = (process.env.VAULTS || '').split(',').map((s) => s.trim()).filter(Boolean);
const RPC = process.env.RPC;
if (!(KEEPER_PRIV || KEEPER_ACCOUNT) || !RPC || !(VAULTS.length || ORACLES.length) || (VAULTS.length && !process.env.FROM_BLOCK)) {
  console.error('set KEEPER_ACCOUNT (or KEEPER_PRIV), RPC, and ORACLE and/or VAULTS with FROM_BLOCK');
  process.exit(2);
}
const SEND_RPC = process.env.SEND_RPC || RPC;
const gwei = (x) => BigInt(Math.round(Number(x) * 1e9));
const RECORD_CAP = gwei(process.env.MAX_GWEI || 1);
const RECORD_TIP = gwei(process.env.RECORD_TIP_GWEI || 0.001);
const ACTION_CAP = gwei(process.env.ACTION_MAX_GWEI || 100);
const ACTION_TIP = gwei(process.env.ACTION_TIP_GWEI || 0.1);
const URGENT_CAP = gwei(process.env.URGENT_MAX_GWEI || 25);
const URGENT_TIP = gwei(process.env.URGENT_TIP_GWEI || 0.1);
const URGENT_AFTER = BigInt(process.env.URGENT_AFTER_BLOCKS || 5);
const FEE_HEADROOM = BigInt(Math.max(1, Math.round(Number(process.env.FEE_HEADROOM || 3))));
const RECORD_MODE = process.env.RECORD_MODE || 'always';
if (!['always', 'demand'].includes(RECORD_MODE)) {
  console.error('RECORD_MODE is always or demand');
  process.exit(2);
}
const RISK_COVER_BPS = BigInt(process.env.RISK_COVER_BPS || 28000);
const RECORD_POLL = Number(process.env.RECORD_POLL_SECONDS || 12);
const FULL_SWEEP = Number(process.env.FULL_SWEEP_SECONDS || 300);
const SCAN_SECONDS = Number(process.env.SCAN_SECONDS || 60);
const ALERT_WEBHOOK = process.env.ALERT_WEBHOOK;
// A record is about 0.93M gas and a transaction can carry about a dozen (its gas and size limits), so what is due goes out that many to a transaction.
const BATCH_RECORDS = Math.max(1, Number(process.env.BATCH_RECORDS || 12));
// DEFER_BLOCKS > 0 lets an interval wait up to that many blocks for a cheaper block: it is recorded when the base fee is at or under the DEFER_PCT-th
// percentile of the last 300 blocks, and at once (up to the caps) once it is that old. The vaults borrow only on an oracle that is up to date, so what waits is
// carried by whoever borrows next; off by default.
const DEFER_BLOCKS = BigInt(process.env.DEFER_BLOCKS || 0);
const DEFER_PCT = Math.min(100, Math.max(0, Number(process.env.DEFER_PCT || 30)));
// The wallet's balance under which an ALERT is raised, in ETH (about 40 records at 0.06 gwei).
const LOW_BALANCE = gwei(process.env.LOW_BALANCE_ETH || 0.004) * 10n ** 9n;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
// The longest batch argument handed to cast, in characters: under Linux's 128 KiB cap on one argument, with room to spare.
const BATCH_ARG_CHARS = Number(process.env.BATCH_ARG_CHARS || 100_000);
const MAX_CHUNK = BigInt(process.env.LOG_CHUNK || 5000);
let logChunk = MAX_CHUNK;
const ONCE = process.env.ONCE === '1';

const cast = (args) => execFileSync('cast', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const num = (s) => BigInt(s.split(' ')[0]);
const call = (to, sig, ...a) => cast(['call', to, sig, ...a, '--rpc-url', RPC]);
const errLine = (e) => String(e.stderr || e.message).split('\n')[0];
const log = (...m) => console.log(new Date().toISOString(), ...m);
const head = () => num(cast(['block-number', '--rpc-url', RPC]));

// Reports something an operator may act on: a log line, and a POST to ALERT_WEBHOOK when set. Each key alerts once
// until it is cleared.
const alerted = new Set();
function alertOnce(key, msg) {
  if (alerted.has(key)) return;
  alerted.add(key);
  log('ALERT', msg);
  if (!ALERT_WEBHOOK) return;
  fetch(ALERT_WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `tac-vault-keeper: ${msg}` }) })
    .catch((e) => log('alert webhook failed:', String(e.message || e)));
}
const clearAlert = (key) => alerted.delete(key);

// A cast keystore account keeps the key out of the process list; KEEPER_PRIV passes it as an argument.
const signer = KEEPER_ACCOUNT
  ? ['--account', KEEPER_ACCOUNT, ...(process.env.KEEPER_PASSWORD_FILE ? ['--password-file', process.env.KEEPER_PASSWORD_FILE] : [])]
  : ['--private-key', KEEPER_PRIV];
let sender;
try {
  sender = cast(['wallet', 'address', ...signer]);
} catch (e) {
  console.error('cannot load the signing key:', errLine(e));
  process.exit(2);
}
if (!KEEPER_ACCOUNT) log('WARNING: KEEPER_PRIV is visible in the process list; prefer KEEPER_ACCOUNT');

// Simulates a call from the keeper's address: { ok, reason }.
function simulate(to, sig, ...a) {
  try {
    cast(['call', to, sig, ...a, '--from', sender, '--rpc-url', RPC]);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: errLine(e) };
  }
}

// A node refuses a send unless the wallet holds gasLimit x the transaction's fee cap, whatever the transaction then pays (the base fee and the tip). The
// cap a transaction offers is therefore the policy cap (MAX_GWEI, URGENT_MAX_GWEI, ACTION_MAX_GWEI) or FEE_HEADROOM times the base fee plus the tip,
// whichever is less: at a base fee of 0.05 gwei a wallet needs a few thousandths of an ETH for a record, not the 0.03 ETH that 25 gwei would ask.
const feeCapFor = (baseFee, cap, tip) => {
  const want = baseFee * FEE_HEADROOM + tip;
  return want < cap ? want : cap;
};
const eth = (wei) => Number(wei) / 1e18;

// A send the wallet cannot pay for is an alert naming what it holds and what the transaction needs, not a refusal from the node on every cycle.
function noteAfford(e) {
  if (e.afford) alertOnce('afford', `the keeper wallet ${sender} cannot pay for a transaction (${e.message}); send it ETH`);
}

// Sends with a gas limit 30% over the estimate and a fee cap of at most the given cap, waits for the receipt (up to five
// minutes, so the next send takes the next nonce) and returns the hash; throws if the wallet cannot pay for it or the transaction reverted.
function send(to, sig, args, cap, tip) {
  const estimate = num(cast(['estimate', to, sig, ...args, '--from', sender, '--rpc-url', RPC]));
  const gasLimit = estimate * 13n / 10n;
  const fee = feeCapFor(num(cast(['base-fee', '--rpc-url', RPC])), cap, tip);
  const need = gasLimit * fee;
  const have = num(cast(['balance', sender, '--rpc-url', RPC]));
  if (have < need) {
    const e = new Error(`it holds ${eth(have)} ETH and this transaction needs ${eth(need)} ETH (${gasLimit} gas at a fee cap of ${Number(fee) / 1e9} gwei)`);
    e.afford = true;
    throw e;
  }
  const out = cast([
    'send', to, sig, ...args, ...signer, '--gas-limit', String(gasLimit), '--gas-price', String(fee),
    '--priority-gas-price', String(tip < fee ? tip : fee), '--timeout', '300', '--rpc-url', SEND_RPC, '--json',
  ]);
  const receipt = JSON.parse(out);
  if (!/1$/.test(String(receipt.status))) throw new Error(`REVERTED on chain: ${receipt.transactionHash}`);
  clearAlert('afford');
  return receipt.transactionHash;
}

const alreadyRecorded = cast(['sig', 'AlreadyRecorded()']);
const tooFewSamples = cast(['sig', 'TooFewSamples()']);

const recorded = (oracle, k) => {
  try {
    return num(call(oracle, 'sampleOf(uint256)(uint256,uint256)', String(k)).split('\n')[0]) !== 0n;
  } catch {
    return false;
  }
};

// Each venue oracle: the contract whose storage it proves, the two slots, its interval and how many to keep.
const configs = new Map();

function readConfig(oracle) {
  if (configs.has(oracle)) return true;
  try {
    const step = num(call(oracle, 'STEP()(uint256)'));
    const [slotA, slotB] = call(oracle, 'slots()(bytes32,bytes32)').split('\n');
    configs.set(oracle, {
      pool: call(oracle, 'POOL()(address)'),
      slots: [slotA, slotB],
      step,
      intervals: num(call(oracle, 'MAX_WINDOW()(uint256)')) / (step * 12n) + 2n,
    });
    return true;
  } catch (e) {
    log(oracle, 'oracle read failed:', errLine(e));
    return false;
  }
}

// Records to the venues' oracles go through Multicall3 when two are due together and the chain has it.
let hasMulticall;
function multicall() {
  if (hasMulticall === undefined) {
    try {
      hasMulticall = cast(['code', MULTICALL3, '--rpc-url', RPC]).length > 2;
    } catch {
      hasMulticall = false;
    }
  }
  return hasMulticall;
}

const RECORD_SIG = 'record(bytes,bytes,bytes[],bytes[],bytes[])';
let lastFull = 0;

// The arguments of `record` for interval k of an oracle: its sample block is picked by the next block's mixHash.
function buildRecord(oracle, c, k, top) {
  const next = (k + 1n) * c.step;
  const mix = BigInt(cast(['block', String(next), '--field', 'mixHash', '--rpc-url', RPC]));
  const n = k * c.step + (mix % c.step);
  const p = JSON.parse(cast(['proof', c.pool, ...c.slots, '-B', String(n), '--rpc-url', RPC]));
  const list = (a) => `[${a.join(',')}]`;
  const args = [
    cast(['block', String(n), '--raw', '--rpc-url', RPC]),
    cast(['block', String(next), '--raw', '--rpc-url', RPC]),
    list(p.accountProof),
    list(p.storageProof[0].proof),
    list(p.storageProof[1].proof),
  ];
  return { oracle, k, n, args, age: top - next };
}

// Looks at the newest intervals of every oracle (all of those a window needs once in FULL_SWEEP seconds) and records
// what is missing, newest first, so a long outage is repaired from the intervals every window needs most.
function sampleAll() {
  const full = Date.now() - lastFull >= FULL_SWEEP * 1000;
  for (const oracle of ORACLES) if (!readConfig(oracle)) return;
  const top = head();
  const baseFee = num(cast(['base-fee', '--rpc-url', RPC]));
  const stepMax = Math.max(...ORACLES.map((o) => Number(configs.get(o).step)));
  const depth = full ? Math.max(...ORACLES.map((o) => Number(configs.get(o).intervals))) : Math.max(3, Number(DEFER_BLOCKS) / stepMax + 3);
  let missed = 0;
  const all = [];                                                                                      // everything due, newest interval first
  for (let i = 0; i < depth; i++) {
    const due = [];
    for (const oracle of ORACLES) {
      const c = configs.get(oracle);
      if (BigInt(i) >= c.intervals) continue;
      // The newest interval whose following block exists, then i back.
      const k = (top - 1n) / c.step - 1n - BigInt(i);
      if (k < 0n) continue;
      try {
        if (recorded(oracle, k)) continue;
        due.push(buildRecord(oracle, c, k, top));
      } catch (e) {
        ++missed;
        log(oracle, 'record', String(k), 'failed:', errLine(e));
      }
    }
    all.push(...due);
  }
  // Out in as few transactions as the limits allow, the newest first (a transaction's own cost is paid once, not for each interval); an interval that can
  // wait for a cheaper block does, unless something due is already older than DEFER_BLOCKS.
  if (all.length && !cheapOrLate(all, baseFee)) log(`${all.length} record(s) due; the base fee ${baseFee / 10n ** 6n}e-3 gwei is above the ${DEFER_PCT}th percentile of the last 300 blocks: waiting for a cheaper block`);
  else for (let j = 0; j < all.length; j += BATCH_RECORDS) missed += submit(all.slice(j, j + BATCH_RECORDS), baseFee);
  if (full) lastFull = Date.now();
  if (missed) alertOnce('missed', `${missed} interval(s) could not be recorded; borrowing and liquidation wait for them`);
  else clearAlert('missed');
}

// With DEFER_BLOCKS off, always. With it on: true when the base fee is at or under the DEFER_PCT-th percentile of the last 300 blocks, or when the oldest
// due interval is DEFER_BLOCKS old. The history is read once a minute.
let feeCache = { at: 0, sorted: [] };
function cheapOrLate(all, baseFee) {
  if (DEFER_BLOCKS === 0n) return true;
  if (all.some((d) => d.age >= DEFER_BLOCKS)) return true;
  if (Date.now() - feeCache.at > 60e3) {
    try {
      const h = JSON.parse(cast(['rpc', 'eth_feeHistory', '0x12c', 'latest', '[]', '--rpc-url', RPC]));
      feeCache = { at: Date.now(), sorted: h.baseFeePerGas.slice(0, -1).map((x) => BigInt(x)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) };
    } catch (e) {
      log('fee history unavailable, not waiting:', errLine(e));
      return true;
    }
  }
  const s = feeCache.sorted;
  return !s.length || baseFee <= s[Math.min(s.length - 1, Math.floor((s.length * DEFER_PCT) / 100))];
}

// Sends the due records: one transaction when more than one is due and Multicall3 exists, else one each. Returns how
// many were not recorded.
function submit(due, baseFee) {
  // An interval that is already older than URGENT_AFTER blocks is nearly late: pay up to the urgent cap for it.
  const urgent = due.some((d) => d.age >= URGENT_AFTER);
  const cap = urgent ? URGENT_CAP : RECORD_CAP;
  const tip = urgent ? URGENT_TIP : RECORD_TIP;
  if (baseFee > cap) {
    log('base fee', String(baseFee), urgent ? 'above URGENT_MAX_GWEI' : 'above MAX_GWEI', ': not recording');
    return urgent ? due.length : 0;
  }
  let missed = 0;
  const ready = [];
  for (const d of due) {
    const sim = simulate(d.oracle, RECORD_SIG, ...d.args);
    if (sim.ok) ready.push(d);
    // Another keeper recorded it first.
    else if (!sim.reason.includes(alreadyRecorded)) {
      ++missed;
      log(d.oracle, 'record', String(d.k), 'would fail:', sim.reason);
    }
  }
  if (!ready.length) return missed;
  // One at a time: the fallback when a batch is not possible or fails.
  const each = (list) => {
    for (const d of list) {
      try {
        log(d.oracle, 'record', String(d.k), String(d.n), send(d.oracle, RECORD_SIG, d.args, cap, tip));
      } catch (e) {
        // Another keeper recorded it between the simulation and the estimate, or its transaction landed first and
        // ours mined and reverted.
        if (errLine(e).includes(alreadyRecorded) || recorded(d.oracle, d.k)) continue;
        ++missed;
        noteAfford(e);
        log(d.oracle, 'record', String(d.k), 'failed:', errLine(e));
      }
    }
  };
  if (ready.length > 1 && multicall()) {
    // Every call must succeed (allowFailure false): the gas estimate then covers all of them, and a batch that
    // loses a race to another keeper reverts whole and is sent again one at a time.
    // A batch goes to cast as one argument, which Linux caps at 128 KiB (E2BIG): a backlog of records, each carrying its block
    // headers, is sent in batches that each stay under BATCH_ARG_CHARS.
    const calls = ready.map((d) => ({ d, call: `(${d.oracle},false,${cast(['calldata', RECORD_SIG, ...d.args])})` }));
    const batches = [];
    for (const c of calls) {
      const last = batches[batches.length - 1];
      if (last && last.chars + c.call.length + 1 <= BATCH_ARG_CHARS) { last.items.push(c); last.chars += c.call.length + 1; }
      else batches.push({ items: [c], chars: c.call.length + 2 });
    }
    for (const b of batches) {
      const list = b.items.map((c) => c.d);
      if (list.length === 1) { each(list); continue; }
      try {
        const hash = send(MULTICALL3, 'aggregate3((address,bool,bytes)[])', [`[${b.items.map((c) => c.call).join(',')}]`], cap, tip);
        for (const d of list) log(d.oracle, 'record', String(d.k), String(d.n), hash);
      } catch (e) {
        noteAfford(e);
        log('batch failed, recording one at a time:', errLine(e));
        each(list.filter((d) => !recorded(d.oracle, d.k)));
      }
    }
  } else {
    each(ready);
  }
  return missed;
}

// A venue whose price is more than 40% under its longest window's upper median, or 60% over its lower one, is worth
// a look: the vaults price from medians, so a move this size either holds (and moves the views) or is traded back.
function checkVenues() {
  for (const oracle of ORACLES) {
    const key = `venue:${oracle}`;
    try {
      const max = num(call(oracle, 'MAX_WINDOW()(uint256)'));
      const [low, high] = call(oracle, 'prices(uint256)(uint256,uint256)', String(max)).split('\n').map(num);
      const spot = num(call(oracle, 'spot()(uint256)'));
      if (spot * 100n < high * 60n) alertOnce(key, `${oracle}: price is more than 40% below its ${max / 3600n}-hour median`);
      else if (spot * 100n > low * 160n) alertOnce(key, `${oracle}: price is more than 60% above its ${max / 3600n}-hour median`);
      else clearAlert(key);
    } catch {
      // Too few intervals recorded for a median: nothing to compare with.
    }
  }
}

// A vault whose owner swaps the oracle (announced ORACLE_DELAY ahead) prices from venues this keeper may not be
// recording: its ORACLE env names the venues, and a new pair needs its own intervals recorded or its prices lapse.
function checkVaultOracles() {
  const known = new Set(ORACLES.map((o) => o.toLowerCase()));
  for (const vault of VAULTS) {
    try {
      const venuesOf = (oracle) => {
        try { return [call(oracle, 'A()(address)'), call(oracle, 'B()(address)')]; } catch { return [oracle]; }
      };
      const now = call(vault, 'ORACLE()(address)');
      const stray = venuesOf(now).filter((v) => !known.has(v.toLowerCase()));
      const key = `oracle:${vault}:${now}`;
      if (ORACLES.length && stray.length) alertOnce(key, `${vault}: its oracle ${now} prices from ${stray.join(', ')}, not recorded here; restart with ORACLE set to them`);
      else clearAlert(key);
      const next = call(vault, 'pendingOracle()(address)');
      // An announcement that was cancelled (or carried out) is forgotten, so announcing it again alerts again.
      for (const k of [...alerted]) if (k.startsWith(`pending-oracle:${vault}:`) && k !== `pending-oracle:${vault}:${next}`) clearAlert(k);
      if (!/^0x0+$/.test(next)) {
        const eta = num(call(vault, 'pendingOracleEta()(uint256)'));
        const venues = venuesOf(next).filter((v) => !known.has(v.toLowerCase()));
        alertOnce(`pending-oracle:${vault}:${next}`, `${vault}: oracle ${next} is announced from ${new Date(Number(eta) * 1000).toISOString()}${venues.length ? `; record ${venues.join(', ')} before then` : ''}`);
      }
    } catch (e) {
      log(vault, 'oracle check failed:', errLine(e));
    }
  }
}

// Per vault: borrowers seen in Borrowed(address indexed owner, address to, uint256 amount, uint256 fee) and the
// next block to read. Only a real borrow of at least MIN_DEBT puts an owner here.
const seen = new Map(VAULTS.map((v) => [v, { owners: new Set(), next: BigInt(process.env.FROM_BLOCK || 0) }]));

function readOwners(vault) {
  const s = seen.get(vault);
  const top = head();
  while (s.next <= top) {
    const to = s.next + logChunk - 1n < top ? s.next + logChunk - 1n : top;
    let out;
    try {
      out = cast([
        'logs', '--address', vault, '--from-block', String(s.next), '--to-block', String(to),
        'Borrowed(address indexed,address,uint256,uint256)', '--rpc-url', RPC, '--json',
      ]);
    } catch (e) {
      // A provider's range limit: retry with a smaller chunk.
      if (logChunk <= 100n) throw e;
      logChunk /= 2n;
      log('log range refused, chunk now', String(logChunk));
      continue;
    }
    for (const l of JSON.parse(out || '[]')) s.owners.add('0x' + l.topics[1].slice(26));
    s.next = to + 1n;
  }
  // A pass without a refusal lets a chunk that was halved by a transient error grow back.
  if (logChunk < MAX_CHUNK) logChunk = logChunk * 2n < MAX_CHUNK ? logChunk * 2n : MAX_CHUNK;
  return [...s.owners];
}

const act = (vault, sig, owner) => send(vault, sig, [owner], ACTION_CAP, ACTION_TIP);

// Whether a borrower is close enough to the liquidation line, or in an auction, that prices should be on the record: the cover is the TAC held at the
// lower of the venues' spot and the newest recorded price (the cautious one), in the vault's unit through its own feed, over the debt. Reads only what an
// oracle with nothing recorded still answers. A price that cannot be read leaves the last answer standing and says so.
let lastRisk = false;
function atRisk() {
  let risky = false;
  for (const vault of VAULTS) {
    try {
      const owners = readOwners(vault);
      const pair = call(vault, 'ORACLE()(address)');
      const spot = num(call(pair, 'spot()(uint256)'));
      let latest = 0n;
      try {
        latest = num(call(pair, 'latest()(uint256)'));
      } catch {}
      const ethPerTac = latest > 0n && latest < spot ? latest : spot;
      const feed = call(vault, 'ETH_USD()(address)');
      const answer = num(call(feed, 'latestRoundData()(uint80,int256,uint256,uint256,uint80)').split('\n')[1]);
      const usdPerTac = (ethPerTac * answer) / 10n ** num(call(feed, 'decimals()(uint8)'));
      for (const owner of owners) {
        const [collateral, debt, start] = call(vault, 'vaults(address)(uint256,uint256,uint256)', owner).split('\n').map(num);
        const key = `risk:${vault}:${owner}`;
        if (debt === 0n) {
          clearAlert(key);
          continue;
        }
        const cover = (collateral * usdPerTac * 10000n) / (debt * 10n ** 18n);
        if (start !== 0n || cover < RISK_COVER_BPS) {
          risky = true;
          alertOnce(key, `${owner} on ${vault} is ${start !== 0n ? 'in an auction' : `at ${Number(cover) / 100}% cover`}: recording prices so that it can be acted on`);
        } else {
          clearAlert(key);
        }
      }
      clearAlert(`risk-read:${vault}`);
    } catch (e) {
      alertOnce(`risk-read:${vault}`, `${vault}: the borrowers' cover could not be read (${errLine(e)}); recording stays as it was`);
      risky ||= lastRisk;
    }
  }
  return (lastRisk = risky);
}

function scan(vault) {
  let list;
  try {
    list = readOwners(vault);
  } catch (e) {
    log(vault, 'LOG SCAN FAILED, vaults are not being checked:', errLine(e));
    return;
  }
  let duration;
  try {
    duration = num(call(vault, 'AUCTION_DURATION()(uint256)'));
  } catch (e) {
    log(vault, 'read failed:', errLine(e));
    return;
  }
  const now = num(cast(['block', 'latest', '--field', 'timestamp', '--rpc-url', RPC]));
  let window = 0n;
  try {
    window = num(call(vault, 'OWNER_WINDOW()(uint256)'));
  } catch {}
  // While the owner has paused auctions, `liquidate` and `absorb` are refused; `cancel` is not.
  let pausedUntil = 0n;
  try {
    pausedUntil = num(call(vault, 'pausedUntil()(uint256)'));
  } catch {}
  const paused = now < pausedUntil;
  // Auctions run on a clock that stands still while they are paused; `auctionStart` is a reading of it.
  let clock = now;
  try {
    clock = num(call(vault, 'auctionTime()(uint256)'));
  } catch {}
  if (paused) log(vault, 'auctions paused until', new Date(Number(pausedUntil) * 1000).toISOString(), ': not liquidating or absorbing');
  for (const owner of list) {
    try {
      const [, debt, start] = call(vault, 'vaults(address)(uint256,uint256,uint256)', owner).split('\n').map(num);
      const key = `auction:${vault}:${owner}`;
      if (start !== 0n) {
        alertOnce(key, `auction on ${vault} for ${owner}: its owner can repay or add TAC until ${new Date((Number(now) + Number(start + window) - Number(clock)) * 1000).toISOString()}`);
      } else {
        clearAlert(key);
      }
      if (debt === 0n) continue;
      if (start === 0n) {
        if (!paused && call(vault, 'liqHealthyView(address)(bool)', owner) === 'false' && simulate(vault, 'liquidate(address)', owner).ok) {
          log(vault, 'liquidate', owner, act(vault, 'liquidate(address)', owner));
          alertOnce(key, `auction on ${vault} for ${owner}: its owner can repay or add TAC for ${window} seconds`);
        }
      } else if (simulate(vault, 'cancel(address)', owner).ok) {
        log(vault, 'cancel', owner, act(vault, 'cancel(address)', owner));
      } else if (clock - start >= duration && !paused) {
        if (simulate(vault, 'absorb(address)', owner).ok) log(vault, 'absorb', owner, act(vault, 'absorb(address)', owner));
        else log(vault, owner, 'auction unsold and not absorbable (vault worth its debt, or the reserve is empty)');
      }
    } catch (e) {
      noteAfford(e);
      // With RECORD_MODE=demand an oracle with nothing recorded is the usual state, not a failure.
      if (RECORD_MODE === 'demand' && errLine(e).includes(tooFewSamples)) continue;
      log(vault, owner, 'check failed:', errLine(e));
    }
  }
}

// An operator's warning: the wallet holds little, in hours of recording at today's base fee (a pair of records is about 1.87M gas, six pairs an hour).
function checkBalance() {
  try {
    const bal = num(cast(['balance', sender, '--rpc-url', RPC]));
    const fee = num(cast(['base-fee', '--rpc-url', RPC]));
    const perHour = 6n * 1_870_000n * (fee > 0n ? fee : 1n);
    if (bal < LOW_BALANCE) alertOnce('balance', `the keeper wallet ${sender} holds ${Number(bal) / 1e18} ETH, about ${Number((bal * 10n) / perHour) / 10} hours of recording at the current base fee; send it ETH`);
    else clearAlert('balance');
  } catch (e) {
    log('balance read failed:', errLine(e));
  }
}

async function main() {
  for (const oracle of ORACLES) {
    try {
      // The oldest block the keeper reads: its longest window of intervals back.
      const step = num(call(oracle, 'STEP()(uint256)'));
      const reach = (num(call(oracle, 'MAX_WINDOW()(uint256)')) / (step * 12n) + 3n) * step;
      const oldest = head() > reach ? head() - reach : 1n;
      cast(['proof', call(oracle, 'POOL()(address)'), '0', '-B', String(oldest), '--rpc-url', RPC]);
    } catch (e) {
      console.error('RPC does not serve eth_getProof for old blocks; use an archive endpoint:', errLine(e));
      process.exit(2);
    }
  }
  let lastScan = 0;
  let lastRiskCheck = 0;
  for (;;) {
    // A node that drops one request (a reset connection, a rate limit) must not end the keeper: that cycle is skipped and the next one tries again.
    try {
      if (ORACLES.length) {
        if (RECORD_MODE === 'demand' && VAULTS.length) {
          // Judged once in SCAN_SECONDS; a vault that has just come near the line starts with a full sweep, since the history behind it is unrecorded.
          if (Date.now() - lastRiskCheck >= SCAN_SECONDS * 1000 || ONCE) {
            const was = lastRisk;
            atRisk();
            lastRiskCheck = Date.now();
            if (lastRisk && !was) lastFull = 0;
          }
          if (lastRisk) sampleAll();
        } else {
          sampleAll();
        }
      }
      if (Date.now() - lastScan >= SCAN_SECONDS * 1000 || ONCE) {
        for (const v of VAULTS) scan(v);
        checkVenues();
        checkVaultOracles();
        checkBalance();
        lastScan = Date.now();
      }
    } catch (e) {
      if (ONCE) throw e;
      log('cycle failed, trying again in', String(RECORD_POLL), 's:', errLine(e));
    }
    if (ONCE) return;
    await new Promise((r) => setTimeout(r, RECORD_POLL * 1000));
  }
}

main();
