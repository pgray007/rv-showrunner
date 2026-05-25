'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const fastify = require('fastify')({ logger: { level: 'info' } });

const cfg = require('./config');
const db = require('./db');
const queue = require('./transcode/queue');
const scanner = require('./worker/scanner');

const DIST_PATH = path.join(__dirname, '../../dist');

async function start() {
  const config = cfg.load();
  db.init(cfg.getConfigRoot());

  // Reset any jobs stuck in transcoding from a previous crash
  db.get()
    .prepare("UPDATE jobs SET status='queued', updated_at=unixepoch() WHERE status='transcoding'")
    .run();

  // Plugins
  await fastify.register(require('@fastify/cors'), { origin: true });

  // Static files only exist after `npm run build` — skip in dev (Vite handles it)
  const distExists = fs.existsSync(DIST_PATH);
  if (distExists) {
    await fastify.register(require('@fastify/static'), {
      root: DIST_PATH,
      prefix: '/',
      decorateReply: true,
    });
  }

  // API routes
  fastify.register(require('./routes/health'), { prefix: '/' });
  fastify.register(require('./routes/settings'), { prefix: '/api' });
  fastify.register(require('./routes/jellyfin'), { prefix: '/api' });
  fastify.register(require('./routes/jobs'), { prefix: '/api' });

  // SPA fallback (production only — in dev Vite handles non-API routes)
  fastify.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.code(404).send({ error: 'Not found' });
    } else if (distExists) {
      reply.sendFile('index.html');
    } else {
      reply.code(200).type('text/html').send(
        `<p style="font-family:sans-serif">API server running. ` +
        `Open <a href="http://localhost:5173">http://localhost:5173</a> for the UI in dev mode.</p>`
      );
    }
  });

  const port = parseInt(process.env.PORT || '3000', 10);
  await fastify.listen({ port, host: '0.0.0.0' });
  fastify.log.info(`rv-showrunner listening on :${port} (static: ${distExists ? 'yes' : 'no — dev mode'})`);

  queue.start(config.maxConcurrentTranscodes);
  scanner.start(config.scanIntervalMinutes);
  scanner.runNow();
}

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
