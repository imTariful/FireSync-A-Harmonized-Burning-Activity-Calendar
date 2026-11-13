/**
 * Fire watchlists and deterministic alerts.
 *
 * A watchlist is a saved bbox + threshold condition. A scheduler evaluates each active
 * watchlist against freshly loaded live NRT observations; when the deterministic condition is
 * met, alerts require previously unseen observation fingerprints. Alerts are delivered
 * in-app only: there is no email/push channel in this deployment, and that is stated in every
 * response rather than implied.
 *
 * Durability: JsonWatchlistStore persists to a JSON file (atomic rename, same pattern as the
 * observation store). MemoryWatchlistStore is used in tests. The scheduler is in-process: it
 * runs only while the server runs and does not backfill windows missed while it was down.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { clusterObservations } from '../utils/fireIntelligence';
import type { CanonicalObservation } from '../types/fire';
import { isValidBbox } from './ai/schema';

export const WATCHLIST_MAX_DAYS = 5;
export const WATCHLIST_MAX_LISTS = 50;
export const WATCHLIST_MAX_ALERTS = 500;

export interface WatchCondition {
  trigger?: 'detections' | 'clusters';
  sensors: 'ALL' | 'MODIS' | 'VIIRS';
  /** Evaluation window in days, clamped to the live NRT range. */
  days: number;
  /** Trigger when at least this many matching detections occur in the window. */
  min_detections: number;
  /** Optional: only detections at or above this FRP (MW) count toward min_detections. */
  min_frp_mw?: number;
}

export interface Watchlist {
  last_error?: string | null;
  /** Fingerprints retained for the entire live-query horizon, persisted with the watchlist. */
  seen_observations?: Record<string, string>;
  id: string;
  name: string;
  bbox: string;
  condition: WatchCondition;
  created_at: string;
  paused: boolean;
  last_evaluated_at: string | null;
  last_counts: { MODIS: number; VIIRS: number; total: number } | null;
}

export interface WatchAlert {
  new_detections?: number;
  first_acquisition_utc?: string;
  last_acquisition_utc?: string;
  potential_clusters?: number;
  id: string;
  watchlist_id: string;
  watchlist_name: string;
  /** UTC date of the trigger; dedup is one alert per watchlist per day. */
  date: string;
  triggered_at: string;
  reason: string;
  counts: { MODIS: number; VIIRS: number; total: number };
  condition: WatchCondition;
  acknowledged: boolean;
}

/** Internal dedup state is persisted, never shipped in UI responses. */
export function publicWatchlist(watchlist: Watchlist): Omit<Watchlist, 'seen_observations'> {
  const { seen_observations: _seen, ...visible } = watchlist;
  return visible;
}

export interface WatchlistEvaluation {
  triggered: boolean;
  reason: string;
  counts: { MODIS: number; VIIRS: number; total: number };
}

/** Deterministic threshold check. No model involvement: the same inputs always give the same answer. */
export function evaluateWatchlist(
  watchlist: Watchlist,
  observations: readonly CanonicalObservation[]
): WatchlistEvaluation {
  const { condition } = watchlist;
  const matching = observations.filter((o) => {
    if (condition.sensors !== 'ALL' && o.sensor !== condition.sensors) return false;
    if (condition.min_frp_mw !== undefined && o.frp_mw < condition.min_frp_mw) return false;
    return true;
  });
  const counts = {
    MODIS: matching.filter((o) => o.sensor === 'MODIS').length,
    VIIRS: matching.filter((o) => o.sensor === 'VIIRS').length,
    total: matching.length,
  };
  const frpNote =
    condition.min_frp_mw !== undefined ? ` with FRP ≥ ${condition.min_frp_mw} MW` : '';
  const clusters = condition.trigger === 'clusters' ? clusterObservations(matching) : null;
  const clusterCount = clusters?.clusters.filter((c) => c.detection_count >= condition.min_detections).length ?? 0;
  const triggered = clusters ? clusterCount > 0 : Math.max(counts.MODIS, counts.VIIRS) >= condition.min_detections;
  return {
    triggered,
    reason: triggered
      ? clusters ? `${clusterCount} potential hotspot cluster(s) meet the source-record threshold (${condition.min_detections}); 5 km/24 h single linkage; not confirmed fire incidents.` : `MODIS ${counts.MODIS}; VIIRS ${counts.VIIRS}${frpNote}: at least one sensor meets ${condition.min_detections} in ${condition.days} day(s).`
      : `MODIS ${counts.MODIS}; VIIRS ${counts.VIIRS}: threshold of ${condition.min_detections} required${frpNote}${clusters ? ' in a potential cluster' : ' per sensor'}.`,
    counts,
  };
}

