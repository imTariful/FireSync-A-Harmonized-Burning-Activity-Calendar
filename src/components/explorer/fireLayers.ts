/**
 * Fire layer definitions for the map (pure: plain objects, no MapLibre import), so the rendering rules are
 * unit-tested (fireLayers.test.ts) and every place that registers or toggles fire layers uses ONE list.
 *
 * Zoomed out the detections are a soft CLOUD (one heatmap per sensor); zoomed in they are individual POINTS
 * (size = pixel footprint, see utils/sensorStyle.ts) with a faint glow under them. The two cross-fade between
 * zoom 6 and 9. There are no visible cluster circles and no count labels at any zoom: the cluster layer only
 * exists as an invisible click target, so clicking a cloud still zooms in. MODIS and VIIRS stay on separate
 * sources and layers, always.
 */
import {
  SENSOR_COLOR,
  SENSOR_NAMES,
  SENSOR_RING_COLOR,
  heatmapRamp,
  sensorRadiusStops,
  type SensorName,
} from '../../utils/sensorStyle';

// ---- Tunable thresholds (zoom levels, px). Tuned by eye, changed here only. --------------------------------------
/** Individual points exist from zoom (CLUSTER_MAX_ZOOM + 1): above this zoom the source stops clustering. */
export const CLUSTER_MAX_ZOOM = 7;
/** The cloud is fully opaque up to this zoom, then fades out ... */
export const CLOUD_FULL_UNTIL_ZOOM = 6;
/** ... and is gone at this zoom. */
export const CLOUD_GONE_AT_ZOOM = 9;
/** Points fade in from this zoom (opacity 0) ... */
export const POINTS_FADE_START_ZOOM = 7.5;
/** ... to full opacity at this one (the cross-fade overlaps the cloud's fade-out). */
export const POINTS_FULL_ZOOM = 9;
/** The glow under a point: radius factor, opacity, blur. */
export const GLOW_RADIUS_FACTOR = 2.2;
export const GLOW_OPACITY = 0.25;
export const GLOW_BLUR = 1;
/** Thin dark translucent outline so points read on bright clouds and imagery (replaces the old white stroke). */
export const POINT_STROKE_COLOR = 'rgba(5,7,13,0.6)';
export const POINT_STROKE_WIDTH = 1;
/** MODIS only: a thin light ring just outside the point (a non-colour cue next to the size difference). */
export const RING_STROKE_WIDTH = 1.25;
export const RING_GAP_PX = 1.5;
/** Invisible cluster circles: radius by cluster size (px), the click target of a cloud. */
export const CLUSTER_HIT_RADIUS: unknown[] = ['step', ['get', 'point_count'], 14, 100, 20, 1000, 28];

// ---- Types (structural, MapLibre-compatible) --------------------------------------------------------------------
export type Expr = unknown[];

export interface FireSourceSpec {
  id: string;
  cluster: boolean;
  clusterMaxZoom?: number;
  clusterRadius?: number;
}

export interface FireLayerSpec {
  id: string;
  type: 'heatmap' | 'circle';
  source: string;
  sensor: SensorName;
  filter?: Expr;
  maxzoom?: number;
  paint: Record<string, unknown>;
}

const lc = (s: SensorName) => s.toLowerCase();

export const heatSourceId = (s: SensorName) => `${lc(s)}-heat-src`;
export const clusterSourceId = (s: SensorName) => `${lc(s)}-src`;

/** FRP as a safe number: null, missing, NaN or non-numeric all become 0 (never null in a paint expression). */
const FRP_NUM: Expr = ['to-number', ['get', 'frp_mw'], 0];

const NOT_CLUSTER: Expr = ['!', ['has', 'point_count']];
const IS_CLUSTER: Expr = ['has', 'point_count'];

/** Opacity that rises from 0 (POINTS_FADE_START_ZOOM) to `max` (POINTS_FULL_ZOOM). */
export function pointsFade(max: number): Expr {
  return ['interpolate', ['linear'], ['zoom'], POINTS_FADE_START_ZOOM, 0, POINTS_FULL_ZOOM, max];
}

/** Opacity of the cloud: 1 up to CLOUD_FULL_UNTIL_ZOOM, 0 from CLOUD_GONE_AT_ZOOM. */
export function cloudFade(): Expr {
  return ['interpolate', ['linear'], ['zoom'], CLOUD_FULL_UNTIL_ZOOM, 1, CLOUD_GONE_AT_ZOOM, 0];
}

/** Footprint radius expression (px by zoom); `factor` scales it, `addPx` offsets it (both keep the shape exact). */
export function radiusExpr(sensor: SensorName, small: boolean, factor = 1, addPx = 0): Expr {
  const stops = sensorRadiusStops(sensor, small).flatMap(([z, r]) => [z, r * factor + addPx]);
  return ['interpolate', ['exponential', 2], ['zoom'], ...stops];
}

export function fireSources(small: boolean): FireSourceSpec[] {
  return SENSOR_NAMES.flatMap((s) => [
    // The heatmap gets its own UNclustered source: on a clustered source it would draw the cluster centroids
    // (no FRP) instead of the real detections.
    { id: heatSourceId(s), cluster: false },
    { id: clusterSourceId(s), cluster: true, clusterMaxZoom: CLUSTER_MAX_ZOOM, clusterRadius: small ? 60 : 40 },
  ]);
}

