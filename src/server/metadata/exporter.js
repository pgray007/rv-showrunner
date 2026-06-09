'use strict';
const fs = require('fs');
const path = require('path');
const mediaSource = require('../media/source');
const logger = require('../logger');

function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildMovieNfo(item) {
  const ids = item.providerIds || {};
  const runtime = item.runtime || '';
  const genres = (item.genres || []).map((g) => `  <genre>${escapeXml(g)}</genre>`).join('\n');
  const studios = (item.studios || []).map((s) => `  <studio>${escapeXml(s)}</studio>`).join('\n');

  const uniqueIds = Object.entries(ids)
    .map(([type, id]) =>
      `  <uniqueid type="${escapeXml(type.toLowerCase())}">${escapeXml(id)}</uniqueid>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<movie>
  <title>${escapeXml(item.title)}</title>
  <originaltitle>${escapeXml(item.title)}</originaltitle>
  <year>${item.year || ''}</year>
  <plot>${escapeXml(item.overview)}</plot>
  <runtime>${runtime}</runtime>
${genres}
${studios}
${uniqueIds}
</movie>`;
}

async function exportMovie(job, destDir, config) {
  const source = mediaSource.getActive(config);
  const itemId = job.source_item_id || job.jellyfin_id;
  let itemData;
  try {
    itemData = await source.client.getItem(itemId);
  } catch (err) {
    logger.warn('metadata', `Could not fetch ${source.label} item data for ${itemId}`, err.message);
    return;
  }

  // NFO
  const nfo = buildMovieNfo(itemData);
  fs.writeFileSync(path.join(destDir, 'movie.nfo'), nfo, 'utf8');

  // Poster
  if (itemData.imageUrl) {
    try {
      await source.client.downloadImage(itemId, 'Primary', path.join(destDir, 'poster.jpg'));
    } catch (err) {
      logger.warn('metadata', `Could not download poster for ${itemId}`, err.message);
    }
  }

  // Backdrop / fanart
  if (itemData.backdropUrl) {
    try {
      await source.client.downloadImage(itemId, 'Backdrop', path.join(destDir, 'fanart.jpg'));
    } catch (err) {
      logger.warn('metadata', `Could not download fanart for ${itemId}`, err.message);
    }
  }
}

module.exports = { exportMovie, buildMovieNfo };
