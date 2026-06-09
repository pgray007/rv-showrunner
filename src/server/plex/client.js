'use strict';
const fs = require('fs');
const cfg = require('../config');

// Plex uses a token query parameter for both JSON metadata and image URLs.
async function plexFetch(urlPath, options = {}, config = null, timeoutMs = 10000) {
  const c = config || cfg.load();
  if (!c.plexUrl) throw new Error('Plex URL not configured');
  if (!c.plexToken) throw new Error('Plex token not configured');

  const base = c.plexUrl.replace(/\/+$/, '');
  const url = new URL(`${base}${urlPath}`);
  url.searchParams.set('X-Plex-Token', c.plexToken);

  let res;
  try {
    res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Plex timed out after ${timeoutMs / 1000}s (${urlPath})`);
    }
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Plex ${options.method || 'GET'} ${urlPath} -> ${res.status}: ${body}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function testConnection(config, timeoutMs = 10000) {
  const data = await plexFetch('/identity', {}, config, timeoutMs);
  const container = data.MediaContainer || data;
  return {
    ServerName: container.friendlyName || container.machineIdentifier || 'Plex',
    Version: container.version || 'unknown',
  };
}

async function getMovieSections(config) {
  const data = await plexFetch('/library/sections', {}, config);
  const directories = asArray(data.MediaContainer?.Directory);
  // rv-showrunner currently transcodes movie libraries only.
  return directories.filter((section) => section.type === 'movie');
}

async function getItems({
  search,
  page = 1,
  limit = 40,
  tagFilter,
  excludeTagFilter,
  genre,
  sortBy = 'titleSort',
  sortOrder = 'asc',
} = {}) {
  const config = cfg.load();
  const all = [];
  // Plex search/filter support varies by endpoint and server version. Load
  // movie sections, normalize, then apply the app's filters consistently.
  for (const section of await getMovieSections(config)) {
    all.push(...await getSectionItems(section.key, config));
  }

  const query = (search || '').trim().toLowerCase();
  let filtered = all.map((item) => normalizeItem(item, config));
  if (query) {
    filtered = filtered.filter((item) => item.title.toLowerCase().includes(query));
  }
  if (tagFilter) {
    filtered = filtered.filter((item) => item.tags.includes(tagFilter));
  }
  if (excludeTagFilter) {
    filtered = filtered.filter((item) => !item.tags.includes(excludeTagFilter));
  }
  if (genre) {
    filtered = filtered.filter((item) => item.genres.includes(genre));
  }

  filtered.sort(compareItems(sortBy, sortOrder));
  const start = (page - 1) * limit;
  return {
    items: filtered.slice(start, start + limit),
    total: filtered.length,
  };
}

async function getGenres() {
  const config = cfg.load();
  const names = new Set();
  // Collect genres from all Plex movie sections into one dropdown list.
  for (const section of await getMovieSections(config)) {
    const data = await plexFetch(`/library/sections/${encodeURIComponent(section.key)}/genre`, {}, config);
    for (const genre of asArray(data.MediaContainer?.Directory)) {
      if (genre.title) names.add(genre.title);
    }
  }
  const genres = [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ id: name, name }));
  return { genres, total: genres.length };
}

async function getTaggedItems() {
  const config = cfg.load();
  const { items } = await getItems({ page: 1, limit: Number.MAX_SAFE_INTEGER, tagFilter: config.rvTag });
  return items;
}

async function getItem(itemId) {
  const config = cfg.load();
  const ratingKey = encodeURIComponent(itemId);
  const data = await plexFetch(`/library/metadata/${ratingKey}`, {}, config);
  const item = asArray(data.MediaContainer?.Metadata)[0];
  if (!item) throw new Error(`Plex item not found: ${itemId}`);
  return normalizeItem(item, config);
}

async function addTag(itemId, tag) {
  const item = await getItem(itemId);
  if (item.tags.includes(tag)) return;
  await editTags(itemId, [...item.tags, tag]);
}

async function removeTag(itemId, tag) {
  const item = await getItem(itemId);
  await editTags(itemId, item.tags.filter((value) => value !== tag));
}

async function editTags(itemId, tags) {
  const config = cfg.load();
  const params = new URLSearchParams({
    type: '1',
    id: itemId,
    'label.locked': '1',
  });
  tags.forEach((tag, index) => {
    params.set(`label[${index}].tag.tag`, tag);
  });
  // Plex labels are edited through the generic metadata edit endpoint.
  await plexFetch(`/:/edit?${params}`, { method: 'PUT' }, config);
}

async function downloadImage(itemId, imageType, destPath) {
  const config = cfg.load();
  const item = await getItem(itemId);
  const imagePath = imageType === 'Backdrop' ? item._backdropPath : item._thumbPath;
  if (!imagePath) return false;
  const base = config.plexUrl.replace(/\/+$/, '');
  const url = new URL(`${base}${imagePath}`);
  url.searchParams.set('X-Plex-Token', config.plexToken);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return true;
}

async function getSectionItems(sectionKey, config) {
  const data = await plexFetch(`/library/sections/${encodeURIComponent(sectionKey)}/all`, {}, config);
  return asArray(data.MediaContainer?.Metadata);
}

function compareItems(sortBy, sortOrder) {
  const direction = sortOrder === 'desc' || sortOrder === 'Descending' ? -1 : 1;
  return (a, b) => {
    if (sortBy === 'DateCreated' || sortBy === 'addedAt') {
      return direction * ((Number(a.dateCreatedEpoch || 0)) - (Number(b.dateCreatedEpoch || 0)));
    }
    return direction * a.title.localeCompare(b.title);
  };
}

function normalizeItem(item, config) {
  const id = String(item.ratingKey || item.key || item.guid);
  const labels = asArray(item.Label).map((label) => label.tag || label.title).filter(Boolean);
  const genres = asArray(item.Genre).map((genre) => genre.tag || genre.title).filter(Boolean);
  const studios = item.studio ? [item.studio] : [];
  const sourcePath = mapPath(getMediaPath(item), config);
  const base = config.plexUrl?.replace(/\/+$/, '');

  // Match the Jellyfin normalized contract so scanner, routes, Browse, and
  // metadata export do not need Plex-specific conditionals.
  return {
    id,
    sourceType: 'plex',
    sourceItemId: id,
    jellyfinId: id,
    title: item.title,
    year: item.year,
    overview: item.summary,
    officialRating: item.contentRating,
    communityRating: item.audienceRating || item.rating,
    criticRating: item.rating ? Math.round(Number(item.rating) * 10) : null,
    dateCreated: item.addedAt ? new Date(Number(item.addedAt) * 1000).toISOString() : null,
    dateCreatedEpoch: item.addedAt || null,
    premiereDate: item.originallyAvailableAt,
    runtime: item.duration ? Math.round(Number(item.duration) / 60000) : null,
    genres,
    studios,
    tags: labels,
    hasRvTag: labels.includes(config.rvTag),
    sourcePath,
    providerIds: providerIds(item),
    imageUrl: item.thumb && base ? imageUrl(base, item.thumb, config.plexToken) : null,
    backdropUrl: item.art && base ? imageUrl(base, item.art, config.plexToken) : null,
    _thumbPath: item.thumb,
    _backdropPath: item.art,
  };
}

function getMediaPath(item) {
  // Plex stores the real file path on Media[].Part[].file.
  const media = asArray(item.Media)[0];
  const part = asArray(media?.Part)[0];
  return part?.file || item.Media?.Part?.file || null;
}

function mapPath(plexPath, config) {
  if (!plexPath) return null;
  const prefix = config.plexMediaPath || '';
  if (prefix && plexPath.startsWith(prefix)) {
    return config.sourceMediaRoot + plexPath.slice(prefix.length);
  }
  return plexPath;
}

function providerIds(item) {
  const ids = {};
  // Plex may expose provider IDs either as a primary guid or a Guid[] list.
  const guid = item.guid || '';
  const imdb = guid.match(/imdb:\/\/([^/?]+)/);
  const tmdb = guid.match(/tmdb:\/\/([^/?]+)/);
  if (imdb) ids.imdb = imdb[1];
  if (tmdb) ids.tmdb = tmdb[1];
  for (const entry of asArray(item.Guid)) {
    const [type, id] = String(entry.id || '').split('://');
    if (type && id) ids[type] = id;
  }
  return ids;
}

function imageUrl(base, imagePath, token) {
  const url = new URL(`${base}${imagePath}`);
  url.searchParams.set('X-Plex-Token', token);
  return url.toString();
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

module.exports = { testConnection, getItems, getGenres, getTaggedItems, getItem, addTag, removeTag, downloadImage };