export interface WatchlistStoreSnapshot {
  version: number;
  watchlists: Watchlist[];
  alerts: WatchAlert[];
  updated_at: string;
}

export interface WatchlistStore {
  readonly kind: 'memory' | 'json_file';
  readonly durable: boolean;
  readonly location: string;
  listWatchlists(): Watchlist[];
  getWatchlist(id: string): Watchlist | undefined;
  saveWatchlist(watchlist: Watchlist): void;
  deleteWatchlist(id: string): boolean;
  listAlerts(limit?: number): WatchAlert[];
  getAlert(id: string): WatchAlert | undefined;
  addAlert(alert: WatchAlert): void;
  acknowledgeAlert(id: string): boolean;
  /** Returns true when an alert for this watchlist already exists on this UTC date. */
  hasAlertForDate(watchlistId: string, date: string): boolean;
  flush(): void;
}

export class MemoryWatchlistStore implements WatchlistStore {
  readonly kind: WatchlistStore['kind'] = 'memory';
  readonly durable: boolean = false;
  readonly location: string = 'process memory (not durable)';
  protected watchlists: Watchlist[] = [];
  protected alerts: WatchAlert[] = [];

  listWatchlists(): Watchlist[] {
    return this.watchlists;
  }
  getWatchlist(id: string): Watchlist | undefined {
    return this.watchlists.find((w) => w.id === id);
  }
  saveWatchlist(watchlist: Watchlist): void {
    const index = this.watchlists.findIndex((w) => w.id === watchlist.id);
    if (index >= 0) this.watchlists[index] = watchlist;
    else this.watchlists.unshift(watchlist);
  }
  deleteWatchlist(id: string): boolean {
    const before = this.watchlists.length;
    this.watchlists = this.watchlists.filter((w) => w.id !== id);
    this.alerts = this.alerts.filter((a) => a.watchlist_id !== id);
    return this.watchlists.length !== before;
  }
  listAlerts(limit = WATCHLIST_MAX_ALERTS): WatchAlert[] {
    return this.alerts.slice(0, limit);
  }
  getAlert(id: string): WatchAlert | undefined {
    return this.alerts.find((a) => a.id === id);
  }
  addAlert(alert: WatchAlert): void {
    this.alerts.unshift(alert);
    if (this.alerts.length > WATCHLIST_MAX_ALERTS) this.alerts.length = WATCHLIST_MAX_ALERTS;
  }
  acknowledgeAlert(id: string): boolean {
    const alert = this.alerts.find((a) => a.id === id);
    if (!alert) return false;
    alert.acknowledged = true;
    return true;
  }
  hasAlertForDate(watchlistId: string, date: string): boolean {
    return this.alerts.some((a) => a.watchlist_id === watchlistId && a.date === date);
  }
  flush(): void {}
}

export class JsonWatchlistStore extends MemoryWatchlistStore {
  readonly kind: WatchlistStore['kind'] = 'json_file';
  readonly durable: boolean = true;
  readonly location: string;
  private readonly path: string;

