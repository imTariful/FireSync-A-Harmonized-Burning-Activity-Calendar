/**
 * Weather–fire context from Open-Meteo.
 *
 * Open-Meteo is a free meteorological API that needs no key. The forecast endpoint is used with
 * `past_days` so the live 1-5 day NRT window is covered; the archive endpoint lags several days
 * and would silently drop the most recent observations.
 *
 * Everything returned is a single-point estimate at the bbox centre for small areas only. The
 * correlations are computed here in code (Pearson r over paired days); Groq may describe them
 * but never computes them. With at most five days, every coefficient is descriptive, not a
 * statistically significant relationship, and correlation is never presented as ignition cause.
 */

import type { CanonicalObservation } from '../../types/fire';
import { bboxAreaKm2, coverageFor, parseBboxString, type Bbox } from './compute';

export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const WEATHER_PROVIDER = 'Open-Meteo';
export const WEATHER_TIMEOUT_MS = 10_000;
/** Boxes wider/taller than this get no point estimate: one coordinate cannot represent them. */
export const MAX_WEATHER_BOX_DEGREES = 20;

export interface WeatherDay {
  date: string;
  temperature_2m_max_c: number | null;
  temperature_2m_min_c: number | null;
  precipitation_mm: number | null;
  wind_speed_10m_max_kmh: number | null;
  relative_humidity_2m_mean_pct: number | null;
}

export type WeatherPoint =
  | { ok: true; latitude: number; longitude: number }
  | { ok: false; reason: string };

/** The bbox centre, only when the box is small enough for a single point to be representative. */
export function weatherPointForBbox(bbox: Bbox): WeatherPoint {
  const widthDeg = bbox.east - bbox.west;
  const heightDeg = bbox.north - bbox.south;
  if (widthDeg > MAX_WEATHER_BOX_DEGREES || heightDeg > MAX_WEATHER_BOX_DEGREES) {
    return {
      ok: false,
      reason: `The area spans ${widthDeg.toFixed(1)}° × ${heightDeg.toFixed(1)}°; a single-point weather estimate is not representative. Choose a smaller area.`,
    };
  }
  if (bboxAreaKm2(bbox) > 2_000_000) {
    return { ok: false, reason: 'The area is too large for a single-point weather estimate.' };
  }
  return {
    ok: true,
    latitude: Number((((bbox.south + bbox.north) / 2) * 100).toFixed(4)) / 100,
    longitude: Number((((bbox.west + bbox.east) / 2) * 100).toFixed(4)) / 100,
  };
}

function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

interface OpenMeteoDaily {
  time?: unknown;
  temperature_2m_max?: unknown;
  temperature_2m_min?: unknown;
  precipitation_sum?: unknown;
  wind_speed_10m_max?: unknown;
  relative_humidity_2m_mean?: unknown;
}

/** Parse an Open-Meteo forecast payload into dated daily rows; malformed rows become nulls, not guesses. */
export function parseOpenMeteoDaily(body: unknown): WeatherDay[] {
  if (!body || typeof body !== 'object') return [];
  const daily = (body as { daily?: OpenMeteoDaily }).daily;
  if (!daily || typeof daily !== 'object') return [];
  const times = Array.isArray(daily.time) ? daily.time : [];
  const pick = (key: keyof OpenMeteoDaily): unknown[] =>
    Array.isArray(daily[key]) ? (daily[key] as unknown[]) : [];
  const cols = {
    temperature_2m_max: pick('temperature_2m_max'),
    temperature_2m_min: pick('temperature_2m_min'),
    precipitation_sum: pick('precipitation_sum'),
    wind_speed_10m_max: pick('wind_speed_10m_max'),
    relative_humidity_2m_mean: pick('relative_humidity_2m_mean'),
  };
  return times
    .filter((t): t is string => typeof t === 'string')
    .map((date, i) => ({
      date,
      temperature_2m_max_c: finiteOrNull(cols.temperature_2m_max[i]),
      temperature_2m_min_c: finiteOrNull(cols.temperature_2m_min[i]),
      precipitation_mm: finiteOrNull(cols.precipitation_sum[i]),
      wind_speed_10m_max_kmh: finiteOrNull(cols.wind_speed_10m_max[i]),
      relative_humidity_2m_mean_pct: finiteOrNull(cols.relative_humidity_2m_mean[i]),
    }));
}

