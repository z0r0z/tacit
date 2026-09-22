// Public payout from a shielded balance: pay a plain 0x address an exact amount from the notes the wallet holds
// (ux.sendUnwrap). The chain then shows the recipient, the amount and the relay's fee, and does not show which
// deposit funded it. This is the pure half: address validation, the fee arithmetic that makes the recipient's
// amount exact, note selection, and the confirmation poll against the recipient's public balance. Every read is
// injected, so it runs unchanged under test; the DOM half is confidential-payout-panel.js.

export class PayoutError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'PayoutError';
    this.code = code;
    Object.assign(this, extra);
  }
}

const lc = (h) => String(h == null ? '' : h).toLowerCase();
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

// ── recipient ──

export function looksLikeAddress(raw) {
  return ADDR_RE.test(String(raw == null ? '' : raw).trim());
}

// EIP-55: a hex letter is upper-case when the matching nibble of keccak256(lower-case hex address) is 8 or more.
export function checksumAddress(address, keccak256) {
  const hex = lc(String(address).replace(/^0x/i, ''));
  const h = keccak256(new TextEncoder().encode(hex));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const nibble = (h[i >> 1] >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    out += nibble >= 8 ? hex[i].toUpperCase() : hex[i];
  }
  return out;
}

// All-lower and all-upper addresses carry no checksum and are accepted as such; a mixed-case one must match its
// checksum exactly. `deny` is a list of { address, reason } the payout must never go to (the pool, the token
// contracts: value sent there cannot be recovered).
export function parseRecipient(raw, { keccak256, deny = [] } = {}) {
  const s = String(raw == null ? '' : raw).trim();
  if (!ADDR_RE.test(s)) {
    return { ok: false, code: 'not-address', message: 'Enter a 0x address: 0x followed by 40 hex characters.' };
  }
  const body = s.slice(2);
  const address = '0x' + lc(body);
  const checksummed = checksumAddress(address, keccak256);
  const hasChecksum = body !== lc(body) && body !== body.toUpperCase();
  if (hasChecksum && s !== checksummed) {
    return { ok: false, code: 'bad-checksum', checksummed, message: 'The capitalization does not match this address’s checksum, so a character is probably wrong. Copy the address again from where you got it.' };
  }
  if (/^0x0{40}$/.test(address)) {
    return { ok: false, code: 'zero-address', message: 'That is the zero address. Nothing sent there can be recovered.' };
  }
  const hit = deny.find((d) => d && lc(d.address) === address);
  if (hit) return { ok: false, code: 'denied', message: hit.reason || 'This address cannot receive a payout.' };
  return { ok: true, address, checksummed, hasChecksum };
}

// ── amounts ──

// A decimal entry to whole units at `decimals` places. Strict: more places than the asset has is refused rather
// than rounded, because the recipient must receive exactly what was typed.
export function parseUnits(raw, decimals) {
  const s = String(raw == null ? '' : raw).trim();
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) {
    throw new PayoutError('bad-amount', 'Enter the amount as a plain number, like 0.25.');
  }
  const [i, f = ''] = s.split('.');
  if (f.length > decimals) {
    throw new PayoutError('too-many-decimals', decimals === 0
      ? 'This asset has no decimal places.'
      : `This asset has ${decimals} decimal places; use at most that many.`, { decimals });
  }
  return BigInt(i || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export function formatUnits(value, decimals) {
  const v = BigInt(value);
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, '0');
  const int = decimals ? s.slice(0, -decimals) : s;
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return (neg ? '-' : '') + (frac ? `${int}.${frac}` : int);
}

// The public token units a payout of `units` in-system units delivers: the pool pays value × unitScale.
export const underlyingUnits = (units, unitScale) => BigInt(units) * BigInt(unitScale || 1);

// Op fields that are JSON numbers on the wire lose exactness past 2^53.
export const MAX_PAYOUT_UNITS = BigInt(Number.MAX_SAFE_INTEGER);

export function publicAssetLabel(ticker) {
  return ({ cETH: 'ETH', cUSDC: 'USDC', cUSDT: 'USDT', cBTC: 'tacBTC', cUSD: 'tacUSD', cTAC: 'TAC' })[ticker]
    || String(ticker || '').replace(/^c/, '') || 'asset';
}

