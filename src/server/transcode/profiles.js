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

function listProfiles() {
  const byName = new Map();

  for (const dir of profileDirs()) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))) {
      try {
        const profile = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (profile?.name) byName.set(profile.name, profile);
      } catch {}
    }
  }

  return [...byName.values()];
}

function getProfile(name) {
  for (const dir of profileDirs()) {
    for (const ext of ['.yaml', '.yml']) {
      const file = path.join(dir, name + ext);
      if (fs.existsSync(file)) {
        return yaml.load(fs.readFileSync(file, 'utf8'));
      }
    }
  }
  throw new Error(`Profile not found: ${name}`);
}

function saveProfile(profile) {
  const dir = profilesDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${profile.name}.yaml`);
  fs.writeFileSync(file, yaml.dump(profile));
}

function deleteProfile(name) {
  const dir = profilesDir();
  for (const ext of ['.yaml', '.yml']) {
    const file = path.join(dir, name + ext);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      return true;
    }
  }
  return false;
}

module.exports = { listProfiles, getProfile, saveProfile, deleteProfile };
