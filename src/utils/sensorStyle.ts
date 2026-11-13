/**
 * Single source of truth for how MODIS and VIIRS look on screen (colour AND size).
 *
 * Colour: MODIS is crimson, VIIRS is yellow. They are distinct:
 *  - SIZE differs (dot size = detection footprint: MODIS 1 km pixel, VIIRS 375 m pixel),
 *  - MODIS points also get a thin light ring (SENSOR_RING_COLOR) at point zoom levels.
 * Text next to a swatch stays neutral (crimson on the dark surfaces is only ~2.9:1, fine for a graphic,
 * not for small text), so use SENSOR_COLOR for dots, lines, bars and fills, not for body text.
 *
 * Size: a point is drawn as the equal-area circle of its pixel footprint (radius = side / sqrt(pi)):
 * about 564 m for MODIS and 212 m for VIIRS, converted to screen pixels with an exponential-by-zoom curve
 * (true to scale at high zoom), with a minimum pixel floor so points stay visible when zoomed out. The floors
 * keep the MODIS:VIIRS ratio, so MODIS is ~2.7x larger in radius (~7x in area) at EVERY zoom.
 * FRP does not change dot size any more: it drives the heatmap weight (cloud intensity) and the inspector.
 *
 * Pure (no DOM, no MapLibre import).
 */

export type SensorName = 'MODIS' | 'VIIRS';
export const SENSOR_NAMES: readonly SensorName[] = ['MODIS', 'VIIRS'];

export const SENSOR_COLOR: Readonly<Record<SensorName, string>> = Object.freeze({
  MODIS: '#b81d3f', // crimson
  VIIRS: '#eab308', // yellow
});

/** Thin light ring drawn around MODIS points (point zoom levels), a second non-colour cue. */
export const SENSOR_RING_COLOR = '#ffd0d8';

/** Nominal pixel side at nadir, in metres. */
export const SENSOR_FOOTPRINT_M: Readonly<Record<SensorName, number>> = Object.freeze({
  MODIS: 1000,
  VIIRS: 375,
});

/** Radius (m) of the circle with the same area as the sensor's square pixel: side / sqrt(pi). */
export function equalAreaRadiusM(sensor: SensorName): number {
  return SENSOR_FOOTPRINT_M[sensor] / Math.sqrt(Math.PI);
}

/** MODIS radius / VIIRS radius (= 1000 / 375 = 2.667). */
export const MODIS_VIIRS_RADIUS_RATIO = SENSOR_FOOTPRINT_M.MODIS / SENSOR_FOOTPRINT_M.VIIRS;

/** Metres per screen pixel at zoom 0 on the equator, for 512 px tiles (MapLibre): 40 075 016.686 m / 512. */
export const METERS_PER_PIXEL_Z0 = 40075016.686 / 512;

/** VIIRS minimum on-screen radius (px). MODIS gets this times the ratio so the sensors stay in proportion. */
export const VIIRS_MIN_RADIUS_PX = 3;
/** Phones draw the floors a little smaller (same ratio). */
export const SMALL_SCREEN_SCALE = 0.85;

export function minRadiusPx(sensor: SensorName, small = false): number {
  const base = sensor === 'VIIRS' ? VIIRS_MIN_RADIUS_PX : VIIRS_MIN_RADIUS_PX * MODIS_VIIRS_RADIUS_RATIO;
  return small ? base * SMALL_SCREEN_SCALE : base;
}

/** True-to-scale on-screen radius (px) at `zoom`, on the equator (no floor). Off the equator it is ~1/cos(lat) larger. */
export function trueRadiusPx(sensor: SensorName, zoom: number): number {
  return (equalAreaRadiusM(sensor) * 2 ** zoom) / METERS_PER_PIXEL_Z0;
}

/** On-screen radius (px): true to scale, but never below the floor. */
export function sensorRadiusPx(sensor: SensorName, zoom: number, small = false): number {
  return Math.max(minRadiusPx(sensor, small), trueRadiusPx(sensor, zoom));
}

/** Highest zoom of the radius curve. */
export const RADIUS_MAX_ZOOM = 22;

/** Zoom at which true scale overtakes the floor (below it the radius is the constant floor). */
export function floorCrossoverZoom(sensor: SensorName, small = false): number {
  return Math.log2((minRadiusPx(sensor, small) * METERS_PER_PIXEL_Z0) / equalAreaRadiusM(sensor));
}

/**
 * Stops for `['interpolate', ['exponential', 2], ['zoom'], ...stops]`: floor up to the crossover zoom, then
 * exactly the true-scale curve (an exponential base-2 interpolation between the crossover and the last stop
 * reproduces radius * 2^zoom exactly).
 */
export function sensorRadiusStops(sensor: SensorName, small = false): Array<[number, number]> {
  const floor = minRadiusPx(sensor, small);
  const zc = floorCrossoverZoom(sensor, small);
  return [
    [0, floor],
    [zc, floor],
    [RADIUS_MAX_ZOOM, trueRadiusPx(sensor, RADIUS_MAX_ZOOM)],
  ];
}

/** Legend swatch diameters (px): drawn in the same ratio as the dots on the map. */
export const LEGEND_SWATCH_PX: Readonly<Record<SensorName, number>> = Object.freeze({
  VIIRS: 9,
  MODIS: Math.round(9 * MODIS_VIIRS_RADIUS_RATIO),
});

// ---------------------------------------------------------------------------
// Colour helpers (heatmap ramp)
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Expected a #rrggbb colour, got "${hex}"`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `hex` mixed toward white by `amount` (0 = unchanged, 1 = white), as #rrggbb. */
export function lighten(hex: string, amount: number): string {
  const a = Math.min(1, Math.max(0, amount));
  const [r, g, b] = hexToRgb(hex).map((v) => Math.round(v + (255 - v) * a));
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * `heatmap-color` ramp for a sensor: transparent, then the sensor colour at ~35 % opacity, the full sensor
 * colour, and a lighter core where detections pile up. Stops are [density 0..1, colour].
 */
export function heatmapRamp(sensor: SensorName): Array<[number, string]> {
  const c = SENSOR_COLOR[sensor];
  return [
    [0, rgba(c, 0)],
    [0.12, rgba(c, 0.35)],
    [0.45, c],
    [0.8, lighten(c, 0.45)],
    [1, lighten(c, 0.8)],
  ];
}
