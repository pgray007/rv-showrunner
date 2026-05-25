'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const cfg = require('../config');
const queue = require('../transcode/queue');

async function routes(fastify) {
  // List jobs
  fastify.get('/jobs', async (req) => {
    const { status } = req.query;
    const rows = status && status !== 'all'
      ? db.get().prepare('SELECT * FROM jobs WHERE status=? ORDER BY updated_at DESC').all(status)
      : db.get().prepare('SELECT * FROM jobs ORDER BY updated_at DESC').all();
    return { jobs: rows };
  });

  // Get single job
  fastify.get('/jobs/:id', async (req, reply) => {
    const job = db.get().prepare('SELECT * FROM jobs WHERE id=?').get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'Not found' });
    return job;
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
    db.get().prepare("UPDATE jobs SET status='queued', error_log=NULL, updated_at=unixepoch() WHERE id=?").run(job.id);
    queue.enqueue();
    return { ok: true };
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
    if (deleteFiles && job.output_path) {
      try {
        const dir = path.dirname(job.output_path);
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn('[jobs] Could not delete output files:', err.message);
      }
    }

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
