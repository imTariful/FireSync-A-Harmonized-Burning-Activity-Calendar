/**
 * Filter helpers shared by the filter bar and the app: defaults, date presets and conflict checks.
 * Pure functions (no UI), so they are unit-tested.
 *
 * Live NASA FIRMS NRT only covers the rolling last 1–5 days. The default is today; longer
 * presets stay inside that window. Historical dates are rejected by the server with LIVE_WINDOW.
 */
import type { FilterState } from '../types/fire';

export const LIVE_MAX_DAYS = 5;

export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

const addDays = (iso: string, n: number): string => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const daysBetween = (start: string, end: string): number => {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
};

/** Earliest date the live NRT Area API can cover (inclusive). */
export const liveWindowStart = (today: string = todayUtc()): string => addDays(today, -(LIVE_MAX_DAYS - 1));

/** True when the whole requested range lies inside the live 1–5 day window. */
export function isWithinLiveWindow(
  start: string,
  end: string,
  today: string = todayUtc()
): boolean {
  return start >= liveWindowStart(today) && end <= today;
}

/**
 * FIRMS `days` value that covers a requested range: from the start date through today,
 * clamped to 1..5. The response is then filtered by the exact start/end dates.
 */
export function liveDaysForRange(
  start: string,
  end: string,
  today: string = todayUtc()
): number {
  const fromStart = daysBetween(start, today);
  const fromEnd = daysBetween(end, today);
  return Math.min(LIVE_MAX_DAYS, Math.max(1, fromStart, fromEnd));
}

/**
 * The requested range clamped into the live NRT window: start no earlier than the window start, end no later
 * than today. Used by requests and exports so they never ask the live service for a date it cannot serve.
 */
export function clampToLiveWindow(
  start: string,
  end: string,
  today: string = todayUtc()
): { start: string; end: string } {
  const earliest = liveWindowStart(today);
  const clampedStart = start < earliest ? earliest : start > today ? today : start;
  const clampedEnd = end > today ? today : end;
  return { start: clampedStart, end: clampedEnd < clampedStart ? clampedStart : clampedEnd };
}

/**
 * What the data pages show when the chosen dates fall outside the live NRT window and are clamped to it.
 * Null when the chosen range is served as-is; otherwise it names the window actually displayed.
 */
export function clampedLiveWindowNotice(
  start: string,
  end: string,
  today: string = todayUtc()
): string | null {
  const effective = clampToLiveWindow(start, end, today);
  if (effective.start === start && effective.end === end) return null;
  return `Showing the live NASA FIRMS window ${effective.start} to ${effective.end}. Live NRT covers only the last ${LIVE_MAX_DAYS} days, so the selected dates (${start} to ${end}) cannot be served.`;
}

export function defaultFilters(today: string = todayUtc()): FilterState {
  return {
    startDate: today,
    endDate: today,
    sensorMode: 'ALL',
    satellite: 'ALL',
    minConfidence: 0,
    minFRP: 0,
    dayNight: 'ALL',
  };
}

export interface DatePreset {
  id: string;
  label: string;
  start: string;
  end: string;
}

/** Presets relative to today, all inside the live NRT window. */
export function datePresets(today: string = todayUtc()): DatePreset[] {
  return [
    { id: '1d', label: 'Today (1 day)', start: today, end: today },
    { id: '2d', label: 'Last 2 days', start: addDays(today, -1), end: today },
    { id: '3d', label: 'Last 3 days', start: addDays(today, -2), end: today },
    { id: '5d', label: 'Last 5 days', start: addDays(today, -4), end: today },
  ];
}

const MODIS_SATELLITES = ['Terra', 'Aqua'];
const VIIRS_SATELLITES = ['Suomi-NPP', 'NOAA-20', 'NOAA-21'];

/** Human-readable reasons why the current filters can only return nothing (empty list = fine). */
export function filterConflicts(
  f: Pick<FilterState, 'startDate' | 'endDate' | 'sensorMode' | 'satellite'>,
  today: string = todayUtc()
): string[] {
  const out: string[] = [];
  if (f.startDate && f.endDate && f.startDate > f.endDate) {
    out.push('Start date is after the end date.');
  }
  if (f.startDate && f.endDate && !isWithinLiveWindow(f.startDate, f.endDate, today)) {
    out.push(`Live NRT only covers the last ${LIVE_MAX_DAYS} days (${liveWindowStart(today)} to ${today}).`);
  }
  if (f.sensorMode === 'MODIS_ONLY' && VIIRS_SATELLITES.includes(f.satellite)) {
    out.push(`${f.satellite} carries VIIRS, but only MODIS is selected.`);
  }
  if (f.sensorMode === 'VIIRS_ONLY' && MODIS_SATELLITES.includes(f.satellite)) {
    out.push(`${f.satellite} carries MODIS, but only VIIRS is selected.`);
  }
  return out;
}
