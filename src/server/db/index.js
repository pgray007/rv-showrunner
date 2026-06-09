'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  jellyfin_id     TEXT NOT NULL UNIQUE,
  source_type     TEXT NOT NULL DEFAULT 'jellyfin',
  source_item_id  TEXT,
  title           TEXT NOT NULL,
  year            INTEGER,
  source_path     TEXT NOT NULL,
  output_path     TEXT,
  profile         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  ffmpeg_cmd      TEXT,
  source_mtime    INTEGER,
  source_size     INTEGER,
  duration_ms     INTEGER,
  progress_ms     INTEGER,
  progress_pct    REAL,
  started_at      INTEGER,
  eta_seconds     INTEGER,
  transcode_info  TEXT,
  error_log       TEXT,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at    INTEGER
);

CREATE TABLE IF NOT EXISTS job_logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id  TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ts      INTEGER NOT NULL DEFAULT (unixepoch()),
  line    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_jellyfin   ON jobs(jellyfin_id);
CREATE INDEX IF NOT EXISTS idx_job_logs_job_id ON job_logs(job_id);
`;

const MIGRATIONS = [
  ['duration_ms', 'ALTER TABLE jobs ADD COLUMN duration_ms INTEGER'],
  ['progress_ms', 'ALTER TABLE jobs ADD COLUMN progress_ms INTEGER'],
  ['progress_pct', 'ALTER TABLE jobs ADD COLUMN progress_pct REAL'],
  ['started_at', 'ALTER TABLE jobs ADD COLUMN started_at INTEGER'],
  ['eta_seconds', 'ALTER TABLE jobs ADD COLUMN eta_seconds INTEGER'],
  ['transcode_info', 'ALTER TABLE jobs ADD COLUMN transcode_info TEXT'],
  ['source_type', "ALTER TABLE jobs ADD COLUMN source_type TEXT NOT NULL DEFAULT 'jellyfin'"],
  ['source_item_id', 'ALTER TABLE jobs ADD COLUMN source_item_id TEXT'],
];

function init(configRoot) {
  const dbPath = path.join(configRoot, 'rv-showrunner.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate();
  return db;
}

function migrate() {
  const columns = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((row) => row.name));
  for (const [column, sql] of MIGRATIONS) {
    if (!columns.has(column)) db.exec(sql);
  }
  db.exec("UPDATE jobs SET source_type='jellyfin' WHERE source_type IS NULL OR source_type=''");
  db.exec('UPDATE jobs SET source_item_id=jellyfin_id WHERE source_item_id IS NULL');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_item ON jobs(source_type, source_item_id)');
}

function get() {
  if (!db) throw new Error('DB not initialized');
  return db;
}

module.exports = { init, get };
