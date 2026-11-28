// The daemon's side of a pair provider's upkeep (lib/automation.mjs): the reads and sends it needs, made from what server.mjs already holds. Everything here
// spends only from the provider's own keys and pays only to them, with one exception that is fixed in code: the buyback send, to TacBuyback, off unless
// FB_LP_BUYBACK=on.
//
//   FB_LP_RECYCLE=off       stop moving take coins from the main address to the reverse address (on by default when the reverse side is on)
//   FB_LP_SKEW=off          quote at the market plus the fee, with no lean (on by default when the reverse side is on)
//   FB_LP_NOTES_MERGE=off   stop merging small ETH notes (on by default)
//   FB_LP_BUYBACK=on        past the target, send what the provider nets to TacBuyback (off unless set)
//   FB_LP_TARGET_ETH=<eth>  the target: this much pool ETH and Bitcoin worth as much (10 unless set; the config's `target` sets the two apart)
//   FB_LP_REBALANCE=dry|on  swap the surplus side on the best venue (THORChain or MAYAChain) when ETH and BTC drift apart (lib/rebalance.mjs; off unless set)
//   FB_LP_AUTO_SHIELD=on    shield the public ETH of the pool account into private notes (lib/shield.mjs; off unless set); the low-balance alerts are always on (lib/refill-watch.mjs)

import { resolve } from 'node:path';
import { makeFileStore } from './store.mjs';
import { recycleConfig, makeRecycler, agreedFeeRate, busyOutpoints } from './recycle.mjs';
import { skewConfig, feeAtMinBps } from './skew.mjs';
import { notesConfig } from './notes.mjs';
import { buybackConfig, targetConfig, buybackTopic } from './buyback.mjs';
import { makeAutomation } from './automation.mjs';
import { shieldConfig, makeShield } from './shield.mjs';
import { watchConfig, makeRefillWatch } from './refill-watch.mjs';
import { rebalanceConfig, makeRebalancer } from './rebalance.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
const lc = (h) => String(h || '').toLowerCase();
const FWD_TERMINAL = new Set(['done', 'refunded', 'rejected', 'aborted', 'lost']);

