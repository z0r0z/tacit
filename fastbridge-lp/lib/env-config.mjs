// What a host can set in the environment without a new image or a new config file: the knobs an operator turns while the process runs.
// A value that is set and not valid is an error (the process does not start on a guess); one that is not set leaves the config as it is.
//
//   PORT                 the port to listen on (Render sets it)
//   FB_LP_DATA_DIR       where the swap records, quotes and logs are kept (a persistent disk)
//   FB_LP_NAME           the name shown in the ad
//   FB_LP_BOARDS         boards to post the ad on, comma separated ("" for none)
//   FB_LP_MIN_AMOUNT     the least it takes, in base units (TAC has 8 places: 1000000000 is 10 TAC)
//   FB_LP_MAX_AMOUNT     the most it takes. Below the least, it quotes nothing and finishes its open swaps: the switch to turn it off
//   FB_LP_FEE_BPS        the fee as a share of the amount, in hundredths of a percent (30 is 0.30%)
//   FB_LP_FLAT_FEE       the flat part of the fee, in base units
//   FB_LP_LINEAGE_DEFAULT_CLASS   what a quote request that names no note history is priced as: clean, long or pool-exit
//   FB_LP_LINEAGE_LONG_FEE_BPS, FB_LP_LINEAGE_LONG_FLAT_FEE           added to the base fee for TAC over the bridge proof's history bound
//   FB_LP_LINEAGE_POOL_EXIT_FEE_BPS, FB_LP_LINEAGE_POOL_EXIT_FLAT_FEE added to the base fee for TAC the proof cannot follow
//   FB_LP_DYNAMIC_FEE    on or off (off when unset): the flat part of the fee of a pair provider follows its own network cost (lib/flatfee.mjs); FB_LP_FLAT_FEE and
//                        FB_LP_REVERSE_FLAT_FEE are then what it falls back to when it cannot read its costs
//   FB_LP_FEE_SUBSIDY    0 to 1 (0.5 when unset): the share of the cost the flat part covers (1 is the whole cost); FB_LP_FEE_SUBSIDY_UNTIL (unix seconds or
//                        a date like 2026-12-31): from then on it is 1
//   FB_LP_FLAT_FEE_MIN, FB_LP_FLAT_FEE_MAX, FB_LP_REVERSE_FLAT_FEE_MIN, FB_LP_REVERSE_FLAT_FEE_MAX   the least and most the flat part moves between (base units)
//   FB_LP_BTC_BASES      the Bitcoin explorers (esplora base URLs, https, comma separated, asked in this order) in place of the config's list: a keyed or
//                        self-hosted one goes first, without a new image
//   FB_LP_MAILBOX_POLL_SECS  how often it reads the board for requests left for it, in seconds (1 to 30; 3 when unset): a request waits for the
//                        next read, so a shorter wait answers a user's quote sooner. Not under 1: the board takes 120 reads a minute from one address
//   FB_LP_REVERSE        on or off (off when unset): sell TAC held on Bitcoin for TAC in the pool (Ethereum -> Bitcoin), from an address of its own
//   FB_LP_REVERSE_FEE_BPS, FB_LP_REVERSE_FLAT_FEE, FB_LP_REVERSE_MIN_AMOUNT, FB_LP_REVERSE_MAX_AMOUNT   its terms, as the forward ones (base units)
//   FB_LP_REVERSE_MAX_OPEN   sends under way at once (1 to 20; 2 when unset)
//   FB_LP_REVERSE_MAX_TAC    the most TAC out at once, whatever is funded (a decimal, up to 8 places; 2000 when unset)
//   FB_LP_PAIR           btc-eth or off (off when unset): a provider of Bitcoin for ETH and ETH for Bitcoin (lib/pair.mjs), a process and a key of its own
//   FB_LP_REVERSE_MAX_SATS   in that mode, the most sats out at once, whatever is funded (a whole number)

const uint = (name, v) => { if (!/^\d{1,30}$/.test(v)) throw new Error(`${name} must be a whole number (got "${v}")`); return v; };

