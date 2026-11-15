
const PROMPTS = new Set([
  'eth_requestAccounts', 'wallet_requestPermissions', 'personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4',
  'eth_sendTransaction', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_watchAsset', 'wallet_sendCalls',
]);
export const QUIET_MS = 600;
export const RETRY_QUIET_MS = 1200;
export const QUICK_MS = 2000;
export const SLOW_MS = 45e3;
const SHOWN_MS = 300;

const MARK = Symbol.for('tacit.promptGuard');

// How many prompts this page has put to a wallet that have not been answered. A wallet that is showing a signature request should not also be
// the page's read node (eth-nodes.js walletNode): its extension has the request to serve, and a hung read queued in front of it is how a prompt
// fails to appear.
let openPrompts = 0;
export const promptOpen = () => openPrompts > 0;
const refused = (e) => e?.code === 4001 || /user (rejected|denied)|rejected the request|request rejected|denied (transaction|message)/i.test(String(e?.shortMessage || e?.message || e || ''));

const instantly = (e) => Object.assign(new Error(e?.message || 'User rejected the request.'), { code: e?.code ?? 4001, quick: true, cause: e });

export const declinedWords = (e, tail = '') => (e?.quick
  ? `Your wallet declined it straight away.${tail ? ` ${tail}` : ''} If that was not you, close any request still open in your wallet, then press again.`
  : `Cancelled in your wallet.${tail ? ` ${tail}` : ''}`);

export function guardProvider(provider, { quiet = QUIET_MS, retryQuiet = RETRY_QUIET_MS, quick = QUICK_MS, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  if (!provider || typeof provider.request !== 'function' || provider[MARK]) return provider;
  const ask = provider.request;
  let answered = 0;
  const prompted = async (args) => {
    openPrompts++;
    try { return await promptedNow(args); } finally { openPrompts--; }
  };
  const promptedNow = async (args) => {
    for (let tries = 0; ; tries++) {
      const wait = answered + (tries ? retryQuiet : quiet) - now();
      if (wait > 0) await sleep(wait);
      const asked = now();
      try {
        const answer = await ask.call(provider, args);
        if (now() - asked >= SHOWN_MS) answered = now();
        return answer;
      } catch (e) {
        const took = now() - asked;
        if (refused(e) && took < quick) {
          answered = now();
          if (tries) throw instantly(e);
          continue;
        }
        if (took >= SHOWN_MS) answered = now();
        throw e;
      }
    }
  };
  const request = (args) => (PROMPTS.has(args?.method) ? prompted(args) : ask.call(provider, args));
  try {
    Object.defineProperty(provider, 'request', { value: request, writable: true, configurable: true });
    Object.defineProperty(provider, MARK, { value: true });
  } catch { }
  return provider;
}

export function stillWaiting(tell, { after = SLOW_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let off = null;
  const timer = setTimer(() => { off = tell(); }, after);
  return () => { clearTimer(timer); if (typeof off === 'function') off(); off = null; };
}
