/**
 * Runtime validation for every AI request body and every model-proposed map action.
 *
 * Hand-written on purpose: the project has no schema library, and these checks are the security
 * boundary between an untrusted model/client payload and the map state.
 */

import type {
  AiChatRequest,
  AiDetectionEvidence,
  AiDetectionExplanationRequest,
  AiMapAction,
} from '../../types/ai';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const BBOX_RE = /^-?\d{1,3}(\.\d+)?,-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?,-?\d{1,2}(\.\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isRealDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** `west,south,east,north` inside valid ranges, with a positive area. */
export function isValidBbox(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !BBOX_RE.test(raw)) return false;
  const [west, south, east, north] = raw.split(',').map(Number);
  return (
    west >= -180 && east <= 180 && south >= -90 && north <= 90 && west < east && south < north
  );
}

export function parseChatRequest(body: unknown, maxChars: number): ValidationResult<AiChatRequest> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const raw = body as Record<string, unknown>;
  const message = typeof raw.message === 'string' ? raw.message.trim() : '';
  if (!message) return { ok: false, error: 'message is required.' };
  if (message.length > maxChars) {
    return { ok: false, error: `message must be at most ${maxChars} characters.` };
  }

  const contextRaw = raw.context;
  if (contextRaw !== undefined && (contextRaw === null || typeof contextRaw !== 'object')) {
    return { ok: false, error: 'context must be an object when provided.' };
  }
  const ctx = (contextRaw ?? {}) as Record<string, unknown>;
  const context: AiChatRequest['context'] = {};
  if (typeof ctx.area_name === 'string' && ctx.area_name.length <= 120) context.area_name = ctx.area_name;
  if (isValidBbox(ctx.bbox)) context.bbox = ctx.bbox;
  if (ctx.sensors === 'ALL' || ctx.sensors === 'MODIS' || ctx.sensors === 'VIIRS') context.sensors = ctx.sensors;
  if (typeof ctx.active_view === 'string' && /^[a-z]{1,20}$/.test(ctx.active_view)) context.active_view = ctx.active_view;
  if (typeof ctx.start_date === 'string' && isRealDate(ctx.start_date)) context.start_date = ctx.start_date;
  if (typeof ctx.end_date === 'string' && isRealDate(ctx.end_date)) context.end_date = ctx.end_date;

  return { ok: true, value: { message, context } };
}

const EVIDENCE_STRING_FIELDS = ['id', 'satellite', 'acq_date', 'acq_time', 'datetime_utc', 'product', 'daynight'] as const;
const EVIDENCE_NUMBER_FIELDS = ['latitude', 'longitude', 'frp_mw', 'brightness', 'bright_ti4', 'bright_ti5', 'scan', 'track'] as const;

export function parseDetectionExplanationRequest(
  body: unknown
): ValidationResult<AiDetectionExplanationRequest> {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const observation = (body as Record<string, unknown>).observation;
  if (!observation || typeof observation !== 'object') {
    return { ok: false, error: 'observation is required.' };
  }
  return { ok: true, value: { observation } };
}

export interface EvidenceParse {
  evidence: AiDetectionEvidence;
  fieldsProvided: string[];
  fieldsMissing: string[];
}

/**
 * Keep only known fields, require the core identity of the record, and report which optional
 * fields were absent so the UI can show "not provided" instead of inventing them.
 */
