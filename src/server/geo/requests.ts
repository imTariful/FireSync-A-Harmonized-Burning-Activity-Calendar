/**
 * Shared request parsing for the AI analysis and geographic endpoints.
 *
 * Bodies are untrusted: the window is clamped to the live NRT range, the bbox must be a real box,
 * and sensors are limited to the two supported instruments.
 */

import { isValidBbox, isRealDate } from '../ai/schema';

export interface AnalysisRequest {
  bbox: string;
  days: number;
  sensors: 'ALL' | 'MODIS' | 'VIIRS';
  start_date: string;
  end_date: string;
  region_id: string | null;
}

export type AnalysisParse = { ok: true; value: AnalysisRequest } | { ok: false; error: string };

export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function parseAnalysisRequest(body: unknown, today: string, maxDays = 5): AnalysisParse {
  if (body !== undefined && body !== null && typeof body !== 'object') {
    return { ok: false, error: 'Body must be a JSON object.' };
  }
  const raw = (body ?? {}) as Record<string, unknown>;

  let bbox = '-180,-90,180,90';
  if (raw.bbox !== undefined && raw.bbox !== null && raw.bbox !== '') {
    if (!isValidBbox(raw.bbox)) {
      return { ok: false, error: 'bbox must be "west,south,east,north" with west<east and south<north.' };
    }
    bbox = raw.bbox;
  }

  const sensors = raw.sensors === 'MODIS' || raw.sensors === 'VIIRS' ? raw.sensors : 'ALL';

  let days = 1;
  if (raw.days !== undefined) {
    const parsed = Number(raw.days);
    if (!Number.isFinite(parsed) || parsed < 1) return { ok: false, error: 'days must be a positive number.' };
    days = Math.min(Math.floor(parsed), maxDays);
  }

  const earliestLiveDate = addDaysIso(today, -(maxDays - 1));

  let endDate = today;
  if (raw.end_date !== undefined) {
    if (typeof raw.end_date !== 'string' || !isRealDate(raw.end_date)) {
      return { ok: false, error: 'end_date must be a real YYYY-MM-DD date.' };
    }
    if (raw.end_date > today) return { ok: false, error: 'end_date cannot be in the future.' };
    if (raw.end_date < earliestLiveDate) {
      return { ok: false, error: `end_date must be within the rolling ${maxDays}-day live NRT window (on or after ${earliestLiveDate}). Historical analysis is not supported on this endpoint.` };
    }
    endDate = raw.end_date;
  }

  let startDate = addDaysIso(endDate, -(days - 1));
  if (raw.start_date !== undefined) {
    if (typeof raw.start_date !== 'string' || !isRealDate(raw.start_date)) {
      return { ok: false, error: 'start_date must be a real YYYY-MM-DD date.' };
    }
    if (raw.start_date > endDate) return { ok: false, error: 'start_date must be on or before end_date.' };
    if (raw.start_date < earliestLiveDate) {
      return { ok: false, error: `start_date must be within the rolling ${maxDays}-day live NRT window (on or after ${earliestLiveDate}). Historical analysis is not supported on this endpoint.` };
    }
    startDate = raw.start_date;
    const span = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000) + 1;
    if (span > maxDays) {
      return { ok: false, error: `The window may not exceed ${maxDays} days of live NRT data.` };
    }
    days = span;
  }

  const regionId = typeof raw.region_id === 'string' && /^[a-z0-9_-]{2,40}$/.test(raw.region_id) ? raw.region_id : null;

  return { ok: true, value: { bbox, days, sensors, start_date: startDate, end_date: endDate, region_id: regionId } };
}
