'use strict';
const cfg = require('../config');

let cachedUser = null;

function headers(config) {
  return {
    'Authorization': `MediaBrowser Token="${config.jellyfinApiKey}"`,
    'Content-Type': 'application/json',
  };
}

async function jellyfinFetch(urlPath, options = {}, config = null, timeoutMs = 10000) {
  const c = config || cfg.load();
  if (!c.jellyfinUrl) throw new Error('Jellyfin URL not configured');
  const url = `${c.jellyfinUrl}${urlPath}`;

  let res;
  try {
    res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { ...headers(c), ...(options.headers || {}) },
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error(`Jellyfin timed out after ${timeoutMs / 1000}s (${urlPath})`);
    }
    throw err;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Jellyfin ${options.method || 'GET'} ${urlPath} → ${res.status}: ${body}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getFirstUserId(config) {
  const cacheKey = `${config.jellyfinUrl}|${config.jellyfinApiKey}`;
  if (cachedUser?.cacheKey === cacheKey) return cachedUser.id;

  const users = await jellyfinFetch('/Users', {}, config);
  const userId = users?.[0]?.Id;
  if (!userId) throw new Error('No Jellyfin users available');

  cachedUser = { cacheKey, id: userId };
  return userId;
}

async function getFullItem(jellyfinId, config) {
  try {
    const userId = await getFirstUserId(config);
    return await jellyfinFetch(`/Users/${encodeURIComponent(userId)}/Items/${encodeURIComponent(jellyfinId)}`, {}, config);
  } catch (err) {
    const params = new URLSearchParams({ Ids: jellyfinId, Limit: '1' });
    const data = await jellyfinFetch(`/Items?${params}`, {}, config);
    const item = data.Items?.[0];
    if (!item) throw err;
    return item;
  }
}

async function testConnection(config, timeoutMs = 10000) {
  return jellyfinFetch('/System/Info', {}, config, timeoutMs);
}

async function getItems({
  search,
  page = 1,
  limit = 40,
  tagFilter,
  excludeTagFilter,
  genre,
  sortBy = 'SortName',
  sortOrder = 'Ascending',
} = {}) {
  const config = cfg.load();
  const params = new URLSearchParams({
    IncludeItemTypes: 'Movie',
    Recursive: 'true',
    SortBy: sortBy,
    SortOrder: sortOrder,
    Fields: 'Path,MediaSources,Tags,Overview,Genres,Studios,ProviderIds,ImageTags,BackdropImageTags,OfficialRating,CommunityRating,CriticRating,DateCreated,PremiereDate',
    StartIndex: String((page - 1) * limit),
    Limit: String(limit),
  });
  if (search) params.set('SearchTerm', search);
  if (tagFilter) params.set('Tags', tagFilter);
  if (excludeTagFilter) params.set('ExcludeTags', excludeTagFilter);
  if (genre) params.set('Genres', genre);

  const data = await jellyfinFetch(`/Items?${params}`, {}, config);
  return {
    items: (data.Items || []).map((item) => normalizeItem(item, config)),
    total: data.TotalRecordCount || 0,
  };
}

async function getGenres() {
  const config = cfg.load();
  const params = new URLSearchParams({
    IncludeItemTypes: 'Movie',
    Recursive: 'true',
    SortBy: 'SortName',
    SortOrder: 'Ascending',
  });
  const data = await jellyfinFetch(`/Genres?${params}`, {}, config);
  return {
    genres: (data.Items || []).map((genre) => ({
      id: genre.Id,
      name: genre.Name,
    })),
    total: data.TotalRecordCount || 0,
  };
}

async function getTaggedItems() {
  const config = cfg.load();
  const all = [];
  let start = 0;
  const limit = 100;
  while (true) {
    const params = new URLSearchParams({
      IncludeItemTypes: 'Movie',
      Recursive: 'true',
      Tags: config.rvTag,
      Fields: 'Path,MediaSources,Tags',
      StartIndex: String(start),
      Limit: String(limit),
    });
    const data = await jellyfinFetch(`/Items?${params}`, {}, config);
    const items = data.Items || [];
    all.push(...items);
    const total = data.TotalRecordCount ?? all.length;
    if (items.length === 0 || all.length >= total) break;
    start += limit;
  }
  return all.map((item) => normalizeItem(item, config));
}

async function getItem(jellyfinId) {
  const config = cfg.load();
  const params = new URLSearchParams({
    Fields: 'Path,MediaSources,Tags,Overview,Genres,Studios,ProviderIds,ImageTags,BackdropImageTags,OfficialRating,CommunityRating,CriticRating,DateCreated,PremiereDate',
  });
  const item = await jellyfinFetch(`/Items/${jellyfinId}?${params}`, {}, config);
  return normalizeItem(item, config);
}

async function addTag(jellyfinId, tag) {
  const config = cfg.load();
  // Fetch full item — a partial Fields=Tags response gets rejected by Jellyfin's POST endpoint
  const item = await getFullItem(jellyfinId, config);
  const tags = item.Tags || [];
  if (tags.includes(tag)) return;
  item.Tags = [...tags, tag];
  await jellyfinFetch(`/Items/${jellyfinId}`, { method: 'POST', body: JSON.stringify(item) }, config);
}

async function removeTag(jellyfinId, tag) {
  const config = cfg.load();
  const item = await getFullItem(jellyfinId, config);
  item.Tags = (item.Tags || []).filter((t) => t !== tag);
  await jellyfinFetch(`/Items/${jellyfinId}`, { method: 'POST', body: JSON.stringify(item) }, config);
}

async function downloadImage(jellyfinId, imageType, destPath) {
  const config = cfg.load();
  const fs = require('fs');
  const url = `${config.jellyfinUrl}/Items/${jellyfinId}/Images/${imageType}`;
  const res = await fetch(url, {
    headers: headers(config),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return true;
}

function mapPath(jellyfinPath, config) {
  if (!jellyfinPath) return null;
  // Replace the Jellyfin host path prefix with the container mount prefix
  const prefix = config.jellyfinMediaPath || '';
  if (prefix && jellyfinPath.startsWith(prefix)) {
    return config.sourceMediaRoot + jellyfinPath.slice(prefix.length);
  }
  // Fallback: if no prefix configured, return path as-is (may still work if mounts align)
  return jellyfinPath;
}

function normalizeItem(item, config) {
  const sourcePath = mapPath(item.Path, config);
  return {
    id: item.Id,
    sourceType: 'jellyfin',
    sourceItemId: item.Id,
    jellyfinId: item.Id,
    title: item.Name,
    year: item.ProductionYear,
    overview: item.Overview,
    officialRating: item.OfficialRating,
    communityRating: item.CommunityRating,
    criticRating: item.CriticRating,
    dateCreated: item.DateCreated,
    premiereDate: item.PremiereDate,
    runtime: item.RunTimeTicks ? Math.round(item.RunTimeTicks / 600000000) : null,
    genres: item.Genres || [],
    studios: (item.Studios || []).map((s) => s.Name),
    tags: item.Tags || [],
    hasRvTag: (item.Tags || []).includes(config.rvTag),
    sourcePath,
    providerIds: item.ProviderIds || {},
    imageUrl: item.ImageTags?.Primary
      ? `${config.jellyfinUrl}/Items/${item.Id}/Images/Primary?api_key=${config.jellyfinApiKey}`
      : null,
    backdropUrl: (item.BackdropImageTags || []).length
      ? `${config.jellyfinUrl}/Items/${item.Id}/Images/Backdrop?api_key=${config.jellyfinApiKey}`
      : null,
  };
}

module.exports = { testConnection, getItems, getGenres, getTaggedItems, getItem, addTag, removeTag, downloadImage };
