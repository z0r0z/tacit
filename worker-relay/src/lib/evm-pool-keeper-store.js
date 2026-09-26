// SQLite state for the EVM pool box keeper: the intents it watches, and the pool's leaves up to a confirmed
// block. A deposit hint is kept only while its box is live and cleared once the box reaches a terminal state.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export const TERMINAL = ['completed', 'closed-elsewhere', 'expired', 'reclaimed', 'failed'];

const enc = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

export function openKeeperStore(dbPath) {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS intents (
      box TEXT PRIMARY KEY, kind TEXT NOT NULL, intent TEXT NOT NULL, hint TEXT,
      status TEXT NOT NULL, reward TEXT NOT NULL, token TEXT NOT NULL, deadline INTEGER NOT NULL,
      created INTEGER NOT NULL, updated INTEGER NOT NULL, next_check INTEGER NOT NULL, checks INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, funded_at INTEGER, tx_hash TEXT, tx_sent_at INTEGER, note TEXT
    );
    CREATE INDEX IF NOT EXISTS intents_due ON intents(status, next_check);
    CREATE TABLE IF NOT EXISTS leaves (idx INTEGER PRIMARY KEY, leaf TEXT NOT NULL, block INTEGER NOT NULL);
  `);

  const st = {
    getMeta: db.prepare('SELECT v FROM meta WHERE k = ?'),
    setMeta: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    ins: db.prepare(`INSERT OR IGNORE INTO intents (box, kind, intent, hint, status, reward, token, deadline, created, updated, next_check)
                     VALUES (@box, @kind, @intent, @hint, 'pending', @reward, @token, @deadline, @now, @now, @now)`),
    get: db.prepare('SELECT * FROM intents WHERE box = ?'),
    due: db.prepare("SELECT * FROM intents WHERE status = 'pending' AND next_check <= ? ORDER BY next_check LIMIT ?"),
    pending: db.prepare("SELECT COUNT(*) AS n FROM intents WHERE status = 'pending'"),
    leafCount: db.prepare('SELECT COUNT(*) AS n FROM leaves'),
    leaves: db.prepare('SELECT leaf FROM leaves ORDER BY idx'),
    insLeaf: db.prepare('INSERT INTO leaves (idx, leaf, block) VALUES (?, ?, ?)'),
    clearLeaves: db.prepare('DELETE FROM leaves'),
  };

  const row = (r) => r && {
    ...r,
    intent: JSON.parse(r.intent),
    hint: r.hint ? JSON.parse(r.hint) : null,
  };

  return {
    db,
    getMeta: (k) => st.getMeta.get(k)?.v ?? null,
    setMeta: (k, v) => st.setMeta.run(k, String(v)),

    // Returns true when the box is new.
    addIntent({ box, kind, intent, hint = null, reward, token, deadline, now }) {
      const r = st.ins.run({ box: box.toLowerCase(), kind, intent: enc(intent), hint: hint ? enc(hint) : null, reward: String(reward), token: token.toLowerCase(), deadline: Number(deadline), now });
      return r.changes === 1;
    },
    get: (box) => row(st.get.get(box.toLowerCase())),
    due: (now, limit) => st.due.all(now, limit).map(row),
    pendingCount: () => st.pending.get().n,

    // Only the listed columns can change; a terminal status also drops the hint.
    update(box, fields) {
      const allowed = ['status', 'next_check', 'checks', 'attempts', 'funded_at', 'tx_hash', 'tx_sent_at', 'note', 'updated'];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      const sets = keys.map((k) => `${k} = @${k}`);
      if (TERMINAL.includes(fields.status)) sets.push('hint = NULL');
      if (!sets.length) return;
      db.prepare(`UPDATE intents SET ${sets.join(', ')} WHERE box = @box`).run({ ...Object.fromEntries(keys.map((k) => [k, fields[k] ?? null])), box: box.toLowerCase() });
    },

    leafCount: () => st.leafCount.get().n,
    leaves: () => st.leaves.all().map((r) => BigInt(r.leaf)),
    // Appends leaves (in index order, starting at the current count) and advances the synced block, atomically.
    appendLeaves: db.transaction((items, syncedBlock) => {
      let idx = st.leafCount.get().n;
      for (const { leaf, block } of items) st.insLeaf.run(idx++, leaf.toString(), Number(block));
      st.setMeta.run('synced_block', String(syncedBlock));
    }),
    resetLeaves: db.transaction(() => {
      st.clearLeaves.run();
      db.prepare("DELETE FROM meta WHERE k = 'synced_block'").run();
    }),
    close: () => db.close(),
  };
}
