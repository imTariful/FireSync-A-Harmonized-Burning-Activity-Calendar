/**
 * NASA FIRMS helpers (server side): CSV -> CanonicalObservation, area validation,
 * TTL cache, rate-limit budget, retry with backoff, concurrency limiting and secret masking.
 *
 * Everything here is dependency-injected / pure so it can be unit-tested without calling NASA.
 * MODIS and VIIRS stay separate sensors; nothing in this file sums or merges them.
 */

import { createHash } from 'node:crypto';
import type {
  CanonicalObservation,
  ConfidenceCategory,
  SatelliteType,
  SensorType,
} from '../types/fire';

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export interface FirmsSourceDef {
  source: string;
  sensor: SensorType;
  satellite?: SatelliteType;
}

/** NASA's current transition notice ends SNPP delivery 2026-11-02; use NOAA-20/21 for live VIIRS. */
export const FIRMS_SOURCES: readonly FirmsSourceDef[] = [
  { source: 'VIIRS_NOAA20_NRT', sensor: 'VIIRS', satellite: 'NOAA-20' },
  { source: 'VIIRS_NOAA21_NRT', sensor: 'VIIRS', satellite: 'NOAA-21' },
  { source: 'MODIS_NRT', sensor: 'MODIS' },
];

export const FIRMS_DEFAULT_BASE_URL = 'https://firms.modaps.eosdis.nasa.gov';
export const FIRMS_TTL_MS = 30 * 60 * 1000;
/** FIRMS documents 5,000 transactions per 10 minutes per MAP_KEY; stay well under it. */
export const FIRMS_RATE_LIMIT = 5000;
export const FIRMS_RATE_BUDGET = 4000;
export const FIRMS_RATE_WINDOW_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Area validation
// ---------------------------------------------------------------------------

export const AREA_PATTERN = /^(world|-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3})$/;

export type AreaCheck = { ok: true; area: string } | { ok: false; reason: string };

/** Validates `world` or `west,south,east,north` (format AND ranges, west < east, south < north). */
export function validateArea(area: string): AreaCheck {
  if (!AREA_PATTERN.test(area)) return { ok: false, reason: 'invalid area' };
  if (area === 'world') return { ok: true, area };
  const [west, south, east, north] = area.split(',').map(Number);
  if (west < -180 || east > 180 || south < -90 || north > 90) {
    return { ok: false, reason: 'area is outside -180..180 / -90..90' };
  }
  if (west >= east || south >= north) {
    return { ok: false, reason: 'area must satisfy west < east and south < north' };
  }
  return { ok: true, area };
}

// ---------------------------------------------------------------------------
// CSV -> CanonicalObservation
// ---------------------------------------------------------------------------

export class FirmsFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirmsFormatError';
  }
}

