'use strict';
const fs = require('fs');
const path = require('path');

// In Docker these are set via env vars. Locally they fall back to ./data/* so
// the server starts without needing /config, /rv-ready, or /cache to exist.
const DEV_DATA = path.join(process.cwd(), 'data');
const CONFIG_ROOT = process.env.CONFIG_ROOT || DEV_DATA;
const CONFIG_PATH = path.join(CONFIG_ROOT, 'config.json');

const envDefaults = {
  jellyfinUrl: process.env.JELLYFIN_URL || '',
  jellyfinApiKey: process.env.JELLYFIN_API_KEY || '',
  jellyfinMediaPath: process.env.JELLYFIN_MEDIA_PATH || '/mnt/user/Media',
  rvTag: process.env.RV_TAG || 'RV-SYNC',
  sourceMediaRoot: process.env.SOURCE_MEDIA_ROOT || path.join(DEV_DATA, 'media'),
  outputRoot: process.env.OUTPUT_ROOT || path.join(DEV_DATA, 'rv-ready'),
  cacheRoot: process.env.CACHE_ROOT || path.join(DEV_DATA, 'cache'),
  transcodeProfile: process.env.TRANSCODE_PROFILE || 'roku-1080p',
  hwAccel: process.env.HW_ACCEL || 'none',
  ffmpegPath: process.env.FFMPEG_PATH || '/usr/bin/ffmpeg',
  scanIntervalMinutes: parseInt(process.env.SCAN_INTERVAL_MINUTES || '10', 10),
  maxConcurrentTranscodes: parseInt(process.env.MAX_CONCURRENT_TRANSCODES || '1', 10),
  unsyncBehavior: 'keep', // keep | delete
};

function load() {
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return { ...envDefaults, ...saved };
    } catch (e) {
      console.warn('[config] Failed to parse config.json, using defaults:', e.message);
    }
  }
  return { ...envDefaults };
}

function save(updates) {
  const current = load();
  const merged = { ...current, ...updates };
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function getConfigRoot() {
  return CONFIG_ROOT;
}

module.exports = { load, save, getConfigRoot };
