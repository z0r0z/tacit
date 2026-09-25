// Replay service for the Bitcoin-native shielded pool (contracts/sp1/confidential/DESIGN-btc-shielded-pool.md §5).
// Follows Bitcoin from BTC_POOL_START_HEIGHT, replays 0x6C/0x6D envelopes in block and input order, persists one SQLite
// transaction per block, rolls back on reorgs, and serves roots, paths, the note feed, nullifier and exit
// status over read-only HTTP. The replay signs nothing and holds no keys; the optional relayer, mounted only
// when BTC_POOL_RELAYER_* keys are set, does.

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  BtcPoolState, ReorgTooDeepError, VerifierUnavailableError, parseEnvelope, carrierPoolEnvelopes,
  ANCHOR_WINDOW, UNDO_DEPTH, bytesToHex,
} from '../../worker/src/btc-shielded-pool.js';
import { makeEsplora, parseBlock, txEnvelopes } from './lib/btc-pool-chain.js';
import { makeShieldInputResolver } from './lib/btc-pool-transparent.js';
import { openBtcPoolStore } from './lib/btc-pool-store.js';
import { makeBtcPoolVerifier } from './lib/btc-pool-verify.js';

const x0 = (b) => '0x' + bytesToHex(b);
const pre = (s) => (s == null ? null : '0x' + s);

// `resolveShieldInput` defaults to the canonical transparent validator (lib/btc-pool-transparent.js).
export function createIndexer({ store, esplora, verifier, network, startHeight, confirmations = 1, log = console.log, resolveShieldInput = null }) {
  if (!Number.isInteger(startHeight) || startHeight < 1) throw new Error('startHeight must be a positive integer');
  const metaNet = store.meta('network'), metaStart = store.meta('start_height');
  if (metaNet && metaNet !== network) throw new Error(`database is for ${metaNet}, not ${network}`);
  if (metaStart && Number(metaStart) !== startHeight) throw new Error(`database starts at ${metaStart}, not ${startHeight}`);
  store.setMeta('network', network);
  store.setMeta('start_height', startHeight);

  const self = {
    state: BtcPoolState.restore(store.snapshot()),
    chainTip: null,
    halted: null,
    lastError: null,
    network, startHeight, verifier,
  };
  const resolveNote = resolveShieldInput || makeShieldInputResolver({ esplora, network, exits: () => self.state.exits });
  const resolveInput = async (op, assetHex) => {
    const n = await resolveNote(op.txid, op.vout);
    return n && n.asset === assetHex ? { cx: n.Cx, cy: n.Cy } : null;
  };

  function rescan(why) {
    log(`full rescan from ${startHeight}: ${why}`);
    store.wipe();
    self.state = new BtcPoolState();
  }

  function rollback(from) {
    log(`reorg: rolling back to ${from - 1}`);
    try {
      self.state.rollbackFrom(from);
    } catch (e) {
      if (e instanceof ReorgTooDeepError) return rescan(e.message);
      throw e;
    }
    try { store.rollbackFrom(from); } catch (e) { self.state = BtcPoolState.restore(store.snapshot()); throw e; }
  }

  async function findFork() {
    const tip = self.state.tip;
    for (let h = tip; h >= Math.max(startHeight, tip - UNDO_DEPTH + 1); h--) {
      const local = store.block(h);
      if (!local) break;
      if (h <= self.chainTip && (await esplora.blockHash(h)) === local.hash) return h + 1;
    }
    return null;
  }

  async function checkReorg() {
    const tip = self.state.tip;
    if (tip === null) return;
    const local = store.block(tip);
    const remote = tip <= self.chainTip ? await esplora.blockHash(tip) : null;
    if (local && remote === local.hash) return;
    const fork = await findFork();
    if (fork === null) rescan(`fork deeper than ${UNDO_DEPTH} blocks`);
    else rollback(fork);
  }

  async function processBlock(height, block) {
    const st = self.state;
    st.beginBlock(height);
    const envelopes = [];
    let delta;
    try {
      for (let i = 0; i < block.txs.length; i++) {
        const tx = block.txs[i];
        if (i === 0) continue;
        const { vin0TacitOp, items } = carrierPoolEnvelopes(txEnvelopes(tx));
        for (const env of items) {
          const parsed = parseEnvelope(env.payload);
          let res;
          if (!parsed) res = { accepted: false, reason: 'non-canonical envelope' };
          else if (parsed.kind === 'shield') {
            if (env.vin !== 0) res = { accepted: false, reason: 'T_BTC_SHIELD must ride vin[0]' };
            else {
              try {
                res = await st.acceptShield(parsed, { txid: tx.txid, inputs: tx.vin, resolveInput });
              } catch (e) {
                self.halted = { height, txid: tx.txid, reason: `shield input unresolved: ${e?.message || e}` };
                throw e;
              }
            }
          } else {
            try {
              res = await st.acceptSpend(parsed, { txid: tx.txid, outputs: tx.vout, vin0TacitOp, verifyProof: verifier.verify });
            } catch (e) {
              if (e instanceof VerifierUnavailableError) self.halted = { height, txid: tx.txid, reason: verifier.reason };
              throw e;
            }
          }
          envelopes.push({ txIndex: i, vin: env.vin, txid: tx.txid, opcode: env.opcode, accepted: res.accepted, reason: res.reason });
          if (!res.accepted) log(`${height} ${tx.txid} vin ${env.vin} 0x${env.opcode.toString(16)} rejected: ${res.reason}`);
        }
      }
      delta = st.endBlock();
    } catch (e) {
      st.abortBlock();
      throw e;
    }
    try {
      store.commitBlock(delta, block.hash, envelopes);
    } catch (e) {
      st.rollbackFrom(height);
      throw e;
    }
    self.halted = null;
    if (envelopes.length) log(`${height}: ${envelopes.length} pool envelope(s), ${st.tree.size} leaves, root ${x0(delta.root)}`);
  }

  // One pass: reorg check, then every confirmed block not yet replayed. Throws on I/O failure with no
  // partial block applied.
  self.syncOnce = async function syncOnce({ maxBlocks = Infinity } = {}) {
    self.chainTip = await esplora.tipHeight();
    await checkReorg();
    const target = self.chainTip - confirmations + 1;
    let done = 0;
    for (let h = self.state.tip === null ? startHeight : self.state.tip + 1; h <= target && done < maxBlocks; h++, done++) {
      const hash = await esplora.blockHash(h);
      const block = parseBlock(await esplora.rawBlock(hash), hash);
      if (h > startHeight) {
        const prev = store.block(h - 1);
        if (!prev || prev.hash !== block.prevHash) { log(`block ${h} does not extend ${h - 1}; rechecking`); break; }
      }
      await processBlock(h, block);
    }
    return done;
  };

  self.status = () => {
    const st = self.state;
    return {
      network, startHeight, confirmations,
      height: st.tip,
      tip: self.chainTip,
      leafCount: st.pending ? st.pending.leafStart : st.tree.size,
      root: st.tip === null ? null : x0(st.roots.get(st.tip)),
      verifierEnabled: !!verifier.enabled,
      verifierReason: verifier.reason || null,
      halted: self.halted,
      shieldInputValidation: 'canonical',
      lastError: self.lastError,
    };
  };
  return self;
}

