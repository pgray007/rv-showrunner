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
const logger = require('../logger');

const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(100);
const DURATION_PROBE_WAIT_MS = 3000;

let maxConcurrent = 1;
let running = 0;
let hwAccelMode = 'none';
let hwDevice = null;
let reloadPending = false;
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
  if ('duration_ms' in extra) { fields.push('duration_ms=?'); values.push(extra.duration_ms); }
  if ('progress_ms' in extra) { fields.push('progress_ms=?'); values.push(extra.progress_ms); }
  if ('progress_pct' in extra) { fields.push('progress_pct=?'); values.push(extra.progress_pct); }
  if ('eta_seconds' in extra) { fields.push('eta_seconds=?'); values.push(extra.eta_seconds); }
  if ('transcode_info' in extra) { fields.push('transcode_info=?'); values.push(extra.transcode_info); }
  if (status === 'transcoding') { fields.push('started_at=unixepoch()'); }
  if (status === 'complete') {
    fields.push('completed_at=unixepoch()', 'progress_pct=100', 'eta_seconds=0');
  }
  values.push(jobId);
  db.get().prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id=?`).run(...values);
}

function setDurationIfTranscoding(jobId, durationMs) {
  db.get().prepare(`
    UPDATE jobs
    SET duration_ms=?, updated_at=unixepoch()
    WHERE id=? AND status='transcoding'
  `).run(durationMs, jobId);
}

async function processJob(job) {
  const config = cfg.load();
  const stagingDir = path.join(config.cacheRoot, 'jobs', job.id);

  onLog(job.id, `[queue] Starting job ${job.id}: ${job.title}`);
  logger.info('queue', `Starting "${job.title}"`, { jobId: job.id, profile: job.profile });
  setStatus(job.id, 'transcoding');

  try {
    const controller = new AbortController();
    activeJobs.set(job.id, controller);
    const profile = profiles.getProfile(job.profile);
    const stagingFile = path.join(stagingDir, `output.tmp.${profile.container}`);
    let durationMs = job.duration_ms || null;
    if (durationMs) {
      setStatus(job.id, 'transcoding', { duration_ms: durationMs, progress_ms: 0, progress_pct: 0, eta_seconds: null });
    }
    const durationPromise = durationMs ? Promise.resolve(durationMs) : getDurationMs(job, config.ffmpegPath);
    if (!durationMs) {
      durationMs = await withTimeout(durationPromise, DURATION_PROBE_WAIT_MS, null);
      if (durationMs) {
        setStatus(job.id, 'transcoding', { duration_ms: durationMs, progress_ms: 0, progress_pct: 0, eta_seconds: null });
      } else {
        onLog(job.id, '[queue] Duration not available after quick probe; starting transcode without waiting');
        durationPromise.then((resolvedMs) => {
          if (resolvedMs) setDurationIfTranscoding(job.id, resolvedMs);
        }).catch(() => {});
      }
    }

    const cmd = await ffmpeg.run({
      inputPath: job.source_path,
      outputPath: stagingFile,
      profile,
      hwAccel: hwAccelMode,
      hwDevice,
      ffmpegPath: config.ffmpegPath,
      onLog: (line) => onLog(job.id, line),
      onProgress: (progress) => updateProgress(job.id, progress),
      onTranscodeInfo: (info) => setStatus(job.id, 'transcoding', { transcode_info: JSON.stringify(info) }),
      signal: controller.signal,
    });

    // Build final output path
    const safeName = `${job.title}${job.year ? ` (${job.year})` : ''}`;
    const finalDir = path.join(config.outputRoot, 'Movies', safeName);
    const finalFile = path.join(finalDir, `${safeName}.${profile.container}`);

    fs.mkdirSync(finalDir, { recursive: true });
    moveFile(stagingFile, finalFile);

    onLog(job.id, `[queue] Moved to ${finalFile}`);

    // Export metadata
    await metadata.exportMovie(job, finalDir, config);

    setStatus(job.id, 'complete', { output_path: finalFile, ffmpeg_cmd: cmd });
    onLog(job.id, '[queue] Complete');
    logger.info('queue', `Completed "${job.title}"`, { jobId: job.id });
  } catch (err) {
    onLog(job.id, `[queue] Error: ${err.message}`);
    if (err.cancelled) logger.warn('queue', `Cancelled "${job.title}"`, { jobId: job.id });
    else logger.error('queue', `Failed "${job.title}"`, { jobId: job.id, error: err.message });
    setStatus(job.id, err.cancelled ? 'cancelled' : 'failed', { error_log: err.message, ffmpeg_cmd: err.cmd || null });
  } finally {
    activeJobs.delete(job.id);
    // Clean up staging dir
    try { fs.rmSync(path.join(config.cacheRoot, 'jobs', job.id), { recursive: true, force: true }); } catch {}
  }
}

async function getDurationMs(job, ffmpegPath) {
  if (job.duration_ms) return job.duration_ms;
  try {
    return await ffmpeg.probeDurationMs(job.source_path, ffmpegPath);
  } catch (err) {
    onLog(job.id, `[queue] Could not probe duration: ${err.message}`);
    return null;
  }
}

function updateProgress(jobId, progress, durationMs) {
  const reportedDurationMs = parseDurationMs(progress);
  if (reportedDurationMs) setDurationIfTranscoding(jobId, reportedDurationMs);
  const outTimeMs = parseProgressMs(progress);
  if (!Number.isFinite(outTimeMs) || outTimeMs <= 0) return;
  const job = db.get().prepare('SELECT started_at, duration_ms FROM jobs WHERE id=?').get(jobId);
  durationMs = durationMs || reportedDurationMs || job?.duration_ms || null;
  const elapsed = job?.started_at ? Math.max(1, Math.floor(Date.now() / 1000) - job.started_at) : null;
  const progressPct = durationMs ? Math.min(99.9, Math.max(0, (outTimeMs / durationMs) * 100)) : null;
  const etaSeconds = elapsed && progressPct && progressPct > 0
    ? Math.max(0, Math.round((elapsed / (progressPct / 100)) - elapsed))
    : null;
  db.get().prepare(`
    UPDATE jobs
    SET progress_ms=?, progress_pct=?, eta_seconds=?, updated_at=unixepoch()
    WHERE id=?
  `).run(Math.round(outTimeMs), progressPct, etaSeconds, jobId);
}

function parseDurationMs(progress) {
  if (progress.duration_ms) {
    const value = Number(progress.duration_ms);
    if (Number.isFinite(value) && value > 0) return Math.round(value);
  }
  if (progress.duration) {
    const value = parseTimestampMs(progress.duration);
    if (value) return value;
  }
  return null;
}

function parseProgressMs(progress) {
  if (progress.out_time_ms) {
    const value = Number(progress.out_time_ms);
    if (Number.isFinite(value) && value > 0) return value / 1000;
  }
  if (progress.out_time_us) {
    const value = Number(progress.out_time_us);
    if (Number.isFinite(value) && value > 0) return value / 1000;
  }
  if (progress.out_time) {
    const value = parseTimestampMs(progress.out_time);
    if (value) return value;
  }
  return null;
}

function parseTimestampMs(value) {
  const match = String(value || '').match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  return Math.round(((Number(hours) * 3600) + (Number(minutes) * 60) + Number(seconds)) * 1000);
}

function withTimeout(promise, timeoutMs, fallback) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function moveFile(source, dest) {
  try {
    fs.renameSync(source, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(source, dest);
    fs.unlinkSync(source);
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
      if (reloadPending && running === 0) {
        probeAndStart().catch((err) => logger.error('queue', 'Hardware reload failed', err));
      } else {
        pump();
      }
    });
  }
}

async function probeAndStart() {
  const config = cfg.load();
  const result = await ffmpeg.probeHwAccel(config.hwAccel, config.ffmpegPath, config.hwDevice);
  if (result.available) {
    hwAccelMode = result.mode;
    hwDevice = result.device || config.hwDevice;
    reloadPending = false;
    logger.info('queue', `Hardware acceleration active: ${hwAccelMode}`, { device: hwDevice || 'none' });
  } else {
    hwAccelMode = 'none';
    hwDevice = config.hwDevice;
    reloadPending = false;
    logger.warn('queue', `Hardware acceleration unavailable; using software`, { reason: result.reason, device: hwDevice });
  }
  pump();
}

function start(max) {
  maxConcurrent = max || 1;
  probeAndStart().catch((err) => logger.error('queue', 'Startup hardware probe failed', err));
}

function enqueue() {
  pump();
}

async function reloadHardwareIfIdle() {
  if (running > 0) {
    reloadPending = true;
    return { ok: false, deferred: true, reason: 'transcode active', running };
  }
  const before = getHardwareState();
  await probeAndStart();
  return { ok: true, deferred: false, before, after: getHardwareState() };
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

function getHardwareState() {
  return {
    activeMode: hwAccelMode,
    activeDevice: hwDevice,
    running,
    reloadPending,
  };
}

module.exports = { start, enqueue, cancel, reloadHardwareIfIdle, getLogEmitter, getHwAccelMode, getHardwareState };
