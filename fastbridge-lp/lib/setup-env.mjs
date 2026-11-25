// The real `io` of fastbridge-lp/setup.mjs: the pool module, the Ethereum nodes and the Bitcoin explorers (the same modules the daemon and
// tools/fastbridge-lp-shield.mjs use). Loaded only when setup runs for real; the tests of the logic use mocks (lib/setup.mjs).

import { resolve } from 'node:path';
import { makeFileStorage } from './storage.mjs';

const ETH_TICKER = 'cETH';
const DEPOSIT_EXISTS = /0xad2fa98e|DepositExists/i;

export async function loadEnv({ keyHex, dataDir, baseConfig, say }) {
  globalThis.localStorage = makeFileStorage(resolve(dataDir, 'wallet-cache.json'));   // the same cache the daemon reads: the wrap-index hints carry over
  const { secp, sha256, keccak_256, hmac } = await import('../../dapp/vendor/tacit-deps.min.js');
  secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
  const { makeConfidentialPoolUx } = await import('../../dapp/confidential-pool-ux.js');
  const { setActiveNetwork } = await import('../../dapp/confidential-deployments.js');
  const { makeBtcWallet } = await import('../../dapp/bitcoin-taproot-wallet.js');
  const { reverseKeyOf } = await import('./reverse.mjs');
  const pairLib = await import('./pair.mjs');
  const { AGREE_NODES } = await import('../../dapp/fastbridge-evm.js');
  setActiveNetwork('mainnet');
  const ux = makeConfidentialPoolUx({ secp, keccak256: keccak_256, sha256, fetchImpl: (u, o) => fetch(u, o), network: 'mainnet' });
  const key = Uint8Array.from(keyHex.match(/../g).map((x) => parseInt(x, 16)));
  const acct = ux.account(key);
  const { prims } = makeBtcWallet({ priv: reverseKeyOf(key), hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('not used'); }, fetchFeeRate: async () => 1 });
  const reverseAddress = prims.wallet.address();
  const meta = ux.assetByTicker[ETH_TICKER];
  const idTail = String(meta.assetId).toLowerCase().replace(/^0x/, '').slice(-64);
  const bases = baseConfig.btcBases;
  const hexq = (v) => '0x' + BigInt(v).toString(16);

  const feed = pairLib.pairFeed({ call: (to, data) => ux.rpc('eth_call', [{ to, data }, 'latest']), fetchImpl: (u, o) => fetch(u, o), log: () => {}, C: baseConfig });
  const privateUnits = async () => {
    const bal = await ux.balance(key);
    const e = Object.entries(bal.byAsset || {}).find(([k]) => k.toLowerCase().endsWith(idTail));
    return e ? e[1].notes.reduce((s, n) => s + BigInt(n.value), 0n) : 0n;
  };
  const buildFor = (p) => ux.buildRouterWrap({ walletPriv: key, amountWei: BigInt(p.amountWei), ticker: ETH_TICKER, index: BigInt(p.index) });

  const io = {
    say,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    publicEth: async () => BigInt(await ux.rpc('eth_getBalance', [acct.address, 'latest'])),
    privateUnits,
    nextIndex: async () => { say('reading the pool for this key\'s next deposit index (a first read takes a few minutes)…'); return ux.nextWrapIndex({ walletPriv: key, ticker: ETH_TICKER }); },
    deposit: async ({ index, amountWei }) => { const s = await ux.routerWrap({ walletPriv: key, amountWei, ticker: ETH_TICKER, index }); return { txHash: s.txHash }; },
    // the pool refuses a deposit it has seen with DepositExists: the same deposit, built again from the key and the index, is the test
    depositRegistered: async (p) => {
      const b = await buildFor(p);
      try { await ux.rpc('eth_call', [{ from: acct.address, to: b.to, value: hexq(b.value || 0), data: b.calldata }, 'latest']); return false; }
      catch (e) { return DEPOSIT_EXISTS.test(String((e && (e.data || e.message)) || e)); }
    },
    receipt: async (h) => { const r = await ux.rpc('eth_getTransactionReceipt', [h]).catch(() => null); return r ? { ok: r.status === '0x1' } : null; },
    // the relay settles unless it is not sending (its sender is under its gas floor): then this address proves and sends the settle itself, after a call that
    // shows the pool would take it. The deposit is rebuilt from the key and the index, so this works after a stop as it does straight after the send.
    settle: async (p) => {
      const built = await buildFor(p);
      const st = await ux.relay.state().then((s) => (s && s.state) || null).catch(() => null);
      const own = st != null && st !== 'ok';
      const selfSettle = own ? async (x) => {
        if (!x || !x.publicValues || !x.proof) throw new Error('there is no proof to send');
        await ux.rpc('eth_call', [{ from: acct.address, to: ux.cfg.pool, data: ux.settleCalldata(x) }, 'latest']);
        return ux.settleFromAccount({ settlerPriv: key, publicValues: x.publicValues, proof: x.proof, memos: x.memos || [] });
      } : null;
      say(own ? `the relay is ${st}: it proves, and this address sends the settle…` : 'asking the relay to settle it into private notes…');
      await ux.submitWrapSettle({ built: { ...built, txHash: p.depositTx }, depositTx: p.depositTx || null, ...(selfSettle ? { selfSettle } : {}) });
    },
    notesLanded: async (p) => (await privateUnits()) >= BigInt(p.privBefore) + BigInt(p.amountWei) / 10n ** 10n,
    btcConfirmed: async () => {
      for (const b of bases) {
        try {
          const r = await fetch(`${b}/address/${reverseAddress}/utxo`, { signal: AbortSignal.timeout(10000) });
          if (!r.ok) continue;
          return (await r.json()).filter((u) => u.status && u.status.confirmed).reduce((s, u) => s + BigInt(u.value), 0n);
        } catch { /* next explorer */ }
      }
      throw new Error('no explorer answered');
    },
    rate: async () => { await feed.refresh().catch(() => {}); const r = feed.rate(); if (!r) throw new Error('no price: the sources are down or disagree'); return { num: BigInt(r.num), den: BigInt(r.den) }; },
    relayState: () => ux.relay.state().then((s) => (s && s.state) || 'ok'),
  };
  return { io, poolAccount: acct.address, reverseAddress, agreeNodes: AGREE_NODES, fetchImpl: (u, o) => fetch(u, o) };
}
