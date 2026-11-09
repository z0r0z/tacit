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
  return out;
}