// ── assets and notes ──

const ORDER = ['cETH', 'cUSDC', 'cUSDT', 'cBTC', 'cUSD', 'cTAC'];

// The pool assets a payout can go out in: the relay takes its fee in the asset (relayFeeEligible) and the asset
// has a public token to pay out (native ETH, or an ERC20 underlying). An id shared by a bridged asset's token row
// and its pool row (TAC / cTAC) is one asset, named by the pool row.
export function payoutAssets({ assets, relayFeeEligible }) {
  const byId = new Map();
  for (const a of assets || []) {
    if (!a || !a.assetId) continue;
    const id = lc(a.assetId);
    const cur = byId.get(id);
    const pool = String(a.ticker || '').startsWith('c');
    if (!cur || (pool && !String(cur.ticker || '').startsWith('c'))) byId.set(id, a);
  }
  const out = [];
  for (const [id, a] of byId) {
    if (!relayFeeEligible(a.ticker)) continue;
    const token = a.native ? null : (ADDR_RE.test(String(a.underlying || '')) && !/^0x0{40}$/.test(a.underlying) ? lc(a.underlying) : undefined);
    if (token === undefined) continue;
    out.push({
      assetId: id, ticker: a.ticker, label: publicAssetLabel(a.ticker),
      decimals: a.tacitDecimals ?? a.decimals ?? 8, unitScale: BigInt(a.unitScale || '1'), token,
    });
  }
  const rank = (t) => { const i = ORDER.indexOf(t); return i < 0 ? ORDER.length : i; };
  return out.sort((x, y) => rank(x.ticker) - rank(y.ticker));
}

export const notesOf = (notes, asset) => (notes || []).filter((n) => lc(n.asset) === lc(asset));

// { total, count, largest } per asset id.
export function heldByAsset(notes) {
  const held = new Map();
  for (const n of notes || []) {
    const id = lc(n.asset);
    const h = held.get(id) || { total: 0n, count: 0, largest: 0n };
    const v = BigInt(n.value);
    h.total += v; h.count += 1; if (v > h.largest) h.largest = v;
    held.set(id, h);
  }
  return held;
}

// The smallest single note that covers `need`; older first among equals. A payout spends exactly one note.
export function pickNote(notes, asset, need) {
  let best = null;
  for (const n of notesOf(notes, asset)) {
    const v = BigInt(n.value);
    if (v < need) continue;
    if (!best) { best = n; continue; }
    const b = BigInt(best.value);
    if (v < b || (v === b && Number(n.leafIndex) < Number(best.leafIndex))) best = n;
  }
  return best;
}

// ── fee arithmetic ──

// sendUnwrap debits `amount` from one note; the recipient receives amount − fee(amount). To pay an exact `net`,
// find the gross whose fee leaves exactly net: the least g with g − fee(g) = net. The fee never falls as g rises,
// but its rounding ladder can jump by several units at once, so g − fee(g) is not monotone. It does rise one unit
// at a time between jumps, so every net has a solution, and iterating g ← net + fee(g) from a lower bound climbs to
// the least one. Wherever the fee is not capped at the whole amount it is at least minFee, so net + minFee is a
// valid start. A fee capped at the amount means net is below the fee's own rounding step: refused.
export function grossForNet({ net, feeOf, minFee = 0n, maxIter = 64 }) {
  net = BigInt(net);
  if (net <= 0n) throw new PayoutError('zero-amount', 'Enter an amount greater than zero.');
  let gross = net + BigInt(minFee);
  for (let i = 0; i < maxIter; i++) {
    const fee = BigInt(feeOf(gross));
    if (fee >= gross) {
      throw new PayoutError('below-fee', 'That amount is far below the relay fee, so the fee would swallow it. Pay more.', { net, fee });
    }
    const next = net + fee;
    if (next === gross) return { gross, fee, net };
    gross = next;
  }
  throw new PayoutError('fee-unstable', 'The relay fee did not settle for this amount. Try a slightly different amount.');
}

