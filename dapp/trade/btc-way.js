// A Bitcoin wallet as a way into a page's key session (trade/key.js `ways.btc`): Xverse, Leather or UniSat signs, and the Tacit key that
// signature opens is handed to the session. tacit.js does the signing and is loaded on the press, so a page that offers this way in
// carries none of it until then; the key is taken out of tacit.js's wallet as soon as it is opened.
import { openBtcWallet } from '/trade/btc-session.js?cb=a8109585';
import { isPasskeyAvailable } from '/prf-wallet.js';
import { makeTacitSession } from '/tacit-session.js?cb=4636e436';
import { secp, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';

const TACIT_URL = '/tacit.js?cb=b45e21d5';

export function btcWay() {
  const TS = makeTacitSession({ url: TACIT_URL, key: () => null, secp, bytesToHex, hexToBytes });
  return (k) => TS.turn(() => openBtcWallet(TS.T, { k, tPriv: TS.tPriv, passkey: isPasskeyAvailable() }));
}
// Whether this browser has a Bitcoin wallet the sign-in sheet can name (it says so when none is found).
export const btcSeen = () => !!(window.btc_providers?.length || window.XverseProviders?.BitcoinProvider || window.LeatherProvider || window.unisat);
