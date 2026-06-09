'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const cfg = require('../config');
const queue = require('../transcode/queue');
const scanner = require('../worker/scanner');
const logger = require('../logger');

async function routes(fastify) {
  // List jobs
  fastify.get('/jobs', async (req) => {
    const { status } = req.query;
    const rows = status && status !== 'all'
      ? db.get().prepare('SELECT * FROM jobs WHERE status=? ORDER BY updated_at DESC').all(status)
      : db.get().prepare('SELECT * FROM jobs ORDER BY updated_at DESC').all();
    // Summaries always use all jobs so filtered views keep global queue totals.
    const summaryRows = status && status !== 'all'
      ? db.get().prepare('SELECT * FROM jobs ORDER BY updated_at DESC').all()
      : rows;
    const jobs = rows.map(addRvReadySize);
    return { jobs, summary: summarizeJobs(summaryRows.map(addRvReadySize)) };
  });

  // Manually run the active source scan and enqueue any newly tagged/labeled items
  fastify.post('/jobs/refresh', async (req, reply) => {
    const result = await scanner.runNow();
    if (!result?.ok) {
      const status = result?.skipped ? 409 : 502;
      return reply.code(status).send(result || { ok: false, error: 'refresh failed' });
    }
    return result;
  });

  // Get single job
  fastify.get('/jobs/:id', async (req, reply) => {
    const job = db.get().prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Not found' });
    return addRvReadySize(job);
  });

  // Get logs for a job (snapshot)
  fastify.get('/jobs/:id/logs', async (req, reply) => {
    const logs = db.get()
      .prepare('SELECT ts, line FROM job_logs WHERE job_id=? ORDER BY id ASC')
      .all(req.params.id);
    return { logs };
  });

  // Stream logs via SSE
  fastify.get('/jobs/:id/logs/stream', async (req, reply) => {
    const jobId = req.params.id;
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (obj) => {
      reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    };

    // Send existing logs first
    const existing = db.get()
      .prepare('SELECT ts, line FROM job_logs WHERE job_id=? ORDER BY id ASC')
      .all(jobId);
    existing.forEach(send);

    const emitter = queue.getLogEmitter();
    const handler = (entry) => send(entry);
    // Each job has its own event name so multiple log streams can stay open
    // without receiving unrelated ffmpeg output.
    emitter.on(`log:${jobId}`, handler);

    req.raw.on('close', () => {
      emitter.off(`log:${jobId}`, handler);
    });

    // Keep open
    return reply;
  });

  // Retry a failed/cancelled job
  fastify.post('/jobs/:id/retry', async (req, reply) => {
    const job = db.get().prepare("SELECT * FROM jobs WHERE id=? AND status IN ('failed','cancelled')").get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Job not found or not retryable' });
    db.get().prepare("UPDATE jobs SET status='queued', error_log=NULL, transcode_info=NULL, updated_at=unixepoch() WHERE id=?").run(job.id);
    queue.enqueue();
    return { ok: true };
  });

  // Delete completed output and re-run the transcode
  fastify.post('/jobs/:id/reprocess', async (req, reply) => {
    const job = db.get().prepare("SELECT * FROM jobs WHERE id=? AND status='complete'").get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Job not found or not complete' });

    const deleted = deleteOutputForJob(job);
    db.get().prepare(`
      UPDATE jobs
      SET status='queued',
          output_path=NULL,
          ffmpeg_cmd=NULL,
          duration_ms=NULL,
          progress_ms=NULL,
          progress_pct=NULL,
          started_at=NULL,
          eta_seconds=NULL,
          error_log=NULL,
          transcode_info=NULL,
          completed_at=NULL,
          updated_at=unixepoch()
      WHERE id=?
    `).run(job.id);
    db.get().prepare('INSERT INTO job_logs (job_id, ts, line) VALUES (?, unixepoch(), ?)').run(
      job.id,
      deleted ? '[queue] Reprocess requested; deleted completed output and requeued job' : '[queue] Reprocess requested; no completed output file was present, requeued job',
    );
    queue.enqueue();
    return { ok: true, deleted };
  });

  // Cancel an active job
  fastify.post('/jobs/:id/cancel', async (req, reply) => {
    const job = db.get().prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Not found' });
    if (job.status === 'queued') {
      db.get().prepare("UPDATE jobs SET status='cancelled', error_log='cancelled before start', updated_at=unixepoch() WHERE id=?").run(job.id);
      return { ok: true };
    }
    if (job.status !== 'transcoding') {
      return reply.code(409).send({ error: `Cannot cancel job in ${job.status} state` });
    }
    const cancelled = queue.cancel(job.id);
    if (!cancelled) return reply.code(409).send({ error: 'Job is no longer active' });
    return { ok: true };
  });

  // Prune old ffmpeg/job logs while keeping recent context per job
  fastify.post('/jobs/logs/prune', async (req) => {
    const keepLast = Math.max(100, Math.min(Number(req.body?.keepLast || 1000), 10000));
    const rows = db.get().prepare('SELECT id FROM jobs').all();
    let deleted = 0;
    const stmt = db.get().prepare(`
      DELETE FROM job_logs
      WHERE job_id=?
        AND id NOT IN (
          SELECT id FROM job_logs WHERE job_id=? ORDER BY id DESC LIMIT ?
        )
    `);
    for (const row of rows) {
      const result = stmt.run(row.id, row.id, keepLast);
      deleted += result.changes || 0;
    }
    return { ok: true, deleted, keepLast };
  });

  // Delete a job (and optionally its output)
  fastify.delete('/jobs/:id', async (req, reply) => {
    const job = db.get().prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Not found' });

    const deleteFiles = req.query.deleteFiles === 'true';
    if (deleteFiles) deleteOutputForJob(job);

    db.get().prepare('DELETE FROM jobs WHERE id=?').run(job.id);
    return { ok: true };
  });

  // Storage usage
  fastify.get('/storage', async () => {
    const config = cfg.load();
    const usage = getDirSize(config.outputRoot);
    return {
      outputRoot: config.outputRoot,
      bytesUsed: usage,
      files: listOutputFiles(config.outputRoot),
    };
  });
}

