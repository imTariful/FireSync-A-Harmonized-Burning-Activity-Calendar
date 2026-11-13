/**
 * Official wildland-fire incident verification (Feature 12).
 *
 * Source: WFIGS "Current Wildland Fire Incident Locations" — the public
 * ArcGIS feature service publishing IRWIN incident records for the United
 * States, refreshed roughly every 5 minutes. No API key is required.
 *
 * Coverage is US wildland fires only (WF / RX / CX categories). A satellite
 * thermal anomaly is never an official incident confirmation in either
 * direction: matches mean "an official incident record exists near recent
 * satellite detections", not that the anomaly is a confirmed wildfire.
 */

import type { CanonicalObservation } from '../types/fire';

export const WFIGS_INCIDENTS_URL =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query';

export const WFIGS_ATTRIBUTION =
  'WFIGS / National Interagency Fire Center — IRWIN incident locations (US wildland fires)';

const OUT_FIELDS = [
  'IrwinID',
  'IncidentName',
  'IncidentTypeCategory',
  'IncidentTypeKind',
  'POOState',
  'POOCity',
  'POOCounty',
  'IncidentSize',
  'PercentContained',
  'FireDiscoveryDateTime',
  'FireOutDateTime',
  'FireCauseGeneral',
  'GACC',
].join(',');

const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_RECORDS = 2000;

export interface OfficialIncident {
  id: string;
  name: string;
  /** IRWIN category: WF wildfire, RX prescribed, CX complex, etc. */
  type_category: string | null;
  type_kind: string | null;
  state: string | null;
  city: string | null;
  county: string | null;
  lat: number;
  lon: number;
  size_acres: number | null;
  percent_contained: number | null;
  discovered_at: string | null;
  out_at: string | null;
  cause: string | null;
  gacc: string | null;
}

export type IncidentMatch = 'satellite_corroborated' | 'no_nearby_detections' | 'unmatchable';

export interface CorroboratedIncident extends OfficialIncident {
  nearby_detections: number;
  nearest_detection_km: number | null;
  match: IncidentMatch;
}

export interface IncidentVerification {
  incidents: CorroboratedIncident[];
  summary: {
    total: number;
    satellite_corroborated: number;
    no_nearby_detections: number;
    unmatchable: number;
    observations_checked: number;
    truncated?: boolean;
  };
  parameters: {
    radius_km: number;
    window_hours: number;
    days: number;
  };
  source: {
    name: string;
    url: string;
    attribution: string;
    coverage: string;
    retrieved_at: string | null;
    cached: boolean;
    record_count: number;
    truncated?: boolean;
  };
  legend: string;
  note: string;
}

