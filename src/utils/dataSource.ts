/**
 * What the Explorer shows: only live NASA FIRMS NRT detections.
 *
 * There is no bundled archive fallback and no user-facing "data mode". If live data cannot be
 * loaded, the map says so honestly; it never substitutes invented or stale sample records.
 * Pure (no React): unit-tested in dataSource.test.ts.
 */

export type LiveStatus = 'idle' | 'loading' | 'ready' | 'error';

export type DataSourceReason =
  | 'pinned-date'
  | 'live-ok'
  | 'live-loading'
  | 'live-error'
  | 'live-empty'
  | 'world-overview';

export interface DataSourceInput {
  /** YYYY-MM-DD picked in the Calendar, or null. */
  pinnedDate: string | null;
  liveStatus: LiveStatus;
  /** Live detections currently held (while loading a new view the previous ones are still there). */
  liveCount: number;
  /** True when the current answer is a capped world overview, not a viewport-specific query. */
  overview?: boolean;
}

export interface DataSourceDecision {
  source: 'live';
  reason: DataSourceReason;
  /** Show the small "live unavailable" chip. */
  fallbackChip: boolean;
}

export function decideDataSource({
  pinnedDate,
  liveStatus,
  liveCount,
  overview = false,
}: DataSourceInput): DataSourceDecision {
  if (pinnedDate) return { source: 'live', reason: 'pinned-date', fallbackChip: false };
  if (overview && liveStatus === 'ready') return { source: 'live', reason: 'world-overview', fallbackChip: false };
  switch (liveStatus) {
    case 'ready':
      return liveCount > 0
        ? { source: 'live', reason: 'live-ok', fallbackChip: false }
        : { source: 'live', reason: 'live-empty', fallbackChip: false };
    case 'error':
      return { source: 'live', reason: 'live-error', fallbackChip: true };
    case 'loading':
      return { source: 'live', reason: 'live-loading', fallbackChip: false };
    default:
      return { source: 'live', reason: 'live-loading', fallbackChip: false };
  }
}

export const LIVE_UNAVAILABLE_CHIP = 'Live NASA FIRMS data unavailable';

/** Text of the fallback chip, or null when there is none to show. */
export function dataSourceChipText(d: DataSourceDecision): string | null {
  return d.fallbackChip && d.reason === 'live-error' ? LIVE_UNAVAILABLE_CHIP : null;
}

/** Short label of what the detections on screen are (legend, Harmonize drawer). */
export function dataSourceLabel(
  d: DataSourceDecision,
  liveDays: number,
  pinnedDate: string | null
): string {
  const window = `last ${liveDays} day${liveDays === 1 ? '' : 's'}`;
  if (d.reason === 'pinned-date' && pinnedDate) return `Live NASA FIRMS, ${pinnedDate}`;
  if (d.reason === 'world-overview') return `Live NASA FIRMS, world overview (${window})`;
  if (d.reason === 'live-error') return 'Live NASA FIRMS unavailable';
  return `Live NASA FIRMS, ${window}`;
}
