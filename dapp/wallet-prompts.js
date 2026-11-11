// A wallet that answers each request in a window of its own closes the window just after the answer, and some turn down every request the
// page still has open when a window closes. A request made in that moment is refused with it, though nobody saw it: a permit signed and its
// deposit sent at once lost the deposit that way. A guarded provider leaves a short quiet after each answered prompt, and asks once more
// for a request refused faster than anyone could have read it, after a longer quiet (a window that was slow to close is the one that refused it).

const PROMPTS = new Set([
  'eth_requestAccounts', 'wallet_requestPermissions', 'personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4',
  'eth_sendTransaction', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_watchAsset', 'wallet_sendCalls',
]);
export const QUIET_MS = 600;
export const RETRY_QUIET_MS = 1200;
export const QUICK_MS = 2000;
export const SLOW_MS = 45e3;
// An answer faster than this was made with no window to close (a site the wallet already allows), so it starts no quiet.
const SHOWN_MS = 300;

// Marked on the provider itself, under a key shared by every copy of this module, so a provider is wrapped once however it is reached.
const MARK = Symbol.for('tacit.promptGuard');
const refused = (e) => e?.code === 4001 || /user (rejected|denied)|rejected the request|request rejected|denied (transaction|message)/i.test(String(e?.shortMessage || e?.message || e || ''));

// What a second refusal that came as fast as the first says: the wallet's answer with the same code, marked `quick`.
const instantly = (e) => Object.assign(new Error(e?.message || 'User rejected the request.'), { code: e?.code ?? 4001, quick: true, cause: e });

// What a refusal is called to the person: their own no, or a wallet that declined before anyone could answer. `tail` follows the first sentence.
export const declinedWords = (e, tail = '') => (e?.quick
  ? `Your wallet declined it straight away.${tail ? ` ${tail}` : ''} If that was not you, close any request still open in your wallet, then press again.`
  : `Cancelled in your wallet.${tail ? ` ${tail}` : ''}`);

export function guardProvider(provider, { quiet = QUIET_MS, retryQuiet = RETRY_QUIET_MS, quick = QUICK_MS, now = Date.now, sleep = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  if (!provider || typeof provider.request !== 'function' || provider[MARK]) return provider;
  const ask = provider.request;
  let answered = 0;
  const prompted = async (args) => {
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

// For a prompt the page is waiting on: `tell()` runs once it has gone `after` ms unanswered (it may return a function that takes what it said
// away), and the returned function, called when the wallet answers, ends the wait and takes that back.
export function stillWaiting(tell, { after = SLOW_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let off = null;
  const timer = setTimer(() => { off = tell(); }, after);
  return () => { clearTimer(timer); if (typeof off === 'function') off(); off = null; };
}