// The plan for paying `net` in `asset`: the gross to debit, the fee, and the one note that covers it. When no
// single note does, the code says why: nothing held, not enough in total, or enough in total but spread over
// several notes (planMerge then sizes the fix).
export function planPayout({ notes, asset, net, feeOf, minFee }) {
  const held = notesOf(notes, asset);
  const total = held.reduce((s, n) => s + BigInt(n.value), 0n);
  if (!held.length) return { ok: false, code: 'no-balance', total: 0n };
  const { gross, fee } = grossForNet({ net, feeOf, minFee });
  if (gross > MAX_PAYOUT_UNITS) throw new PayoutError('too-large', 'That amount is too large for one payout.');
  const note = pickNote(held, asset, gross);
  if (note) {
    const value = BigInt(note.value);
    return { ok: true, net: BigInt(net), fee, gross, note, change: value - gross, wholeNote: value === gross, total };
  }
  const largest = held.reduce((m, n) => (BigInt(n.value) > m ? BigInt(n.value) : m), 0n);
  if (total < gross) return { ok: false, code: 'insufficient', net: BigInt(net), fee, gross, total, largest, short: gross - total };
  return { ok: false, code: 'no-single-note', net: BigInt(net), fee, gross, total, largest };
}

// Merging notes is a relayed self-transfer of several notes into one, paying a flat relay fee out of the total.
// Takes the largest notes first, as few as reach `need` after the fee, at most `maxInputs`.
export function planMerge({ notes, need, mergeFee, maxInputs = 16 }) {
  const sorted = [...notes].sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : BigInt(b.value) < BigInt(a.value) ? -1 : 0));
  if (sorted.length < 2) return { ok: false, code: 'single-note' };
  const fee = BigInt(mergeFee);
  const picked = [];
  let sum = 0n;
  for (const n of sorted) {
    if (picked.length === maxInputs) break;
    picked.push(n); sum += BigInt(n.value);
    if (sum - fee >= need) break;
  }
  const merged = sum - fee;
  if (picked.length < 2) return { ok: false, code: 'single-note' };
  if (merged <= 0n) return { ok: false, code: 'fee-exceeds-notes', fee, sum };
  return { ok: true, notes: picked, count: picked.length, sum, fee, merged, covers: merged >= need };
}

// How many notes the pool has gained since `note` was created: a rough measure of the cover it has had. Null when
// the scan did not carry the numbers.
export function coverSince({ note, poolStats }) {
  const created = poolStats && poolStats.totalNotesCreated;
  const at = note && note.leafIndex;
  if (created == null || at == null || !Number.isFinite(Number(created)) || !Number.isFinite(Number(at))) return null;
  return Math.max(0, Number(created) - Number(at) - 1);
}

// ── confirmation ──

const ERC20_BALANCE_OF = '0x70a08231';
const hexToBig = (h, what) => {
  if (typeof h !== 'string' || !/^0x[0-9a-fA-F]+$/.test(h)) throw new PayoutError('unreadable', `Could not read the recipient's ${what}.`);
  return BigInt(h);
};

// A function that reads the recipient's public balance: ETH through eth_getBalance, a token through balanceOf.
export function makeBalanceReader({ rpc, ethCall, token = null, address }) {
  if (!ADDR_RE.test(String(address))) throw new PayoutError('not-address', 'A 0x address is required.');
  if (!token) return async () => hexToBig(await rpc('eth_getBalance', [address, 'latest']), 'balance');
  const data = ERC20_BALANCE_OF + lc(address).slice(2).padStart(64, '0');
  return async () => {
    const out = await ethCall(token, data);
    if (typeof out !== 'string' || !/^0x[0-9a-fA-F]{64}/.test(out)) throw new PayoutError('unreadable', 'Could not read the recipient’s token balance.');
    return BigInt(out.slice(0, 66));
  };
}