interface WfigsFeature {
  /** ArcGIS JSON format uses `attributes`; GeoJSON uses `properties`. */
  attributes?: Record<string, unknown>;
  properties?: Record<string, unknown>;
  /** GeoJSON: {type:'Point',coordinates:[lon,lat]}; ArcGIS JSON: {x,y}. */
  geometry?: { x?: number; y?: number; coordinates?: unknown } | null;
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function epochMsToIso(v: unknown): string | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function parseFeature(f: WfigsFeature): OfficialIncident | null {
  const a = f.properties ?? f.attributes ?? {};
  const lat = num(a.InitialLatitude);
  const lon = num(a.InitialLongitude);
  // Fallbacks: GeoJSON coordinates [lon,lat], then ArcGIS JSON {x,y}.
  const coords = Array.isArray(f.geometry?.coordinates) ? f.geometry.coordinates : null;
  const glon = coords ? num(coords[0]) : num(f.geometry?.x);
  const glat = coords ? num(coords[1]) : num(f.geometry?.y);
  const flat = lat ?? glat;
  const flon = lon ?? glon;
  if (flat === null || flon === null || Math.abs(flat) > 90 || Math.abs(flon) > 180) return null;
  const id = str(a.IrwinID) ?? str(a.OBJECTID) ?? `${flon},${flat}`;
  return {
    id,
    name: str(a.IncidentName) ?? id,
    type_category: str(a.IncidentTypeCategory),
    type_kind: str(a.IncidentTypeKind),
    state: str(a.POOState),
    city: str(a.POOCity),
    county: str(a.POOCounty),
    lat: flat,
    lon: flon,
    size_acres: num(a.IncidentSize),
    percent_contained: num(a.PercentContained),
    discovered_at: epochMsToIso(a.FireDiscoveryDateTime),
    out_at: epochMsToIso(a.FireOutDateTime),
    cause: str(a.FireCauseGeneral),
    gacc: str(a.GACC),
  };
}

export interface FetchIncidentsOptions {
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Force a refresh, bypassing the cache. */
  bypassCache?: boolean;
}

interface CacheEntry {
  at: number;
  incidents: OfficialIncident[];
  truncated: boolean;
  inflight?: Promise<{ incidents: OfficialIncident[]; truncated: boolean }>;
}

const cache: CacheEntry = { at: 0, incidents: [], truncated: false };

/**
 * Fetch current US wildland-fire incidents from WFIGS/IRWIN. Cached for 5
 * minutes; concurrent callers share one in-flight request.
 */
export async function fetchOfficialIncidents(opts: FetchIncidentsOptions = {}): Promise<{
  incidents: OfficialIncident[];
  retrieved_at: string | null;
  cached: boolean;
  truncated: boolean;
}> {
  const now = opts.now ?? (() => new Date());
  const nowMs = now().getTime();
  if (!opts.bypassCache && cache.incidents.length > 0 && nowMs - cache.at < CACHE_TTL_MS) {
    return { incidents: cache.incidents, retrieved_at: null, cached: true, truncated: cache.truncated };
  }
  if (cache.inflight) {
    const res = await cache.inflight;
    return { incidents: res.incidents, retrieved_at: null, cached: true, truncated: res.truncated };
  }

  const doFetch = async (): Promise<{ incidents: OfficialIncident[]; truncated: boolean }> => {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const url =
      WFIGS_INCIDENTS_URL +
      `?where=${encodeURIComponent('1=1')}` +
      `&outFields=${encodeURIComponent(OUT_FIELDS)}` +
      `&returnGeometry=true&outSR=4326&f=geojson` +
      `&resultRecordCount=${MAX_RECORDS}` +
      `&orderByFields=${encodeURIComponent('FireDiscoveryDateTime DESC')}`;
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`WFIGS incidents request failed: HTTP ${res.status}`);
    const body = (await res.json()) as {
      features?: WfigsFeature[];
      exceededTransferLimit?: boolean;
      error?: { code?: number; message?: string };
    };
    // F63 fix: ArcGIS returns HTTP 200 with an error object when the query fails.
    // Distinguish a valid empty feature collection from a failed provider response.
    if (body.error) {
      throw new Error(`ArcGIS service error (code ${body.error.code ?? 'unknown'}): ${body.error.message ?? 'no message'}`);
    }
    if (!Array.isArray(body.features)) {
      throw new Error('ArcGIS response missing features array; provider may have returned an unexpected format.');
    }
    const features = body.features;
    // F64 fix: check exceededTransferLimit and record cap to carry accurate truncation status
    const truncated = Boolean(body.exceededTransferLimit) || features.length >= MAX_RECORDS;
    const incidents = features.map(parseFeature).filter((i): i is OfficialIncident => i !== null);
    return { incidents, truncated };
  };

