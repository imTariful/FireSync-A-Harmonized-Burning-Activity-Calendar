/**
 * Deterministic fire-intelligence calculations for the AI features.
 *
 * Everything here is pure: no network, no model, no randomness. The Groq layer may only describe
 * these results, never produce them. Clusters are always labelled candidate groups, because a group
 * of satellite thermal anomalies is not a confirmed wildfire.
 */

import type { CanonicalObservation } from '../types/fire';
import { aggregateToSpatialTemporalGrid, HARMONIZATION_CONSTANTS } from './harmonization';
import { haversineDistanceKm } from './spatial';

// --------------------------------------------------------------------------- clustering

export interface ClusterOptions {
  /** Max distance between linked detections (single linkage), km. Default 5. */
  linkKm?: number;
  /** Max time between linked detections, hours. Default 24. */
  linkHours?: number;
  /** Upper bound on returned clusters (largest first). Default 50. */
  maxClusters?: number;
  /** Upper bound on observations analysed. Default 5000. */
  maxDetections?: number;
}

export interface ResolvedClusterOptions {
  linkKm: number;
  linkHours: number;
  maxClusters: number;
  maxDetections: number;
}

export const CLUSTER_DEFAULTS: ResolvedClusterOptions = {
  linkKm: 5,
  linkHours: 24,
  maxClusters: 50,
  maxDetections: 5_000,
};

export type ClusterEvolutionPhase = 'single_pass' | 'increasing' | 'steady' | 'decreasing' | 'fading';

export interface ClusterEvolution {
  /**
   * Deterministic summary of how detections are distributed inside the cluster's own time span.
   * 'single_pass' means the whole group fits inside ~24 h, so no trend can be claimed.
   * 'fading' means no detection in the last 24 h of the analysed window's latest activity.
   */
  phase: ClusterEvolutionPhase;
  /** Detections within 24 h before the latest detection seen in this analysis. */
  recent_24h_detections: number;
  /** Detections in the first half of the cluster's active span vs the second half. */
  early_half_detections: number;
  late_half_detections: number;
}

export interface HotspotCluster {
  id: string;
  /** Fixed wording: this is a group of detections, not a confirmed fire. */
  label: 'candidate_hotspot_group';
  detection_count: number;
  by_sensor: { MODIS: number; VIIRS: number };
  centroid: { latitude: number; longitude: number };
  bbox: { west: number; south: number; east: number; north: number };
  first_detection_utc: string;
  last_detection_utc: string;
  duration_hours: number;
  active_days: number;
  /** Per-day detection counts inside the cluster, always separated by sensor. */
  daily_counts: Array<{ date: string; MODIS: number; VIIRS: number }>;
  evolution: ClusterEvolution;
  frp_mw: { MODIS: number; VIIRS: number; mean: number; max: number };
  satellites: string[];
  active_1km_cells: number;
  mean_confidence: number | null;
  notes: string[];
}

export interface ClusterResult {
  clusters: HotspotCluster[];
  /** Groups found before the maxClusters cap, so a capped list is never reported as the total. */
  found_clusters: number;
  total_detections: number;
  analysed_detections: number;
  truncated: boolean;
  options: ResolvedClusterOptions;
  notes: string[];
}

function confidenceNumber(value: number | string): number | null {
  if (typeof value === 'number') return value;
  if (value === 'high') return 80;
  if (value === 'nominal') return 50;
  if (value === 'low') return 20;
  return null;
}

function resolveOptions(options: ClusterOptions): ResolvedClusterOptions {
  const linkKm = Number.isFinite(options.linkKm) && (options.linkKm as number) > 0 ? (options.linkKm as number) : CLUSTER_DEFAULTS.linkKm;
  const linkHours =
    Number.isFinite(options.linkHours) && (options.linkHours as number) > 0
      ? (options.linkHours as number)
      : CLUSTER_DEFAULTS.linkHours;
  const maxClusters =
    Number.isFinite(options.maxClusters) && (options.maxClusters as number) > 0
      ? Math.floor(options.maxClusters as number)
      : CLUSTER_DEFAULTS.maxClusters;
  const maxDetections =
    Number.isFinite(options.maxDetections) && (options.maxDetections as number) > 0
      ? Math.floor(options.maxDetections as number)
      : CLUSTER_DEFAULTS.maxDetections;
  return { linkKm, linkHours, maxClusters, maxDetections };
}

