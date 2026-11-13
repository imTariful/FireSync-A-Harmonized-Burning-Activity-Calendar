/**
 * FireSync server entry point.
 *
 * Express is the primary application API. All routes live in src/server/app.ts so they can
 * be tested without Vite. This file only configures the process:
 *   - development (NODE_ENV !== 'production'): Vite middleware for HMR
 *   - production (NODE_ENV === 'production'): static files from dist/ with an SPA fallback
 *
 * The production path is what the Docker image uses. It never mounts Vite, so the runtime
 * image does not need the Vite toolchain.
 *
 * F11 fix: dotenv.config() is called before any dynamic imports so that env vars such as
 * FIRESYNC_HISTORICAL_PARQUET are populated before historical.ts reads them at module-load
 * time. Static `import` statements are hoisted by the ES module loader and always run
 * before top-level code, so we use dynamic import() for the app factory instead.
 */

import dotenv from 'dotenv';
import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must run before any dynamic import() that transitively loads historical.ts or agnicalendar.ts,
// both of which read FIRESYNC_HISTORICAL_PARQUET at module-load time (top-level const).
dotenv.config();

const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const here = path.dirname(fileURLToPath(import.meta.url));

async function startServer() {
  // Dynamic import ensures dotenv.config() above has already populated process.env before
  // historical.ts / agnicalendar.ts are evaluated for the first time.
  const { createApp } = await import('./src/server/app');
  const { app, store } = createApp();

  if (isProduction) {
    const distDir = path.join(here, 'dist');
    const indexHtml = path.join(distDir, 'index.html');
    if (!existsSync(indexHtml)) {
      console.error(
        `Production mode requires a built frontend at ${distDir}. ` +
          'Run `npm run build` first. The server will not fall back to Vite in production.'
      );
      process.exit(1);
    }
    app.use(express.static(distDir, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      return res.sendFile(indexHtml);
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`FireSync server listening on http://0.0.0.0:${PORT} (${isProduction ? 'production' : 'development'})`);
    console.log(`Storage: ${store.kind} (${store.durable ? 'durable' : 'not durable'})`);
    console.log(`FIRMS ingestion configured: ${Boolean(process.env.FIRMS_MAP_KEY) ? 'yes' : 'no'}`);
    console.log('Local store starts empty; only completed real FIRMS ingestion jobs add records. Live NRT is fetched on demand.');
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