export function parseEvidence(observation: unknown): ValidationResult<EvidenceParse> {
  if (!observation || typeof observation !== 'object') return { ok: false, error: 'observation must be an object.' };
  const raw = observation as Record<string, unknown>;

  const sensor = raw.sensor;
  if (sensor !== 'MODIS' && sensor !== 'VIIRS') {
    return { ok: false, error: 'observation.sensor must be MODIS or VIIRS.' };
  }
  const id = typeof raw.id === 'string' && raw.id ? raw.id : '';
  if (!id) return { ok: false, error: 'observation.id is required.' };

  // F58 fix: check for null/undefined before Number() conversion so that null
  // measurements are rejected (or kept as undefined) rather than silently becoming 0.
  const rawLat = raw.latitude;
  const rawLon = raw.longitude;
  if (rawLat == null) return { ok: false, error: 'observation.latitude is required.' };
  if (rawLon == null) return { ok: false, error: 'observation.longitude is required.' };
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, error: 'observation.latitude is invalid.' };
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return { ok: false, error: 'observation.longitude is invalid.' };
  const rawFrp = raw.frp_mw;
  if (rawFrp == null) return { ok: false, error: 'observation.frp_mw is required.' };
  const frp = Number(rawFrp);
  if (!Number.isFinite(frp) || frp < 0) return { ok: false, error: 'observation.frp_mw is invalid.' };

  const acqDate = typeof raw.acq_date === 'string' && isRealDate(raw.acq_date) ? raw.acq_date : '';
  if (!acqDate) return { ok: false, error: 'observation.acq_date must be a real YYYY-MM-DD date.' };
  const datetime = typeof raw.datetime_utc === 'string' && raw.datetime_utc ? raw.datetime_utc : '';
  if (!datetime) return { ok: false, error: 'observation.datetime_utc is required.' };

  const provided: string[] = [];
  const missing: string[] = [];

  const str = (key: string): string | undefined => {
    const value = raw[key];
    if (typeof value === 'string' && value) {
      provided.push(key);
      return value;
    }
    missing.push(key);
    return undefined;
  };
  const num = (key: string): number | undefined => {
    const raw_val = raw[key];
    // F58 fix: null/undefined must not be converted to 0 via Number(null).
    // Only convert values that are already numbers or non-empty numeric strings.
    if (raw_val == null) { missing.push(key); return undefined; }
    const value = Number(raw_val);
    if (Number.isFinite(value)) {
      provided.push(key);
      return value;
    }
    missing.push(key);
    return undefined;
  };

  const evidence: AiDetectionEvidence = {
    id,
    sensor,
    satellite: str('satellite') ?? 'unknown',
    latitude: lat,
    longitude: lon,
    acq_date: acqDate,
    acq_time: str('acq_time') ?? 'unknown',
    datetime_utc: datetime,
    confidence:
      typeof raw.confidence === 'number' || typeof raw.confidence === 'string'
        ? (raw.confidence as number | string)
        : 'unknown',
    frp_mw: frp,
    product: str('product') ?? 'unknown',
  };
  provided.push('id', 'sensor', 'latitude', 'longitude', 'acq_date', 'datetime_utc', 'frp_mw');
  if (evidence.confidence !== 'unknown') provided.push('confidence');
  else missing.push('confidence');

  const brightness = num('brightness');
  if (brightness !== undefined) evidence.brightness = brightness;
  const ti4 = num('bright_ti4');
  if (ti4 !== undefined) evidence.bright_ti4 = ti4;
  const ti5 = num('bright_ti5');
  if (ti5 !== undefined) evidence.bright_ti5 = ti5;
  const scan = num('scan');
  if (scan !== undefined) evidence.scan = scan;
  const track = num('track');
  if (track !== undefined) evidence.track = track;
  const daynight = str('daynight');
  if (daynight) evidence.daynight = daynight;
  if (raw.provenance_status === 'VERIFIED' || raw.provenance_status === 'UNVERIFIED') {
    evidence.provenance_status = raw.provenance_status;
    provided.push('provenance_status');
  } else {
    missing.push('provenance_status');
  }

  // Guard against unbounded strings being forwarded to the model.
  for (const key of EVIDENCE_STRING_FIELDS) {
    const value = raw[key];
    if (typeof value === 'string' && value.length > 120) {
      return { ok: false, error: `observation.${key} is too long.` };
    }
  }
  for (const key of EVIDENCE_NUMBER_FIELDS) {
    const value = raw[key];
    if (value !== undefined && !Number.isFinite(Number(value))) {
      return { ok: false, error: `observation.${key} must be a number.` };
    }
  }

  return {
    ok: true,
    value: { evidence, fieldsProvided: [...new Set(provided)], fieldsMissing: [...new Set(missing)] },
  };
}

/** Validate a model-proposed map action. Anything not in the contract is rejected, not repaired. */
export function parseMapAction(raw: unknown, today: string): ValidationResult<AiMapAction> {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'action must be an object.' };
  const value = raw as Record<string, unknown>;

  if (value.type === 'focus_region') {
    const regionId = typeof value.region_id === 'string' ? value.region_id : '';
    if (!/^[a-z0-9_-]{2,40}$/.test(regionId)) return { ok: false, error: 'focus_region needs a valid region_id.' };
    const name = typeof value.name === 'string' ? value.name.slice(0, 120) : '';
    if (!isValidBbox(value.bbox)) return { ok: false, error: 'focus_region needs a valid bbox.' };
    return { ok: true, value: { type: 'focus_region', region_id: regionId, name, bbox: value.bbox } };
  }

  if (value.type !== 'apply_filters') {
    return { ok: false, error: 'Unknown action type.' };
  }

  const action: AiMapAction = { type: 'apply_filters' };
  if (value.sensors !== undefined) {
    if (value.sensors !== 'ALL' && value.sensors !== 'MODIS' && value.sensors !== 'VIIRS') {
      return { ok: false, error: 'apply_filters.sensors must be ALL, MODIS or VIIRS.' };
    }
    action.sensors = value.sensors;
  }
  if (value.days !== undefined) {
    const days = Number(value.days);
    if (!Number.isInteger(days) || days < 1 || days > 5) {
      return { ok: false, error: `apply_filters.days must be an integer between 1 and 5 for live NRT data (today is ${today}).` };
    }
    action.days = days;
  }
  if (value.min_frp !== undefined) {
    const frp = Number(value.min_frp);
    if (!Number.isFinite(frp) || frp < 0 || frp > 10_000) {
      return { ok: false, error: 'apply_filters.min_frp must be between 0 and 10000 MW.' };
    }
    action.min_frp = frp;
  }
  if (value.min_confidence !== undefined) {
    const confidence = Number(value.min_confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
      return { ok: false, error: 'apply_filters.min_confidence must be between 0 and 100.' };
    }
    action.min_confidence = confidence;
  }
  if (action.sensors === undefined && action.days === undefined && action.min_frp === undefined && action.min_confidence === undefined) {
    return { ok: false, error: 'apply_filters must change at least one filter.' };
  }
  return { ok: true, value: action };
}
