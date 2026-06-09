'use strict';
const crypto = require('crypto');
const fs = require('fs');
const db = require('../db');
const cfg = require('../config');
const mediaSource = require('../media/source');
const queue = require('../transcode/queue');
const logger = require('../logger');

let timer = null;
let running = false;

async function scan() {
  if (running) {
    logger.warn('scanner', 'Previous scan still running; skipping');
    return { ok: false, skipped: true, reason: 'scan already running' };
  }

  running = true;
  try {
    return await scanOnce();
  } finally {
    running = false;
  }
}

async function scanOnce() {
  const config = cfg.load();
  const source = mediaSource.getActive(config);
  logger.info('scanner', `Running ${source.label} tag scan`);

  let tagged;
  try {
    tagged = await source.client.getTaggedItems();
  } catch (err) {
    logger.error('scanner', 'Failed to fetch tagged items', err.message);
    return { ok: false, error: err.message, enqueued: 0, tagged: 0, deleted: 0 };
  }

  const taggedIds = new Set(tagged.map((i) => sourceItemId(i)));
  let enqueued = 0;
  let deleted = 0;

  // Upsert newly tagged items
  for (const item of tagged) {
    if (!item.sourcePath) {
      logger.warn('scanner', `No source path for "${item.title}"; check ${source.label} media path mapping`);
      continue;
    }

    const itemId = sourceItemId(item);
    const existing = db.get()
      .prepare('SELECT id, status FROM jobs WHERE source_type=? AND source_item_id=?')
      .get(source.type, itemId);

    if (!existing) {
      let sourceMtime = null;
      let sourceSize = null;
      try {
        const stat = fs.statSync(item.sourcePath);
        sourceMtime = Math.floor(stat.mtimeMs / 1000);
        sourceSize = stat.size;
      } catch {}

      const jobId = crypto.randomUUID();
      const legacyId = source.type === 'jellyfin' ? itemId : `${source.type}:${itemId}`;
      db.get().prepare(`
        INSERT INTO jobs (id, jellyfin_id, source_type, source_item_id, title, year, source_path, profile, status, source_mtime, source_size)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
      `).run(jobId, legacyId, source.type, itemId, item.title, item.year || null, item.sourcePath, config.transcodeProfile, sourceMtime, sourceSize);
      enqueued++;
    } else if (existing.status === 'deleted') {
      // Re-tagged after deletion — reset to queued
      db.get().prepare("UPDATE jobs SET status='queued', updated_at=unixepoch() WHERE id=?").run(existing.id);
      enqueued++;
    }
  }

  // Handle items that lost their tag
  const tracked = db.get()
    .prepare("SELECT id, jellyfin_id, source_type, source_item_id, output_path FROM jobs WHERE source_type=? AND status NOT IN ('failed','skipped','deleted','cancelled')")
    .all(source.type);

  for (const row of tracked) {
    if (!taggedIds.has(row.source_item_id || row.jellyfin_id)) {
      if (config.unsyncBehavior === 'delete' && row.output_path) {
        try {
          const dir = require('path').dirname(row.output_path);
          fs.rmSync(dir, { recursive: true, force: true });
          logger.info('scanner', `Deleted ${dir} because tag was removed`);
        } catch (err) {
          logger.warn('scanner', `Could not delete ${row.output_path}`, err.message);
        }
      }
      db.get().prepare("UPDATE jobs SET status='deleted', updated_at=unixepoch() WHERE id=?").run(row.id);
      deleted++;
    }
  }

  if (enqueued > 0) {
    logger.info('scanner', `Enqueued ${enqueued} new job(s)`);
    queue.enqueue();
  } else {
    logger.info('scanner', 'No new items');
  }
  return { ok: true, enqueued, tagged: tagged.length, deleted };
}

function sourceItemId(item) {
  return String(item.sourceItemId || item.id || item.jellyfinId);
}

function start(intervalMinutes) {
  const ms = (intervalMinutes || 10) * 60 * 1000;
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    scan().catch((err) => logger.error('scanner', 'Unexpected scan error', err));
  }, ms);
  logger.info('scanner', `Polling every ${intervalMinutes} minute(s)`);
}

function runNow() {
  return scan().catch((err) => {
    logger.error('scanner', 'Unexpected scan error', err);
    return { ok: false, error: err.message, enqueued: 0, tagged: 0, deleted: 0 };
  });
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runNow };