/**
 * Single-linkage spatial-temporal clustering over a bounded set of detections.
 *
 * Candidates come from a coarse lat/lon bucket grid (so this stays fast on thousands of records);
 * membership is then decided by haversine distance AND the time window, never by bucket edges.
 */
export function clusterObservations(
  observations: readonly CanonicalObservation[],
  options: ClusterOptions = {}
): ClusterResult {
  const resolved = resolveOptions(options);
  const analysed = observations.slice(0, resolved.maxDetections);
  const truncated = observations.length > analysed.length;
  const notes: string[] = [
    'Groups are candidate hotspot clusters of satellite thermal anomalies; they are not confirmed wildfires or fire perimeters.',
    `Link rule: detections within ${resolved.linkKm} km and ${resolved.linkHours} h of each other.`,
  ];
  if (truncated) notes.push(`Only the first ${resolved.maxDetections} detections were clustered; the input was larger.`);
  if (analysed.length === 0) {
    return {
      clusters: [],
      found_clusters: 0,
      total_detections: observations.length,
      analysed_detections: 0,
      truncated,
      options: resolved,
      notes,
    };
  }

  // F53 fix: use a latitude-aware bucket step so high-latitude observations are not spread
  // across too many buckets, and wrap longitude buckets at ±180° for dateline crossing.
  // The bucket step in degrees is chosen so that the equatorial degree corresponds to linkKm,
  // but we always check adjacent buckets in both axes so a few-bucket mismatch is tolerated.
  const step = Math.max(resolved.linkKm / 111, 0.01);
  const buckets = new Map<string, number[]>();
  const wrapLonBucket = (b: number) => {
    const totalBuckets = Math.ceil(360 / step);
    return ((b % totalBuckets) + totalBuckets) % totalBuckets;
  };
  const latBucketOf = (lat: number) => Math.floor(lat / step);
  const lonBucketOf = (lon: number) => Math.floor(((lon + 180) % 360) / step);
  const keyOf = (latB: number, lonB: number) => `${latB}:${wrapLonBucket(lonB)}`;
  analysed.forEach((o, index) => {
    const key = keyOf(latBucketOf(o.latitude), lonBucketOf(o.longitude));
    const list = buckets.get(key);
    if (list) list.push(index);
    else buckets.set(key, [index]);
  });

  const parent = new Int32Array(analysed.length).map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const maxMs = resolved.linkHours * 3_600_000;
  analysed.forEach((a, i) => {
    const latB = latBucketOf(a.latitude);
    const lonB = lonBucketOf(a.longitude);
    // F53 fix: check a 3×3 neighbourhood in bucket space with dateline-wrapped lon buckets.
    for (let dLat = -1; dLat <= 1; dLat += 1) {
      for (let dLon = -1; dLon <= 1; dLon += 1) {
        const candidates = buckets.get(keyOf(latB + dLat, lonB + dLon));
        if (!candidates) continue;
        for (const j of candidates) {
          if (j <= i) continue;
          const b = analysed[j];
          const dt = Math.abs(Date.parse(a.datetime_utc) - Date.parse(b.datetime_utc));
          if (!Number.isFinite(dt) || dt > maxMs) continue;
          if (haversineDistanceKm(a.latitude, a.longitude, b.latitude, b.longitude) <= resolved.linkKm) {
            union(i, j);
          }
        }
      }
    }
  });

  const groups = new Map<number, number[]>();
  analysed.forEach((_, index) => {
    const root = find(index);
    const list = groups.get(root);
    if (list) list.push(index);
    else groups.set(root, [index]);
  });

  const clusters: HotspotCluster[] = [];
  const memberTimes = new Map<HotspotCluster, number[]>();
  for (const indexes of groups.values()) {
    const members = indexes.map((i) => analysed[i]);
    const modis = members.filter((o) => o.sensor === 'MODIS');
    const viirs = members.filter((o) => o.sensor === 'VIIRS');
    const times = members.map((o) => o.datetime_utc).sort();
    const lat = members.reduce((s, o) => s + o.latitude, 0) / members.length;
    const lon = members.reduce((s, o) => s + o.longitude, 0) / members.length;
    const frp = members.map((o) => o.frp_mw);
    const confidences = members.map((o) => confidenceNumber(o.confidence)).filter((v): v is number => v !== null);
    const cells = aggregateToSpatialTemporalGrid(members, 1.0).size;
    const days = new Set(members.map((o) => o.acq_date));

    const dayCounts = new Map<string, { MODIS: number; VIIRS: number }>();
    for (const m of members) {
      const entry = dayCounts.get(m.acq_date) ?? { MODIS: 0, VIIRS: 0 };
      entry[m.sensor] += 1;
      dayCounts.set(m.acq_date, entry);
    }
    const daily_counts = [...dayCounts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, c]) => ({ date, MODIS: c.MODIS, VIIRS: c.VIIRS }));

    const timesMs = members.map((o) => Date.parse(o.datetime_utc)).filter((t) => Number.isFinite(t));
    const firstMs = timesMs.length > 0 ? Math.min(...timesMs) : NaN;
    const lastMs = timesMs.length > 0 ? Math.max(...timesMs) : NaN;
    const spanMs = lastMs - firstMs;
    // recent_24h_detections is filled in after sorting, once the window's latest activity is known.
    const evolution: ClusterEvolution =
      !Number.isFinite(spanMs) || spanMs < 86_400_000
        ? { phase: 'single_pass', recent_24h_detections: 0, early_half_detections: 0, late_half_detections: 0 }
        : (() => {
            const mid = firstMs + spanMs / 2;
            const early = timesMs.filter((t) => t < mid).length;
            const late = timesMs.length - early;
            return {
              phase: late > early ? 'increasing' : late < early ? 'decreasing' : 'steady',
              recent_24h_detections: 0,
              early_half_detections: early,
              late_half_detections: late,
            } as ClusterEvolution;
          })();

    const cluster: HotspotCluster = {
      id: `cluster-${clusters.length + 1}`,
      label: 'candidate_hotspot_group',
      detection_count: members.length,
      by_sensor: { MODIS: modis.length, VIIRS: viirs.length },
      centroid: { latitude: Number(lat.toFixed(5)), longitude: Number(lon.toFixed(5)) },
      bbox: {
        west: Number(Math.min(...members.map((o) => o.longitude)).toFixed(5)),
        south: Number(Math.min(...members.map((o) => o.latitude)).toFixed(5)),
        east: Number(Math.max(...members.map((o) => o.longitude)).toFixed(5)),
        north: Number(Math.max(...members.map((o) => o.latitude)).toFixed(5)),
      },
      first_detection_utc: times[0],
      last_detection_utc: times[times.length - 1],
      duration_hours: Number(
        (Math.max(0, Date.parse(times[times.length - 1]) - Date.parse(times[0])) / 3_600_000).toFixed(1)
      ),
      active_days: days.size,
      daily_counts,
      evolution,
      frp_mw: {
        MODIS: Number(modis.reduce((s, o) => s + o.frp_mw, 0).toFixed(1)),
        VIIRS: Number(viirs.reduce((s, o) => s + o.frp_mw, 0).toFixed(1)),
        mean: Number((frp.reduce((s, v) => s + v, 0) / members.length).toFixed(1)),
        max: Number(Math.max(...frp).toFixed(1)),
      },
      satellites: [...new Set(members.map((o) => o.satellite))].sort(),
      active_1km_cells: cells,
      mean_confidence:
        confidences.length > 0
          ? Number((confidences.reduce((s, v) => s + v, 0) / confidences.length).toFixed(1))
          : null,
      notes: [
        'Candidate hotspot group from satellite thermal anomalies; not a confirmed wildfire.',
        'FRP sums stay separate per sensor and are never combined into one fire energy figure.',
        'The evolution phase describes detection timing only; it is not fire growth or a perimeter.',
      ],
    };
    memberTimes.set(cluster, timesMs);
    clusters.push(cluster);
  }

  clusters.sort((a, b) => b.detection_count - a.detection_count);

  // "Fading" needs the window's latest activity, which is only known once every group exists.
  const windowEnd = Math.max(
    ...clusters.map((c) => Date.parse(c.last_detection_utc)).filter((t) => Number.isFinite(t))
  );
  if (Number.isFinite(windowEnd)) {
    const recentCutoff = windowEnd - 86_400_000;
    for (const cluster of clusters) {
      const times = memberTimes.get(cluster) ?? [];
      const recent = times.filter((t) => t > recentCutoff).length;
      cluster.evolution.recent_24h_detections = recent;
      if (cluster.evolution.phase !== 'single_pass' && recent === 0) {
        cluster.evolution.phase = 'fading';
      }
    }
  }

  return {
    clusters: clusters.slice(0, resolved.maxClusters),
    found_clusters: clusters.length,
    total_detections: observations.length,
    analysed_detections: analysed.length,
    truncated,
    options: resolved,
    notes,
  };
}

