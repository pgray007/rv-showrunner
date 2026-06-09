'use strict';
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const profiles = require('../transcode/profiles');
const mediaSource = require('../media/source');
const ffmpeg = require('../transcode/ffmpeg');
const queue = require('../transcode/queue');
const pkg = require('../../../package.json');

async function routes(fastify) {
  fastify.get('/settings', async () => {
    const config = cfg.load();
    // Never expose the full API key — mask it for display
    return {
      ...config,
      jellyfinApiKey: config.jellyfinApiKey ? '***' + config.jellyfinApiKey.slice(-4) : '',
      plexToken: config.plexToken ? '***' + config.plexToken.slice(-4) : '',
      _hasApiKey: !!config.jellyfinApiKey,
      _hasPlexToken: !!config.plexToken,
      appVersion: pkg.version,
    };
  });

  fastify.post('/settings', async (req, reply) => {
    const body = req.body || {};
    const previous = cfg.load();
    // Strip UI-only fields before persisting
    const { _hasApiKey, checks, required, ok, version, ...clean } = body;
    // If client echoes back the masked placeholder, preserve the existing key
    stripMaskedSecrets(clean);
    const updated = cfg.save(clean);
    const hardwareChanged = previous.hwAccel !== updated.hwAccel ||
      previous.hwDevice !== updated.hwDevice ||
      previous.ffmpegPath !== updated.ffmpegPath;
    const hardwareReload = hardwareChanged
      ? await queue.reloadHardwareIfIdle()
      : { ok: true, deferred: false, unchanged: true, after: queue.getHardwareState() };
    return {
      ok: true,
      hardwareReload,
      config: {
        ...updated,
        jellyfinApiKey: updated.jellyfinApiKey ? '***' + updated.jellyfinApiKey.slice(-4) : '',
        plexToken: updated.plexToken ? '***' + updated.plexToken.slice(-4) : '',
        _hasApiKey: !!updated.jellyfinApiKey,
        _hasPlexToken: !!updated.plexToken,
        appVersion: pkg.version,
      },
    };
  });

  fastify.post('/settings/test-connection', async (req, reply) => {
    const config = cfg.load();
    // Allow testing with a freshly provided key before saving
    const clean = { ...(req.body || {}) };
    stripMaskedSecrets(clean);
    const testConfig = { ...config, ...clean };
    try {
      const source = mediaSource.getActive(testConfig);
      const info = await source.client.testConnection(testConfig);
      return { ok: true, serverName: info.ServerName, version: info.Version };
    } catch (err) {
      return reply.code(502).send({ ok: false, error: err.message });
    }
  });

  fastify.get('/diagnostics/readiness', async () => {
    const config = cfg.load();
    const checks = {};

    checks.config = checkWritable(cfg.getConfigRoot());
    checks.cache = checkWritable(config.cacheRoot);
    checks.output = checkWritable(config.outputRoot);
    checks.media = checkReadable(config.sourceMediaRoot);

    try {
      const profile = profiles.getProfile(config.transcodeProfile);
      checks.profile = { ok: true, name: profile.name || config.transcodeProfile, container: profile.container };
    } catch (err) {
      checks.profile = { ok: false, reason: err.message };
    }

    try {
      const source = mediaSource.getActive(config);
      const info = await source.client.testConnection(config, 3000);
      checks.source = { ok: true, type: source.type, label: source.label, serverName: info.ServerName, version: info.Version };
    } catch (err) {
      checks.source = { ok: false, reason: err.message };
    }

    try {
      const source = mediaSource.getActive(config);
      const { items } = await source.client.getItems({ page: 1, limit: 1 });
      const item = items[0];
      if (!item) {
        checks.pathMapping = { ok: false, reason: `No movies returned by ${source.label}` };
      } else if (!item.sourcePath) {
        checks.pathMapping = { ok: false, reason: `${source.label} item did not include a source path` };
      } else if (!fs.existsSync(item.sourcePath)) {
        checks.pathMapping = {
          ok: false,
          reason: `Mapped path is not readable: ${item.sourcePath}`,
          jellyfinMediaPath: config.jellyfinMediaPath,
          plexMediaPath: config.plexMediaPath,
          sourceMediaRoot: config.sourceMediaRoot,
        };
      } else {
        checks.pathMapping = { ok: true, sampleTitle: item.title, sourcePath: item.sourcePath };
      }
    } catch (err) {
      checks.pathMapping = { ok: false, reason: err.message };
    }

    checks.gpu = {
      ok: config.hwAccel === 'none' || fs.existsSync(config.hwDevice),
      device: config.hwDevice,
      hwAccel: config.hwAccel,
      activeMode: queue.getHardwareState().activeMode,
      activeDevice: queue.getHardwareState().activeDevice,
      reloadPending: queue.getHardwareState().reloadPending,
      reason: config.hwAccel !== 'none' && !fs.existsSync(config.hwDevice) ? 'GPU device is not mounted into the container' : undefined,
    };

    const required = ['config', 'cache', 'output', 'media', 'profile', 'source', 'pathMapping'];
    if (config.hwAccel !== 'none') required.push('gpu');
    return {
      ok: required.every((key) => checks[key]?.ok),
      checks,
      required,
    };
  });

  fastify.post('/diagnostics/ffmpeg-test', async (req, reply) => {
    const config = mergeTestConfig(cfg.load(), req.body || {});
    try {
      const profile = profiles.getProfile(config.transcodeProfile);
      const outputPath = path.join(config.cacheRoot, 'diagnostics', `ffmpeg-test.${profile.container || 'mp4'}`);
      const result = await ffmpeg.testEncode({
        outputPath,
        profile,
        hwAccel: config.hwAccel,
        hwDevice: config.hwDevice,
        ffmpegPath: config.ffmpegPath,
      });
      try { fs.rmSync(outputPath, { force: true }); } catch {}
      if (!result.ok) return reply.code(502).send(result);
      return result;
    } catch (err) {
      return reply.code(500).send({ ok: false, reason: err.message });
    }
  });

  fastify.get('/diagnostics/hardware-devices', async () => ({
    selected: cfg.load().hwDevice,
    state: queue.getHardwareState(),
    devices: discoverHardwareDevices(),
  }));

  // Profile management
  fastify.get('/profiles', async () => ({ profiles: profiles.listProfiles() }));

  fastify.post('/profiles', async (req, reply) => {
    try {
      const profile = profiles.saveProfile(req.body);
      return { ok: true, profile };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  fastify.delete('/profiles/:name', async (req, reply) => {
    if (cfg.load().transcodeProfile === req.params.name) {
      return reply.code(409).send({ error: 'Cannot delete the selected default profile' });
    }
    const deleted = profiles.deleteProfile(req.params.name);
    if (!deleted) return reply.code(404).send({ error: 'Profile not found' });
    return { ok: true };
  });
}

function discoverHardwareDevices() {
  const root = '/dev/dri';
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => /^renderD\d+$/.test(name))
    .sort()
    .map((name) => {
      const devicePath = path.join(root, name);
      const sysfs = path.join('/sys/class/drm', name, 'device');
      const vendor = readTrimmed(path.join(sysfs, 'vendor'));
      const device = readTrimmed(path.join(sysfs, 'device'));
      const sysfsRealPath = realPath(sysfs);
      const sysfsBase = sysfsRealPath ? path.basename(sysfsRealPath) : null;
      const pci = sysfsBase?.match(/^[0-9a-fA-F:.]+$/) ? sysfsBase : null;
      const labelParts = [devicePath];
      if (vendor === '0x8086') labelParts.push('Intel');
      if (pci) labelParts.push(`PCI ${pci}`);
      if (device) labelParts.push(`device ${device}`);
      return {
        path: devicePath,
        label: labelParts.join(' · '),
        vendor,
        device,
        pci,
      };
    });
}

function realPath(target) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
  } catch {
    return null;
  }
}

function readTrimmed(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

function mergeTestConfig(config, body) {
  const { _hasApiKey, ...clean } = body || {};
  stripMaskedSecrets(clean);
  return { ...config, ...clean };
}

function stripMaskedSecrets(clean) {
  if (clean.jellyfinApiKey && clean.jellyfinApiKey.startsWith('***')) delete clean.jellyfinApiKey;
  if (clean.plexToken && clean.plexToken.startsWith('***')) delete clean.plexToken;
  delete clean._hasApiKey;
  delete clean._hasPlexToken;
}

function checkReadable(target) {
  if (!target) return { ok: false, reason: 'not configured' };
  try {
    fs.accessSync(target, fs.constants.R_OK);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, path: target, reason: err.message };
  }
}

function checkWritable(target) {
  if (!target) return { ok: false, reason: 'not configured' };
  try {
    fs.mkdirSync(target, { recursive: true });
    const probe = path.join(target, `.rv-showrunner-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, path: target, reason: err.message };
  }
}

module.exports = routes;
