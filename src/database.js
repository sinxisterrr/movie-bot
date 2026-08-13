import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filename) {
  const path = filename === ':memory:' ? filename : resolve(filename);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS guild_config (
      guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, timezone TEXT NOT NULL,
      event_weekday INTEGER NOT NULL, event_time TEXT NOT NULL, location TEXT NOT NULL,
      role_id TEXT, paused INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cycles (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, event_at TEXT NOT NULL,
      phase TEXT NOT NULL, ballot_message_id TEXT, scheduled_event_id TEXT,
      winner_nomination_id INTEGER, UNIQUE(guild_id, event_at)
    );
    CREATE TABLE IF NOT EXISTS nominations (
      id INTEGER PRIMARY KEY, cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
      title TEXT NOT NULL COLLATE NOCASE, user_id TEXT NOT NULL,
      UNIQUE(cycle_id, title), UNIQUE(cycle_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS votes (
      cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL, nomination_id INTEGER NOT NULL REFERENCES nominations(id) ON DELETE CASCADE,
      PRIMARY KEY(cycle_id, user_id)
    );
  `);
  const configColumns = db.prepare('PRAGMA table_info(guild_config)').all().map((column) => column.name);
  if (!configColumns.includes('role_message_id')) {
    db.exec('ALTER TABLE guild_config ADD COLUMN role_message_id TEXT');
  }
  return db;
}
