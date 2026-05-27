'use strict';
const cfg = require('../config');
const jf = require('../jellyfin/client');
const db = require('../db');

const SORT_OPTIONS = {
  title: { sortBy: 'SortName', sortOrder: 'Ascending' },
  newest: { sortBy: 'DateCreated', sortOrder: 'Descending' },
};

async function routes(fastify) {
  // Browse / search movies
  fastify.get('/jellyfin/items', async (req) => {
    const { search, page = 1, limit = 40, tagState = 'all', sort = 'title', genre = '' } = req.query;
    const config = cfg.load();
    const filters = tagState === 'tagged'
      ? { tagFilter: config.rvTag }
      : tagState === 'untagged'
        ? { excludeTagFilter: config.rvTag }
        : {};
    const sortOption = SORT_OPTIONS[sort] || SORT_OPTIONS.title;
    const { items, total } = await jf.getItems({
      search,
      page: Number(page),
      limit: Number(limit),
      genre,
      ...sortOption,
      ...filters,
    });

    // Annotate with job status from DB
    const jellyfinIds = items.map((i) => i.jellyfinId);
    const jobRows = jellyfinIds.length
      ? db.get()
          .prepare(`SELECT jellyfin_id, status FROM jobs WHERE jellyfin_id IN (${jellyfinIds.map(() => '?').join(',')})`)
          .all(...jellyfinIds)
      : [];
    const jobMap = Object.fromEntries(jobRows.map((r) => [r.jellyfin_id, r.status]));

    return {
      items: items.map((i) => ({ ...i, jobStatus: jobMap[i.jellyfinId] || null })),
      total,
      page: Number(page),
      limit: Number(limit),
    };
  });

  fastify.get('/jellyfin/genres', async () => jf.getGenres());

  // Add RV tag
  fastify.post('/jellyfin/items/:id/tag', async (req, reply) => {
    const config = cfg.load();
    try {
      await jf.addTag(req.params.id, config.rvTag);
      return { ok: true };
    } catch (err) {
      fastify.log.error({ jellyfinId: req.params.id, err: err.message }, 'addTag failed');
      return reply.code(502).send({ error: err.message });
    }
  });

  // Remove RV tag
  fastify.delete('/jellyfin/items/:id/tag', async (req, reply) => {
    const config = cfg.load();
    try {
      await jf.removeTag(req.params.id, config.rvTag);
      return { ok: true };
    } catch (err) {
      fastify.log.error({ jellyfinId: req.params.id, err: err.message }, 'removeTag failed');
      return reply.code(502).send({ error: err.message });
    }
  });
}

module.exports = routes;
