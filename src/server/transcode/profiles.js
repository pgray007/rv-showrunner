'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const cfg = require('../config');

function profilesDir() {
  return path.join(cfg.getConfigRoot(), 'profiles');
}

function defaultProfilesDir() {
  return path.join(process.cwd(), 'profiles');
}

function profileDirs() {
  return [...new Set([defaultProfilesDir(), profilesDir()])];
}

function profilePath(dir, name, ext = '.yaml') {
  return path.join(dir, `${name}${ext}`);
}

function hasProfileInDir(dir, name) {
  return ['.yaml', '.yml'].some((ext) => fs.existsSync(profilePath(dir, name, ext)));
}

function listProfiles() {
  const byName = new Map();

  for (const dir of profileDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) {
      try {
        const profile = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (profile?.name) {
          const custom = dir === profilesDir();
          const existing = byName.get(profile.name);
          byName.set(profile.name, {
            ...profile,
            builtin: existing?.builtin && custom ? true : !custom,
            editable: custom,
            source: custom ? 'custom' : 'default',
          });
        }
      } catch {}
    }
  }

  return [...byName.values()];
}

function getProfile(name) {
  for (const dir of [profilesDir(), defaultProfilesDir()]) {
    for (const ext of ['.yaml', '.yml']) {
      const file = profilePath(dir, name, ext);
      if (fs.existsSync(file)) {
        return yaml.load(fs.readFileSync(file, 'utf8'));
      }
    }
  }
  throw new Error(`Profile not found: ${name}`);
}

function saveProfile(profile) {
  const clean = validateProfile(profile);
  const customExists = hasProfileInDir(profilesDir(), clean.name);
  const builtinExists = hasProfileInDir(defaultProfilesDir(), clean.name);
  if (builtinExists && !customExists) {
    throw new Error('Built-in profiles cannot be edited directly. Duplicate the profile first.');
  }
  const dir = profilesDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = profilePath(dir, clean.name);
  fs.writeFileSync(file, yaml.dump(clean));
  return clean;
}

function deleteProfile(name) {
  assertValidName(name);
  const dir = profilesDir();
  for (const ext of ['.yaml', '.yml']) {
    const file = profilePath(dir, name, ext);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return true;
    }
  }
  return false;
}

function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') throw new Error('Profile is required');
  const clean = {
    name: String(profile.name || '').trim(),
    container: String(profile.container || 'mp4').trim(),
    videoCodec: String(profile.videoCodec || 'h264').trim(),
    audioCodec: String(profile.audioCodec || 'aac').trim(),
    maxWidth: Number(profile.maxWidth),
    maxHeight: Number(profile.maxHeight),
    videoBitrate: String(profile.videoBitrate || '').trim(),
    maxrate: String(profile.maxrate || '').trim(),
    bufsize: String(profile.bufsize || '').trim(),
    audioBitrate: String(profile.audioBitrate || '').trim(),
    audioChannels: Number(profile.audioChannels),
    subtitleMode: String(profile.subtitleMode || 'burn-forced-only').trim(),
  };

  assertValidName(clean.name);
  if (clean.container !== 'mp4') throw new Error('Only mp4 profiles are currently supported');
  if (clean.videoCodec !== 'h264') throw new Error('Only h264 video profiles are currently supported');
  if (clean.audioCodec !== 'aac') throw new Error('Only aac audio profiles are currently supported');
  if (!['burn-forced-only', 'none'].includes(clean.subtitleMode)) throw new Error('Unsupported subtitle mode');

  for (const key of ['maxWidth', 'maxHeight']) {
    if (!Number.isInteger(clean[key]) || clean[key] < 16 || clean[key] > 7680) {
      throw new Error(`${key} must be a whole number between 16 and 7680`);
    }
  }
  if (!Number.isInteger(clean.audioChannels) || clean.audioChannels < 1 || clean.audioChannels > 8) {
    throw new Error('audioChannels must be a whole number between 1 and 8');
  }

  for (const key of ['videoBitrate', 'maxrate', 'bufsize', 'audioBitrate']) {
    if (!/^\d+(?:\.\d+)?[kKmM]$/.test(clean[key])) {
      throw new Error(`${key} must use ffmpeg bitrate format, for example 6M or 192k`);
    }
  }

  return clean;
}

function assertValidName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(String(name || ''))) {
    throw new Error('Profile name must be 1-64 characters and use only letters, numbers, dots, underscores, or hyphens');
  }
}

module.exports = { listProfiles, getProfile, saveProfile, deleteProfile, validateProfile };