// Success is only ever the recipient's balance rising by the expected amount. The relay's job status is read for
// progress and to stop early on a failure, and even then the balance is checked first: a job the relay calls
// settled proves nothing here. Statuses: 'paid', 'timeout' (still unconfirmed), 'failed' (the relay gave up),
// 'lost' (the relay no longer has the job).
export async function waitForPayout({
  readBalance, baseline, expected, readJob = null, now = Date.now, sleep, timeoutMs = 12 * 60 * 1000, intervalMs = 6000, onTick,
}) {
  baseline = BigInt(baseline); expected = BigInt(expected);
  if (expected <= 0n) throw new PayoutError('zero-amount', 'Nothing to wait for.');
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  let job = null, delta = 0n, lastError = null, unknowns = 0;
  for (;;) {
    try {
      const bal = await readBalance();
      delta = bal - baseline;
      if (delta >= expected) return { status: 'paid', delta, balance: bal, job };
    } catch (e) { lastError = e; }
    if (readJob) {
      try { job = await readJob(); } catch { /* keep polling; the balance is the authority */ }
      if (job && job.status === 'failed') return { status: 'failed', delta, job, error: job.error || null };
      // A job the relay has only just stored can read as unknown from another edge; it takes two in a row to count as lost.
      if (job && job.status === 'unknown') { if (++unknowns >= 2) return { status: 'lost', delta, job }; } else unknowns = 0;
    }
    const elapsedMs = now() - start;
    if (onTick) { try { onTick({ elapsedMs, delta, job }); } catch { /* display only */ } }
    if (elapsedMs >= timeoutMs) return { status: 'timeout', delta, job, lastError };
    await wait(intervalMs);
  }
}

// ── wording ──

export const PRIVACY_POINTS = [
  'This hides who sent the payment from people reading the chain. The recipient’s address and the amount are public on-chain, and the relay that settles it is told which of your notes it spends.',
  'The pool is small, so this is weak privacy: do not treat it as anonymous. Anyone who can match this payout to a recent deposit can tie it to the address that made the deposit.',
  'To make a match harder, pay an amount that does not match a recent deposit, and wait between depositing and paying.',
];

export function poolSizeLine(outstandingNotes) {
  const n = Number(outstandingNotes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const about = n.toLocaleString('en-US');
  return n < 5000
    ? `The pool holds about ${about} shielded notes across every asset and user, so the crowd you hide in is small.`
    : `The pool holds about ${about} shielded notes across every asset and user. Your real cover is only the similar deposits and payments around the same time, which is far fewer.`;
}

export function coverLine(notesSince) {
  if (notesSince == null) return null;
  return notesSince < 25
    ? `Only ${notesSince} notes have been added to the pool since the note you would spend was created. That is very little cover; waiting longer helps.`
    : `${notesSince.toLocaleString('en-US')} notes have been added to the pool since the note you would spend was created.`;
}

export const WHOLE_NOTE_LINE = 'This spends a whole note, so what leaves the pool equals that note’s full value. If the note came from a single deposit, the payout matches the deposit’s size and links the two. Pay a slightly different amount to keep some change.';
export const NO_CHECKSUM_LINE = 'The address has no checksum (it is all one case), so a mistyped character would not be caught. Compare it with the address you were given, character by character.';
export const IRREVERSIBLE_LINE = 'Once the relay settles this it cannot be undone.';
export const feeExceedsLine = () => 'The relay fee is larger than the amount being paid.';
export const contractLine = (label) => `This address is a smart contract. Make sure it can receive ${label}; a contract that cannot handle it can lock the funds.`;

// The outcome of the latest payout as { tone, text } for the activity line. `a.phase` is 'submitted', 'paid',
// 'timeout', 'failed' or 'lost'; nothing but 'paid' says the payment arrived.
export function activityView(a) {
  if (!a) return null;
  const what = `${a.amountText} ${a.label} to ${a.address}`;
  switch (a.phase) {
    case 'submitted':
      return { tone: 'progress', text: `Submitted ${what} (job ${a.jobId}). Waiting for it to reach the recipient${a.relayStatus ? `; the relay says ${a.relayStatus}` : ''}.` };
    case 'paid':
      return { tone: 'ok', text: `Paid: ${what} arrived. The recipient’s balance rose by ${a.receivedText} ${a.label}.` };
    case 'timeout':
      return { tone: 'warn', text: `Submitted, not yet confirmed: ${what}. Job id ${a.jobId}. The relay may still be working on it. Check the recipient’s balance again later; your shielded balance reflects it once it settles.` };
    case 'failed':
      return { tone: 'error', text: `The relay could not settle ${what}${a.error ? ` (${a.error})` : ''}. Nothing was paid. Job id ${a.jobId}.` };
    case 'lost':
      return { tone: 'warn', text: `The relay no longer knows job ${a.jobId} (${what}). Check your shielded balance before trying again: the note may or may not have been spent.` };
    default:
      return null;
  }
}