function heatmapLayer(sensor: SensorName, small: boolean): FireLayerSpec {
  return {
    id: `${lc(sensor)}-heatmap`,
    type: 'heatmap',
    source: heatSourceId(sensor),
    sensor,
    // The cloud is gone at CLOUD_GONE_AT_ZOOM: stop drawing it a little later (cheaper, never cuts the fade).
    maxzoom: CLOUD_GONE_AT_ZOOM + 0.5,
    paint: {
      // FRP drives the cloud intensity (not the dot size).
      'heatmap-weight': ['interpolate', ['linear'], FRP_NUM, 0, 0.2, 50, 0.6, 150, 1],
      'heatmap-intensity': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 1.7, 9, 2.6],
      'heatmap-color': [
        'interpolate',
        ['linear'],
        ['heatmap-density'],
        ...heatmapRamp(sensor).flatMap(([d, c]) => [d, c]),
      ],
      'heatmap-radius': small
        ? ['interpolate', ['linear'], ['zoom'], 0, 7, 5, 16, 9, 28]
        : ['interpolate', ['linear'], ['zoom'], 0, 10, 5, 24, 9, 40],
      'heatmap-opacity': cloudFade(),
    },
  };
}

function glowLayer(sensor: SensorName, small: boolean): FireLayerSpec {
  return {
    id: `${lc(sensor)}-glow`,
    type: 'circle',
    source: clusterSourceId(sensor),
    sensor,
    filter: NOT_CLUSTER,
    paint: {
      'circle-color': SENSOR_COLOR[sensor],
      'circle-radius': radiusExpr(sensor, small, GLOW_RADIUS_FACTOR),
      'circle-opacity': pointsFade(GLOW_OPACITY),
      'circle-blur': GLOW_BLUR,
    },
  };
}

/** Invisible (opacity 0): only here so a click on a cloud can zoom into it. Never drawn, no stroke, no label. */
function clusterHitLayer(sensor: SensorName): FireLayerSpec {
  return {
    id: `${lc(sensor)}-clusters`,
    type: 'circle',
    source: clusterSourceId(sensor),
    sensor,
    filter: IS_CLUSTER,
    paint: {
      'circle-color': SENSOR_COLOR[sensor],
      'circle-opacity': 0,
      'circle-radius': CLUSTER_HIT_RADIUS,
    },
  };
}

function pointsLayer(sensor: SensorName, small: boolean): FireLayerSpec {
  return {
    id: `${lc(sensor)}-points`,
    type: 'circle',
    source: clusterSourceId(sensor),
    sensor,
    filter: NOT_CLUSTER,
    paint: {
      'circle-color': SENSOR_COLOR[sensor],
      'circle-radius': radiusExpr(sensor, small),
      'circle-opacity': pointsFade(1),
      'circle-stroke-width': POINT_STROKE_WIDTH,
      'circle-stroke-color': POINT_STROKE_COLOR,
      'circle-stroke-opacity': pointsFade(1),
    },
  };
}

function ringLayer(sensor: SensorName, small: boolean): FireLayerSpec {
  return {
    id: `${lc(sensor)}-ring`,
    type: 'circle',
    source: clusterSourceId(sensor),
    sensor,
    filter: NOT_CLUSTER,
    paint: {
      'circle-color': SENSOR_COLOR[sensor],
      'circle-opacity': 0, // ring only, no fill
      'circle-radius': radiusExpr(sensor, small, 1, RING_GAP_PX),
      'circle-stroke-width': RING_STROKE_WIDTH,
      'circle-stroke-color': SENSOR_RING_COLOR,
      'circle-stroke-opacity': pointsFade(0.9),
    },
  };
}

/**
 * All fire layers, bottom to top: clouds, glows, invisible cluster targets, points, MODIS rings. Grouped by
 * kind (not by sensor) so VIIRS never sits under MODIS clouds, and small VIIRS dots stay on top of big MODIS dots.
 */
export function fireLayers(small: boolean): FireLayerSpec[] {
  return [
    ...SENSOR_NAMES.map((s) => heatmapLayer(s, small)),
    ...SENSOR_NAMES.map((s) => glowLayer(s, small)),
    ...SENSOR_NAMES.map((s) => clusterHitLayer(s)),
    ...SENSOR_NAMES.map((s) => pointsLayer(s, small)),
    ringLayer('MODIS', small),
  ];
}

/** Every fire layer id (what "is there a fire under this click?" checks, and what the layer toggles cover). */
export function fireLayerIds(): string[] {
  return fireLayers(false).map((l) => l.id);
}

/** Layer ids of one sensor: switching a sensor off hides exactly these. */
export function sensorLayerIds(sensor: SensorName): string[] {
  return fireLayers(false)
    .filter((l) => l.sensor === sensor)
    .map((l) => l.id);
}

/** Layers whose click means "inspect this detection" / "zoom into this cloud". */
export const clusterClickLayerId = (s: SensorName) => `${lc(s)}-clusters`;
export const pointClickLayerId = (s: SensorName) => `${lc(s)}-points`;
