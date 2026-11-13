/**
 * Shared live NASA FIRMS Area API loader.
 *
 * One instance is used by /api/v1/fires and by every endpoint that is asked for `source=live`,
 * so identical area/day requests share one upstream round-trip, one TTL cache and one rate budget.
 *
 * The service never invents observations. A failed source is reported in `errors`; if every
 * source fails, `get()` throws a LiveFiresError that carries the real HTTP classification.
 */

import type { CanonicalObservation } from '../types/fire';
import {
  FIRMS_DEFAULT_BASE_URL,
  FIRMS_SOURCES,
  FIRMS_TTL_MS,
  RateBudget,
  TtlCache,
  FirmsRequestError,
  capByFrp,
  classifyFailures,
  defaultSleep,
  describeError,
  fetchTextWithRetry,
  firmsCsvToObservations,
  mapSettledWithConcurrency,
  maskSecret,
} from '../utils/firms';

export interface LiveFiresPayload {
  total: number;
  truncated: boolean;
  errors: string[];
  observations: CanonicalObservation[];
  retrieved_at: string;
  cached: boolean;
  area: string;
  days: number;
  counts: { MODIS: number; VIIRS: number };
}

export interface LiveFiresQuery {
  area: string;
  days: number;
  cap: number;
}

export interface LiveFiresDeps {
  getKey: () => string | undefined;
  getBaseUrl?: () => string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  cache?: TtlCache<LiveFiresPayload>;
  budget?: RateBudget;
  /** Max simultaneous upstream calls (default 2; FIRMS had failures when 3 were fired at once). */
  concurrency?: number;
  attempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export class LiveFiresError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly options: { errors?: string[]; headers?: Record<string, string> } = {}
  ) {
    super(message);
    this.name = 'LiveFiresError';
  }
}

export class LiveFiresService {
  private readonly now: () => number;
  private readonly cache: TtlCache<LiveFiresPayload>;
  private readonly budget: RateBudget;
  private readonly log: Pick<Console, 'info' | 'warn' | 'error'>;
  private readonly inflight = new Map<string, Promise<LiveFiresPayload>>();

  constructor(private readonly deps: LiveFiresDeps) {
    this.now = deps.now ?? Date.now;
    this.cache = deps.cache ?? new TtlCache<LiveFiresPayload>(FIRMS_TTL_MS, 200, this.now);
    this.budget = deps.budget ?? new RateBudget(undefined, undefined, this.now);
    this.log = deps.logger ?? console;
  }

  async get(query: LiveFiresQuery): Promise<LiveFiresPayload> {
    const key = this.deps.getKey()?.trim();
    if (!key) {
      throw new LiveFiresError(503, 'The server has no NASA FIRMS key configured. Add FIRMS_MAP_KEY to .env and restart.', {
        errors: [],
      });
    }

    const area = query.area;
    const days = Math.min(Math.max(Math.trunc(query.days) || 1, 1), 5);
    const cap = Math.min(Math.max(Math.trunc(query.cap) || 20_000, 1), 100_000);
    const cacheKey = `${area}:${days}:${cap}`;

    const hit = this.cache.get(cacheKey);
    if (hit) return { ...hit, cached: true };

    let pending = this.inflight.get(cacheKey);
    if (!pending) {
      pending = this.load(key, area, days, cap, cacheKey).finally(() => this.inflight.delete(cacheKey));
      this.inflight.set(cacheKey, pending);
    }
    return pending;
  }

  private async load(
    key: string,
    area: string,
    days: number,
    cap: number,
    cacheKey: string
  ): Promise<LiveFiresPayload> {
    const baseUrl = (this.deps.getBaseUrl?.() ?? FIRMS_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const fetchImpl = this.deps.fetchImpl ?? fetch;

    // Fail fast (without touching NASA) if this request cannot fit in the remaining budget.
    const needed = days * FIRMS_SOURCES.length;
    if (this.budget.remaining() < needed) {
      const wait = this.budget.secondsUntilAvailable(needed);
      this.log.warn(`[firms] local rate budget exhausted; retry in ~${wait}s`);
      throw new LiveFiresError(429, 'Too many live-data requests right now. Please wait a few minutes and retry.', {
        headers: { 'Retry-After': String(wait) },
      });
    }

    const retrievedAt = new Date(this.now()).toISOString();
    const started = this.now();

    const results = await mapSettledWithConcurrency(
      FIRMS_SOURCES,
      this.deps.concurrency ?? 2,
      async (def) => {
        const url = `${baseUrl}/api/area/csv/${key}/${def.source}/${area}/${days}`;
        const csv = await fetchTextWithRetry(url, {
          attempts: this.deps.attempts ?? 3,
          baseDelayMs: this.deps.baseDelayMs ?? 800,
          timeoutMs: this.deps.timeoutMs ?? 60_000,
          fetchImpl,
          sleep: this.deps.sleep ?? defaultSleep,
          beforeAttempt: () => this.budget.tryConsume(days),
          onRetry: ({ attempt, delayMs, error }) =>
            this.log.warn(
              `[firms] ${def.source} attempt ${attempt} failed (${describeError(error, key)}); retrying in ${delayMs} ms`
            ),
        });
        return firmsCsvToObservations(csv, def, retrievedAt);
      }
    );

    const failures: unknown[] = [];
    const errors: string[] = [];
    let truncated = false;
    const observations: CanonicalObservation[] = [];

    results.forEach((r, i) => {
      const def = FIRMS_SOURCES[i];
      if (r.status === 'fulfilled') {
        const capped = capByFrp(r.value, cap); // keeps the strongest hotspots per source
        truncated ||= capped.truncated;
        observations.push(...capped.items);
        return;
      }
      failures.push(r.reason);
      // Full detail (incl. err.cause) goes to the server log only, with the key masked.
      this.log.error(`[firms] ${def.source} failed for area=${area} days=${days}: ${describeError(r.reason, key)}`);
      const brief =
        r.reason instanceof FirmsRequestError
          ? r.reason.status
            ? `HTTP ${r.reason.status}`
            : r.reason.kind === 'timeout'
              ? 'timeout'
              : 'network error'
          : maskSecret(r.reason instanceof Error ? r.reason.message : String(r.reason), key);
      errors.push(`${def.source}: ${brief}`);
    });

    this.log.info(
      `[firms] area=${area} days=${days} -> ${observations.length} detections, ${errors.length} source error(s), ${this.now() - started} ms`
    );

    if (observations.length === 0 && failures.length === FIRMS_SOURCES.length) {
      const summary = classifyFailures(failures);
      throw new LiveFiresError(summary.status, summary.message, { errors });
    }

    const payload: LiveFiresPayload = {
      total: observations.length,
      truncated,
      errors,
      observations,
      retrieved_at: retrievedAt,
      cached: false,
      area,
      days,
      counts: {
        MODIS: observations.filter((o) => o.sensor === 'MODIS').length,
        VIIRS: observations.filter((o) => o.sensor === 'VIIRS').length,
      },
    };
    // Never cache partial results, otherwise a one-off source failure would stick for 30 minutes.
    if (errors.length === 0) this.cache.set(cacheKey, payload);
    return payload;
  }
}
