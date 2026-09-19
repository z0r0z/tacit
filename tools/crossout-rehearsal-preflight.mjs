#!/usr/bin/env node
// Cross-out rehearsal PREFLIGHT — read-only. Answers one question: is it safe to record an ETH->BTC cross-out
// on the live pool RIGHT NOW? It moves nothing, holds no keys, and only reads public chain state.
//
//   node tools/crossout-rehearsal-preflight.mjs [--wallet 0x..] [--amount-units N] [--dest-xonly 0x..]
//
//   --wallet        the ETH address that will hold the TAC to wrap (checks its public TAC balance)
//   --amount-units  the crossing size in 8-decimal TAC units (1.23456789 TAC = 123456789)
//   --dest-xonly    the x-only P2TR key the Bitcoin note will land at (validated as a real curve point)
//
// Exit 0 only if every AUTOMATED check passes. Some gates cannot be read from outside the operator's
// infrastructure (worker env, sidecar state, wallet funding) — those print as MANUAL and are the operator's
// to confirm; a green run here is necessary, not sufficient.

const POOL = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const RELAY = '0x20A6ddc2C6E620c6248B5A34E85996516FDd19D0';
const TAC_TOKEN = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';
const TAC_ID = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const UNIT_SCALE = 10n ** 10n; // 8-dec native -> 18-dec ERC-20
const REFLECTION_CONFIRMATIONS = 24n; // the pool's immutable
const MAX_LAG_GO = 12; // a cross-out is safe only once reflection is essentially at the tip
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://eth.merkle.io'];
const ESPLORAS = ['https://mempool.space/api', 'https://blockstream.info/api'];

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const results = [];
const note = (level, name, detail) => { results.push({ level, name, detail }); };

async function ethCall(to, data) {
  let err;
  for (const rpc of RPCS) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }), signal: AbortSignal.timeout(12000) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      return j.result;
    } catch (e) { err = e; }
  }
  throw new Error(`eth_call failed on every RPC: ${err?.message}`);
}
const word = (h, i = 0) => h.slice(2 + i * 64, 2 + (i + 1) * 64);
const big = (h, i = 0) => BigInt('0x' + word(h, i));
const pad32 = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');

async function btcTip() {
  for (const b of ESPLORAS) {
    try { const r = await fetch(`${b}/blocks/tip/height`, { signal: AbortSignal.timeout(10000) }); if (r.ok) return Number((await r.text()).trim()); } catch {}
  }
  throw new Error('no esplora reachable for the Bitcoin tip');
}

// x-only key must be a real secp256k1 x-coordinate: x^3 + 7 must be a quadratic residue mod p.
function isCurveX(hex) {
  const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  const x = BigInt('0x' + hex);
  if (x === 0n || x >= P) return false;
  const rhs = (x * x * x + 7n) % P;
  let r = 1n, b = rhs, e = (P - 1n) / 2n;
  while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; }
  return r === 1n; // Euler's criterion
}

