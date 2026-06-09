'use strict';
const cfg = require('../config');
const mediaSource = require('../media/source');
const db = require('../db');

const SORT_OPTIONS = {
  title: { sortBy: 'SortName', sortOrder: 'Ascending' },
  newest: { sortBy: 'DateCreated', sortOrder: 'Descending' },
};

async function routes(fastify) {
  async function listItems(req) {
    const { search, page = 1, limit = 40, tagState = 'all', sort = 'title', genre = '' } = req.query;
    const config = cfg.load();
    const source = mediaSource.getActive(config);
    // Map UI filter names onto the active source's tag/label filters.
    const filters = tagState === 'tagged'
      ? { tagFilter: config.rvTag }
      : tagState === 'untagged'
        ? { excludeTagFilter: config.rvTag }
        : {};
    const sortOption = SORT_OPTIONS[sort] || SORT_OPTIONS.title;
    const { items, total } = await source.client.getItems({
      search,
      page: Number(page),
      limit: Number(limit),
      genre,
      ...sortOption,
      ...filters,
    });

    // Annotate source items with local job status so Browse can show whether a
    // selected movie is queued, transcoding, complete, or failed.
    const itemIds = items.map(sourceItemId);
    const jobRows = itemIds.length
      ? db.get()
          .prepare(`SELECT source_item_id, jellyfin_id, status FROM jobs WHERE source_type=? AND source_item_id IN (${itemIds.map(() => '?').join(',')})`)
          .all(source.type, ...itemIds)
      : [];
    const jobMap = Object.fromEntries(jobRows.map((r) => [r.source_item_id || r.jellyfin_id, r.status]));

    return {
      sourceType: source.type,
      sourceLabel: source.label,
      items: items.map((i) => ({ ...i, jobStatus: jobMap[sourceItemId(i)] || null })),
      total,
      page: Number(page),
      limit: Number(limit),
    };
  }

  // New source-neutral routes power the UI; old /jellyfin routes stay as
  // compatibility aliases for older clients and bookmarks.
  fastify.get('/media/items', listItems);
  fastify.get('/jellyfin/items', listItems);

  async function listGenres() {
    return mediaSource.getActive(cfg.load()).client.getGenres();
  }

  fastify.get('/media/genres', listGenres);
  fastify.get('/jellyfin/genres', listGenres);

  // Add RV tag
  async function addTag(req, reply) {
    const config = cfg.load();
    const source = mediaSource.getActive(config);
    try {
      await source.client.addTag(req.params.id, config.rvTag);
      return { ok: true };
    } catch (err) {
      fastify.log.error({ source: source.type, itemId: req.params.id, err: err.message }, 'addTag failed');
      return reply.code(502).send({ error: err.message });
    }
  }

  fastify.post('/media/items/:id/tag', addTag);
  fastify.post('/jellyfin/items/:id/tag', addTag);

  // Remove RV tag
  async function removeTag(req, reply) {
    const config = cfg.load();
    const source = mediaSource.getActive(config);
    try {
      await source.client.removeTag(req.params.id, config.rvTag);
      return { ok: true };
    } catch (err) {
      fastify.log.error({ source: source.type, itemId: req.params.id, err: err.message }, 'removeTag failed');
      return reply.code(502).send({ error: err.message });
    }
  }

  fastify.delete('/media/items/:id/tag', removeTag);
  fastify.delete('/jellyfin/items/:id/tag', removeTag);
}

function sourceItemId(item) {
  return String(item.sourceItemId || item.id || item.jellyfinId);
}

module.exports = routes;
