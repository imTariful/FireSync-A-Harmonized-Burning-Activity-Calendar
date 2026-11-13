/**
 * Timeline bucketing (pure logic, no UI, no clock).
 *
 * Observations are grouped into fixed-width UTC time buckets. Buckets are aligned to
 * multiples of the bucket width from the Unix epoch, so any width that divides 24 h
 * aligns to UTC midnight.
 *
 * Science rules:
 * - MODIS and VIIRS are always kept as separate counts / FRP sums. Nothing here sums
 *   raw counts or FRP across sensors.
 * - Only buckets that contain at least one observation are returned (sparse). An absent
 *   bucket means "no loaded observation", NOT "no fire activity" or "no overpass".
 * - A bucket that ends after `now` is flagged `partial` (data still incomplete).
 */
import type { CanonicalObservation, SensorType } from '../types/fire';

const MS_PER_HOUR = 3_600_000;

export interface SensorBucketStats {
  /** Number of detections from this sensor in the bucket. */
  count: number;
  /** Sum of frp_mw for this sensor only. Missing / non-finite frp_mw adds 0. */
  frpSumMw: number;
}

export interface TimeBucket {
  /** Inclusive start, ms since epoch (UTC). */
  startMs: number;
  /** Exclusive end, ms since epoch (UTC). */
  endMs: number;
  MODIS: SensorBucketStats;
  VIIRS: SensorBucketStats;
  /** True when endMs > now: the bucket reaches into the future, so its data is incomplete. */
  partial: boolean;
}

export interface BucketingResult {
  /** Buckets with at least one observation, sorted by startMs ascending. */
  buckets: TimeBucket[];
  bucketHours: number;
  /** Observations skipped because datetime_utc was missing or not a parseable date. */
  skipped: number;
  /** Observations skipped because sensor was neither MODIS nor VIIRS (never merged into a sensor). */
  skippedSensor: number;
}

type TimelineObs = Pick<CanonicalObservation, 'datetime_utc' | 'sensor' | 'frp_mw'>;

/** Epoch ms of datetime_utc, or null when missing / unparseable. */
function parseMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function bucketMsOf(bucketHours: number): number {
  if (typeof bucketHours !== 'number' || !Number.isFinite(bucketHours) || bucketHours <= 0) {
    throw new RangeError(`bucketHours must be a finite number > 0 (got ${String(bucketHours)})`);
  }
  return bucketHours * MS_PER_HOUR;
}

/**
 * Group observations into UTC time buckets of `bucketHours`.
 *
 * @param now Injected "current time" in epoch ms (never read from the clock here).
 * @throws RangeError when bucketHours is not a finite number > 0, or `now` is not finite.
 */
export function bucketObservations(
  observations: readonly TimelineObs[],
  bucketHours: number,
  now: number,
): BucketingResult {
  const bucketMs = bucketMsOf(bucketHours);
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    throw new RangeError(`now must be a finite epoch-ms number (got ${String(now)})`);
  }

  const byStart = new Map<number, TimeBucket>();
  let skipped = 0;
  let skippedSensor = 0;

  for (const o of observations) {
    const t = parseMs(o?.datetime_utc);
    if (t === null) {
      skipped++;
      continue;
    }
    if (o.sensor !== 'MODIS' && o.sensor !== 'VIIRS') {
      skippedSensor++;
      continue;
    }
    const startMs = Math.floor(t / bucketMs) * bucketMs;
    let b = byStart.get(startMs);
    if (!b) {
      const endMs = startMs + bucketMs;
      b = {
        startMs,
        endMs,
        MODIS: { count: 0, frpSumMw: 0 },
        VIIRS: { count: 0, frpSumMw: 0 },
        partial: endMs > now,
      };
      byStart.set(startMs, b);
    }
    const s: SensorBucketStats = b[o.sensor as SensorType];
    s.count++;
    const frp = o.frp_mw;
    if (typeof frp === 'number' && Number.isFinite(frp)) s.frpSumMw += frp;
  }

  const buckets = [...byStart.values()].sort((a, b) => a.startMs - b.startMs);
  return { buckets, bucketHours, skipped, skippedSensor };
}

/**
 * Overall time span covered by the buckets: { startMs of the first, endMs of the last },
 * or null for an empty list. Buckets are sparse, so the span may contain gaps.
 */
export function bucketRange(
  buckets: readonly Pick<TimeBucket, 'startMs' | 'endMs'>[],
): { startMs: number; endMs: number } | null {
  if (buckets.length === 0) return null;
  let startMs = Infinity;
  let endMs = -Infinity;
  for (const b of buckets) {
    if (b.startMs < startMs) startMs = b.startMs;
    if (b.endMs > endMs) endMs = b.endMs;
  }
  return { startMs, endMs };
}