/** Splits one CSV line; understands double-quoted fields (FIRMS normally has none). */
export function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function firmsCsvToObservations(
  csv: string,
  def: FirmsSourceDef,
  retrievedAt: string
): CanonicalObservation[] {
  const text = csv.trim();
  if (!text) throw new FirmsFormatError(`${def.source}: empty response`);

  const lines = text.split(/\r?\n/);
  const cols = splitCsvLine(lines[0]);
  // FIRMS returns plain-text errors (invalid key, rate limit) instead of CSV
  if (!cols.includes('latitude')) {
    throw new FirmsFormatError(`${def.source}: ${lines[0].slice(0, 120)}`);
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^\d{4}$/;

  function isRealUtcDate(s: string): boolean {
    if (!DATE_RE.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  function isValidTime(s: string): boolean {
    if (!TIME_RE.test(s)) return false;
    return parseInt(s.slice(0, 2), 10) <= 23 && parseInt(s.slice(2), 10) <= 59;
  }

  const out: CanonicalObservation[] = [];
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const v = splitCsvLine(line);
    const get = (name: string) => {
      const i = cols.indexOf(name);
      return i >= 0 ? (v[i] ?? '') : '';
    };
    // F06 fix: validate coordinates before canonicalization — blank or
    // non-finite values must be rejected, never coerced to 0.
    const latRaw = get('latitude');
    const lonRaw = get('longitude');
    if (!latRaw || !lonRaw) continue;
    const lat = Number(latRaw);
    const lon = Number(lonRaw);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;

    const date = get('acq_date');
    if (!isRealUtcDate(date)) continue; // rejects empty, 'not-date', out-of-range values

    const rawTime = get('acq_time').padStart(4, '0');
    if (!isValidTime(rawTime)) continue; // rejects time=9999 etc.
    const time = rawTime;

    const frpRaw = get('frp');
    const frpVal = Number(frpRaw);
    if (!Number.isFinite(frpVal) || frpVal < 0) continue; // rejects negative or non-finite FRP
    const rawConf = get('confidence');
    // The legacy canonical schema requires these values. Fail this source explicitly
    // instead of inventing zero FRP/dimensions, confidence or daytime observations.
    const requiredNumber = (field: string): number => {
      const raw = get(field).trim();
      const n = raw ? Number(raw) : NaN;
      if (!Number.isFinite(n) || n < 0) throw new FirmsFormatError(`${def.source}: missing/invalid ${field}; source unavailable, not a zero measurement`);
      return n;
    };
    const frp = requiredNumber('frp');
    const scan = requiredNumber('scan');
    const track = requiredNumber('track');
    if (!['D', 'N'].includes(get('daynight'))) throw new FirmsFormatError(`${def.source}: missing/unknown daynight; no daytime default applied`);
    if (def.sensor === 'VIIRS' ? !['l', 'n', 'h'].includes(rawConf) : !rawConf.trim() || !Number.isFinite(Number(rawConf)) || Number(rawConf) < 0 || Number(rawConf) > 100) {
      throw new FirmsFormatError(`${def.source}: missing/unknown confidence; no nominal default applied`);
    }

    let confidence: number | string = rawConf;
    let category: ConfidenceCategory;
    if (def.sensor === 'VIIRS') {
      category = rawConf === 'h' ? 'high' : rawConf === 'l' ? 'low' : 'nominal';
    } else {
      const n = Number(rawConf);
      confidence = n;
      category = n >= 80 ? 'high' : n >= 30 ? 'nominal' : 'low';
    }

    const satellite: SatelliteType =
      def.satellite ?? (get('satellite').toUpperCase().startsWith('A') ? 'Aqua' : 'Terra');
    const key = `${def.source}|${satellite}|${lat}|${lon}|${date}|${time}`;
    const hash = createHash('sha256').update(key).digest('hex');

    out.push({
      id: `live-${hash.slice(0, 16)}`,
      source_record_id: key,
      latitude: lat,
      longitude: lon,
      acq_date: date,
      acq_time: time,
      datetime_utc: `${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`,
      sensor: def.sensor,
      satellite,
      product: def.source,
      processing_version: get('version'),
      confidence,
      confidence_category: category,
      frp_mw: frp,
      brightness: def.sensor === 'MODIS' ? Number(get('brightness')) || undefined : undefined,
      bright_ti4: def.sensor === 'VIIRS' ? Number(get('bright_ti4')) || undefined : undefined,
      bright_ti5: def.sensor === 'VIIRS' ? Number(get('bright_ti5')) || undefined : undefined,
      scan,
      track,
      // daynight was already validated to D/N above; never invent a classification.
      daynight: get('daynight') as 'D' | 'N',
      source_file: `FIRMS API ${def.source}`,
      retrieved_at: retrievedAt,
      quality_flags: '',
      record_hash: hash,
      // The record was parsed from a response returned by the official NASA FIRMS API
      // in this request. This is live-source provenance, not a claim about a local file.
      provenance_status: 'VERIFIED',
    });
  }
  return out;
}

/** Keeps the `cap` strongest (highest FRP) detections. Returns the same array when under the cap. */
export function capByFrp<T extends { frp_mw: number }>(
  items: T[],
  cap: number
): { items: T[]; truncated: boolean } {
  if (items.length <= cap) return { items, truncated: false };
  return { items: [...items].sort((a, b) => b.frp_mw - a.frp_mw).slice(0, cap), truncated: true };
}

// ---------------------------------------------------------------------------
// Secret masking
// ---------------------------------------------------------------------------

/** Removes the MAP_KEY (and any `/csv/<key>/` URL segment) from a string. */
export function maskSecret(text: string, secret?: string): string {
  let out = text;
  if (secret) out = out.split(secret).join('***');
  return out.replace(/(\/(?:area|country)\/csv\/)[^/\s]+/gi, '$1***');
}

/** One-line description of an error including its `cause` chain (fetch failures hide the reason there). */
export function describeError(err: unknown, secret?: string): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 4; depth++) {
    if (cur instanceof Error) {
      const code = (cur as { code?: unknown }).code;
      parts.push(`${cur.name}: ${cur.message}${code ? ` [${String(code)}]` : ''}`);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return maskSecret(parts.join(' <- '), secret);
}

// ---------------------------------------------------------------------------
// TTL cache
// ---------------------------------------------------------------------------

export class TtlCache<T> {
  private readonly store = new Map<string, { t: number; value: T }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 200,
    private readonly now: () => number = Date.now
  ) {}

  get(key: string): T | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (this.now() - hit.t >= this.ttlMs) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: T): void {
    this.store.delete(key);
    if (this.store.size >= this.maxEntries) this.evict();
    this.store.set(key, { t: this.now(), value });
  }

  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  private evict(): void {
    const t = this.now();
    for (const [k, v] of this.store) {
      if (t - v.t >= this.ttlMs) this.store.delete(k);
    }
    // still full: drop oldest insertion
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------------------
// Rate-limit budget (sliding window)
// ---------------------------------------------------------------------------

export class RateBudget {
  private events: { t: number; w: number }[] = [];

  constructor(
    private readonly limit: number = FIRMS_RATE_BUDGET,
    private readonly windowMs: number = FIRMS_RATE_WINDOW_MS,
    private readonly now: () => number = Date.now
  ) {}

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    this.events = this.events.filter((e) => e.t > cutoff);
  }

  used(): number {
    this.prune();
    return this.events.reduce((s, e) => s + e.w, 0);
  }

  remaining(): number {
    return Math.max(0, this.limit - this.used());
  }

  /** Records `weight` transactions if they fit; returns false (and records nothing) otherwise. */
  tryConsume(weight = 1): boolean {
    if (this.remaining() < weight) return false;
    this.events.push({ t: this.now(), w: weight });
    return true;
  }

  /** Seconds until enough budget frees up for `weight` (0 if it fits now). */
  secondsUntilAvailable(weight = 1): number {
    if (this.remaining() >= weight) return 0;
    this.prune();
    let free = this.remaining();
    for (const e of this.events) {
      free += e.w;
      if (free >= weight) return Math.max(1, Math.ceil((e.t + this.windowMs - this.now()) / 1000));
    }
    return Math.ceil(this.windowMs / 1000);
  }
}

// ---------------------------------------------------------------------------
// Fetch with retry + backoff
// ---------------------------------------------------------------------------

export class FirmsRequestError extends Error {
  readonly responseText?: string;

  constructor(
    message: string,
    readonly kind: 'http' | 'network' | 'timeout' | 'budget',
    readonly retryable: boolean,
    readonly status?: number,
    options?: { cause?: unknown; responseText?: string }
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'FirmsRequestError';
    this.responseText = options?.responseText;
  }
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Called before every attempt (1-based). Return false to stop (e.g. rate budget exhausted). */
  beforeAttempt?: (attempt: number) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; error: FirmsRequestError }) => void;
  random?: () => number;
}

