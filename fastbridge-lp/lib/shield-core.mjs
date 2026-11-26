// The deposit of a provider's own ETH or TAC into the pool as private notes of its key, in steps that tools/fastbridge-lp-shield.mjs and the daemon's
// auto-shield (lib/shield.mjs) share. `ux` is the pool wallet module (dapp/confidential-pool-ux.js).

export const GAS_KEPT = 5n * 10n ** 14n;                         // an ETH deposit leaves at least this much for the deposit's gas and a settle
export const DEPOSIT_EXISTS = /0xad2fa98e|DepositExists/i;

const hexq = (v) => '0x' + BigInt(v).toString(16);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "1.5" -> the pool's units (8 places) and the token's (18)
export function parseAmount(text) {
  if (!/^\d+(\.\d{1,8})?$/.test(String(text))) throw new Error('the amount must have up to 8 places');
  const [whole, frac = ''] = String(text).split('.');
  const notes8 = BigInt(whole) * 10n ** 8n + BigInt(frac.padEnd(8, '0'));
  return { notes8, amountWei: notes8 * 10n ** 10n };
}

// builds the deposit and runs it as a call (nothing is sent); a deposit that would revert throws, `duplicate` set when the index is already used
export async function checkDeposit({ ux, key, address, amountWei, ticker, index }) {
  const built = await ux.buildRouterWrap({ walletPriv: key, amountWei, ticker, ...(index != null ? { index } : {}) });
  if (!built.needsPermit2Approval) {
    try { await ux.rpc('eth_call', [{ from: address, to: built.to, value: hexq(built.value || 0), data: built.calldata }, 'latest']); }
    catch (e) {
      const raw = String((e && (e.data || e.message)) || e);
      const err = new Error(`the deposit would revert, so nothing was sent: ${raw.slice(0, 200)}`);
      err.duplicate = DEPOSIT_EXISTS.test(raw);
      throw err;
    }
  }
  return { built };
}

export const sendDeposit = ({ ux, key, amountWei, ticker, index }) => ux.routerWrap({ walletPriv: key, amountWei, ticker, ...(index != null ? { index } : {}) });

// the receipt of a transaction, polled; null when it has not been mined after `tries`
export async function waitMined(ux, txHash, { tries = 90, delayMs = 4000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const r = await ux.rpc('eth_getTransactionReceipt', [txHash]).catch(() => null);
    if (r) return r;
    if (i + 1 < tries) await sleep(delayMs);
  }
  return null;
}

// The settle. A relay that is not sending settles (its sender is under its gas floor) only proves: this address then sends the settle itself, after a
// call that shows the pool would take it, `turn` taking its place among the address's other sends. The deposit is on the chain either way.
export async function settleDeposit({ ux, key, address, sent, turn = (fn) => fn(), say = () => {} }) {
  const relayState = await ux.relay.state().then((s) => (s && s.state) || null).catch(() => null);
  const own = relayState != null && relayState !== 'ok';
  const selfSettle = own ? (x) => turn(async () => {
    if (!x || !x.publicValues || !x.proof) throw new Error('there is no proof to send');
    await ux.rpc('eth_call', [{ from: address, to: ux.cfg.pool, data: ux.settleCalldata(x) }, 'latest']);
    return ux.settleFromAccount({ settlerPriv: key, publicValues: x.publicValues, proof: x.proof, memos: x.memos || [] });
  }) : null;
  say(own ? `the relay is ${relayState}: it proves, and this address sends the settle…` : 'asking the relay to settle it into private notes…');
  return ux.submitWrapSettle({ built: sent, depositTx: sent.txHash, ...(selfSettle ? { selfSettle } : {}) });
}