  constructor(path: string) {
    super();
    this.path = path;
    this.location = `JSON file: ${path}`;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<WatchlistStoreSnapshot>;
      if (Array.isArray(parsed.watchlists)) this.watchlists = parsed.watchlists;
      if (Array.isArray(parsed.alerts)) this.alerts = parsed.alerts;
    } catch (err) {
      // F16 fix: quarantine the corrupt file by renaming it, then throw so callers
      // see the error rather than silently starting with an empty watchlist store.
      const quarantine = `${this.path}.corrupt.${Date.now()}`;
      try {
        renameSync(this.path, quarantine);
      } catch {
        // If rename fails, leave in place and still propagate the original error.
      }
      throw new Error(
        `Corrupt watchlist store at ${this.path} (quarantined to ${quarantine}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  private persist(): void {
    const snapshot: WatchlistStoreSnapshot = {
      version: 1,
      watchlists: this.watchlists,
      alerts: this.alerts,
      updated_at: new Date().toISOString(),
    };
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }

  override saveWatchlist(watchlist: Watchlist): void {
    super.saveWatchlist(watchlist);
    this.persist();
  }
  override deleteWatchlist(id: string): boolean {
    const removed = super.deleteWatchlist(id);
    if (removed) this.persist();
    return removed;
  }
  override addAlert(alert: WatchAlert): void {
    super.addAlert(alert);
    this.persist();
  }
  override acknowledgeAlert(id: string): boolean {
    const ok = super.acknowledgeAlert(id);
    if (ok) this.persist();
    return ok;
  }
  override flush(): void {
    this.persist();
  }
}

export function createWatchlistStoreFromEnv(
  env: NodeJS.ProcessEnv = process.env
): WatchlistStore {
  const path = env.FIRESYNC_WATCHLIST_PATH?.trim();
  if (path) return new JsonWatchlistStore(path);
  return new MemoryWatchlistStore();
}

// --------------------------------------------------------------------------- request validation

export interface WatchlistCreateInput {
  name: string;
  bbox: string;
  condition: WatchCondition;
}

export type WatchlistParse =
  | { ok: true; value: WatchlistCreateInput }
  | { ok: false; error: string };

export function parseWatchlistCreate(body: unknown): WatchlistParse {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const raw = body as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 80) : '';
  if (!name) return { ok: false, error: 'name is required (1-80 characters).' };
  const bbox = typeof raw.bbox === 'string' ? raw.bbox.trim() : '';
  if (!isValidBbox(bbox)) {
    return { ok: false, error: 'bbox must be "west,south,east,north" with west<east and south<north.' };
  }
  const cond = (raw.condition ?? {}) as Record<string, unknown>;
  if (cond.trigger !== undefined && cond.trigger !== 'detections' && cond.trigger !== 'clusters') return { ok: false, error: 'trigger must be detections or clusters.' };
  const sensors = cond.sensors === 'MODIS' || cond.sensors === 'VIIRS' ? cond.sensors : 'ALL';
  const days = Number(cond.days ?? 1);
  if (!Number.isInteger(days) || days < 1 || days > WATCHLIST_MAX_DAYS) {
    return { ok: false, error: `condition.days must be an integer from 1 to ${WATCHLIST_MAX_DAYS}.` };
  }
  const minDetections = Number(cond.min_detections);
  if (!Number.isInteger(minDetections) || minDetections < 1 || minDetections > 1_000_000) {
    return { ok: false, error: 'condition.min_detections must be an integer >= 1.' };
  }
  let minFrp: number | undefined;
  if (cond.min_frp_mw !== undefined && cond.min_frp_mw !== null) {
    const frp = Number(cond.min_frp_mw);
    if (!Number.isFinite(frp) || frp < 0 || frp > 100_000) {
      return { ok: false, error: 'condition.min_frp_mw must be a non-negative number.' };
    }
    minFrp = frp;
  }
  return {
    ok: true,
    value: {
      name,
      bbox,
      condition: { sensors, days, min_detections: minDetections, ...(cond.trigger ? { trigger: cond.trigger as 'detections' | 'clusters' } : {}), ...(minFrp !== undefined ? { min_frp_mw: minFrp } : {}) },
    },
  };
}

// --------------------------------------------------------------------------- scheduler

export interface WatchlistEvaluationRecord {
  watchlist: Watchlist;
  evaluation: WatchlistEvaluation;
  alert: WatchAlert | null;
}

/**
 * Evaluate one watchlist against already-loaded observations, persist last-seen counts and
 * record alerts only when new observation fingerprints are present. Shared by the scheduler and the
 * manual "check now" route so both paths behave identically.
 */
export function recordWatchlistEvaluation(
  store: WatchlistStore,
  watchlist: Watchlist,
  observations: readonly CanonicalObservation[],
  now: () => Date = () => new Date(),
  newId: (prefix: string) => string = (prefix) =>
    `${prefix}-${now().getTime()}-${Math.random().toString(36).slice(2, 8)}`
): WatchlistEvaluationRecord {
  const current = store.getWatchlist(watchlist.id) ?? watchlist;
  const cutoff = new Date(now().getTime() - 6 * 86400000).toISOString();
  const seen = Object.fromEntries(Object.entries(current.seen_observations ?? {}).filter(([, time]) => time >= cutoff));
  const fingerprint = (o: CanonicalObservation) => createHash('sha256').update([o.sensor, o.satellite, o.latitude, o.longitude, o.acq_date, o.acq_time].join('|')).digest('hex');
  const [west, south, east, north] = watchlist.bbox.split(',').map(Number);
  const start = new Date(now().getTime() - (watchlist.condition.days - 1) * 86400000).toISOString().slice(0, 10);
  const end = now().toISOString().slice(0, 10);
  const unique = new Map<string, CanonicalObservation>();
  for (const o of observations) {
    if (o.longitude < west || o.longitude > east || o.latitude < south || o.latitude > north || o.acq_date < start || o.acq_date > end) continue;
    if (watchlist.condition.sensors !== 'ALL' && o.sensor !== watchlist.condition.sensors) continue;
    if (watchlist.condition.min_frp_mw !== undefined && o.frp_mw < watchlist.condition.min_frp_mw) continue;
    unique.set(fingerprint(o), o);
  }
  const fresh = [...unique.entries()].filter(([key]) => !seen[key]);
  const evaluation = evaluateWatchlist(watchlist, watchlist.condition.trigger === 'clusters' ? fresh.map(([, o]) => o) : [...unique.values()]);
  for (const [key, o] of unique) seen[key] = o.datetime_utc;
  if (Object.keys(seen).length > 100_000) throw new Error('Watchlist exceeds 100000 observations; narrow the area to preserve reliable deduplication.');
  const updated: Watchlist = {
    ...watchlist,
    last_evaluated_at: now().toISOString(),
    last_counts: evaluation.counts,
    seen_observations: seen,
    last_error: null,
  };
  store.saveWatchlist(updated);
  const today = now().toISOString().slice(0, 10);
  let alert: WatchAlert | null = null;
  if (evaluation.triggered && fresh.length > 0) {
    const times = fresh.map(([, o]) => o.datetime_utc).sort();
    alert = {
      id: newId('alert'),
      watchlist_id: watchlist.id,
      watchlist_name: watchlist.name,
      date: today,
      triggered_at: now().toISOString(),
      reason: evaluation.reason,
      counts: evaluation.counts,
      condition: watchlist.condition,
      acknowledged: false,
      new_detections: fresh.length,
      first_acquisition_utc: times[0],
      last_acquisition_utc: times[times.length - 1],
    };
    store.addAlert(alert);
  }
  return { watchlist: updated, evaluation, alert };
}

export interface WatchlistSchedulerDeps {
  store: WatchlistStore;
  /** Load observations for one watchlist's window; the caller decides live vs store. */
  load: (watchlist: Watchlist) => Promise<CanonicalObservation[]>;
  now?: () => Date;
  newId?: (prefix: string) => string;
  onError?: (watchlistId: string, error: unknown) => void;
}

export interface WatchlistScheduler {
  running: boolean;
  intervalMinutes: number;
  runOnce(): Promise<{ evaluated: number; alerts: number }>;
  start(intervalMinutes: number): void;
  stop(): void;
}

/**
 * Evaluate every unpaused watchlist and record alerts only when new observation fingerprints are present.
 * Failures on one watchlist never block the others and are reported through onError.
 */
export function createWatchlistScheduler(deps: WatchlistSchedulerDeps): WatchlistScheduler {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? ((prefix: string) => `${prefix}-${now().getTime()}-${Math.random().toString(36).slice(2, 8)}`);
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let evaluating = false;

  const runOnce = async (): Promise<{ evaluated: number; alerts: number }> => {
    if (evaluating) return { evaluated: 0, alerts: 0 };
    evaluating = true;
    try {
      let evaluated = 0;
      let alerts = 0;
      for (const watchlist of deps.store.listWatchlists()) {
        if (watchlist.paused) continue;
        try {
          const observations = await deps.load(watchlist);
          const record = recordWatchlistEvaluation(
            deps.store,
            watchlist,
            observations,
            now,
            newId
          );
          evaluated += 1;
          if (record.alert) alerts += 1;
        } catch (err) {
          deps.store.saveWatchlist({ ...(deps.store.getWatchlist(watchlist.id) ?? watchlist), last_error: 'Live evaluation failed; last successful counts are retained. Retry or check source availability.' });
          deps.onError?.(watchlist.id, err);
        }
      }
      return { evaluated, alerts };
    } finally {
      evaluating = false;
    }
  };

  return {
    get running() {
      return running;
    },
    intervalMinutes: 0,
    runOnce,
    start(intervalMinutes: number) {
      if (timer) return;
      running = true;
      timer = setInterval(() => {
        void runOnce().catch(() => undefined);
      }, Math.max(1, intervalMinutes) * 60_000);
      // Never keep the process alive for the scheduler alone.
      if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      running = false;
    },
  };
}