// --------------------------------------------------------------------------- period comparison

export interface PeriodStats {
  label: string;
  day_count: number;
  by_sensor: { MODIS: number; VIIRS: number };
  frp_mw: { MODIS: number; VIIRS: number };
  active_1km_cells: number;
  active_days: number;
  first_detection_utc: string | null;
  last_detection_utc: string | null;
}

export interface ComparisonChange {
  absolute: number;
  percent: number | null;
  direction: 'increase' | 'decrease' | 'unchanged';
}

export interface PeriodComparison {
  a: PeriodStats;
  b: PeriodStats;
  change: { MODIS: ComparisonChange; VIIRS: ComparisonChange; active_1km_cells: ComparisonChange };
  normalized: { a_per_day: { MODIS: number; VIIRS: number }; b_per_day: { MODIS: number; VIIRS: number } };
  notes: string[];
}

function periodStats(label: string, observations: readonly CanonicalObservation[], dayCount: number): PeriodStats {
  const modis = observations.filter((o) => o.sensor === 'MODIS');
  const viirs = observations.filter((o) => o.sensor === 'VIIRS');
  const times = observations.map((o) => o.datetime_utc).sort();
  return {
    label,
    day_count: dayCount,
    by_sensor: { MODIS: modis.length, VIIRS: viirs.length },
    frp_mw: {
      MODIS: Number(modis.reduce((s, o) => s + o.frp_mw, 0).toFixed(1)),
      VIIRS: Number(viirs.reduce((s, o) => s + o.frp_mw, 0).toFixed(1)),
    },
    active_1km_cells: aggregateToSpatialTemporalGrid([...observations], 1.0).size,
    active_days: new Set(observations.map((o) => o.acq_date)).size,
    first_detection_utc: times[0] ?? null,
    last_detection_utc: times[times.length - 1] ?? null,
  };
}

