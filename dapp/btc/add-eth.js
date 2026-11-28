// Adding ETH to the Tacit wallet's private balance from an Ethereum wallet, for a swap of ETH for BTC that the balance is short of (the lane's "Add ETH" on /btc/).
// The deposit is the one the tETH page and the swap card make (teth/wrap.js wrapEth): one wallet transaction deposits the ETH and the relay's tip, then the relay
// proves it and it lands as a note of the key's. A deposit under way is kept in this browser, by key, so a page opened again finishes it instead of asking again.
//
//   addUnits(amount, available)        -> pool units (1e-8 ETH) to add so a lock of `amount` can be made (see below)
//   const add = makeAddEth({ getUx })
//   add.start({ key, units, onStep })  -> { wei, tip, hash }      key: { priv: Uint8Array, pubHex, mode, address }
//   add.pending(pubHex)                -> the kept deposit, or null
//   add.resume({ key, onStep })        -> { landed } | null       finishes a kept deposit (null: there was none, or nothing was sent)
//
//   add.balance()                      -> { account, wei } of the connected Ethereum wallet, or null
//   add.warm()                         reads ahead what a deposit needs (before the key is open)
//
// onStep(k, d): 'wallet' (finding the wallet), 'quote', 'prepare', 'confirm' ({ wei, tip, from }), 'sent' (hash), 'mined' ({ hash, units }: the deposit is in a block,
// so its note will land), 'proving' (hash), 'landed'.
// Errors carry `html` (a sentence the lane shows as it is) when there is a way forward worth a link, `short` when the wallet holds too little, `userStopped`
// when the wallet was declined, and `kept` when a deposit was sent and is still being finished.
import { rpc, fmtUnits, short, esc, E10 } from '/trade/util.js?cb=9c8b4133';

const KEY = 'tacit-btc-add-eth-v1:';
const KEEP_MS = 3 * 86400e3;                                     // a deposit kept longer than this is not looked for again
const GAS_GUESS = 150000n;                                       // a deposit's gas when the node cannot estimate it (about 110k measured)
const WRAP_MODULE = '/teth/wrap.js?cb=ce5e16c2', READ_MODULE = '/teth/read.js?cb=3784b81d', WALLET_MODULE = '/trade/wallet.js?cb=ff74eb58', PICK_MODULE = '/trade/sign-in.js?cb=ce1ac266';
const eth = (wei) => fmtUnits(wei, 18, 6);

// A lock of `amount` (pool units) is made from one note of exactly that amount, or from notes that hold it and the relay's fee of cutting them (the lane's
// `available` is what the notes hold less that fee). So: with something available, the shortfall, which brings `available` to the amount; with nothing
// available (no notes, or notes worth less than the fee of a cut), the amount itself, deposited as one note of exactly that amount, which needs no cut.
export function addUnits(amount, available) {
  const a = BigInt(amount), have = available == null ? 0n : BigInt(available);
  if (a <= 0n || have >= a) return 0n;
  return have > 0n ? a - have : a;
}
// The relay's tip is at most a twentieth of a deposit (teth/read.js wrapQuote): the least deposit that a tip of `tip` wei allows, in pool units, rounded up.
export const leastFor = (tip) => (BigInt(tip) * 20n + E10 - 1n) / E10;

const read = (pub) => { try { const r = JSON.parse(localStorage.getItem(KEY + pub) || 'null'); return r && Date.now() - r.at < KEEP_MS ? r : null; } catch { return null; } };
const write = (pub, r) => { try { localStorage.setItem(KEY + pub, JSON.stringify(r)); } catch { /* the deposit still lands; only a reload would not finish it */ } };
const drop = (pub) => { try { localStorage.removeItem(KEY + pub); } catch { /* nothing kept */ } };