export const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** GETs `url` as text. Retries network errors, timeouts, 408/429/5xx with exponential backoff + jitter. */
export async function fetchTextWithRetry(url: string, opts: RetryOptions): Promise<string> {
  const random = opts.random ?? Math.random;
  let lastError: FirmsRequestError | undefined;

  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    if (opts.beforeAttempt && !opts.beforeAttempt(attempt)) {
      throw new FirmsRequestError(
        'FIRMS request budget exhausted',
        'budget',
        false,
        undefined,
        lastError ? { cause: lastError } : undefined
      );
    }

    try {
      const res = await opts.fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs) });
      if (!res.ok) {
        // Keep a short response body so callers can distinguish an invalid MAP_KEY
        // (FIRMS returns HTTP 400 for this) from a genuinely transient outage.
        let responseText: string | undefined;
        try {
          responseText = (await res.text()).slice(0, 300) || undefined;
        } catch {
          responseText = undefined;
        }
        throw new FirmsRequestError(
          `HTTP ${res.status}`,
          'http',
          isRetryableStatus(res.status),
          res.status,
          { responseText }
        );
      }
      return await res.text();
    } catch (e) {
      if (e instanceof FirmsRequestError) lastError = e;
      else if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
        lastError = new FirmsRequestError(`timeout after ${opts.timeoutMs} ms`, 'timeout', true, undefined, {
          cause: e,
        });
      } else {
        lastError = new FirmsRequestError(
          e instanceof Error ? e.message : String(e),
          'network',
          true,
          undefined,
          { cause: e }
        );
      }

      if (!lastError.retryable || attempt === opts.attempts) throw lastError;
      const delayMs = Math.round(opts.baseDelayMs * 2 ** (attempt - 1) * (1 + random() * 0.25));
      opts.onRetry?.({ attempt, delayMs, error: lastError });
      await opts.sleep(delayMs);
    }
  }
  // unreachable, keeps the type checker happy
  throw lastError ?? new FirmsRequestError('no attempts made', 'network', false);
}

