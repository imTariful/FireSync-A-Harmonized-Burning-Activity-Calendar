/**
 * "What changed?" comparison between two consecutive live NRT windows.
 *
 * Window A is the most recent `days_a` days ending today. Window B is the `days_b` days
 * immediately before window A. Both windows must fit inside the live NRT 5-day limit, because
 * the loader only receives live NRT observations. Counts stay separate per sensor; the
 * comparison never produces a combined fire count.
 */

import type { AiObservationLoader, AiObservationPayload } from '../../types/ai';
import type { CanonicalObservation } from '../../types/fire';
import { comparePeriods, type ComparisonChange, type PeriodStats } from '../../utils/fireIntelligence';
import { isRealDate, isValidBbox } from '../ai/schema';
import { addDaysIso } from './requests';

export interface ComparisonWindow {
  label: 'window_a' | 'window_b';
  start_date: string;
  end_date: string;
  days: number;
}

export interface CompareRequest {
  bbox: string;
  sensors: 'ALL' | 'MODIS' | 'VIIRS';
  days_a: number;
  days_b: number;
  window_a: ComparisonWindow;
  window_b: ComparisonWindow;
}

export type CompareParse =
  | { ok: true; value: CompareRequest }
  | { ok: false; error: string; code?: 'INVALID_REQUEST' | 'LIVE_WINDOW' };

export interface CompareSourceMeta {
  data_source: 'live' | 'store';
  provenance_status: AiObservationPayload['provenance'];
  retrieved_at: string | null;
  source_errors: string[];
  truncated: boolean;
}

export interface CompareResponse {
  window_a: ComparisonWindow;
  window_b: ComparisonWindow;
  a: PeriodStats;
  b: PeriodStats;
  change: { MODIS: ComparisonChange; VIIRS: ComparisonChange; active_1km_cells: ComparisonChange };
  normalized: { a_per_day: { MODIS: number; VIIRS: number }; b_per_day: { MODIS: number; VIIRS: number } };
  notes: string[];
  coverage_note: string;
  source: CompareSourceMeta;
}

const WORLD_BBOX = '-180,-90,180,90';
const DAY_MS = 86_400_000;

/** Build a validated window; reversed or invalid dates return null instead of a broken range. */
export function makeComparisonWindow(
  label: ComparisonWindow['label'],
  startDate: string,
  endDate: string
): ComparisonWindow | null {
  if (!isRealDate(startDate) || !isRealDate(endDate)) return null;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  if (start > end) return null;
  return {
    label,
    start_date: startDate,
    end_date: endDate,
    days: Math.round((end - start) / DAY_MS) + 1,
  };
}

/** A = last daysA days; B = the daysB days immediately before A. */
export function buildComparisonWindows(
  today: string,
  daysA: number,
  daysB: number
): { window_a: ComparisonWindow; window_b: ComparisonWindow } | null {
  if (!isRealDate(today)) return null;
  if (!Number.isInteger(daysA) || !Number.isInteger(daysB) || daysA < 1 || daysB < 1) return null;

  const aStart = addDaysIso(today, -(daysA - 1));
  const bEnd = addDaysIso(aStart, -1);
  const bStart = addDaysIso(bEnd, -(daysB - 1));
  const windowA = makeComparisonWindow('window_a', aStart, today);
  const windowB = makeComparisonWindow('window_b', bStart, bEnd);
  if (!windowA || !windowB) return null;
  return { window_a: windowA, window_b: windowB };
}

function parseDays(
  value: unknown,
  field: 'days_a' | 'days_b',
  maxDays: number
): number | { error: string } {
  if (value === undefined) return 1;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxDays) {
    return { error: `${field} must be an integer from 1 to ${maxDays}.` };
  }
  return parsed;
}

