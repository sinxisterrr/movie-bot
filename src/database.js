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
    CREATE TABLE IF NOT EXISTS manager_config (
      guild_id TEXT PRIMARY KEY, timezone TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
      creator_id TEXT NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
      role_id TEXT, run_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL, executed_at TEXT, message_id TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS scheduled_jobs_due
      ON scheduled_jobs(status, run_at);
    CREATE TABLE IF NOT EXISTS scheduled_job_files (
      id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
      filename TEXT NOT NULL, storage_path TEXT NOT NULL, content_type TEXT,
      size INTEGER NOT NULL, description TEXT
    );
    CREATE TABLE IF NOT EXISTS marvin_responses (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, text TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'pet'
    );
    CREATE TABLE IF NOT EXISTS passport_events (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, role_id TEXT NOT NULL,
      name TEXT NOT NULL, stamp_path TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL,
      UNIQUE(guild_id, role_id)
    );
    CREATE TABLE IF NOT EXISTS passport_stamps (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      event_id INTEGER NOT NULL REFERENCES passport_events(id), awarded_at TEXT NOT NULL,
      UNIQUE(guild_id, user_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS passport_stamps_member
      ON passport_stamps(guild_id, user_id, awarded_at, id);
    CREATE TABLE IF NOT EXISTS passport_milestones (
      guild_id TEXT NOT NULL, user_id TEXT NOT NULL, threshold INTEGER NOT NULL,
      reached_at TEXT NOT NULL, PRIMARY KEY(guild_id, user_id, threshold)
    );
    CREATE TABLE IF NOT EXISTS passport_pending_notices (
      id INTEGER PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
      message TEXT NOT NULL, created_at TEXT NOT NULL
    );
  `);
  const configColumns = db.prepare('PRAGMA table_info(guild_config)').all().map((column) => column.name);
  if (!configColumns.includes('role_message_id')) {
    db.exec('ALTER TABLE guild_config ADD COLUMN role_message_id TEXT');
  }
  const responseColumns = db.prepare('PRAGMA table_info(marvin_responses)').all().map((column) => column.name);
  if (!responseColumns.includes('kind')) {
    db.exec("ALTER TABLE marvin_responses ADD COLUMN kind TEXT NOT NULL DEFAULT 'pet'");
  }
  migrateMultipleNominations(db);
  return db;
}

function migrateMultipleNominations(db) {
  const hasPerUserUniqueIndex = db.prepare("PRAGMA index_list('nominations')").all().some((index) => {
    if (!index.unique) return false;
    const columns = db.prepare(`PRAGMA index_info('${index.name.replaceAll("'", "''")}')`).all().map((column) => column.name);
    return columns.length === 2 && columns[0] === 'cycle_id' && columns[1] === 'user_id';
  });
  if (!hasPerUserUniqueIndex) return;

  db.exec(`
    PRAGMA foreign_keys = OFF;
    BEGIN;
    CREATE TABLE nominations_new (
      id INTEGER PRIMARY KEY, cycle_id INTEGER NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
      title TEXT NOT NULL COLLATE NOCASE, user_id TEXT NOT NULL,
      UNIQUE(cycle_id, title)
    );
    INSERT INTO nominations_new (id, cycle_id, title, user_id)
      SELECT id, cycle_id, title, user_id FROM nominations;
    DROP TABLE nominations;
    ALTER TABLE nominations_new RENAME TO nominations;
    COMMIT;
    PRAGMA foreign_keys = ON;
  `);
}