function deleteOutputForJob(job) {
  if (!job.output_path) return false;
  try {
    const dir = path.dirname(job.output_path);
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    logger.warn('jobs', 'Could not delete output files', err.message);
    return false;
  }
}

function summarizeJobs(rows) {
  // Queue summaries drive the dashboard progress bar and ETA display.
  const active = rows.filter((job) => ['queued', 'transcoding'].includes(job.status));
  const complete = rows.filter((job) => job.status === 'complete');
  const total = active.length + complete.length;
  const pctValues = rows
    .filter((job) => ['queued', 'transcoding', 'complete'].includes(job.status))
    .map((job) => job.status === 'complete' ? 100 : Number(job.progress_pct || 0));
  const overallPct = pctValues.length
    ? pctValues.reduce((sum, pct) => sum + pct, 0) / pctValues.length
    : 0;
  const etaSeconds = rows
    .filter((job) => job.status === 'transcoding')
    .reduce((sum, job) => sum + Number(job.eta_seconds || 0), 0);
  const estimatedQueuedSeconds = estimateQueuedSeconds(rows);
  const estimatedEtaSeconds = etaSeconds || estimatedQueuedSeconds
    ? etaSeconds + estimatedQueuedSeconds
    : null;
  return {
    total,
    active: active.length,
    queued: rows.filter((job) => job.status === 'queued').length,
    transcoding: rows.filter((job) => job.status === 'transcoding').length,
    complete: complete.length,
    failed: rows.filter((job) => job.status === 'failed').length,
    overallPct,
    etaSeconds,
    estimatedQueuedSeconds,
    estimatedEtaSeconds,
    etaEstimated: estimatedQueuedSeconds > 0,
  };
}