export function parseCompareRequest(body: unknown, today: string, maxDays = 5): CompareParse {
  if (body !== undefined && body !== null && typeof body !== 'object') {
    return { ok: false, error: 'Body must be a JSON object.', code: 'INVALID_REQUEST' };
  }
  const raw = (body ?? {}) as Record<string, unknown>;

  let bbox = WORLD_BBOX;
  if (raw.bbox !== undefined && raw.bbox !== null && raw.bbox !== '') {
    if (!isValidBbox(raw.bbox)) {
      return {
        ok: false,
        error: 'bbox must be "west,south,east,north" with west<east and south<north.',
        code: 'INVALID_REQUEST',
      };
    }
    bbox = raw.bbox;
  }

  const sensors = raw.sensors === 'MODIS' || raw.sensors === 'VIIRS' ? raw.sensors : 'ALL';

  const parsedA = parseDays(raw.days_a, 'days_a', maxDays);
  if (typeof parsedA !== 'number') return { ok: false, error: parsedA.error, code: 'INVALID_REQUEST' };
  const parsedB = parseDays(raw.days_b, 'days_b', maxDays);
  if (typeof parsedB !== 'number') return { ok: false, error: parsedB.error, code: 'INVALID_REQUEST' };

  if (parsedA + parsedB > maxDays) {
    return {
      ok: false,
      error: `The two comparison windows together may not exceed ${maxDays} days of live NRT data.`,
      code: 'LIVE_WINDOW',
    };
  }

  const windows = buildComparisonWindows(today, parsedA, parsedB);
  if (!windows) {
    return { ok: false, error: 'The comparison windows are invalid.', code: 'INVALID_REQUEST' };
  }

  return {
    ok: true,
    value: {
      bbox,
      sensors,
      days_a: parsedA,
      days_b: parsedB,
      window_a: windows.window_a,
      window_b: windows.window_b,
    },
  };
}

function observationsInWindow(
  observations: readonly CanonicalObservation[],
  window: ComparisonWindow
): CanonicalObservation[] {
  return observations.filter((o) => o.acq_date >= window.start_date && o.acq_date <= window.end_date);
}

/**
 * Load both windows through the caller's loader, then compare the real observations.
 * The loader receives the union window (days_a + days_b); parseCompareRequest has already
 * rejected a union larger than the live NRT limit.
 */
export async function runComparison(
  load: AiObservationLoader,
  request: CompareRequest
): Promise<CompareResponse> {
  const totalDays = request.days_a + request.days_b;
  const payload = await load({
    days: totalDays,
    bbox: request.bbox === WORLD_BBOX ? null : request.bbox,
  });

  const sensorFiltered =
    request.sensors === 'ALL'
      ? payload.observations
      : payload.observations.filter((o) => o.sensor === request.sensors);

  const aObs = observationsInWindow(sensorFiltered, request.window_a);
  const bObs = observationsInWindow(sensorFiltered, request.window_b);
  // comparePeriods computes change as (second period - first period). Pass the baseline first so
  // the signed change means recent - baseline and the percentage is relative to the baseline.
  const comparison = comparePeriods(
    { label: request.window_b.label, days: request.window_b.days, observations: bObs },
    { label: request.window_a.label, days: request.window_a.days, observations: aObs }
  );

  const coverageParts: string[] = [];
  if (request.window_a.days !== request.window_b.days) {
    coverageParts.push(
      `Window A covers ${request.window_a.days} day(s) and window B covers ${request.window_b.days} day(s); use the per-day values for a like-for-like comparison.`
    );
  }
  if (aObs.length === 0) {
    coverageParts.push('No observation record in window A; that is missing coverage, not zero fire.');
  }
  if (bObs.length === 0) {
    coverageParts.push('No observation record in window B; that is missing coverage, not zero fire.');
  }
  if (payload.truncated) {
    coverageParts.push('The upstream response was capped, so these counts are lower bounds.');
  }
  if (payload.source === 'store') {
    coverageParts.push('Source is the local store, not live NRT data.');
  }
  if (payload.errors.length > 0) {
    coverageParts.push(`Source errors: ${payload.errors.slice(0, 3).join(' | ')}`);
  }

  return {
    window_a: request.window_a,
    window_b: request.window_b,
    // comparePeriods was called baseline-first; expose the recent window as `a` and the baseline
    // as `b`, with the already correctly oriented change and per-day values.
    a: comparison.b,
    b: comparison.a,
    change: comparison.change,
    normalized: { a_per_day: comparison.normalized.b_per_day, b_per_day: comparison.normalized.a_per_day },
    notes: comparison.notes,
    coverage_note:
      coverageParts.length > 0
        ? coverageParts.join(' ')
        : 'Both windows have the same length and contain observation records; the per-day values are directly comparable.',
    source: {
      data_source: payload.source,
      provenance_status: payload.provenance,
      retrieved_at: payload.retrieved_at,
      source_errors: payload.errors.slice(0, 5),
      truncated: payload.truncated,
    },
  };
}