export interface WeatherFetchResult {
  available: boolean;
  reason: string | null;
  point: { latitude: number; longitude: number } | null;
  days: WeatherDay[];
  provider: string;
  api: string;
  retrieved_at: string | null;
}

/**
 * Fetch daily weather for [startDate, endDate] at one point. Failures return `available: false`
 * with the reason — never an empty success and never fabricated values.
 */
export async function fetchWeatherDays(options: {
  latitude: number;
  longitude: number;
  startDate: string;
  endDate: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}): Promise<WeatherFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? WEATHER_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());
  const spanDays =
    Math.round(
      (Date.parse(`${options.endDate}T00:00:00Z`) - Date.parse(`${options.startDate}T00:00:00Z`)) /
        86_400_000
    ) + 1;
  // F55 fix: past_days is the count of days back from today to the earliest requested date,
  // not just the span length of the window.
  const todayUtc = now().toISOString().slice(0, 10);
  const daysAgo = Math.max(
    Math.ceil(
      (Date.parse(`${todayUtc}T00:00:00Z`) - Date.parse(`${options.startDate}T00:00:00Z`)) /
        86_400_000
    ),
    1
  );
  const pastDays = Math.min(Math.max(daysAgo, spanDays, 1), 15);
  const params = new URLSearchParams({
    latitude: String(options.latitude),
    longitude: String(options.longitude),
    daily:
      'temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,relative_humidity_2m_mean',
    timezone: 'UTC',
    past_days: String(pastDays),
    forecast_days: '1',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${OPEN_METEO_FORECAST_URL}?${params.toString()}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      return {
        available: false,
        reason: `Open-Meteo returned HTTP ${res.status}.`,
        point: { latitude: options.latitude, longitude: options.longitude },
        days: [],
        provider: WEATHER_PROVIDER,
        api: 'forecast',
        retrieved_at: null,
      };
    }
    const body = await res.json().catch(() => null);
    const days = parseOpenMeteoDaily(body).filter(
      (d) => d.date >= options.startDate && d.date <= options.endDate
    );
    if (days.length === 0) {
      return {
        available: false,
        reason: 'Open-Meteo returned no daily rows inside the requested window.',
        point: { latitude: options.latitude, longitude: options.longitude },
        days: [],
        provider: WEATHER_PROVIDER,
        api: 'forecast',
        retrieved_at: null,
      };
    }
    return {
      available: true,
      reason: null,
      point: { latitude: options.latitude, longitude: options.longitude },
      days,
      provider: WEATHER_PROVIDER,
      api: 'forecast',
      retrieved_at: now().toISOString(),
    };
  } catch (err) {
    return {
      available: false,
      reason:
        err instanceof Error && err.name === 'AbortError'
          ? `Open-Meteo did not answer within ${timeoutMs} ms.`
          : `Open-Meteo request failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      point: { latitude: options.latitude, longitude: options.longitude },
      days: [],
      provider: WEATHER_PROVIDER,
      api: 'forecast',
      retrieved_at: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

// --------------------------------------------------------------------------- correlations

export interface CorrelationPair {
  r: number | null;
  pairs: number;
}

/** Pearson r over paired finite values; null when fewer than 3 pairs or zero variance. */
export function pearson(xs: readonly number[], ys: readonly number[]): CorrelationPair {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i += 1) {
    const x = xs[i];
    const y = ys[i];
    if (Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y]);
  }
  if (pairs.length < 3) return { r: null, pairs: pairs.length };
  const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length;
  const my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const [x, y] of pairs) {
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
    sxy += (x - mx) * (y - my);
  }
  if (sxx === 0 || syy === 0) return { r: null, pairs: pairs.length };
  return { r: Number((sxy / Math.sqrt(sxx * syy)).toFixed(3)), pairs: pairs.length };
}

export interface WeatherVariable {
  key: keyof Omit<WeatherDay, 'date'>;
  label: string;
  unit: string;
}

export const WEATHER_VARIABLES: readonly WeatherVariable[] = [
  { key: 'temperature_2m_max_c', label: 'Max temperature', unit: '°C' },
  { key: 'temperature_2m_min_c', label: 'Min temperature', unit: '°C' },
  { key: 'precipitation_mm', label: 'Precipitation', unit: 'mm' },
  { key: 'wind_speed_10m_max_kmh', label: 'Max wind speed', unit: 'km/h' },
  { key: 'relative_humidity_2m_mean_pct', label: 'Mean humidity', unit: '%' },
];

export interface FireWeatherCorrelation {
  variable: string;
  label: string;
  unit: string;
  MODIS: CorrelationPair;
  VIIRS: CorrelationPair;
}

/**
 * Correlate each weather variable with per-sensor daily detection counts.
 * Only days with an observation record are paired: a no-record day is missing coverage, not zero
 * fire, so it is excluded rather than counted as "no detections".
 */
export function fireWeatherCorrelations(
  fireDays: ReadonlyArray<{ date: string; MODIS: number; VIIRS: number; status: string }>,
  weatherDays: readonly WeatherDay[]
): FireWeatherCorrelation[] {
  const weatherByDate = new Map(weatherDays.map((d) => [d.date, d]));
  const observed = fireDays.filter((d) => d.status === 'observed');
  return WEATHER_VARIABLES.map((variable) => {
    const xs: number[] = [];
    const modis: number[] = [];
    const viirs: number[] = [];
    for (const day of observed) {
      const w = weatherByDate.get(day.date);
      const value = w ? w[variable.key] : null;
      if (value === null || value === undefined) continue;
      xs.push(value);
      modis.push(day.MODIS);
      viirs.push(day.VIIRS);
    }
    return {
      variable: variable.key,
      label: variable.label,
      unit: variable.unit,
      MODIS: pearson(xs, modis),
      VIIRS: pearson(xs, viirs),
    };
  });
}

export interface WeatherFireAnalysis {
  weather: WeatherFetchResult;
  fire_daily: ReturnType<typeof coverageFor>['days'];
  correlations: FireWeatherCorrelation[];
  paired_days: number;
  notes: string[];
}

export function buildWeatherFireAnalysis(options: {
  observations: readonly CanonicalObservation[];
  bboxString: string;
  startDate: string;
  endDate: string;
  sourceErrors: readonly string[];
  weather: WeatherFetchResult;
}): WeatherFireAnalysis {
  const bbox = parseBboxString(options.bboxString);
  const fire = coverageFor(options.observations, options.startDate, options.endDate, options.sourceErrors);
  const correlations = options.weather.available
    ? fireWeatherCorrelations(fire.days, options.weather.days)
    : [];
  const pairedDays = correlations.length
    ? Math.max(...correlations.map((c) => Math.min(c.MODIS.pairs, c.VIIRS.pairs)))
    : 0;
  const notes = [
    'Weather is a single-point Open-Meteo estimate at the bbox centre, not an area average.',
    'Correlations are Pearson r over at most five paired days: descriptive only, never a causal or forecasting claim.',
    'Days without an observation record are excluded from the pairs; missing coverage is not zero fire.',
    'MODIS and VIIRS counts stay separate; no combined fire count is produced.',
  ];
  if (!bbox) notes.push('The bbox could not be parsed for a weather point.');
  return {
    weather: options.weather,
    fire_daily: fire.days,
    correlations,
    paired_days: pairedDays,
    notes,
  };
}