// ---------------------------------------------------------------------------
// Concurrency-limited settled map
// ---------------------------------------------------------------------------

/** Like Promise.allSettled(items.map(fn)) but runs at most `limit` calls at once; keeps input order. */
export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// User-facing failure classification
// ---------------------------------------------------------------------------

export interface FailureSummary {
  status: 429 | 502 | 504;
  message: string;
}

/** Turns per-source failures into one HTTP status + a message that is safe to show to end users. */
export function classifyFailures(failures: unknown[]): FailureSummary {
  const rateLimited = failures.some(
    (f) =>
      (f instanceof FirmsRequestError && (f.status === 429 || f.kind === 'budget')) ||
      (f instanceof FirmsFormatError && /exceed|limit|too many|transaction/i.test(f.message))
  );
  if (rateLimited) {
    return {
      status: 429,
      message:
        'NASA FIRMS is limiting requests right now (rate limit). Please wait a few minutes and retry.',
    };
  }
  const badKey = failures.some(
    (f) =>
      (f instanceof FirmsRequestError &&
        (f.status === 401 ||
          f.status === 403 ||
          (f.status === 400 && /invalid|map_?key|unauthor/i.test(f.responseText ?? '')))) ||
      (f instanceof FirmsFormatError && /invalid|map_key|unauthor/i.test(f.message))
  );
  if (badKey) {
    return {
      status: 502,
      message: 'NASA FIRMS rejected the server key. Check FIRMS_MAP_KEY in .env and restart the server.',
    };
  }
  if (failures.length > 0 && failures.every((f) => f instanceof FirmsRequestError && f.kind === 'timeout')) {
    return {
      status: 504,
      message: 'NASA FIRMS took too long to answer. Zoom in to a smaller area, or retry in a moment.',
    };
  }
  const network = failures.some((f) => f instanceof FirmsRequestError && f.kind === 'network');
  return {
    status: 502,
    message: network
      ? 'Could not reach NASA FIRMS (network error). Check the connection and retry.'
      : 'NASA FIRMS is temporarily unavailable. Please retry in a minute.',
  };
}
