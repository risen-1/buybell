import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS groups (
      chat_id INTEGER PRIMARY KEY,
      title TEXT,
      network TEXT, token TEXT, symbol TEXT, token_name TEXT,
      pool TEXT, pool_name TEXT, quote_symbol TEXT,
      min_usd REAL DEFAULT 0, emoji TEXT DEFAULT '🟢', emoji_step REAL DEFAULT 10,
      media_id TEXT, media_type TEXT,
      sells INTEGER DEFAULT 0, whale_usd REAL DEFAULT 0,
      pro_until INTEGER DEFAULT 0,
      paused INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
      added_by INTEGER, created INTEGER
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT, name TEXT, ref_by INTEGER, payout TEXT, created INTEGER
    );
    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, text TEXT, url TEXT, days INTEGER, usd REAL,
      status TEXT, starts INTEGER, ends INTEGER, impressions INTEGER DEFAULT 0, created INTEGER
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, ref TEXT, user_id INTEGER, usd REAL,
      net TEXT, amount TEXT, nano TEXT, nonce TEXT, status TEXT, tx TEXT,
      created INTEGER, paid_at INTEGER, ref_by INTEGER, commission REAL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS states (key TEXT PRIMARY KEY, data TEXT, updated INTEGER);
    CREATE TABLE IF NOT EXISTS counters (day TEXT, name TEXT, n INTEGER, PRIMARY KEY (day, name));
  `);

  const q = sql => db.prepare(sql);
  const day = () => new Date().toISOString().slice(0, 10);

  return {
    raw: db,
    all: (sql, ...a) => q(sql).all(...a),
    get: (sql, ...a) => q(sql).get(...a),
    run: (sql, ...a) => q(sql).run(...a),

    group: id => q('SELECT * FROM groups WHERE chat_id = ?').get(id),
    upsertGroup(chatId, fields) {
      const g = q('SELECT chat_id FROM groups WHERE chat_id = ?').get(chatId);
      if (!g) q('INSERT INTO groups (chat_id, created) VALUES (?, ?)').run(chatId, Date.now());
      const keys = Object.keys(fields);
      if (keys.length) q(`UPDATE groups SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE chat_id = ?`).run(...keys.map(k => fields[k]), chatId);
      return q('SELECT * FROM groups WHERE chat_id = ?').get(chatId);
    },
    trackedGroups: () => q("SELECT * FROM groups WHERE active = 1 AND paused = 0 AND pool IS NOT NULL").all(),

    user(u) {
      q('INSERT INTO users (id, username, name, created) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET username = excluded.username, name = excluded.name')
        .run(u.id, u.username || '', [u.first_name, u.last_name].filter(Boolean).join(' '), Date.now());
      return q('SELECT * FROM users WHERE id = ?').get(u.id);
    },

    getState(key) {
      const r = q('SELECT data, updated FROM states WHERE key = ?').get(key);
      return r && Date.now() - r.updated < 30 * 60000 ? JSON.parse(r.data) : null;
    },
    setState(key, data) {
      if (data == null) q('DELETE FROM states WHERE key = ?').run(key);
      else q('INSERT OR REPLACE INTO states (key, data, updated) VALUES (?, ?, ?)').run(key, JSON.stringify(data), Date.now());
    },

    count(name, n = 1) {
      q('INSERT INTO counters (day, name, n) VALUES (?, ?, ?) ON CONFLICT(day, name) DO UPDATE SET n = n + excluded.n').run(day(), name, n);
    },
    sumCounter(name, days) {
      const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
      return q('SELECT COALESCE(SUM(n), 0) AS n FROM counters WHERE name = ? AND day >= ?').get(name, since).n;
    }
  };
}
