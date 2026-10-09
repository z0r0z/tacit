// Push BitcoinLightRelay.advanceTip forward from any wallet — permissionless on chain
// (contracts/src/lib/BitcoinLightRelay.sol:253: no access-control modifier, headers are their own proof via
// chain-work). Ports tools/advance-header-relay.mjs's reviewed plan/canonical-check/batching logic so a
// browser wallet and the CLI drive the exact same calldata. This module never signs — the caller supplies
// `send`/`waitReceipt` (an injected wallet in the browser, a raw key in the CLI).

const HEADER_RELAY = '0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0'; // docs/DEPLOYMENTS.md — BitcoinLightRelay
const MAX_BATCH = 40;    // gas-bounding choice mirroring header-relay.js's own default; not a contract limit
const HEADER_LEAD = 110; // mirrors HEADER_RELAY_LEAD — how far past the reflection's attested height to go

const SEL_TIP_HEIGHT = '0x1fd4827a';  // tipHeight()
const SEL_TIP = '0x2755cd2d';         // tip()
const SEL_ADVANCE_TIP = '0xb09e9e05'; // advanceTip(bytes)

export function makeHeaderRelayAdvance({
  rpcUrl = 'https://ethereum-rpc.publicnode.com',
  esploraUrl = 'https://blockstream.info/api',
  statusUrl = 'https://api.tacit.finance/reflection/status?network=mainnet',
  fetchImpl = (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null),
} = {}) {
  if (!fetchImpl) throw new Error('header-relay-advance: no fetch available, pass fetchImpl');

  const hexToBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
  const bytesToHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  // Explorer hashes are displayed byte-reversed; the relay keys blocks by the header's internal byte order.
  const reverseHex = (h) => h.replace(/^0x/, '').toLowerCase().match(/../g).reverse().join('');

  async function rpc(method, params) {
    const res = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  }
  const ethCall = (data) => rpc('eth_call', [{ to: HEADER_RELAY, data }, 'latest']);
  const tipHeight = async () => Number(BigInt(await ethCall(SEL_TIP_HEIGHT)));

  async function esplora(path) {
    const res = await fetchImpl(esploraUrl + path);
    if (!res.ok) throw new Error(`esplora ${path}: ${res.status}`);
    return (await res.text()).trim();
  }

  async function reflectionStatus() {
    try {
      const res = await fetchImpl(statusUrl);
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  // Current state of the relay, the live Bitcoin chain and the reflection — everything a caller needs to
  // decide whether advancing would help, and to show real numbers instead of a vague "waiting" message.
  async function status() {
    const [relayTip, relayTipHash, btcTipStr, refl] = await Promise.all([
      tipHeight(),
      ethCall(SEL_TIP).then((h) => h.toLowerCase()),
      esplora('/blocks/tip/height'),
      reflectionStatus(),
    ]);
    const btcTip = Number(btcTipStr);
    const attested = Number.isFinite(Number(refl?.attestedHeight)) ? Number(refl.attestedHeight) : null;
    const confirmations = Number.isFinite(Number(refl?.confirmations)) ? Number(refl.confirmations) : 24;
    const burnDeposits = Number.isFinite(Number(refl?.burnDeposits)) ? Number(refl.burnDeposits) : null;
    return {
      relayTip, relayTipHash, btcTip, behind: btcTip - relayTip,
      attested, confirmations, reflectionLag: attested != null ? relayTip - confirmations - attested : null,
      burnDeposits,
    };
  }

  // Refuse rather than guess when the relay's own tip isn't the canonical block at that height — the same
  // refusal tools/advance-header-relay.mjs makes. A fork needs header-relay.js's findResumeHeight walk, an
  // operator action; this module only ever extends the honest chain from a tip it has confirmed is canonical.
  async function checkCanonical({ relayTip, relayTipHash }) {
    const explorerHashAtTip = await esplora(`/block-height/${relayTip}`);
    const canonicalHash = '0x' + reverseHex(explorerHashAtTip);
    if (canonicalHash !== relayTipHash) {
      throw new Error(`relay tip ${relayTip} does not match the canonical chain (relay=${relayTipHash}, explorer=${canonicalHash}) — this needs fork recovery, not a plain advance; ask an operator`);
    }
  }

  // Choose how far to advance, always bounded by btcTip-2 (reorg margin). `need` is a height a caller
  // actually cares about maturing (e.g. a stuck deposit's block + confirmations): when given, it drives the
  // target directly — a real target isn't second-guessed by the general pacing heuristic below. Omit it to
  // just clear the relay's general backlog, which instead caps at attested+confirmations+HEADER_LEAD, so a
  // helper with no specific target never pays gas to run the relay further ahead than the reflection could
  // use soon. `useless` is a hint, not a block: it's set when `need` is already met, or (with no `need`)
  // when the relay already has more maturity headroom than the reflection has consumed — the reflection's
  // own pacing, not the relay's tip, is what the next batch is waiting on.
  function plan({ relayTip, btcTip, attested, confirmations, need }) {
    const safeBtcTip = btcTip - 2;
    const to = need != null
      ? Math.min(safeBtcTip, Math.max(need, relayTip))
      : Math.min(safeBtcTip, attested != null ? attested + confirmations + HEADER_LEAD : safeBtcTip);
    const pending = Math.max(0, to - relayTip);
    const aheadOfReflection = attested != null && (relayTip - confirmations > attested);
    const needAlreadyMet = need != null && need <= relayTip;
    const useless = needAlreadyMet || (need == null && aheadOfReflection);
    if (pending <= 0) return { action: 'idle', pending: 0, useless };
    return { action: 'advance', from: relayTip + 1, to, pending, useless };
  }

  async function headerAt(height) {
    const hash = await esplora(`/block-height/${height}`);
    const hex = await esplora(`/block/${hash}/header`);
    if (!/^[0-9a-fA-F]{160}$/.test(hex)) throw new Error(`bad header @${height} (${hex.slice(0, 16)}…)`);
    return hexToBytes(hex);
  }

  // advanceTip(bytes) calldata for headers [from..to], batched at MAX_BATCH — identical ABI encoding to
  // tools/advance-header-relay.mjs (a fixed 32-byte offset word, a length word, the headers, zero-padded).
  async function buildBatches({ from, to }) {
    const batches = [];
    for (let start = from; start <= to; start += MAX_BATCH) {
      const end = Math.min(to, start + MAX_BATCH - 1);
      const headers = [];
      for (let h = start; h <= end; h++) headers.push(await headerAt(h));
      const flat = new Uint8Array(headers.length * 80);
      headers.forEach((h, i) => flat.set(h, i * 80));
      const offsetWord = (32).toString(16).padStart(64, '0'); // the single dynamic `bytes` arg starts at word 1
      const lengthWord = BigInt(flat.length).toString(16).padStart(64, '0');
      const data = SEL_ADVANCE_TIP + offsetWord + lengthWord + bytesToHex(flat).slice(2) + '00'.repeat((32 - (flat.length % 32)) % 32);
      batches.push({ from: start, to: end, count: headers.length, data });
    }
    return batches;
  }

  // Real gas estimate from the caller's own node — never a hardcoded formula. That was the bug in
  // tools/advance-header-relay.mjs: a flat `300000 + 60000·n` guess, which undershoots the real ~172k/header
  // marginal cost (measured on the header cron's own live sends: 1 header used 263,969 gas, 2 used 436,448)
  // for any batch of 2 or more — an out-of-gas revert on the one documented do-it-yourself path.
  async function estimateGas({ data, fromAddress }) {
    const gasHex = await rpc('eth_estimateGas', [{ to: HEADER_RELAY, from: fromAddress, data }]);
    return (BigInt(gasHex) * 125n) / 100n;
  }

  // High-level orchestration shared by the browser page and the CLI, so the batch/re-check/send loop is
  // written once. `send({to,data,gas})` returns a tx hash; `waitReceipt(hash)` resolves `{status}` (0x1/0x0
  // or 1/0). `onProgress` is called once per batch attempt, before and after sending. `onPlan` hears this run's plan
  // before its headers are read (a long backlog takes a while to fetch) and `onBatches` the batches it will send, so
  // a caller shows the run it is actually making rather than one it planned separately.
  async function runAdvance({ need, fromAddress, send, waitReceipt, onProgress, onPlan, onBatches }) {
    const st = await status();
    await checkCanonical(st);
    const pl = plan({ ...st, need });
    onPlan?.({ ...st, ...pl });
    if (pl.action !== 'advance') return { ...st, ...pl, sent: [] };
    const batches = await buildBatches(pl);
    onBatches?.(batches);
    const sent = [];
    for (const batch of batches) {
      // A duplicate header doesn't revert (advanceTip just finds a shorter or equal chain and no-ops), but
      // skip the ones that already landed since planning so a slow multi-batch run doesn't waste gas.
      const fresh = await tipHeight();
      if (fresh >= batch.to) { onProgress?.({ ...batch, skipped: true }); continue; }
      const gas = await estimateGas({ data: batch.data, fromAddress });
      onProgress?.({ ...batch, sending: true });
      const txHash = await send({ to: HEADER_RELAY, data: batch.data, gas });
      onProgress?.({ ...batch, txHash });
      const receipt = await waitReceipt(txHash);
      const ok = receipt?.status === '0x1' || receipt?.status === 1;
      if (!ok) throw new Error(`advanceTip reverted: ${txHash}`);
      sent.push({ ...batch, txHash });
    }
    return { ...st, ...pl, sent };
  }

  return { HEADER_RELAY, MAX_BATCH, status, checkCanonical, plan, buildBatches, estimateGas, runAdvance };
}