// ── HTTP ──
function noteRow(r) {
  return {
    leafIndex: r.idx, txid: r.txid, height: r.height, leaf: pre(r.leaf), asset: pre(r.asset), Cx: pre(r.cx), Cy: pre(r.cy),
    spend_key: pre(r.spend_key), nk_pub: pre(r.nk_pub), pk_eph: pre(r.pk_eph), ct_note: pre(r.ct_note),
  };
}

export function createHandler(ix, store) {
  return (req, res) => {
    const send = (code, body, extra = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ...extra });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': '*' });
      return res.end();
    }
    if (req.method !== 'GET') return send(405, { error: 'read-only' });
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname.replace(/\/$/, '');
    let m;
    try {
      if (p === '/health' || p === '/btc-pool/status') return send(200, ix.status());
      const st = ix.state;
      if (p === '/btc-pool/roots') {
        const from = st.tip === null ? 0 : st.tip + 1 - ANCHOR_WINDOW;
        return send(200, { height: st.tip, roots: store.rootsFrom(from).map((r) => ({ height: r.height, root: pre(r.root) })) });
      }
      if ((m = p.match(/^\/btc-pool\/root\/(\d+)$/))) {
        const b = store.block(Number(m[1]));
        if (!b) return send(404, { error: 'height not replayed' });
        return send(200, { height: b.height, root: pre(b.root), blockHash: b.hash, retained: st.roots.has(b.height) });
      }
      if ((m = p.match(/^\/btc-pool\/path\/(\d+)$/))) {
        if (st.pending) return send(503, { error: 'block in progress' }, { 'Retry-After': '1' });
        const i = Number(m[1]);
        if (i >= st.tree.size) return send(404, { error: 'no such leaf' });
        const { root, path } = st.tree.rootAndPath(i);
        return send(200, { leafIndex: i, leaf: x0(st.tree.leaf(i)), height: st.tip, root: x0(root), path: path.map(x0) });
      }
      if (p === '/btc-pool/notes') {
        const from = Math.max(0, Number(url.searchParams.get('from')) || 0);
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        const rows = store.notes(from, limit).map(noteRow);
        return send(200, { height: st.tip, from, notes: rows, next: rows.length ? rows[rows.length - 1].leafIndex + 1 : from });
      }
      if ((m = p.match(/^\/btc-pool\/nullifier\/(?:0x)?([0-9a-fA-F]{64})$/))) {
        const r = store.nullifier(m[1].toLowerCase());
        return send(200, r ? { nf: pre(r.nf), spent: true, height: r.height, txid: r.txid } : { nf: pre(m[1].toLowerCase()), spent: false, height: st.tip });
      }
      if ((m = p.match(/^\/btc-pool\/exit\/([0-9a-fA-F]{64})\/(\d+)$/))) {
        const r = store.exit(m[1].toLowerCase(), Number(m[2]));
        return send(200, r
          ? { exists: true, txid: r.txid, vout: r.vout, height: r.height, asset: pre(r.asset), Cx: pre(r.cx), Cy: pre(r.cy) }
          : { exists: false, height: st.tip });
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(500, { error: String(e?.message || e) });
    }
  };
}