  cache.inflight = doFetch();
  try {
    const result = await cache.inflight;
    cache.at = nowMs;
    cache.incidents = result.incidents;
    cache.truncated = result.truncated;
    return { incidents: result.incidents, retrieved_at: now().toISOString(), cached: false, truncated: result.truncated };
  } finally {
    cache.inflight = undefined;
  }
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface CorroborateOptions {
  /** Incidents discovered within this many days are kept. */
  days?: number;
  /** Only incidents in this state code (e.g. 'US-CO'). */
  state?: string;
  /** Match radius around the incident point. Default 10 km. */
  radiusKm?: number;
  /** Detections must be within this many hours of discovery. Default 72. */
  windowHours?: number;
  now?: () => Date;
}

/**
 * Deterministic corroboration: count satellite detections near each incident
 * point within a time window around its discovery. Never upgrades a
 * satellite anomaly to a confirmed fire — it only reports proximity.
 */
export function corroborateIncidents(
  incidents: readonly OfficialIncident[],
  observations: readonly CanonicalObservation[],
  opts: CorroborateOptions = {}
): CorroboratedIncident[] {
  const days = Math.min(Math.max(opts.days ?? 14, 1), 60);
  const radiusKm = opts.radiusKm ?? 10;
  const windowHours = opts.windowHours ?? 72;
  const now = opts.now ?? (() => new Date());
  const cutoff = now().getTime() - days * 24 * 3600 * 1000;
  const state = opts.state?.trim().toUpperCase();

  const recent = incidents.filter((inc) => {
    if (state && (inc.state ?? '').toUpperCase() !== state) return false;
    if (!inc.discovered_at) return false;
    const t = Date.parse(inc.discovered_at);
    return Number.isFinite(t) && t >= cutoff;
  });

  // Pre-index observations once: parse datetime once per record.
  const obsTimes = observations.map((o) => {
    const t = Date.parse(o.datetime_utc);
    return { o, t: Number.isFinite(t) ? t : null };
  });

  return recent.map((inc) => {
    const disc = Date.parse(inc.discovered_at ?? '');
    let nearby = 0;
    let nearest: number | null = null;
    if (Number.isFinite(disc)) {
      for (const { o, t } of obsTimes) {
        if (t === null) continue;
        if (Math.abs(t - disc) > windowHours * 3600 * 1000) continue;
        const km = haversineKm(inc.lat, inc.lon, o.latitude, o.longitude);
        if (km <= radiusKm) {
          nearby += 1;
          if (nearest === null || km < nearest) nearest = km;
        }
      }
    }
    const match: IncidentMatch =
      nearby > 0 ? 'satellite_corroborated' : Number.isFinite(disc) ? 'no_nearby_detections' : 'unmatchable';
    return { ...inc, nearby_detections: nearby, nearest_detection_km: nearest, match };
  });
}

export async function verifyIncidents(
  observations: readonly CanonicalObservation[],
  opts: CorroborateOptions & FetchIncidentsOptions = {}
): Promise<IncidentVerification> {
  const fetched = await fetchOfficialIncidents(opts);
  const days = Math.min(Math.max(opts.days ?? 14, 1), 60);
  const radiusKm = opts.radiusKm ?? 10;
  const windowHours = opts.windowHours ?? 72;
  const incidents = corroborateIncidents(fetched.incidents, observations, opts);
  const summary = {
    total: incidents.length,
    satellite_corroborated: incidents.filter((i) => i.match === 'satellite_corroborated').length,
    no_nearby_detections: incidents.filter((i) => i.match === 'no_nearby_detections').length,
    unmatchable: incidents.filter((i) => i.match === 'unmatchable').length,
    observations_checked: observations.length,
    truncated: fetched.truncated,
  };
  return {
    incidents,
    summary,
    parameters: { radius_km: radiusKm, window_hours: windowHours, days },
    source: {
      name: 'WFIGS Current Wildland Fire Incident Locations (IRWIN)',
      url: WFIGS_INCIDENTS_URL.split('?')[0],
      attribution: WFIGS_ATTRIBUTION,
      coverage: 'United States wildland fires (WF/RX/CX) reported to IRWIN; refreshed ~5 min.',
      retrieved_at: fetched.retrieved_at,
      cached: fetched.cached,
      record_count: fetched.incidents.length,
      truncated: fetched.truncated,
    },
    legend: 'Satellite thermal anomalies, not confirmed wildfires or burned area.',
    note:
      'Official incident records are US-only (IRWIN/WFIGS). "satellite_corroborated" means detections occurred within the match radius of the incident discovery time — consistent with, not proof of, the reported fire. RX = prescribed fire. Incidents outside the satellite coverage window or outside the US cannot be verified here.',
  };
}