/**
 * Observations that fall inside buckets[index]: startMs <= time < endMs (inclusive start,
 * exclusive end). Input order is preserved. Returns [] for an out-of-range / non-integer
 * index. Observations with an invalid datetime_utc are never included.
 */
export function observationsInBucket<T extends Pick<CanonicalObservation, 'datetime_utc'>>(
  observations: readonly T[],
  buckets: readonly Pick<TimeBucket, 'startMs' | 'endMs'>[],
  index: number,
): T[] {
  if (!Number.isInteger(index) || index < 0 || index >= buckets.length) return [];
  const { startMs, endMs } = buckets[index];
  return observations.filter((o) => {
    const t = parseMs(o?.datetime_utc);
    return t !== null && t >= startMs && t < endMs;
  });
}

// ---------------------------------------------------------------------------
// Playback axis (pure logic, added for the timeline UI). Everything above is unchanged.
//
// Science rules kept here as well:
// - MODIS and VIIRS stay separate everywhere (per-step stats, cumulative counts). No sum across sensors.
// - A step with `hasData: false` means "no loaded observation in this window". It is NOT "no fire
//   activity" and NOT "no overpass". Its counts are 0 only because nothing was loaded.
// ---------------------------------------------------------------------------

/** Upper bound on playback steps (a few steps per second at most, setData runs once per step). */
export const MAX_TIMELINE_STEPS = 72;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** Candidate widths (hours). All divide 24 h, so steps align to UTC midnight. */
const WIDTH_LADDER = [1, 6, 12, 24] as const;

function alignedStepCount(firstMs: number, lastMs: number, bucketHours: number): number {
  const w = bucketHours * MS_PER_HOUR;
  return Math.floor(lastMs / w) - Math.floor(firstMs / w) + 1;
}

/**
 * Bucket width (hours) for a loaded time span [firstMs, lastMs] (first / last observation time).
 * 1 h when the span is <= 2 days, otherwise 6 h. If that would still exceed MAX_TIMELINE_STEPS the
 * width is widened (12 h, 24 h, then whole multiples of 24 h) so the axis never gets longer.
 * Non-finite or reversed input falls back to 1 h (an empty / single-point axis).
 */
export function chooseBucketHours(firstMs: number, lastMs: number): number {
  if (!Number.isFinite(firstMs) || !Number.isFinite(lastMs) || lastMs < firstMs) return 1;
  const spanMs = lastMs - firstMs;
  const start = spanMs <= 2 * MS_PER_DAY ? 0 : 1;
  for (let i = start; i < WIDTH_LADDER.length; i++) {
    if (alignedStepCount(firstMs, lastMs, WIDTH_LADDER[i]) <= MAX_TIMELINE_STEPS) return WIDTH_LADDER[i];
  }
  const days = Math.ceil(spanMs / MS_PER_DAY);
  return 24 * Math.max(1, Math.ceil(days / MAX_TIMELINE_STEPS));
}

/** Parsed-time cache: each observation's date is parsed once, never again per step / per frame. */
const timeCache = new WeakMap<object, number | null>();

function obsTimeMs(o: Pick<CanonicalObservation, 'datetime_utc'>): number | null {
  if (o === null || typeof o !== 'object') return null;
  const hit = timeCache.get(o);
  if (hit !== undefined) return hit;
  const t = parseMs(o.datetime_utc);
  timeCache.set(o, t);
  return t;
}

/** Epoch ms of the earliest and latest parseable observation (any sensor), or null if none. */
export function observationTimeSpan(
  observations: readonly Pick<CanonicalObservation, 'datetime_utc'>[],
): { firstMs: number; lastMs: number } | null {
  let firstMs = Infinity;
  let lastMs = -Infinity;
  for (const o of observations) {
    const t = obsTimeMs(o);
    if (t === null) continue;
    if (t < firstMs) firstMs = t;
    if (t > lastMs) lastMs = t;
  }
  return firstMs === Infinity ? null : { firstMs, lastMs };
}

export interface TimelineStep extends TimeBucket {
  /** Position on the axis (0-based). */
  index: number;
  /** False for a gap: no observation was loaded for this window (NOT zero activity). */
  hasData: boolean;
}

export interface TimelineAxis {
  bucketHours: number;
  /** Contiguous, equal-width steps from the first bucket's start to the last bucket's end. */
  steps: TimelineStep[];
  /** Axis start / end (ms), or null when there are no steps. */
  startMs: number | null;
  endMs: number | null;
  /** Observations skipped for a missing / unparseable datetime_utc. */
  skipped: number;
  /** Observations skipped for a sensor other than MODIS / VIIRS. */
  skippedSensor: number;
}

/**
 * Continuous axis over [first bucket start, last bucket end]. Buckets with data come from
 * bucketObservations; every hole between them becomes an explicit step with hasData = false.
 * @param bucketHours omit to choose it from the loaded span (chooseBucketHours).
 * @param now injected clock (epoch ms) for the `partial` flag.
 */
