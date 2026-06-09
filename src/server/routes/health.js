'use strict';
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const cfg = require('../config');
const mediaSource = require('../media/source');
const queue = require('../transcode/queue');

const VERSION = require('../../../package.json').version;
const execFileAsync = promisify(execFile);
const SOURCE_HEALTH_TIMEOUT_MS = 2000;
const FFMPEG_HEALTH_TIMEOUT_MS = 2000;

async function routes(fastify) {
  fastify.get('/version', async () => ({ version: VERSION }));

  fastify.get('/health', async () => {
    const config = cfg.load();
    const checks = {};

    // Health is lightweight enough for container probes: quick remote source
    // check, mount checks, GPU presence, and ffmpeg availability.
    try {
      const source = mediaSource.getActive(config);
      await source.client.testConnection(config, SOURCE_HEALTH_TIMEOUT_MS);
      checks.source = { ok: true, type: source.type, label: source.label };
    } catch (err) {
      checks.source = { ok: false, reason: err.message };
    }

    checks.media = checkMount(config.sourceMediaRoot, false);
    checks.output = checkMount(config.outputRoot, true);
    checks.cache = checkMount(config.cacheRoot, true);

    const hardware = queue.getHardwareState();
    checks.gpu = {
      ok: config.hwAccel === 'none' || fs.existsSync(config.hwDevice),
      device: config.hwDevice,
      hwAccelMode: hardware.activeMode,
      activeDevice: hardware.activeDevice,
      reloadPending: hardware.reloadPending,
    };

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
