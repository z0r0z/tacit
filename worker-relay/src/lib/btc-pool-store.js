// SQLite persistence for the Bitcoin shielded-pool indexer. Every row carries the height of the block
// that created it, so a block commits in one transaction and a rollback is a delete by height.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { bytesToHex, hexToBytes } from '../../../worker/src/btc-shielded-pool.js';

const h = (b) => bytesToHex(b);
const SCHEMA = '3';
const TABLES = ['blocks', 'leaves', 'nullifiers', 'exits', 'envelopes'];
// Relayer state has its own version; replay rescans and rollbacks leave it alone.
const RELAY_SCHEMA = '1';
const RELAY_TABLES = ['relay_payloads', 'relay_carriers'];
const RELAY_TERMINAL = "('confirmed', 'dropped', 'rejected', 'replayed-elsewhere', 'empty', 'cancelled')";

export function openBtcPoolStore(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
  // A database written under another envelope layout replays from scratch.
  if ((db.prepare("SELECT v FROM meta WHERE k = 'schema'").get()?.v ?? null) !== SCHEMA) {
    db.transaction(() => {
      for (const t of TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
      db.prepare("INSERT INTO meta (k, v) VALUES ('schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(SCHEMA);
    })();
  }
  if ((db.prepare("SELECT v FROM meta WHERE k = 'relay_schema'").get()?.v ?? null) !== RELAY_SCHEMA) {
    db.transaction(() => {
      for (const t of RELAY_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
      db.prepare("INSERT INTO meta (k, v) VALUES ('relay_schema', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(RELAY_SCHEMA);
    })();
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS relay_payloads (id TEXT PRIMARY KEY, state TEXT NOT NULL, updated INTEGER NOT NULL, rec TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS relay_carriers (id TEXT PRIMARY KEY, state TEXT NOT NULL, updated INTEGER NOT NULL, rec TEXT NOT NULL);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS blocks (height INTEGER PRIMARY KEY, hash TEXT NOT NULL, root TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leaves (
      idx INTEGER PRIMARY KEY, height INTEGER NOT NULL, txid TEXT NOT NULL, leaf TEXT NOT NULL,
      asset TEXT NOT NULL, pk_eph TEXT NOT NULL, ct_note TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS leaves_height ON leaves(height);
    CREATE TABLE IF NOT EXISTS nullifiers (nf TEXT PRIMARY KEY, height INTEGER NOT NULL, txid TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS nullifiers_height ON nullifiers(height);
    CREATE TABLE IF NOT EXISTS exits (
      txid TEXT NOT NULL, vout INTEGER NOT NULL, height INTEGER NOT NULL,
      asset TEXT NOT NULL, cx TEXT NOT NULL, cy TEXT NOT NULL, PRIMARY KEY (txid, vout)
    );
    CREATE INDEX IF NOT EXISTS exits_height ON exits(height);
    CREATE TABLE IF NOT EXISTS envelopes (
      height INTEGER NOT NULL, tx_index INTEGER NOT NULL, vin INTEGER NOT NULL, txid TEXT NOT NULL,
      opcode INTEGER NOT NULL, accepted INTEGER NOT NULL, reason TEXT, PRIMARY KEY (height, tx_index, vin)
    );
  `);

  const st = {
    getMeta: db.prepare('SELECT v FROM meta WHERE k = ?'),
    setMeta: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    tip: db.prepare('SELECT height, hash, root FROM blocks ORDER BY height DESC LIMIT 1'),
    block: db.prepare('SELECT height, hash, root FROM blocks WHERE height = ?'),
    insBlock: db.prepare('INSERT INTO blocks (height, hash, root) VALUES (?, ?, ?)'),
    insLeaf: db.prepare(`INSERT INTO leaves (idx, height, txid, leaf, asset, pk_eph, ct_note)
                         VALUES (@idx, @height, @txid, @leaf, @asset, @pk_eph, @ct_note)`),
    insNf: db.prepare('INSERT INTO nullifiers (nf, height, txid) VALUES (?, ?, ?)'),
    insExit: db.prepare('INSERT INTO exits (txid, vout, height, asset, cx, cy) VALUES (?, ?, ?, ?, ?, ?)'),
    insEnv: db.prepare('INSERT INTO envelopes (height, tx_index, vin, txid, opcode, accepted, reason) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    notes: db.prepare('SELECT * FROM leaves WHERE idx >= ? ORDER BY idx LIMIT ?'),
    nf: db.prepare('SELECT nf, height, txid FROM nullifiers WHERE nf = ?'),
    exit: db.prepare('SELECT * FROM exits WHERE txid = ? AND vout = ?'),
    rootsFrom: db.prepare('SELECT height, root FROM blocks WHERE height >= ? ORDER BY height'),
    allLeaves: db.prepare('SELECT idx, height, leaf FROM leaves ORDER BY idx'),
    allNf: db.prepare('SELECT nf, height, txid FROM nullifiers'),
    allExits: db.prepare('SELECT * FROM exits'),
  };
  const delFrom = TABLES.map((t) => db.prepare(`DELETE FROM ${t} WHERE height >= ?`));

  const commitBlock = db.transaction((delta, hash, envelopes) => {
    st.insBlock.run(delta.height, hash, h(delta.root));
    for (const l of delta.leaves) {
      st.insLeaf.run({
        idx: l.leafIndex, height: l.height, txid: l.txid, leaf: h(l.leaf), asset: h(l.asset), pk_eph: h(l.pkEph), ct_note: h(l.ctNote),
      });
    }
    for (const n of delta.nullifiers) st.insNf.run(n.nf, n.height, n.txid);
    for (const x of delta.exits) st.insExit.run(x.txid, x.vout, x.height, h(x.asset), h(x.cx), h(x.cy));
    for (const e of envelopes) st.insEnv.run(delta.height, e.txIndex, e.vin, e.txid, e.opcode, e.accepted ? 1 : 0, e.reason ?? null);
  });
  const rl = {
    putP: db.prepare('INSERT INTO relay_payloads (id, state, updated, rec) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated = excluded.updated, rec = excluded.rec'),
    putC: db.prepare('INSERT INTO relay_carriers (id, state, updated, rec) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated = excluded.updated, rec = excluded.rec'),
    allP: db.prepare('SELECT rec FROM relay_payloads ORDER BY updated'),
    allC: db.prepare('SELECT rec FROM relay_carriers ORDER BY updated'),
    pruneP: db.prepare(`DELETE FROM relay_payloads WHERE updated < ? AND state IN ${RELAY_TERMINAL}`),
    pruneC: db.prepare(`DELETE FROM relay_carriers WHERE updated < ? AND state IN ${RELAY_TERMINAL}`),
  };
  const relaySave = db.transaction((ps, cs) => {
    for (const r of ps) rl.putP.run(r.id, r.state, r.updatedAt ?? Date.now(), JSON.stringify(r));
    for (const r of cs) rl.putC.run(r.id, r.state, r.updatedAt ?? Date.now(), JSON.stringify(r));
  });
  const relay = {
    save: (ps, cs) => relaySave(ps, cs),
    load: () => ({ payloads: rl.allP.all().map((r) => JSON.parse(r.rec)), carriers: rl.allC.all().map((r) => JSON.parse(r.rec)) }),
    prune: (before) => { rl.pruneP.run(before); rl.pruneC.run(before); },
  };

  const rollbackFrom = db.transaction((height) => { for (const d of delFrom) d.run(height); });
  const wipe = db.transaction(() => { for (const d of delFrom) d.run(-1); });

  return {
    db,
    meta: (k) => st.getMeta.get(k)?.v ?? null,
    setMeta: (k, v) => st.setMeta.run(k, String(v)),
    tip: () => st.tip.get() || null,
    block: (height) => st.block.get(height) || null,
    commitBlock,
    rollbackFrom,
    wipe,
    notes: (from, limit) => st.notes.all(from, limit),
    nullifier: (nf) => st.nf.get(nf) || null,
    exit: (txid, vout) => st.exit.get(txid, vout) || null,
    rootsFrom: (height) => st.rootsFrom.all(height),
    // Rows for BtcPoolState.restore.
    snapshot() {
      const t = st.tip.get();
      if (!t) return { tip: null, leaves: [], nullifiers: [], exits: [], roots: [] };
      return {
        tip: t.height,
        leaves: st.allLeaves.all().map((r) => ({ leafIndex: r.idx, height: r.height, leaf: hexToBytes(r.leaf) })),
        nullifiers: st.allNf.all(),
        exits: st.allExits.all().map((r) => ({ txid: r.txid, vout: r.vout, height: r.height, asset: hexToBytes(r.asset), cx: hexToBytes(r.cx), cy: hexToBytes(r.cy) })),
        roots: st.rootsFrom.all(t.height - 288 - 144).map((r) => [r.height, hexToBytes(r.root)]),
      };
    },
    relay,
    close: () => db.close(),
  };
}