try {
  // 1. The generation is the active one and TAC is registered as expected.
  const succ = big(await ethCall(POOL, '0x6ff968c3'));
  succ === 0n ? note('ok', 'pool is the active generation', 'successor() == 0') : note('fail', 'pool has been retired', `successor != 0 — do not cross out from a retired generation`);

  const a = await ethCall(POOL, '0x9fda5b66' + pad32(TAC_ID));
  const [reg, underlying, scale, link, poolMinted] = [big(a, 0), '0x' + word(a, 1).slice(24), big(a, 2), '0x' + word(a, 3), big(a, 4)];
  (reg === 1n && poolMinted === 1n && scale === UNIT_SCALE && link.toLowerCase() === TAC_ID && underlying.toLowerCase() === TAC_TOKEN.toLowerCase())
    ? note('ok', 'TAC is registered, pool-minted, linked to its Bitcoin id', `unitScale ${scale}`)
    : note('fail', 'TAC registration is not as expected', JSON.stringify({ reg: String(reg), underlying, scale: String(scale), link, poolMinted: String(poolMinted) }));

  // 2. Counters — informational, but they say what a cross-out will change.
  const consumed = big(await ethCall(POOL, '0x281d8cc9'));
  const crossOuts = big(await ethCall(POOL, '0xa6f8c9d6'));
  note('info', 'on-chain counters', `bitcoinConsumedCount=${consumed}  crossOutCount=${crossOuts}  (this cross-out will make crossOutCount ${crossOuts + 1n})`);

  // 3. Reflection must be essentially caught up. This is the gate that matters most: a cross-out moves an
  //    on-chain counter, and until a Mode-B batch folds it every forward-only batch is refused.
  const [tipHash, relayTip, btc] = [await ethCall(POOL, '0x182f6171'), big(await ethCall(RELAY, '0x1fd4827a')), await btcTip()];
  const attested = big(await ethCall(RELAY, '0x59a53331' + pad32(tipHash)));
  if (attested === 0n) {
    note('fail', 'reflection height unreadable', 'attested tip hash unknown to the relay (blockHeight == 0)');
  } else {
    const lag = btc - Number(attested);
    note('info', 'chain heights', `bitcoin=${btc}  relay=${relayTip}  reflection-attested=${attested}`);
    lag <= MAX_LAG_GO
      ? note('ok', 'reflection is caught up', `lag ${lag} <= ${MAX_LAG_GO} blocks`)
      : note('fail', 'reflection is NOT caught up', `lag ${lag} blocks (> ${MAX_LAG_GO}). Do not cross out until it closes — and do not flip REFLECTION_MODEB_REQUIRED=1 early either; both belong to whoever runs the catch-up`);
    // The batch tip must sit at/below relay.tip - 24; if the relay is not that far ahead reflection cannot advance.
    relayTip - REFLECTION_CONFIRMATIONS >= attested
      ? note('ok', 'relay is ahead of reflection by at least the confirmation depth', `relay-24=${relayTip - REFLECTION_CONFIRMATIONS} >= attested=${attested}`)
      : note('warn', 'relay is not yet 24 blocks ahead of reflection', 'the next batch cannot be anchored until the header feeder advances');
  }

  // 4. Optional inputs.
  if (args['dest-xonly'] !== undefined) {
    const k = pad32(args['dest-xonly']);
    /^0+$/.test(k) ? note('fail', 'destination key', 'zero key — the guest rejects it at burn')
      : !isCurveX(k) ? note('fail', 'destination key', 'not a valid secp256k1 x-coordinate — the note would be unspendable')
      : note('ok', 'destination key is a valid non-zero x-only point', '0x' + k);
  } else note('warn', 'no --dest-xonly given', 'the destination key cannot be validated yet — a LOST key strands the value');

  if (args['amount-units'] !== undefined) {
    let u; try { u = BigInt(args['amount-units']); } catch { u = -1n; }
    if (u <= 0n) note('fail', 'amount', '--amount-units must be a positive integer');
    else {
      const wei = u * UNIT_SCALE;
      note('ok', 'amount is unit-aligned', `${u} units = ${wei} wei = ${Number(u) / 1e8} TAC (a multiple of unitScale by construction)`);
      if (args.wallet) {
        const bal = big(await ethCall(TAC_TOKEN, '0x70a08231' + pad32(args.wallet)));
        bal >= wei ? note('ok', 'wallet holds enough TAC', `${bal} wei >= ${wei}`) : note('fail', 'wallet holds too little TAC', `${bal} wei < ${wei}`);
      } else note('warn', 'no --wallet given', 'cannot check the TAC balance');
    }
  } else note('warn', 'no --amount-units given', 'suggest 123456789 (1.23456789 TAC): distinct digits make any scale error visible');
} catch (e) {
  note('fail', 'preflight aborted', String(e?.message || e));
}

// 5. Gates that only the operator can see — printed every time, never inferred.
const manual = [
  'tacit-api has REFLECTION_MODEB_REQUIRED=1 (it must NOT be 0 — with 0 the worker will assemble forward-only batches that a cross-out makes revert on-chain, burning paid proofs, and a forward batch that scans the Bitcoin mint silently SKIPS it)',
  'tacit-eth-state is running with DRY_RUN=0 and has published a live candidate (GET /reflection/eth-state, box token)',
  'the shared relay wallet has gas for header + reflection + eth-state work (the reflection cron and header feeder both spend from it)',
  'NO other session or operator is performing a cross-out or a fast-lane spend at the same time (each moves a counter the in-flight proof must match)',
  'the destination key is BACKED UP and a test signature under it has been produced BEFORE the burn is proven',
];

const tag = { ok: '  ok  ', fail: ' FAIL ', warn: ' warn ', info: ' info ' };
console.log('\nCross-out rehearsal preflight —', new Date().toISOString(), '\n');
for (const r of results) console.log(`[${tag[r.level]}] ${r.name}${r.detail ? '\n         ' + r.detail : ''}`);
console.log('\nMANUAL gates (cannot be read from outside — confirm each):');
for (const m of manual) console.log('  [ ? ] ' + m);
const failed = results.filter((r) => r.level === 'fail').length;
console.log(`\n${failed ? `NO-GO — ${failed} automated check(s) failed.` : 'AUTOMATED CHECKS PASS — now confirm every MANUAL gate above before proceeding.'}\n`);
process.exit(failed ? 1 : 0);
