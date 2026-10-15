// SQLite state for the EVM pool box keeper: the intents it watches, and the pool's leaves up to a confirmed
// block. A deposit hint is kept only while its box is live and cleared once the box reaches a terminal state.
// A receive box ({ npk, feeBps }) stays pending while watched: it is swept whenever it holds enough, and its deadline
// is when the watch lapses unless the box is registered again.

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
    -- Confirmed pool Transact and router Received events, as served by /events.
    CREATE TABLE IF NOT EXISTS events (block INTEGER NOT NULL, log_index INTEGER NOT NULL, ev TEXT NOT NULL, PRIMARY KEY (block, log_index));
  `);
  // A store synced before events were kept replays its leaves once so the events table covers them too.
  if (db.prepare("SELECT v FROM meta WHERE k = 'events_kept'").get() === undefined) {
    db.exec("DELETE FROM leaves; DELETE FROM events; DELETE FROM meta WHERE k = 'synced_block'; INSERT INTO meta (k, v) VALUES ('events_kept', '1')");
  }

  const st = {
    getMeta: db.prepare('SELECT v FROM meta WHERE k = ?'),
    setMeta: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
    ins: db.prepare(`INSERT OR IGNORE INTO intents (box, kind, intent, hint, status, reward, token, deadline, created, updated, next_check)
                     VALUES (@box, @kind, @intent, @hint, 'pending', @reward, @token, @deadline, @now, @now, @now)`),
    get: db.prepare('SELECT * FROM intents WHERE box = ?'),
    due: db.prepare("SELECT * FROM intents WHERE status = 'pending' AND kind != 'receive' AND next_check <= ? ORDER BY next_check LIMIT ?"),
    dueReceive: db.prepare("SELECT * FROM intents WHERE status = 'pending' AND kind = 'receive' AND next_check <= ? ORDER BY next_check LIMIT ?"),
    pending: db.prepare("SELECT COUNT(*) AS n FROM intents WHERE status = 'pending' AND kind != 'receive'"),
    receiving: db.prepare("SELECT COUNT(*) AS n FROM intents WHERE status = 'pending' AND kind = 'receive'"),
    lapsed: db.prepare("SELECT box FROM intents WHERE status = 'pending' AND kind = 'receive' AND deadline < ? AND COALESCE(note, '') != 'swept' ORDER BY deadline LIMIT 1"),
    unfunded: db.prepare("SELECT box FROM intents WHERE status = 'pending' AND kind = 'receive' AND funded_at IS NULL AND COALESCE(note, '') != 'swept' ORDER BY created LIMIT 1"),
    unfundedPending: db.prepare("SELECT box FROM intents WHERE status = 'pending' AND kind != 'receive' AND funded_at IS NULL ORDER BY created LIMIT 1"),
    leafCount: db.prepare('SELECT COUNT(*) AS n FROM leaves'),
    leaves: db.prepare('SELECT leaf FROM leaves ORDER BY idx'),
    insLeaf: db.prepare('INSERT INTO leaves (idx, leaf, block) VALUES (?, ?, ?)'),
    clearLeaves: db.prepare('DELETE FROM leaves'),
    insEvent: db.prepare('INSERT OR REPLACE INTO events (block, log_index, ev) VALUES (?, ?, ?)'),
    eventsFrom: db.prepare('SELECT block, ev FROM events WHERE block >= ? ORDER BY block, log_index LIMIT ?'),
    eventsBetween: db.prepare('SELECT block, log_index, ev FROM events WHERE block >= ? AND block <= ? ORDER BY block, log_index'),
    updEvent: db.prepare('UPDATE events SET ev = ? WHERE block = ? AND log_index = ?'),
    clearEvents: db.prepare('DELETE FROM events'),
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
    // Deposit and wrap boxes, and receive boxes, are due on separate quotas so neither can starve the other.
    due: (now, limit) => st.due.all(now, limit).map(row),
    dueReceive: (now, limit) => st.dueReceive.all(now, limit).map(row),
    // Boxes awaiting completion; receive boxes, which are watched indefinitely, are counted apart.
    pendingCount: () => st.pending.get().n,
    receiveCount: () => st.receiving.get().n,
    // Makes room for a new receive box: drops the one whose watch lapsed longest ago and that was never swept, else
    // the oldest one that has never held funds (so registrations that fill the table without paying cannot lock
    // out new users); false if there is none.
    evictLapsedReceive(now) {
      const r = st.lapsed.get(now) ?? st.unfunded.get();
      if (!r) return false;
      db.prepare('DELETE FROM intents WHERE box = ?').run(r.box);
      return true;
    },

    // At capacity, drops the oldest deposit or wrap intent whose box has never held funds; false if there is none.
    evictUnfundedPending() {
      const r = st.unfundedPending.get();
      if (!r) return false;
      db.prepare('DELETE FROM intents WHERE box = ?').run(r.box);
      return true;
    },

    // Only the listed columns can change; a terminal status also drops the hint.
    update(box, fields) {
      const allowed = ['status', 'next_check', 'checks', 'attempts', 'funded_at', 'tx_hash', 'tx_sent_at', 'note', 'updated', 'deadline'];
      const keys = Object.keys(fields).filter((k) => allowed.includes(k));
      const sets = keys.map((k) => `${k} = @${k}`);
      if (TERMINAL.includes(fields.status)) sets.push('hint = NULL');
      if (!sets.length) return;
      db.prepare(`UPDATE intents SET ${sets.join(', ')} WHERE box = @box`).run({ ...Object.fromEntries(keys.map((k) => [k, fields[k] ?? null])), box: box.toLowerCase() });
    },

    leafCount: () => st.leafCount.get().n,
    leaves: () => st.leaves.all().map((r) => BigInt(r.leaf)),
    // Appends leaves (in index order, starting at the current count) and their blocks' events, and advances the
    // synced block, atomically. events: [{ block, logIndex, ev (JSON-ready) }].
    appendLeaves: db.transaction((items, syncedBlock, events = []) => {
      let idx = st.leafCount.get().n;
      for (const { leaf, block } of items) st.insLeaf.run(idx++, leaf.toString(), Number(block));
      for (const e of events) st.insEvent.run(Number(e.block), Number(e.logIndex), JSON.stringify(e.ev));
      st.setMeta.run('synced_block', String(syncedBlock));
    }),
    // Up to `limit` stored events from `fromBlock` on, in chain order. → [{ block, ev }]
    eventsFrom: (fromBlock, limit) => st.eventsFrom.all(Number(fromBlock), limit).map((r) => ({ block: r.block, ev: JSON.parse(r.ev) })),
    syncedBlock: () => { const v = st.getMeta.get('synced_block')?.v; return v === undefined ? null : Number(v); },
    // Stored events in blocks a..b, in chain order. → [{ block, logIndex, ev }]
    eventsBetween: (a, b) => st.eventsBetween.all(Number(a), Number(b)).map((r) => ({ block: r.block, logIndex: r.log_index, ev: JSON.parse(r.ev) })),
    // Rewrites stored events in place (same block and log index) and, with a key, moves a progress mark, atomically.
    updateEvents: db.transaction((rows, key = null, value = null) => {
      for (const r of rows) st.updEvent.run(JSON.stringify(r.ev), Number(r.block), Number(r.logIndex));
      if (key) st.setMeta.run(key, String(value));
    }),
    resetLeaves: db.transaction(() => {
      st.clearLeaves.run();
      st.clearEvents.run();
      db.prepare("DELETE FROM meta WHERE k IN ('synced_block', 'facts_block', 'facts_logs_block')").run();
    }),
    close: () => db.close(),
  };
}