export function makeAddEth({ getUx, pick = null }) {
  let mods = null, wallet = null;
  const load = () => (mods ||= Promise.all([import(WRAP_MODULE), import(READ_MODULE), import(WALLET_MODULE)]).then(([w, r, k]) => ({ ...w, ...r, ...k })).catch((e) => { mods = null; throw e; }));

  const noWallet = (key) => Object.assign(new Error('No Ethereum wallet in this browser.'), {
    noWallet: true,
    html: `${key?.mode === 'passkey' ? 'Your Tacit wallet opened with a passkey, and this' : 'This'} browser has no Ethereum wallet to add ETH from. Open this page in your wallet app’s browser, or shield ETH into this same Tacit wallet on the <a href="/teth/">tETH page</a> from any wallet, then swap here.`,
  });
  // the page's Ethereum wallet: the one already connected, one this browser connected before, the only one there is, or the one the visitor picks
  async function connect(key) {
    const M = await load();
    wallet ||= M.makeWallet({ rpc });
    if (wallet.state.account) return wallet;
    if (await wallet.restore().catch(() => false)) return wallet;
    let list = wallet.available();
    for (let i = 0; i < 5 && !list.length; i++) { dispatchEvent(new Event('eip6963:requestProvider')); await new Promise((r) => setTimeout(r, 120)); list = wallet.available(); }
    if (!list.length) throw noWallet(key);
    let w = list[0];
    if (list.length > 1) {
      const choose = pick || (await import(PICK_MODULE)).pickWalletSheet;
      const uuid = await choose(list.map((x, i) => ({ uuid: x.info?.uuid || String(i), name: x.info?.name || 'Wallet', icon: x.info?.icon || '' })));
      if (uuid == null) throw Object.assign(new Error('No wallet was chosen. Nothing was sent.'), { userStopped: true });
      w = list.find((x, i) => (x.info?.uuid || String(i)) === uuid) || w;
    }
    await wallet.connect(w);
    if (!wallet.state.account) throw new Error('The wallet did not give an account. Nothing was sent.');
    return wallet;
  }

  // What the deposit asks of the wallet, checked before the wallet is asked: the ETH, the relay's tip and the network fee, against what the account holds.
  // What the connected Ethereum wallet holds publicly, in wei: read only when the page's wallet is connected (or this browser connected one before, which
  // reconnects without asking). null when there is none or the read failed.
  // (a wallet that never answers, or rejects, leaves the balance unknown after BALANCE_MS: it never holds up the lane or a quote)
  const BALANCE_MS = 6000;
  const balance = () => { let t; return Promise.race([balanceNow().catch(() => null), new Promise((r) => { t = setTimeout(() => r(null), BALANCE_MS); })]).finally(() => clearTimeout(t)); };
  async function balanceNow() {
    try {
      const M = await load();
      wallet ||= M.makeWallet({ rpc });
      if (!wallet.state.account && !(await wallet.restore().catch(() => false))) return null;
      const a = wallet.state.account;
      return a ? { account: a, wei: await rpc('eth_getBalance', [a, 'latest']).then(BigInt) } : null;
    } catch { return null; }
  }

  async function afford({ to, data, value, from }) {
    const [have, price, gas] = await Promise.all([
      rpc('eth_getBalance', [from, 'latest']).then(BigInt, () => null),
      rpc('eth_gasPrice', []).then(BigInt, () => null),
      rpc('eth_estimateGas', [{ from, to, data, value: '0x' + BigInt(value).toString(16) }]).then(BigInt, () => null),
    ]);
    if (have == null || price == null) return;                   // not read: the wallet itself refuses a send it cannot pay for
    const fee = (gas ?? GAS_GUESS) * price;
    if (have < BigInt(value) + fee) {
      throw Object.assign(new Error('The wallet holds too little ETH.'), {
        userStopped: true, short: { have, need: BigInt(value) + fee },
        html: `Your wallet ${esc(short(from))} holds ${esc(eth(have))} ETH. This needs ${esc(eth(value))} ETH and about ${esc(eth(fee))} ETH network fee. Nothing was sent.`,
      });
    }
  }

  async function start({ key, units, onStep = () => {} }) {
    const M = await load();
    const want = BigInt(units);
    if (want <= 0n) throw new Error('There is nothing to add.');
    if (read(key.pubHex)?.hash) throw Object.assign(new Error('A deposit to your private balance is still being finished.'), { kept: true });
    onStep('wallet');
    const w = await connect(key), from = w.state.account;
    onStep('quote');
    // a deposit too small for the relay's tip to be at most a twentieth of it is made larger: the rest stays in the private balance
    let wei = want * E10, q;
    try { q = await M.wrapQuote(wei); }
    catch (e) {
      if (!/more than 5%/.test(String(e?.message))) throw e;
      const big = await M.wrapQuote(10n ** 17n);
      wei = (leastFor(big.tip) > want ? leastFor(big.tip) : want) * E10;
      q = await M.wrapQuote(wei);
    }
    const t = await getUx();
    const rec = { v: 1, wei: String(wei), from, at: Date.now(), hash: null };
    const guarded = {
      async sendTx(tx) {
        await afford({ ...tx, from });
        onStep('confirm', { wei, tip: q.tip, from });
        write(key.pubHex, rec);
        let hash;
        try { hash = await w.sendTx(tx); } catch (e) { drop(key.pubHex); throw e; }
        rec.hash = hash; write(key.pubHex, rec);
        return hash;
      },
      // a deposit can sit for a while when Ethereum is busy: the wait is long, and the page says it is still waiting (the lane's own timer). Mined, it is
      // said at once ('mined'): the ETH has left the wallet for good and lands as a note of the key's, so a swap can be started on it while the relay finishes it
      receipt: async (hash) => {
        const rc = await w.receipt(hash, { timeoutMs: 30 * 60e3 });
        if (rc && rc.status === '0x1') { try { onStep('mined', { hash: rc.transactionHash || hash, units: wei / E10 }); } catch { /* the deposit goes on */ } }
        return rc;
      },
    };
    try {
      await M.wrapEth({ priv: () => Uint8Array.from(key.priv), wei, tip: q.tip, to: q.to, from, wallet: guarded, ux: t, say: (k, d) => { if (k !== 'confirm') onStep(k, d); } });
    } catch (e) {
      // (not sent, failed on chain, or cancelled in the wallet before it was mined: nothing is left to finish)
      if (!rec.hash || e?.reverted || e?.replaced) { drop(key.pubHex); throw e; }
      // sent: kept, and finished from the kept record (this page's resume, or after a reload)
      throw Object.assign(e, { kept: true, hash: rec.hash });
    }
    drop(key.pubHex);
    onStep('landed');
    return { wei, tip: q.tip, hash: rec.hash };
  }

  // A deposit this browser kept: its transaction is waited for, then the relay is asked to finish it (teth/wrap.js finish) unless it has landed already.
  // A deposit whose hash was never kept (the page closed while the wallet was asked) is looked for among the key's deposits by its amount.
  async function resume({ key, onStep = () => {} }) {
    const rec = read(key.pubHex);
    if (!rec) return null;
    const M = await load(), t = await getUx(), priv = () => Uint8Array.from(key.priv);
    if (rec.hash) {
      onStep('sent', rec.hash);
      for (;;) {
        const rc = await rpc('eth_getTransactionReceipt', [rec.hash]).catch(() => undefined);
        if (rc && rc.status !== '0x1') { drop(key.pubHex); throw new Error(`The deposit failed (${rec.hash.slice(0, 10)}…). Nothing was lost but its network fee.`); }
        if (rc) break;
        if (Date.now() - rec.at > 3600e3) {                       // an hour on and no node knows it: dropped, or replaced in the wallet
          if (!(await rpc('eth_getTransactionByHash', [rec.hash]).catch(() => true))) { drop(key.pubHex); throw new Error('The deposit was never mined (cancelled or replaced in your wallet). Nothing left your wallet.'); }
        }
        await new Promise((r) => setTimeout(r, 6000));
      }
    }
    onStep('proving', rec.hash);
    const held = await M.readHeld({ priv, ux: t });
    const p = (held.pending || []).find((d) => (rec.hash && String(d.txHash || '').toLowerCase() === rec.hash.toLowerCase()) || BigInt(d.value) * E10 === BigInt(rec.wei));
    if (!p) { drop(key.pubHex); if (!rec.hash) return null; onStep('landed'); return { landed: true }; }
    const r = await M.finish({ priv, pending: [p], ux: t, say: (k, d) => onStep(k, d) });
    if (!r.done) throw Object.assign(r.err || new Error('The relay did not finish the deposit yet.'), { kept: true, hash: rec.hash });
    drop(key.pubHex);
    onStep('landed');
    return { landed: true };
  }

  // What a deposit reads first, read before it is asked for: the modules, and the pool's record of ETH deposits (which the next deposit index is picked from)
  const warm = () => load().then(() => getUx()).then((t) => t.warmWrapLogs?.({ ticker: 'cETH' })).catch(() => {});

  return { start, resume, warm, balance, pending: (pub) => read(pub), relayWords: async (e) => (await load()).relayWords(e) };
}
