'use strict';
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// In Docker these are set via env vars. Locally they fall back to ./data/* so
// the server starts without needing /config, /rv-ready, or /cache to exist.
const DEV_DATA = path.join(process.cwd(), 'data');
const CONFIG_ROOT = process.env.CONFIG_ROOT || DEV_DATA;
const SETTINGS_PATH = path.join(CONFIG_ROOT, 'settings.json');
const LEGACY_CONFIG_PATH = path.join(CONFIG_ROOT, 'config.json');

const PERSISTED_KEYS = new Set([
  'mediaSource',
  'jellyfinUrl',
  'jellyfinApiKey',
  'jellyfinMediaPath',
  'plexUrl',
  'plexToken',
  'plexMediaPath',
  'rvTag',
  'sourceMediaRoot',
  'outputRoot',
  'cacheRoot',
  'transcodeProfile',
  'hwAccel',
  'hwDevice',
  'ffmpegPath',
  'scanIntervalMinutes',
  'maxConcurrentTranscodes',
  'unsyncBehavior',
]);

const envDefaults = {
  mediaSource: process.env.MEDIA_SOURCE || 'jellyfin',
  jellyfinUrl: process.env.JELLYFIN_URL || '',
  jellyfinApiKey: process.env.JELLYFIN_API_KEY || '',
  jellyfinMediaPath: process.env.JELLYFIN_MEDIA_PATH || '/mnt/user/Media',
  plexUrl: process.env.PLEX_URL || '',
  plexToken: process.env.PLEX_TOKEN || '',
  plexMediaPath: process.env.PLEX_MEDIA_PATH || '/mnt/user/Media',
  rvTag: process.env.RV_TAG || 'RV-SYNC',
  sourceMediaRoot: process.env.SOURCE_MEDIA_ROOT || path.join(DEV_DATA, 'media'),
  outputRoot: process.env.OUTPUT_ROOT || path.join(DEV_DATA, 'rv-ready'),
  cacheRoot: process.env.CACHE_ROOT || path.join(DEV_DATA, 'cache'),
  transcodeProfile: process.env.TRANSCODE_PROFILE || 'roku-1080p',
  hwAccel: process.env.HW_ACCEL || 'none',
  hwDevice: process.env.HW_DEVICE || '/dev/dri/renderD128',
  ffmpegPath: process.env.FFMPEG_PATH || '/usr/bin/ffmpeg',
  scanIntervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES || '10', 10),
  maxConcurrentTranscodes: parseInt(process.env.MAX_CONCURRENT_TRANSCODES || '1', 10),
  unsyncBehavior: 'keep', // keep | delete
};

function load() {
  const saved = readSaved();
  return { ...envDefaults, ...saved };
}

function readSaved() {
  for (const file of [SETTINGS_PATH, LEGACY_CONFIG_PATH]) {
    if (!fs.existsSync(file)) continue;
    try {
      return sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      logger.warn('config', `Failed to parse ${path.basename(file)}; using defaults`, e.message);
    }
  }
  return {};
}

function sanitize(values) {
  const clean = {};
  for (const [key, value] of Object.entries(values || {})) {
    if (PERSISTED_KEYS.has(key) && value !== undefined) clean[key] = value;
  }
  if (['qsv', 'qsvDerived', 'qsvViaVaapi'].includes(clean.hwAccel)) {
    clean.hwAccel = 'vaapi';
  }
  if (clean.mediaSource && !['jellyfin', 'plex'].includes(clean.mediaSource)) {
    clean.mediaSource = 'jellyfin';
  }
  return clean;
}

function save(updates) {
  const current = readSaved();
  const merged = sanitize({ ...current, ...updates });
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return { ...envDefaults, ...merged };
}

function getConfigRoot() {
  return CONFIG_ROOT;
}

module.exports = { load, save, getConfigRoot };