export async function wireAutomation({ C, key, prims, btc, tacit, ux, evm, service, swapStore, quoteStore, rside, rateFeed, poolTurn, turn = (fn) => fn(), data, keccak256, log, alert, setLean, env = process.env }) {
  const cfg = { recycle: recycleConfig(C, env), skew: skewConfig(C, env), notes: notesConfig(C, env), buyback: buybackConfig(C, env), target: targetConfig(C, env) };
  if (!rside) { cfg.recycle.enabled = false; cfg.skew.enabled = false; }
  const kv = makeFileStore(resolve(data, 'upkeep'));
  const asset = lc(C.evmAsset);
  const mainSpk = hex(prims.p2wpkhScript(prims.wallet.pub));

  const recycler = rside && cfg.recycle.enabled ? makeRecycler({
    cfg: cfg.recycle, btc, fwd: swapStore, rev: rside.swaps, mainSpk, reverseSpk: hex(rside.prims.p2wpkhScript(rside.prims.wallet.pub)),
    sign: (tx, i, value) => tacit.signP2wpkhInputWithKey(tx, i, value, key, prims.wallet.pub),
    serialize: (tx) => hex(tacit.serializeTx(tx)), txidOf: (tx) => tacit.txid(tx),
    load: async () => { const r = await kv.get('recycle'); if (r) delete r.id; return r; }, save: async (s) => kv.put({ ...s, id: 'recycle' }),
    bases: C.btcBases, log, alert, onMoved: (m) => auto.onMoved(m),
  }) : null;

  // the free notes of the pool ETH (one scan, shared by the report, the merge and the buyback)
  let notesRun = null, notesAt = 0, notesLast = null;
  // (the pool names the asset with its 0x: a bare id found no note, so the merge, the buyback and the note report saw none)
  const ethNotes = async () => {
    if (notesLast && Date.now() - notesAt < 30000) return notesLast;
    notesRun ||= Promise.resolve(ux.balance(key, { bridge: false, cbtc: false })).then(({ byAsset }) => { notesLast = ((((byAsset[`0x${asset.replace(/^0x/, '')}`] || byAsset[asset.replace(/^0x/, '')]) || {}).notes) || []).filter((n) => BigInt(n.value) > 0n); notesAt = Date.now(); return notesLast; }).finally(() => { notesRun = null; });
    return notesRun;
  };
  // nothing under way on the forward side: no swap open, no hold, nothing promised (a merge or a send then spends no note a lock waits on)
  const quiet = async () => {
    for (const r of await swapStore.list()) if (!FWD_TERMINAL.has(r.phase)) return false;
    if (service.reservations && [...service.reservations.values()].some((r) => r.until > Math.floor(Date.now() / 1000))) return false;
    return (await service.held()) === 0n;
  };
  const isFloor = (e) => /free relayed settles|free_budget|fee below|floor/i.test(String((e && e.message) || e));
  const merge = async ({ notes, amount, fee }) => {
    const sum = notes.reduce((s, n) => s + BigInt(n.value), 0n), to = ux.identity(key).pubHex;
    try { const r = await ux.transfer({ walletPriv: key, notes, recipientPubHex: to, amount: sum, fee: 0n }); notesLast = null; return { fee: 0n, txHash: r && r.txHash }; }
    catch (e) { if (!isFloor(e) || !(fee > 0n)) throw e; }
    const r = await ux.transfer({ walletPriv: key, notes, recipientPubHex: to, amount, fee });
    notesLast = null;
    return { fee, txHash: r && r.txHash };
  };
  const sendBuyback = async ({ note, amount, to }) => {
    if (lc(to) !== cfg.buyback.to) throw new Error('the buyback address is not the fixed one: nothing sent');
    const r = await ux.sendUnwrap({ note, walletPriv: key, recipient: cfg.buyback.to, amount });
    notesLast = null;
    const block = await ux.rpc('eth_blockNumber', []).then((h) => Number(BigInt(h)), () => null);
    return { fee: r && r.fee != null ? BigInt(r.fee) : 0n, txHash: (r && r.txHash) || null, block };
  };
  const topic = buybackTopic(keccak256);
  const readBought = async (fromBlock) => {
    if (fromBlock == null) return null;
    const latest = Number(BigInt(await ux.rpc('eth_blockNumber', [])));
    if (latest < fromBlock) return null;
    const to = Math.min(latest, fromBlock + 9999);
    const logs = await ux.rpc('eth_getLogs', [{ address: cfg.buyback.to, topics: [topic], fromBlock: '0x' + fromBlock.toString(16), toBlock: '0x' + to.toString(16) }]);
    const events = (logs || []).map((l) => ({ block: Number(BigInt(l.blockNumber)), index: Number(BigInt(l.logIndex || '0x0')), tx: l.transactionHash, ethIn: BigInt('0x' + l.data.slice(2, 66)), tacOut: BigInt('0x' + l.data.slice(66, 130)) }))
      .sort((a, b) => a.block - b.block || a.index - b.index);
    return { events, toBlock: to };
  };
  const balanceAt = async (block) => BigInt(await ux.rpc('eth_getBalance', [cfg.buyback.to, '0x' + block.toString(16)]));

  const R = C.reverse || {};
  const auto = makeAutomation({
    cfg, kv, rate: () => rateFeed.rate(), fwd: swapStore, rev: rside ? rside.swaps : null,
    fwdQuote: (id) => quoteStore.get(id), revQuote: (id) => (rside ? rside.quotes.get(id) : null),
    ethFree: () => service.free(), ethNotes, btcSats: rside ? async () => (await rside.btc.satsUtxos()).reduce((s, c) => s + BigInt(c.value), 0n) : async () => null,
    txFee: async (txid) => { const t = await btc.fetchTx(txid).catch(() => null); return t && t.status && t.status.confirmed && Number.isFinite(t.fee) ? t.fee : null; },
    relayFee: () => evm.cutReserve(10n ** 10n), quiet, gate: poolTurn, merge, sendBuyback, readBought, balanceAt, recycler,
    feeAtMin: { fwd: feeAtMinBps(C.quote.minAmount, C.quote.feeBps, C.quote.flatFee), rev: R.enabled ? feeAtMinBps(R.minAmount, R.feeBps, R.flatFee) : Infinity },
    log, alert,
  });

  // the public ETH of the pool account: shielded into private notes (off unless FB_LP_AUTO_SHIELD=on), and the alerts for what the provider needs
  let shield = null, watch = null, rebalancer = null;
  let sendFromImpl = null;                       // (set where the rebalancing is wired: the shield sends a fresh address's deposit through it)
  if (typeof ux.account === 'function' && typeof ux.rpc === 'function') {
    const address = ux.account(key).address, sc = shieldConfig(env);
    shield = makeShield({ cfg: sc, ux, key, address, quiet: async () => !(rebalancer && rebalancer.holding()) && (await quiet()), turn, load: () => kv.get('shield'), save: (r) => kv.put(r), log, alert, sendFrom: (x) => { if (!sendFromImpl) throw new Error('not ready'); return sendFromImpl(x); } });
    const sats = async () => {
      const a = [btc, rside && rside.btc].filter((b) => b && typeof b.satsUtxos === 'function');
      if (!a.length) return null;
      let t = 0n; for (const b of a) t += (await b.satsUtxos()).reduce((x, c) => x + BigInt(c.value), 0n);
      return t;
    };
    watch = makeRefillWatch({
      cfg: watchConfig(env), shield: sc, shieldInfo: () => shield.info(), autoShield: sc.enabled, freeEth: () => service.free(), sats, poolAccount: address,
      btcAddresses: [btc.address, rside && rside.btc && rside.btc.address].filter(Boolean),
      publicEth: async () => BigInt(await ux.rpc('eth_getBalance', [address, 'latest'])), alert,
    });
    if (sc.enabled) {
      let sbusy = false;
      setInterval(() => { if (sbusy) return; sbusy = true; shield.step().catch(() => {}).finally(() => { sbusy = false; }); }, 60000).unref();
      log({ level: 'info', msg: 'auto-shield is on: ETH sent to the pool account is shielded', address, reserveEth: Number(sc.reserveWei / 10n ** 10n) / 1e8, everySecs: sc.everySecs });
    }
  }
  // the surplus side swapped on the best venue (off unless FB_LP_REBALANCE is dry or on): the ETH is unshielded from the provider's own notes, sent from its own address, and the
  // other side lands at its own reverse Bitcoin address
  if (rside && typeof ux.account === 'function' && typeof ux.rpc === 'function') {
    const rc = rebalanceConfig(env);
    if (rc.mode !== 'off') {
      const acct = ux.account(key), address = acct.address, sc = shieldConfig(env);
      const { secp: sp } = await import('../../dapp/vendor/tacit-deps.min.js');
      const { makeEvmTx } = await import('../../dapp/evm-tx.js');
      const evmTx = makeEvmTx({ secp: sp, keccak256 });
      const UNITW = 10n ** 10n, rpc = (m, p) => ux.rpc(m, p);
      // all the provider's Bitcoin, the coins on their way (a move of the recycler between its two addresses) counted where they are going: confirmed alone would show a coin in flight as gone
      const satsAll = async () => {
        let t = 0n;
        for (const b of [btc, rside.btc]) {
          if (!b) continue;
          if (typeof b.satsCoins === 'function') { const r = await b.satsCoins(); t += r.coins.reduce((x, c) => x + BigInt(c.value), 0n) + BigInt(r.pending || 0); }
          else if (typeof b.satsUtxos === 'function') t += (await b.satsUtxos()).reduce((x, c) => x + BigInt(c.value), 0n);
        }
        return t;
      };
      const ownEthNotes = ethNotes;
      const publicWei = async (a) => BigInt(await rpc('eth_getBalance', [a || address, 'latest']));
      // a fresh address for each swap: the key is the provider's own key hashed with a counter, so it is always found again from the key and the count (nothing else is kept to lose)
      const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
      const freshPriv = (i) => { for (let c = 0; c < 8; c++) { const h = keccak256(Uint8Array.from([...key, ...Buffer.from('tacit-rebalance-eth-v1'), (i >>> 24) & 255, (i >>> 16) & 255, (i >>> 8) & 255, i & 255, c])); const k = BigInt('0x' + hex(h)); if (k > 0n && k < SECP_N) return h; } throw new Error('no key'); };
      const freshAcct = (i) => ux.account(freshPriv(i));
      // the deposit of the ETH a fresh address received: built for the key's own note (the pool does not tie a native-ETH deposit to who sends it) and sent from that address
      sendFromImpl = async ({ amountWei, index, ticker, priv }) => {
        const built = await ux.buildRouterWrap({ walletPriv: key, amountWei, ticker, index }), a = ux.account(priv);
        const nonce = BigInt(await rpc('eth_getTransactionCount', [a.address, 'pending'])), base = BigInt(await rpc('eth_gasPrice', [])), tip = 1_500_000_000n;
        const signed = evmTx.signEip1559({ chainId: 1n, nonce, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip, gasLimit: 300000n, to: built.to, value: BigInt(built.value), data: built.calldata }, a.priv);
        return { ...built, txHash: await rpc('eth_sendRawTransaction', [signed.raw]), from: a.address };
      };
      const shieldReserve = async () => 350000n * (BigInt(await rpc('eth_gasPrice', [])) * 2n + 1_500_000_000n);
      const ethPerBtc = () => { const c = rateFeed && rateFeed.current(); return c && Number(c.ethPerBtc) > 0 ? Number(c.ethPerBtc) : null; };   // (feed.rate() is a { num, den } ratio, not a price)
      // the Bitcoin leg: sats spent from the reverse address (its confirmed plain coins that no swap names), one output to the venue's vault, one OP_RETURN with the memo, change back to the
      // reverse address; never below `keepSats` left there for the ETH-for-BTC side. Built and signed here, kept by the rebalancer, then sent: the same bytes if it is sent again.
      const { reverseKeyOf } = await import('./reverse.mjs');
      const { bech32 } = await import('../../dapp/vendor/tacit-deps.min.js');
      const rkey = reverseKeyOf(key), rSpk = hex(rside.prims.p2wpkhScript(rside.prims.wallet.pub)), KEEP_SATS = Number(process.env.FB_LP_REBALANCE_KEEP_SATS ?? 150000);
      const scriptOfBech32 = (addr) => { const d = bech32.decode(addr); const prog = bech32.fromWords(d.words.slice(1)); if (d.prefix !== 'bc' || d.words[0] !== 0 || (prog.length !== 20 && prog.length !== 32)) throw new Error('the vault address is not a segwit v0 address'); return Uint8Array.from([0x00, prog.length, ...prog]); };
      const btcBuild = async ({ to, sats, memo, feeRate = null, inputs = null }) => {
        const amount = Number(sats);
        if (!(amount >= 20000)) throw new Error('the amount is too small to send');
        if (!/^=:e:0x[0-9a-fA-F]{40}(:[0-9]+(\/[0-9]+){0,2})?$/.test(memo) || memo.length > 80) throw new Error('the memo is not a plain swap to an ETH address');
        const busy = busyOutpoints(await swapStore.list(), await rside.swaps.list());
        // a replacement spends exactly the coins of the send it replaces (so the two cannot both confirm); a first send chooses its coins
        const coins = inputs ? inputs.map((c) => ({ txid: c.txid, vout: c.vout, value: c.value })) : (await (rside.btc.satsCoins ? rside.btc.satsCoins().then((r) => r.coins) : rside.btc.satsUtxos())).filter((c) => Number.isInteger(c.value) && c.value >= 10000 && !busy.has(`${c.txid}:${c.vout}`)).sort((a, b) => b.value - a.value);
        const rate = feeRate || await agreedFeeRate({ bases: C.btcBases, fetchImpl: (u, o) => fetch(u, o), target: '3', minAnswers: 2, cap: 40 });
        const memoBytes = Buffer.from(memo, 'utf8'), vaultScript = scriptOfBech32(to);
        const have = coins.reduce((t, c) => t + c.value, 0);
        const pick = []; let sum = 0, fee = 0;
        for (const c of coins) { pick.push(c); sum += c.value; fee = Math.ceil((11 + 68 * pick.length + 31 + (9 + vaultScript.length) + (11 + memoBytes.length)) * rate); if (!inputs && sum >= amount + fee + 546) break; }
        if (sum < amount + fee + 546) throw new Error('the reverse address does not hold enough plain coins for this send');
        if (!inputs && have - amount - fee < KEEP_SATS) throw new Error(`the send would leave the reverse address under ${KEEP_SATS} sats`);
        if (fee * 10000 > amount * 100) throw new Error(`the fee (${fee} sats at ${rate} sat/vB) is over 1% of the send`);
        const change = sum - amount - fee;
        const hb = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
        const tx = { version: 2, locktime: 0, inputs: pick.map((c) => ({ txid: c.txid, vout: c.vout, sequence: 0xfffffffd, witness: [] })), outputs: [{ value: amount, script: vaultScript }, { value: 0, script: Uint8Array.from([0x6a, memoBytes.length, ...memoBytes]) }, { value: change, script: hb(rSpk) }] };
        pick.forEach((c, i) => { tx.inputs[i].witness = tacit.signP2wpkhInputWithKey(tx, i, c.value, rkey, rside.prims.wallet.pub); });
        return { txid: tacit.txid(tx), hex: hex(tacit.serializeTx(tx)), fee, rate, inputs: pick.map((c) => ({ txid: c.txid, vout: c.vout, value: c.value })) };
      };
      // how often the vault has paid out lately, as its Bitcoin transactions show: the newest page of its history, counting those with an OUT: or REFUND: memo that spend from the vault
      const btcVaultHistory = async (vault) => {
        for (const base of C.btcBases || []) {
          try {
            const r = await fetch(`${String(base).replace(/\/$/, '')}/address/${vault}/txs`, { signal: AbortSignal.timeout(15000) });
            if (!r.ok) continue;
            const txs = await r.json();
            return txs.filter((t) => (t.vout || []).some((o) => o.scriptpubkey_type === 'op_return' && /(4f55543a|524546554e443a)/i.test(String(o.scriptpubkey || ''))) && (t.vin || []).some((i) => i.prevout && i.prevout.scriptpubkey_address === vault)).length;
          } catch { /* the next explorer */ }
        }
        return 0;
      };
      rebalancer = makeRebalancer({
        // the rebalancing also waits for the reverse side: no ETH-for-BTC swap under way, and no live quote for one (the Bitcoin it spends is the coins that side locks from)
        quiet: async () => {
          if (!(await quiet())) return false;
          const REV_END = new Set(['done', 'refunded', 'counter-took', 'aborted']);
          for (const r of await rside.swaps.list()) if (!REV_END.has(r.phase)) return false;
          const nowS = Math.floor(Date.now() / 1000);
          for (const q of await rside.quotes.list().catch(() => [])) if (Number(q.validUntil) > nowS && !q.swapId && !q.settled) return false;
          return true;
        },
        cfg: rc, rate: async () => ethPerBtc(), gate: poolTurn, turn,
        // nothing is planned while the auto-shield has a deposit on its way into the pool: that ETH is in neither the public balance nor the notes yet
        settled: async () => !(shield && shield.info().pending),
        inventory: async () => {
          const pub = await publicWei();
          const priv = BigInt(await service.free()) * UNITW, spare = pub > sc.reserveWei ? pub - sc.reserveWei : 0n;
          return { ethWei: priv + spare, sats: Number(await satsAll()) };
        },
        unshield: async ({ units, to }) => {
          const want = BigInt(units), note = (await ownEthNotes()).filter((n) => BigInt(n.value) >= want).sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? -1 : 1))[0];
          if (!note) throw new Error(`no single private note covers ${want} pool units`);
          const r = await ux.sendUnwrap({ note, walletPriv: key, recipient: to || address, amount: want });
          notesLast = null;
          return r;
        },
        ethBalance: (a) => publicWei(a),
        ethNonce: (a) => rpc('eth_getTransactionCount', [a || address, 'pending']),
        freshAddress: (i) => freshAcct(i).address,
        shieldFresh: !sc.enabled ? null : async ({ fi }) => { const a = freshAcct(fi); return shield.shieldFrom({ address: a.address, priv: a.priv, reserveWei: await shieldReserve(), minWei: 10n ** 16n }); },
        ethReceipt: (tx) => rpc('eth_getTransactionReceipt', [tx]).catch(() => null),
        sendEth: async ({ to, value, memo, fi = null }) => {
          const me = fi != null ? freshAcct(fi) : acct;
          // the send is a plain transfer from this address to the venue's vault with the memo as its data; the amount can never exceed the swap limit, nor the vault be this address
          if (!/^0x[0-9a-fA-F]{40}$/.test(to) || lc(to) === lc(address) || lc(to) === lc(me.address)) throw new Error('the vault address is not usable: nothing sent');
          if (BigInt(value) > rc.maxSwapWei) throw new Error('the amount is over the swap limit: nothing sent');
          if (!/^[\x20-\x7e]{1,120}$/.test(memo)) throw new Error('the memo is not plain text: nothing sent');
          const data = '0x' + Buffer.from(memo, 'utf8').toString('hex');
          const nonce = BigInt(await rpc('eth_getTransactionCount', [me.address, 'pending'])), base = BigInt(await rpc('eth_gasPrice', [])), tip = 1_500_000_000n;
          const est = BigInt(await rpc('eth_estimateGas', [{ from: me.address, to, value: '0x' + BigInt(value).toString(16), data }]));
          const gasLimit = est * 13n / 10n;
          if (gasLimit > 120000n) throw new Error('the transfer needs more gas than a plain transfer with a memo should: nothing sent');
          const signed = evmTx.signEip1559({ chainId: 1n, nonce, maxPriorityFeePerGas: tip, maxFeePerGas: base * 2n + tip, gasLimit, to, value: BigInt(value), data }, me.priv);
          return rpc('eth_sendRawTransaction', [signed.raw]);
        },
        // how many times the venue's router has paid out of the vault in about the last 30 hours (TransferOut with the vault as its first topic): read from the Ethereum nodes
        btcBuild, btcBroadcast: (h) => btc.broadcast({ revealHex: h }), btcStatus: (id) => btc.status(id),
        btcInputsOf: async (txid) => {
          const t = await btc.fetchTx(txid);
          const own = rSpk.toLowerCase(), ins = (t.vin || []).map((i) => ({ txid: i.txid, vout: i.vout, value: i.prevout && i.prevout.value, spk: String((i.prevout && i.prevout.scriptpubkey) || '').toLowerCase() }));
          if (!ins.length || ins.some((i) => !Number.isInteger(i.value) || i.spk !== own)) throw new Error('an input is not a coin of the reverse address');
          return ins.map(({ txid: a, vout, value }) => ({ txid: a, vout, value }));
        },
        // for a bump the explorers need not agree within a factor (a first send waits for that): the lower middle of two or more answers, which the rebalancing then caps (FB_LP_REBALANCE_MAX_FEE_RATE) and the send's fee limit bounds
        btcFeeRate: async () => {
          const vals = (await Promise.all((C.btcBases || []).map(async (b) => { try { const r = await fetch(`${String(b).replace(/\/$/, '')}/fee-estimates`, { signal: AbortSignal.timeout(15000) }); if (!r.ok) return null; const f = await r.json(), v = Number(f['2'] ?? f['3'] ?? f['6']); return Number.isFinite(v) && v > 0 && v < 5000 ? Math.max(1, v) : null; } catch { return null; } }))).filter((v) => v != null).sort((a, b) => a - b);
          if (vals.length < 2) throw new Error('fewer than two explorers gave a fee estimate');
          return vals[Math.floor((vals.length - 1) / 2)];
        },
        vaultHistory: async ({ chain, router, vault }) => {
          if (chain === 'BTC') return btcVaultHistory(vault);
          const topic0 = '0x' + Buffer.from(keccak256(new TextEncoder().encode('TransferOut(address,address,address,uint256,string)'))).toString('hex');
          const head = Number(BigInt(await rpc('eth_blockNumber', [])));
          const logs = await rpc('eth_getLogs', [{ address: router, fromBlock: '0x' + (head - 9000).toString(16), toBlock: '0x' + head.toString(16), topics: [topic0, '0x' + '0'.repeat(24) + String(vault).toLowerCase().replace(/^0x/, '')] }]);
          return Array.isArray(logs) ? logs.length : 0;
        },
        address, btcDestination: rside.btc.address, gasReserveWei: sc.reserveWei,
        load: () => kv.get('rebalance'), save: (r) => kv.put(r), log, alert,
      });
      let rbusy = false;
      setInterval(() => { if (rbusy) return; rbusy = true; rebalancer.step().catch(() => {}).finally(() => { rbusy = false; }); }, 60000).unref();
      log({ level: 'info', msg: `rebalance is ${rc.mode}`, venues: rc.venues, bandBps: rc.bandBps, minEth: Number(rc.minSwapWei / UNITW) / 1e8, maxEth: Number(rc.maxSwapWei / UNITW) / 1e8, maxDayEth: Number(rc.maxPerDayWei / UNITW) / 1e8, maxCostBps: rc.maxCostBps });
    }
  }
  const tickSecs = Math.max(30, Number((C.upkeep && C.upkeep.tickSecs) || 120));
  let busy = false;
  const go = async () => { if (busy) return; busy = true; try { await auto.tick(); setLean(auto.skew()); if (watch) await watch.check(); } catch (e) { log({ level: 'error', msg: 'upkeep: a look failed', error: String((e && e.message) || e).slice(0, 200) }); } finally { busy = false; } };
  setTimeout(go, 20000).unref();
  setInterval(go, tickSecs * 1000).unref();
  log({ level: 'info', msg: 'upkeep is on', recycle: cfg.recycle.enabled, skew: cfg.skew.enabled ? cfg.skew.maxBps : 0, notesMerge: cfg.notes.enabled, buyback: cfg.buyback.enabled, targetEth: String(cfg.target.eth), tickSecs });
  // /info carries the totals, the target, the lean, the buybacks and what the provider needs (refill)
  const wrap = (handle) => async (req) => {
    const r = await handle(req);
    if (req && req.method === 'GET' && req.path === '/info' && r && r.status === 200 && r.body && typeof r.body === 'object') {
      // the extras are the upkeep's own view: when one cannot be built, /info is the terms alone, and still answers
      try { const x = auto.info(); if (x) return { ...r, body: { ...r.body, ...x, ...(watch ? { refill: watch.info() } : {}), ...(rebalancer ? { rebalance: rebalancer.info() } : {}) } }; }
      catch (e) { log({ level: 'error', msg: '/info: the upkeep part could not be read', error: String((e && e.message) || e).slice(0, 160) }); }
    }
    return r;
  };
  return { auto, wrap, cfg };
}