function changeBetween(a: number, b: number): ComparisonChange {
  const absolute = b - a;
  return {
    absolute,
    // A zero baseline has no meaningful percentage; null, never Infinity or 0 as "no change".
    percent: a === 0 ? null : Number(((absolute / a) * 100).toFixed(1)),
    direction: absolute > 0 ? 'increase' : absolute < 0 ? 'decrease' : 'unchanged',
  };
}

export function comparePeriods(
  a: { label: string; days: number; observations: readonly CanonicalObservation[] },
  b: { label: string; days: number; observations: readonly CanonicalObservation[] }
): PeriodComparison {
  const statsA = periodStats(a.label, a.observations, a.days);
  const statsB = periodStats(b.label, b.observations, b.days);
  const perDay = (stats: PeriodStats) => ({
    MODIS: Number((stats.by_sensor.MODIS / Math.max(stats.day_count, 1)).toFixed(2)),
    VIIRS: Number((stats.by_sensor.VIIRS / Math.max(stats.day_count, 1)).toFixed(2)),
  });
  return {
    a: statsA,
    b: statsB,
    change: {
      MODIS: changeBetween(statsA.by_sensor.MODIS, statsB.by_sensor.MODIS),
      VIIRS: changeBetween(statsA.by_sensor.VIIRS, statsB.by_sensor.VIIRS),
      active_1km_cells: changeBetween(statsA.active_1km_cells, statsB.active_1km_cells),
    },
    normalized: { a_per_day: perDay(statsA), b_per_day: perDay(statsB) },
    notes: [
      'Counts stay separate per sensor; the change is never reported as a single fire count.',
      'A day with no record is unknown coverage, not zero activity.',
      'Percent change is null when the baseline period had no detections of that sensor.',
    ],
  };
}

