'use strict';
const cfg = require('../config');
const jellyfin = require('../jellyfin/client');
const plex = require('../plex/client');

const SOURCES = {
  jellyfin,
  plex,
};

function getActive(config = cfg.load()) {
  const type = config.mediaSource || 'jellyfin';
  const client = SOURCES[type];
  if (!client) throw new Error(`Unsupported media source: ${type}`);
  return { type, client, label: type === 'plex' ? 'Plex' : 'Jellyfin' };
}

module.exports = { getActive };