// ── main ──
async function main() {
  const env = process.env;
  const network = env.BTC_POOL_NETWORK || 'signet';
  if (network !== 'signet' && network !== 'mainnet') throw new Error('BTC_POOL_NETWORK must be signet or mainnet');
  const startHeight = Number(env.BTC_POOL_START_HEIGHT);
  let esploraBases = env.BTC_POOL_ESPLORA;
  if (!esploraBases) {
    // Mainnet falls back to the relay's own esplora list (lib/config.js btcEsplora); config.js itself is not
    // imported because it demands relay env this service does not carry.
    esploraBases = network === 'signet'
      ? 'https://mempool.space/signet/api'
      : (env.BTC_ESPLORA || 'https://mempool.space/api,https://blockstream.info/api,https://mempool.emzy.de/api');
  }
  const confirmations = Number(env.BTC_POOL_CONFIRMATIONS || (network === 'signet' ? 1 : 3));
  const pollMs = Number(env.BTC_POOL_POLL_SECS || 30) * 1000;
  const log = (...a) => console.log(`[btc-pool ${network} ${new Date().toISOString()}]`, ...a);

  const store = openBtcPoolStore(env.BTC_POOL_DB || '/var/lib/tacit-btc-pool/btc-pool.db');
  const verifier = makeBtcPoolVerifier({ log: (...a) => console.error(...a) });
  const ix = createIndexer({ store, esplora: makeEsplora(esploraBases), verifier, network, startHeight, confirmations, log });
  log(`resuming at ${ix.state.tip ?? `(empty, start ${startHeight})`}; verifier ${verifier.enabled ? 'enabled' : `DISABLED: ${verifier.reason}`}`);

  createServer(await withRelayer(createHandler(ix, store), { ix, verifier, network, esploraBases, log })).listen(Number(env.PORT || 10000), () => log(`listening on ${env.PORT || 10000}`));

  for (;;) {
    try {
      await ix.syncOnce({ maxBlocks: 500 });
      ix.lastError = null;
    } catch (e) {
      ix.lastError = String(e?.message || e);
      if (e instanceof VerifierUnavailableError) console.error(`!!! btc-pool halted at ${ix.halted?.height} (${ix.halted?.txid}): spend verifier unavailable`);
      else log(`sync failed: ${ix.lastError}`);
    }
    await new Promise((r) => setTimeout(r, ix.state.tip !== null && ix.chainTip !== null && ix.state.tip < ix.chainTip - confirmations ? 1000 : pollMs));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

// ── relayer hook (lib/btc-pool-relayer.js): mounts /btc-pool/relay/* only when its keys are set ──
async function withRelayer(handler, ctx) {
  const { startBtcPoolRelayerFromEnv } = await import('./lib/btc-pool-relayer.js');
  const relayer = startBtcPoolRelayerFromEnv(ctx);
  return relayer ? relayer.wrap(handler) : handler;
}