// --------------------------------------------------------------------------- integrity audit

export type AuditStatus = 'pass' | 'warn' | 'fail' | 'not_applicable';

export interface AuditCheck {
  id: string;
  label: string;
  status: AuditStatus;
  detail: string;
}

export interface AuditReport {
  checked_records: number;
  checks: AuditCheck[];
  summary: { pass: number; warn: number; fail: number; not_applicable: number };
  by_sensor: { MODIS: number; VIIRS: number };
  by_provenance: { VERIFIED: number; UNVERIFIED: number };
  scientific_status: 'EXPLORATORY';
  limitations: string[];
}

const SATELLITES = new Set(['Terra', 'Aqua', 'Suomi-NPP', 'NOAA-20', 'NOAA-21']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Deterministic data-quality audit. It reports what it measured and never promotes the dataset:
 * `scientific_status` is always EXPLORATORY, because integrity checks are not validation.
 */
export function auditDataset(observations: readonly CanonicalObservation[], today: string): AuditReport {
  const total = observations.length;
  const badCoords = observations.filter(
    (o) =>
      !Number.isFinite(o.latitude) ||
      !Number.isFinite(o.longitude) ||
      o.latitude < -90 ||
      o.latitude > 90 ||
      o.longitude < -180 ||
      o.longitude > 180
  );
  const badDates = observations.filter(
    (o) => !isRealIsoDate(o.acq_date) || !o.datetime_utc || Number.isNaN(Date.parse(o.datetime_utc))
  );
  const futureDated = observations.filter((o) => o.acq_date > today);
  const badFrp = observations.filter((o) => !Number.isFinite(o.frp_mw) || o.frp_mw < 0);
  const badSatellite = observations.filter((o) => !SATELLITES.has(o.satellite));
  const unknownSensor = observations.filter((o) => o.sensor !== 'MODIS' && o.sensor !== 'VIIRS');
  const accTimeMismatch = observations.filter((o) => {
    if (!o.datetime_utc) return false;
    // F60 fix: guard parsed timestamp validity before calling toISOString().
    // An invalid datetime_utc string makes new Date().toISOString() throw RangeError.
    const parsed = Date.parse(o.datetime_utc);
    if (!Number.isFinite(parsed)) return true; // malformed → flag as mismatch
    const derived = new Date(parsed).toISOString().slice(0, 10);
    return derived !== o.acq_date;
  });
  const hashCounts = new Map<string, number>();
  for (const o of observations) {
    if (!o.record_hash) continue;
    hashCounts.set(o.record_hash, (hashCounts.get(o.record_hash) ?? 0) + 1);
  }
  const duplicates = [...hashCounts.values()].reduce((sum, count) => sum + (count > 1 ? count - 1 : 0), 0);
  const verified = observations.filter((o) => o.provenance_status === 'VERIFIED').length;

  const check = (
    id: string,
    label: string,
    failing: number,
    detail: (n: number) => string,
    applies = total > 0
  ): AuditCheck => ({
    id,
    label,
    status: !applies ? 'not_applicable' : failing === 0 ? 'pass' : failing >= Math.max(1, total * 0.05) ? 'fail' : 'warn',
    detail: applies
      ? failing === 0
        ? detail(0)
        : detail(failing)
      : 'No records to check in this window.',
  });

  const checks: AuditCheck[] = [
    check('coordinates', 'Coordinates inside valid ranges', badCoords.length, (n) =>
      n === 0 ? 'Every record has latitude in [-90, 90] and longitude in [-180, 180].' : `${n} record(s) have invalid coordinates.`
    ),
    check('dates', 'Acquisition dates are real ISO dates', badDates.length, (n) =>
      n === 0 ? 'Every record has a valid acq_date and parseable datetime_utc.' : `${n} record(s) have invalid dates.`
    ),
    check('future', 'No future-dated observations', futureDated.length, (n) =>
      n === 0 ? `No record is dated after ${today}.` : `${n} record(s) are dated after ${today}.`
    ),
    check('frp', 'Fire radiative power is finite and non-negative', badFrp.length, (n) =>
      n === 0 ? 'Every FRP value is a finite non-negative number of MW.' : `${n} record(s) have invalid FRP.`
    ),
    check('satellites', 'Satellites are recognised platforms', badSatellite.length, (n) =>
      n === 0 ? 'Every satellite name is one of Terra, Aqua, Suomi-NPP, NOAA-20, NOAA-21.' : `${n} record(s) name an unknown satellite.`
    ),
    check('sensor', 'Every record is exactly one sensor', unknownSensor.length, (n) =>
      n === 0 ? 'Records are tagged MODIS or VIIRS; no combined-sensor record exists.' : `${n} record(s) have an unexpected sensor value.`
    ),
    check('timestamps', 'Acquisition date matches the UTC timestamp', accTimeMismatch.length, (n) =>
      n === 0 ? 'acq_date equals the date part of datetime_utc for every record.' : `${n} record(s) disagree between acq_date and datetime_utc.`
    ),
    check('duplicates', 'No duplicate records by content hash', duplicates, (n) =>
      n === 0 ? 'No repeated record_hash values were found.' : `${n} duplicate record(s) share a record_hash.`
    ),
    check('provenance', 'Provenance is recorded per record', total - verified, (n) =>
      n === 0
        ? 'Every record carries provenance_status VERIFIED from a completed ingestion or the live source.'
        : `${n} of ${total} record(s) are UNVERIFIED.`,
      total > 0
    ),
  ];

  const summary = {
    pass: checks.filter((c) => c.status === 'pass').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    fail: checks.filter((c) => c.status === 'fail').length,
    not_applicable: checks.filter((c) => c.status === 'not_applicable').length,
  };

  return {
    checked_records: total,
    checks,
    summary,
    by_sensor: {
      MODIS: observations.filter((o) => o.sensor === 'MODIS').length,
      VIIRS: observations.filter((o) => o.sensor === 'VIIRS').length,
    },
    by_provenance: { VERIFIED: verified, UNVERIFIED: total - verified },
    scientific_status: 'EXPLORATORY',
    limitations: [
      `Harmonization remains EXPLORATORY (fixed ${HARMONIZATION_CONSTANTS.VIIRS_COUNT_SCALE_FACTOR} VIIRS coefficient).`,
      'Passing integrity checks is not scientific validation and does not establish ground truth.',
      'Cloud, smoke, scan-angle and overpass coverage are not assessed here.',
      'Missing records are not zero fire activity.',
    ],
  };
}