function estimateQueuedSeconds(rows) {
  const queued = rows.filter((job) => job.status === 'queued');
  if (!queued.length) return 0;

  const secondsPerByte = estimateSecondsPerByte(rows);
  if (secondsPerByte) {
    // Prefer a byte-weighted estimate when completed jobs have source sizes;
    // fall back to average job duration for files without stat data.
    const sizedSeconds = queued
      .filter((job) => Number(job.source_size) > 0)
      .reduce((sum, job) => sum + (Number(job.source_size) * secondsPerByte), 0);
    const unsized = queued.filter((job) => !Number(job.source_size)).length;
    return Math.round(sizedSeconds + (unsized * estimateAverageJobSeconds(rows)));
  }

  const averageJobSeconds = estimateAverageJobSeconds(rows);
  return averageJobSeconds ? Math.round(queued.length * averageJobSeconds) : 0;
}

function estimateSecondsPerByte(rows) {
  // Include completed jobs and in-flight jobs with enough progress to estimate
  // a rough throughput for the current machine/profile mix.
  const samples = rows
    .filter((job) => job.status === 'complete' && job.started_at && job.completed_at && Number(job.source_size) > 0)
    .map((job) => ({
      seconds: Math.max(1, Number(job.completed_at) - Number(job.started_at)),
      bytes: Number(job.source_size),
    }));

  for (const job of rows.filter((row) => row.status === 'transcoding' && row.started_at && Number(row.progress_pct) > 1 && Number(row.source_size) > 0)) {
    const elapsed = Math.max(1, Math.floor(Date.now() / 1000) - Number(job.started_at));
    const projectedSeconds = elapsed / (Number(job.progress_pct) / 100);
    samples.push({ seconds: projectedSeconds, bytes: Number(job.source_size) });
  }

  if (!samples.length) return null;
  const totalSeconds = samples.reduce((sum, sample) => sum + sample.seconds, 0);
  const totalBytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
  return totalBytes > 0 ? totalSeconds / totalBytes : null;
}

function estimateAverageJobSeconds(rows) {
  const durations = rows
    .filter((job) => job.status === 'complete' && job.started_at && job.completed_at)
    .map((job) => Math.max(1, Number(job.completed_at) - Number(job.started_at)));

  for (const job of rows.filter((row) => row.status === 'transcoding' && row.started_at && Number(row.progress_pct) > 1)) {
    const elapsed = Math.max(1, Math.floor(Date.now() / 1000) - Number(job.started_at));
    durations.push(elapsed / (Number(job.progress_pct) / 100));
  }

  if (!durations.length) return 0;
  return durations.reduce((sum, seconds) => sum + seconds, 0) / durations.length;
}

function addRvReadySize(job) {
  // Compute output size lazily so the jobs table does not need to be updated
  // when files are deleted or modified outside the app.
  let rvReadySize = null;
  if (job.output_path) {
    try {
      const stat = fs.statSync(job.output_path);
      if (stat.isFile()) rvReadySize = stat.size;
    } catch {}
  }
  return { ...job, rv_ready_size: rvReadySize, transcode_info: parseTranscodeInfo(job.transcode_info) };
}

function parseTranscodeInfo(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getDirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += getDirSize(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function listOutputFiles(root) {
  if (!fs.existsSync(root)) return [];
  const results = [];
  // Output is organized as Type/Title/file, matching media-library layouts.
  for (const type of fs.readdirSync(root, { withFileTypes: true })) {
    if (!type.isDirectory()) continue;
    const typeDir = path.join(root, type.name);
    for (const item of fs.readdirSync(typeDir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const itemDir = path.join(typeDir, item.name);
      let size = 0;
      try { size = getDirSize(itemDir); } catch {}
      results.push({ name: item.name, type: type.name, path: itemDir, size });
    }
  }
  return results;
}

module.exports = routes;