export function applyEnv(C, env = process.env) {
  const out = { ...C, quote: { ...(C.quote || {}) } };
  const has = (k) => env[k] != null && String(env[k]).trim() !== '';
  if (has('PORT')) { const p = Number(env.PORT); if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`PORT must be a port number (got "${env.PORT}")`); out.port = p; }
  if (has('FB_LP_DATA_DIR')) out.dataDir = String(env.FB_LP_DATA_DIR).trim();
  if (has('FB_LP_NAME')) out.name = String(env.FB_LP_NAME).trim().slice(0, 40);
  if (env.FB_LP_BOARDS != null) out.boards = String(env.FB_LP_BOARDS).split(',').map((s) => s.trim()).filter(Boolean);
  if (has('FB_LP_MIN_AMOUNT')) out.quote.minAmount = uint('FB_LP_MIN_AMOUNT', String(env.FB_LP_MIN_AMOUNT).trim());
  if (has('FB_LP_MAX_AMOUNT')) out.quote.maxAmount = uint('FB_LP_MAX_AMOUNT', String(env.FB_LP_MAX_AMOUNT).trim());
  if (has('FB_LP_FEE_BPS')) { const b = Number(env.FB_LP_FEE_BPS); if (!Number.isInteger(b) || b < 0 || b > 500) throw new Error(`FB_LP_FEE_BPS must be 0 to 500 (got "${env.FB_LP_FEE_BPS}")`); out.quote.feeBps = b; }
  if (has('FB_LP_FLAT_FEE')) out.quote.flatFee = uint('FB_LP_FLAT_FEE', String(env.FB_LP_FLAT_FEE).trim());
  if (has('FB_LP_TAKE_IN_LOCK')) { const t = String(env.FB_LP_TAKE_IN_LOCK).trim().toLowerCase(); if (t !== 'on' && t !== 'off') throw new Error(`FB_LP_TAKE_IN_LOCK must be on or off (got "${env.FB_LP_TAKE_IN_LOCK}")`); out.quote.takeInLock = t === 'on'; }
  if (['FB_LP_LINEAGE_DEFAULT_CLASS', 'FB_LP_LINEAGE_LONG_FEE_BPS', 'FB_LP_LINEAGE_LONG_FLAT_FEE', 'FB_LP_LINEAGE_POOL_EXIT_FEE_BPS', 'FB_LP_LINEAGE_POOL_EXIT_FLAT_FEE'].some(has)) {
    const lf = { ...(C.quote && C.quote.lineageFees ? C.quote.lineageFees : {}) };
    const cls = (key) => ({ ...(lf[key] || {}) });
    if (has('FB_LP_LINEAGE_DEFAULT_CLASS')) { const c = String(env.FB_LP_LINEAGE_DEFAULT_CLASS).trim(); if (!['clean', 'long', 'pool-exit'].includes(c)) throw new Error(`FB_LP_LINEAGE_DEFAULT_CLASS must be clean, long or pool-exit (got "${c}")`); lf.defaultClass = c; }
    const fee = (name, key) => {
      const bpsName = `FB_LP_LINEAGE_${name}_FEE_BPS`, flatName = `FB_LP_LINEAGE_${name}_FLAT_FEE`, one = cls(key);
      if (has(bpsName)) { const b = Number(env[bpsName]); if (!Number.isInteger(b) || b < 0 || b > 9000) throw new Error(`${bpsName} must be 0 to 9000 (got "${env[bpsName]}")`); one.feeBps = b; }
      if (has(flatName)) one.flatFee = uint(flatName, String(env[flatName]).trim());
      lf[key] = one;
    };
    fee('LONG', 'long'); fee('POOL_EXIT', 'poolExit');
    out.quote.lineageFees = lf;
  }
  if (has('FB_LP_MAILBOX_POLL_SECS')) { const n = Number(env.FB_LP_MAILBOX_POLL_SECS); if (!Number.isFinite(n) || n < 1 || n > 30) throw new Error(`FB_LP_MAILBOX_POLL_SECS must be 1 to 30 (got "${env.FB_LP_MAILBOX_POLL_SECS}")`); out.mailboxPollSecs = n; }
  if (has('FB_LP_BTC_BASES')) {
    const bases = String(env.FB_LP_BTC_BASES).split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
    if (!bases.length || bases.some((b) => !/^https:\/\/[^\s/][^\s]*$/.test(b))) throw new Error('FB_LP_BTC_BASES must be https URLs, comma separated');
    out.btcBases = bases;
  }
  if (has('FB_LP_PAIR')) { const v = String(env.FB_LP_PAIR).trim().toLowerCase(); if (v !== 'btc-eth' && v !== 'off') throw new Error(`FB_LP_PAIR must be btc-eth or off (got "${env.FB_LP_PAIR}")`); if (v === 'btc-eth') out.pair = 'btc-eth'; else delete out.pair; }
  const fm = {};
  if (has('FB_LP_DYNAMIC_FEE')) { const v = String(env.FB_LP_DYNAMIC_FEE).trim().toLowerCase(); if (v !== 'on' && v !== 'off') throw new Error(`FB_LP_DYNAMIC_FEE must be on or off (got "${env.FB_LP_DYNAMIC_FEE}")`); fm.dynamic = v === 'on'; }
  if (has('FB_LP_FEE_SUBSIDY')) { const t = String(env.FB_LP_FEE_SUBSIDY).trim(), n = Number(t); if (!/^\d*\.?\d+$/.test(t) || n < 0 || n > 1) throw new Error(`FB_LP_FEE_SUBSIDY must be 0 to 1 (got "${t.slice(0, 20)}")`); fm.subsidy = n; }
  if (has('FB_LP_FEE_SUBSIDY_UNTIL')) { const t = String(env.FB_LP_FEE_SUBSIDY_UNTIL).trim(), n = /^\d{9,11}$/.test(t) ? Number(t) : Math.floor(Date.parse(t) / 1000); if (!Number.isFinite(n) || n <= 0) throw new Error(`FB_LP_FEE_SUBSIDY_UNTIL must be unix seconds or a date (got "${t.slice(0, 30)}")`); fm.subsidyUntil = n; }
  for (const [k, side, f] of [['FB_LP_FLAT_FEE_MIN', 'fwd', 'min'], ['FB_LP_FLAT_FEE_MAX', 'fwd', 'max'], ['FB_LP_REVERSE_FLAT_FEE_MIN', 'rev', 'min'], ['FB_LP_REVERSE_FLAT_FEE_MAX', 'rev', 'max']]) {
    if (has(k)) { fm[side] = { ...(fm[side] || {}), [f]: uint(k, String(env[k]).trim()) }; }
  }
  if (Object.keys(fm).length) out.feeModel = { ...(C.feeModel || {}), ...fm, ...(fm.fwd ? { fwd: { ...((C.feeModel || {}).fwd || {}), ...fm.fwd } } : {}), ...(fm.rev ? { rev: { ...((C.feeModel || {}).rev || {}), ...fm.rev } } : {}) };
  // the reverse side: off unless asked for, and every value that is set must be valid (the process does not start on a guess)
  if (has('FB_LP_REVERSE') || ['FEE_BPS', 'FLAT_FEE', 'MIN_AMOUNT', 'MAX_AMOUNT', 'MAX_OPEN', 'MAX_TAC', 'MAX_SATS'].some((k) => has('FB_LP_REVERSE_' + k))) {
    const r = { ...(C.reverse || {}) };
    if (has('FB_LP_REVERSE')) { const v = String(env.FB_LP_REVERSE).trim().toLowerCase(); if (v !== 'on' && v !== 'off') throw new Error(`FB_LP_REVERSE must be on or off (got "${env.FB_LP_REVERSE}")`); r.enabled = v === 'on'; }
    if (has('FB_LP_REVERSE_FEE_BPS')) { const b = Number(env.FB_LP_REVERSE_FEE_BPS); if (!Number.isInteger(b) || b < 0 || b > 500) throw new Error(`FB_LP_REVERSE_FEE_BPS must be 0 to 500 (got "${env.FB_LP_REVERSE_FEE_BPS}")`); r.feeBps = b; }
    if (has('FB_LP_REVERSE_FLAT_FEE')) r.flatFee = uint('FB_LP_REVERSE_FLAT_FEE', String(env.FB_LP_REVERSE_FLAT_FEE).trim());
    if (has('FB_LP_REVERSE_MIN_AMOUNT')) r.minAmount = uint('FB_LP_REVERSE_MIN_AMOUNT', String(env.FB_LP_REVERSE_MIN_AMOUNT).trim());
    if (has('FB_LP_REVERSE_MAX_AMOUNT')) r.maxAmount = uint('FB_LP_REVERSE_MAX_AMOUNT', String(env.FB_LP_REVERSE_MAX_AMOUNT).trim());
    if (has('FB_LP_REVERSE_MAX_OPEN')) { const n = Number(env.FB_LP_REVERSE_MAX_OPEN); if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error(`FB_LP_REVERSE_MAX_OPEN must be 1 to 20 (got "${env.FB_LP_REVERSE_MAX_OPEN}")`); r.maxOpen = n; }
    if (has('FB_LP_REVERSE_MAX_TAC')) { const t = String(env.FB_LP_REVERSE_MAX_TAC).trim(); if (!/^\d{1,12}(\.\d{1,8})?$/.test(t) || Number(t) <= 0) throw new Error(`FB_LP_REVERSE_MAX_TAC must be a positive amount of TAC (got "${t.slice(0, 20)}")`); r.maxTac = t; }
    if (has('FB_LP_REVERSE_MAX_SATS')) r.maxSats = uint('FB_LP_REVERSE_MAX_SATS', String(env.FB_LP_REVERSE_MAX_SATS).trim());
    out.reverse = r;
  }
  return out;
}
