/**
 * Express handler for GET /api/v1/fires (live NASA FIRMS hotspots).
 *
 * The upstream work is done by the shared LiveFiresService, so this route and every
 * `source=live` endpoint share one cache, one in-flight map and one rate budget.
 * MAP_KEY is read lazily, used only to build the upstream URL, and is masked in every
 * log line and every error string sent to the browser.
 */

import type { Request, RequestHandler, Response } from 'express';
import {
  FIRMS_DEFAULT_BASE_URL,
  FIRMS_SOURCES,
  RateBudget,
  TtlCache,
  describeError,
  validateArea,
} from '../utils/firms';
import {
  LiveFiresError,
  LiveFiresService,
  type LiveFiresPayload,
} from './liveFires';

export type FiresPayload = LiveFiresPayload;

export interface FiresHandlerDeps {
  getKey: () => string | undefined;
  getBaseUrl?: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  cache?: TtlCache<FiresPayload>;
  budget?: RateBudget;
  /** Max simultaneous upstream calls (default 2; FIRMS had failures when 3 were fired at once). */
  concurrency?: number;
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  /** Shared service (the app passes one so every live endpoint uses the same cache/budget). */
  service?: LiveFiresService;
}

export function createFiresHandler(deps: FiresHandlerDeps): RequestHandler {
  const service =
    deps.service ??
    new LiveFiresService({
      getKey: deps.getKey,
      getBaseUrl: deps.getBaseUrl,
      fetchImpl: deps.fetchImpl,
      now: deps.now,
      sleep: deps.sleep,
      cache: deps.cache,
      budget: deps.budget,
      concurrency: deps.concurrency,
      attempts: deps.attempts,
      baseDelayMs: deps.baseDelayMs,
      timeoutMs: deps.timeoutMs,
      logger: deps.logger,
    });
  const log = deps.logger ?? console;

  return async (req: Request, res: Response) => {
    try {
      const key = deps.getKey();
      if (!key || key === 'YOUR_NASA_FIRMS_MAP_KEY') {
        return res.status(503).json({
          error: 'The server has no NASA FIRMS key configured. Add FIRMS_MAP_KEY to .env and restart.',
          code: 'FIRMS_KEY_NOT_CONFIGURED',
        });
      }

      const check = validateArea(String(req.query.area ?? 'world'));
      if (!check.ok) return res.status(400).json({ error: check.reason });
      const area = check.area;

      const days = Math.min(Math.max(parseInt(String(req.query.days ?? '1'), 10) || 1, 1), 5);
      const cap = Math.min(Math.max(parseInt(String(req.query.cap ?? '20000'), 10) || 20000, 1000), 100000);

      const payload = await service.get({ area, days, cap });
      return res.json(payload);
    } catch (err) {
      if (err instanceof LiveFiresError) {
        for (const [h, v] of Object.entries(err.options.headers ?? {})) res.setHeader(h, v);
        return res.status(err.status).json({
          error: err.message,
          ...(err.options.errors ? { errors: err.options.errors } : {}),
        });
      }
      log.error(`[firms] unexpected error: ${describeError(err, deps.getKey())}`);
      return res.status(500).json({ error: 'Unexpected server error while loading fire data.' });
    }
  };
}

export { FIRMS_SOURCES, FIRMS_DEFAULT_BASE_URL };
