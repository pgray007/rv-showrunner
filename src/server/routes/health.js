'use strict';
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const cfg = require('../config');
const jellyfin = require('../jellyfin/client');
const queue = require('../transcode/queue');

const VERSION = require('../../../package.json').version;
const execFileAsync = promisify(execFile);
const JELLYFIN_HEALTH_TIMEOUT_MS = 2000;
const FFMPEG_HEALTH_TIMEOUT_MS = 2000;

async function routes(fastify) {
  fastify.get('/version', async () => ({ version: VERSION }));

  fastify.get('/health', async () => {
    const config = cfg.load();
    const checks = {};

    // Jellyfin connectivity
    try {
      await jellyfin.testConnection(config, JELLYFIN_HEALTH_TIMEOUT_MS);
      checks.jellyfin = { ok: true };
    } catch (err) {
      checks.jellyfin = { ok: false, reason: err.message };
    }

    // Mount checks
    checks.media = checkMount(config.sourceMediaRoot, false);
    checks.output = checkMount(config.outputRoot, true);
    checks.cache = checkMount(config.cacheRoot, true);

    // GPU
    const dri = '/dev/dri/renderD128';
    checks.gpu = {
      ok: fs.existsSync(dri),
      device: dri,
      hwAccelMode: queue.getHwAccelMode(),
    };

    // ffmpeg
    try {
      const { stdout } = await execFileAsync(config.ffmpegPath, ['-version'], {
        timeout: FFMPEG_HEALTH_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
      });
      const firstLine = stdout.toString().split('\n')[0];
      checks.ffmpeg = { ok: true, version: firstLine };
    } catch {
      checks.ffmpeg = { ok: false };
    }

    const allOk = ['media', 'output', 'cache', 'ffmpeg'].every((k) => checks[k]?.ok);
    return { ok: allOk, checks, version: VERSION };
  });
}

function checkMount(mountPath, writable) {
  if (!mountPath) return { ok: false, reason: 'not configured' };
  try {
    fs.accessSync(mountPath, writable ? fs.constants.W_OK : fs.constants.R_OK);
    return { ok: true, path: mountPath };
  } catch (err) {
    return { ok: false, path: mountPath, reason: err.message };
  }
}

module.exports = routes;
