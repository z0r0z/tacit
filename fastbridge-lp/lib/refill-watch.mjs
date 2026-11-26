// Tells the operator when the provider needs funds, through the alert (lib/alert.mjs), and shows the same facts in /info under `refill`. Four conditions,
// each said when it begins and again every `dedupeSecs` (4 hours) while it lasts, and once more, as an info, when it ends:
//
//   freeEth   the private ETH not promised is under FB_LP_ALERT_LOW_ETH (0.05)           -> send ETH to the pool account
//   sats      the Bitcoin at the provider's addresses is under FB_LP_ALERT_LOW_SATS (100000) -> send BTC to the address
//   gas       the public ETH of the pool account is under the gas reserve                  -> send ETH there
//   waiting   public ETH above the reserve and the smallest chunk has sat unshielded for 30 minutes, with auto-shield off -> shield it or switch it on
//
// A read that gives null (it could not be made) leaves its condition as it was.

const UNIT = 10n ** 10n;
const eth8 = (units) => (Number(BigInt(units)) / 1e8).toFixed(4);
const ethW = (wei) => eth8(BigInt(wei) / UNIT);

export function watchConfig(env = process.env) {
  const eth = (k, d) => {
    const t = String(env[k] ?? d).trim();
    if (!/^\d{1,6}(\.\d{1,8})?$/.test(t)) throw new Error(`${k} must be an amount of ETH (got "${env[k]}")`);
    const [w, f = ''] = t.split('.');
    return BigInt(w) * 10n ** 8n + BigInt(f.padEnd(8, '0'));
  };
  const sats = Number(env.FB_LP_ALERT_LOW_SATS ?? 100000);
  if (!Number.isInteger(sats) || sats < 0) throw new Error(`FB_LP_ALERT_LOW_SATS must be a whole number of sats (got "${env.FB_LP_ALERT_LOW_SATS}")`);
  return { lowEthUnits: eth('FB_LP_ALERT_LOW_ETH', '0.05'), lowSats: BigInt(sats) };
}

export function makeRefillWatch({ cfg, shield, freeEth, sats, publicEth, poolAccount, btcAddresses = [], autoShield = false, shieldInfo = () => null, now = () => Math.floor(Date.now() / 1000), alert = () => {}, dedupeSecs = 14400, waitSecs = 1800 }) {
  const said = new Map(), active = new Set();
  let seen = { freeEth: null, sats: null, publicEth: null }, waitingSince = null;
  const btcTo = btcAddresses.length ? btcAddresses.join(' or ') : 'the provider\'s Bitcoin address';

  function judge(key, on, bad, ok) {
    const t = now();
    if (on) {
      active.add(key);
      if (t - (said.get(key) ?? -Infinity) >= dedupeSecs) { said.set(key, t); alert({ level: 'warn', ...bad }); }
    } else if (active.delete(key)) { said.delete(key); alert({ level: 'info', ...ok }); }
  }

  async function check() {
    const r = async (f) => { try { const v = await f(); return v == null ? null : BigInt(v); } catch { return null; } };
    const [free, sat, pub] = [await r(freeEth), await r(sats), await r(publicEth)];
    seen = { freeEth: free == null ? seen.freeEth : free, sats: sat == null ? seen.sats : sat, publicEth: pub == null ? seen.publicEth : pub };
    const reserve = shield.reserveWei, min = shield.minWei, t = now();
    if (free != null) judge('freeEth', free < cfg.lowEthUnits, { msg: `private ETH to lend is low: ${eth8(free)} ETH free, under ${eth8(cfg.lowEthUnits)}. Send ETH to ${poolAccount}${autoShield ? ' (it is shielded and lent on its own)' : ' and shield it with tools/fastbridge-lp-shield.mjs, or set FB_LP_AUTO_SHIELD=on'}` }, { msg: `private ETH to lend is back: ${eth8(free)} ETH free` });
    if (sat != null) judge('sats', sat < cfg.lowSats, { msg: `Bitcoin is low: ${sat} sats at the provider's addresses, under ${cfg.lowSats}. Send BTC to ${btcTo}` }, { msg: `Bitcoin is back: ${sat} sats at the provider's addresses` });
    if (pub != null) {
      judge('gas', pub < reserve, { msg: `the pool account is under its gas reserve: ${ethW(pub)} ETH, under ${ethW(reserve)}. Send ETH to ${poolAccount}; with none left the provider cannot send its own settles or deposits` }, { msg: `the pool account has its gas reserve again: ${ethW(pub)} ETH` });
      const over = pub >= reserve + min;
      if (over && waitingSince == null) waitingSince = t;
      if (!over) waitingSince = null;
      judge('waiting', over && !autoShield && t - waitingSince >= waitSecs, { msg: `${ethW(pub - reserve)} ETH at ${poolAccount} has sat unshielded for ${Math.round((t - waitingSince) / 60)} minutes: run tools/fastbridge-lp-shield.mjs, or set FB_LP_AUTO_SHIELD=on` }, { msg: 'the ETH at the pool account is shielded or in use' });
    }
  }

  // no secrets: balances, thresholds, the addresses the provider is funded at
  const info = () => ({
    poolAccount, btcAddresses,
    freeEth: seen.freeEth == null ? null : eth8(seen.freeEth), lowEth: eth8(cfg.lowEthUnits),
    sats: seen.sats == null ? null : String(seen.sats), lowSats: String(cfg.lowSats),
    publicEth: seen.publicEth == null ? null : ethW(seen.publicEth), gasReserveEth: ethW(shield.reserveWei), minChunkEth: ethW(shield.minWei),
    alerting: [...active].sort(), autoShield: { on: !!autoShield, ...(shieldInfo() || {}) },
  });
  return { check, info };
}
