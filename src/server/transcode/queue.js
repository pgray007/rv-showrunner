'use strict';
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const cfg = require('../config');
const ffmpeg = require('./ffmpeg');
const profiles = require('./profiles');
const metadata = require('../metadata/exporter');

const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(100);

let maxConcurrent = 1;
let running = 0;
let hwAccelMode = 'none';
const activeJobs = new Map();

function onLog(jobId, line) {
  const ts = Math.floor(Date.now() / 1000);
  db.get().prepare('INSERT INTO job_logs (job_id, ts, line) VALUES (?, ?, ?)').run(jobId, ts, line);
  logEmitter.emit(`log:${jobId}`, { ts, line });
}

function setStatus(jobId, status, extra = {}) {
  const fields = ['status=?', 'updated_at=unixepoch()'];
  const values = [status];
  if ('error_log' in extra) { fields.push('error_log=?'); values.push(extra.error_log); }
  if ('output_path' in extra) { fields.push('output_path=?'); values.push(extra.output_path); }
  if ('ffmpeg_cmd' in extra) { fields.push('ffmpeg_cmd=?'); values.push(extra.ffmpeg_cmd); }
  if (status === 'complete') { fields.push('completed_at=unixepoch()'); }
  values.push(jobId);
  db.get().prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id=?`).run(...values);
}

async function processJob(job) {
  const config = cfg.load();
  const stagingDir = path.join(config.cacheRoot, 'jobs', job.id);

  onLog(job.id, `[queue] Starting job ${job.id}: ${job.title}`);
  setStatus(job.id, 'transcoding');

  try {
    const controller = new AbortController();
    activeJobs.set(job.id, controller);
    const profile = profiles.getProfile(job.profile);
    const stagingFile = path.join(stagingDir, `output.tmp.${profile.container}`);

    const cmd = await ffmpeg.run({
      inputPath: job.source_path,
      outputPath: stagingFile,
      profile,
      hwAccel: hwAccelMode,
      ffmpegPath: config.ffmpegPath,
      onLog: (line) => onLog(job.id, line),
      signal: controller.signal,
    });

    // Build final output path
    const safeName = `${job.title}${job.year ? ` (${job.year})` : ''}`;
    const finalDir = path.join(config.outputRoot, 'Movies', safeName);
    const finalFile = path.join(finalDir, `${safeName}.${profile.container}`);

    fs.mkdirSync(finalDir, { recursive: true });
    fs.renameSync(stagingFile, finalFile);

    onLog(job.id, `[queue] Moved to ${finalFile}`);

    // Export metadata
    await metadata.exportMovie(job, finalDir, config);

    setStatus(job.id, 'complete', { output_path: finalFile, ffmpeg_cmd: cmd });
    onLog(job.id, '[queue] Complete');
  } catch (err) {
    onLog(job.id, `[queue] Error: ${err.message}`);
    setStatus(job.id, err.cancelled ? 'cancelled' : 'failed', { error_log: err.message, ffmpeg_cmd: err.cmd || null });
  } finally {
    activeJobs.delete(job.id);
    // Clean up staging dir
    try { fs.rmSync(path.join(config.cacheRoot, 'jobs', job.id), { recursive: true, force: true }); } catch {}
  }
}

async function pump() {
  while (running < maxConcurrent) {
    const job = db.get()
      .prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at ASC LIMIT 1")
      .get();
    if (!job) break;
    running++;
    processJob(job).finally(() => {
      running--;
      pump();
    });
  }
}

async function probeAndStart() {
  const config = cfg.load();
  const result = await ffmpeg.probeHwAccel(config.hwAccel, config.ffmpegPath);
  if (result.available) {
    hwAccelMode = result.mode;
    console.info(`[queue] Hardware accel: ${hwAccelMode}`);
  } else {
    hwAccelMode = 'none';
    console.warn(`[queue] HW accel unavailable (${result.reason}), using software`);
  }
  pump();
}

function start(max) {
  maxConcurrent = max || 1;
  probeAndStart().catch((err) => console.error('[queue] startup error:', err));
}

function enqueue() {
  pump();
}

function cancel(jobId) {
  const controller = activeJobs.get(jobId);
  if (!controller) return false;
  controller.abort();
  return true;
}

function getLogEmitter() {
  return logEmitter;
}

function getHwAccelMode() {
  return hwAccelMode;
}

module.exports = { start, enqueue, cancel, getLogEmitter, getHwAccelMode };