export function buildTimelineAxis(
  observations: readonly TimelineObs[],
  now: number,
  bucketHours?: number,
): TimelineAxis {
  let hours = bucketHours;
  if (hours === undefined) {
    const span = observationTimeSpan(observations);
    hours = span ? chooseBucketHours(span.firstMs, span.lastMs) : 1;
  }
  const { buckets, skipped, skippedSensor } = bucketObservations(observations, hours, now);
  const range = bucketRange(buckets);
  if (!range) return { bucketHours: hours, steps: [], startMs: null, endMs: null, skipped, skippedSensor };

  const w = hours * MS_PER_HOUR;
  const byStart = new Map(buckets.map((b) => [b.startMs, b]));
  const steps: TimelineStep[] = [];
  for (let s = range.startMs, i = 0; s < range.endMs; s += w, i++) {
    const b = byStart.get(s);
    steps.push(
      b
        ? { ...b, index: i, hasData: true }
        : {
            index: i,
            startMs: s,
            endMs: s + w,
            MODIS: { count: 0, frpSumMw: 0 },
            VIIRS: { count: 0, frpSumMw: 0 },
            partial: s + w > now,
            hasData: false,
          },
    );
  }
  return { bucketHours: hours, steps, startMs: range.startMs, endMs: range.endMs, skipped, skippedSensor };
}

export interface TimelineIndex<T> {
  axis: TimelineAxis;
  /** Observations per step (same order as the input). Skipped observations appear nowhere. */
  byStep: T[][];
  /** Running totals per sensor up to and including step i. Never summed across sensors. */
  cumulative: { MODIS: number[]; VIIRS: number[] };
}

/**
 * One pass over the observations: group them per axis step and derive per-sensor cumulative counts.
 * Observations with an invalid date, a non-MODIS/VIIRS sensor, or a time outside the axis are left out.
 */
export function indexTimeline<T extends TimelineObs>(
  observations: readonly T[],
  axis: TimelineAxis,
): TimelineIndex<T> {
  const n = axis.steps.length;
  const byStep: T[][] = Array.from({ length: n }, () => []);
  const perStep = { MODIS: new Array<number>(n).fill(0), VIIRS: new Array<number>(n).fill(0) };
  if (n > 0 && axis.startMs !== null && axis.endMs !== null) {
    const w = axis.bucketHours * MS_PER_HOUR;
    for (const o of observations) {
      if (o.sensor !== 'MODIS' && o.sensor !== 'VIIRS') continue;
      const t = obsTimeMs(o);
      if (t === null || t < axis.startMs || t >= axis.endMs) continue;
      const i = Math.floor((t - axis.startMs) / w);
      byStep[i].push(o);
      perStep[o.sensor as SensorType][i]++;
    }
  }
  const run = (a: number[]): number[] => {
    let acc = 0;
    return a.map((c) => (acc += c));
  };
  return { axis, byStep, cumulative: { MODIS: run(perStep.MODIS), VIIRS: run(perStep.VIIRS) } };
}

/**
 * Cutoff (epoch ms) for a step: the last millisecond inside it (endMs - 1). Detections "at or before
 * the cutoff" are exactly those with time < the step's exclusive end. Returns null for an out-of-range
 * or non-integer index (including an empty axis).
 */
export function stepCutoffMs(axis: Pick<TimelineAxis, 'steps'>, index: number): number | null {
  if (!Number.isInteger(index) || index < 0 || index >= axis.steps.length) return null;
  return axis.steps[index].endMs - 1;
}

/**
 * Observations to show at a step. 'cumulative' (default): everything up to and including the step.
 * 'step': only that step's own observations. Uses the prebuilt index, so no dates are parsed here.
 * Returns [] for an out-of-range index.
 */
export function observationsAtStep<T extends TimelineObs>(
  index: TimelineIndex<T>,
  step: number,
  mode: 'cumulative' | 'step' = 'cumulative',
): T[] {
  if (!Number.isInteger(step) || step < 0 || step >= index.byStep.length) return [];
  if (mode === 'step') return index.byStep[step].slice();
  const out: T[] = [];
  for (let i = 0; i <= step; i++) for (const o of index.byStep[i]) out.push(o);
  return out;
}

/**
 * Observations whose time is <= cutoffMs, input order preserved. Observations with a missing /
 * unparseable datetime_utc are excluded. Dates are parsed once per observation object (cached).
 */
export function observationsAtOrBefore<T extends Pick<CanonicalObservation, 'datetime_utc'>>(
  observations: readonly T[],
  cutoffMs: number,
): T[] {
  if (typeof cutoffMs !== 'number' || !Number.isFinite(cutoffMs)) return [];
  return observations.filter((o) => {
    const t = obsTimeMs(o);
    return t !== null && t <= cutoffMs;
  });
}
