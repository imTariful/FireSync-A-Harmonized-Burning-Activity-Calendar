import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_FULL_UNTIL_ZOOM,
  CLOUD_GONE_AT_ZOOM,
  CLUSTER_MAX_ZOOM,
  GLOW_BLUR,
  GLOW_OPACITY,
  GLOW_RADIUS_FACTOR,
  POINTS_FADE_START_ZOOM,
  POINTS_FULL_ZOOM,
  POINT_STROKE_COLOR,
  fireLayerIds,
  fireLayers,
  fireSources,
  sensorLayerIds,
} from './fireLayers';
import { FIRST_FIRE_LAYER_ID } from './basemap';
import { SENSOR_COLOR, SENSOR_RING_COLOR, sensorRadiusPx } from '../../utils/sensorStyle';

const byId = (small = false) => new Map(fireLayers(small).map((l) => [l.id, l]));

/** Evaluates `['interpolate', ['linear'|exponential, ...], ['zoom'], z0, v0, z1, v1, ...]` at `zoom` (clamped). */
function evalZoomInterpolate(expr: unknown, zoom: number): number {
  const e = expr as unknown[];
  assert.equal(e[0], 'interpolate');
  const base = (e[1] as unknown[])[0] === 'exponential' ? ((e[1] as unknown[])[1] as number) : 1;
  const stops: Array<[number, number]> = [];
  for (let i = 3; i < e.length; i += 2) stops.push([e[i] as number, e[i + 1] as number]);
  if (zoom <= stops[0][0]) return stops[0][1];
  if (zoom >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 1; i < stops.length; i++) {
    const [z0, v0] = stops[i - 1];
    const [z1, v1] = stops[i];
    if (zoom <= z1) {
      const t = base === 1 ? (zoom - z0) / (z1 - z0) : (base ** (zoom - z0) - 1) / (base ** (z1 - z0) - 1);
      return v0 + t * (v1 - v0);
    }
  }
  throw new Error('unreachable');
}

test('MODIS and VIIRS have separate sources and separate layers (never merged)', () => {
  const sources = fireSources(false).map((s) => s.id);
  assert.deepEqual(sources.sort(), ['modis-heat-src', 'modis-src', 'viirs-heat-src', 'viirs-src']);
  const modis = new Set(sensorLayerIds('MODIS'));
  const viirs = new Set(sensorLayerIds('VIIRS'));
  assert.ok(modis.size > 0 && viirs.size > 0);
  for (const id of modis) assert.ok(!viirs.has(id));
  for (const l of fireLayers(false)) {
    assert.ok(l.source.startsWith(l.sensor.toLowerCase()), `${l.id} reads its own sensor's source`);
  }
});

test('no numbered clusters: no symbol / text layer and no "-count" layer anywhere', () => {
  for (const l of fireLayers(false)) {
    assert.notEqual((l as { type: string }).type, 'symbol');
    assert.ok(!l.id.endsWith('-count'));
    assert.equal('text-field' in l.paint, false);
  }
});

test('the cluster layer is an invisible click target: opacity 0, no stroke', () => {
  for (const s of ['modis', 'viirs']) {
    const c = byId().get(`${s}-clusters`)!;
    assert.equal(c.paint['circle-opacity'], 0);
    assert.equal('circle-stroke-width' in c.paint, false);
    assert.deepEqual(c.filter, ['has', 'point_count']);
  }
});

test('clustering stops at zoom 7, so individual points exist from zoom 8', () => {
  assert.equal(CLUSTER_MAX_ZOOM, 7);
  for (const src of fireSources(false)) {
    if (src.cluster) assert.equal(src.clusterMaxZoom, CLUSTER_MAX_ZOOM);
    else assert.equal(src.clusterMaxZoom, undefined);
  }
});

test('cloud: opaque up to ~zoom 6, gone by ~zoom 9, and its layer is not cut off before the fade ends', () => {
  assert.equal(CLOUD_FULL_UNTIL_ZOOM, 6);
  assert.equal(CLOUD_GONE_AT_ZOOM, 9);
  for (const s of ['modis', 'viirs']) {
    const h = byId().get(`${s}-heatmap`)!;
    const op = h.paint['heatmap-opacity'];
    assert.equal(evalZoomInterpolate(op, 0), 1);
    assert.equal(evalZoomInterpolate(op, CLOUD_FULL_UNTIL_ZOOM), 1);
    assert.equal(evalZoomInterpolate(op, CLOUD_GONE_AT_ZOOM), 0);
    assert.ok(evalZoomInterpolate(op, 7.5) > 0 && evalZoomInterpolate(op, 7.5) < 1);
    assert.ok((h.maxzoom ?? Infinity) >= CLOUD_GONE_AT_ZOOM, 'maxzoom must not cut the fade');
    assert.notEqual(h.maxzoom, 14);
  }
});

test('cloud colour ramp is transparent at density 0 and built from the sensor colour', () => {
  for (const s of ['MODIS', 'VIIRS'] as const) {
    const ramp = byId().get(`${s.toLowerCase()}-heatmap`)!.paint['heatmap-color'] as unknown[];
    assert.deepEqual(ramp.slice(0, 3), ['interpolate', ['linear'], ['heatmap-density']]);
    assert.equal(ramp[3], 0);
    assert.match(ramp[4] as string, /^rgba\(\d+,\d+,\d+,0\)$/);
    assert.ok(ramp.includes(SENSOR_COLOR[s]));
  }
});

test('FRP drives the cloud weight, not the dot size', () => {
  const h = byId().get('modis-heatmap')!;
  assert.ok(JSON.stringify(h.paint['heatmap-weight']).includes('frp_mw'));
  for (const l of fireLayers(false).filter((l) => l.type === 'circle')) {
    assert.ok(!JSON.stringify(l.paint['circle-radius']).includes('frp_mw'), `${l.id} radius ignores FRP`);
  }
});

test('points cross-fade in between zoom 7.5 and 9', () => {
  assert.equal(POINTS_FADE_START_ZOOM, 7.5);
  assert.equal(POINTS_FULL_ZOOM, 9);
  for (const s of ['modis', 'viirs']) {
    const p = byId().get(`${s}-points`)!;
    const op = p.paint['circle-opacity'];
    assert.equal(evalZoomInterpolate(op, 0), 0);
    assert.equal(evalZoomInterpolate(op, POINTS_FADE_START_ZOOM), 0);
    assert.equal(evalZoomInterpolate(op, POINTS_FULL_ZOOM), 1);
    assert.equal(evalZoomInterpolate(op, 12), 1);
  }
});

test('point radius is the footprint curve and keeps the ~2.7 MODIS:VIIRS ratio at every zoom', () => {
  for (const small of [false, true]) {
    const m = byId(small).get('modis-points')!.paint['circle-radius'];
    const v = byId(small).get('viirs-points')!.paint['circle-radius'];
    for (let z = 0; z <= 22; z += 0.5) {
      const rm = evalZoomInterpolate(m, z);
      const rv = evalZoomInterpolate(v, z);
      assert.ok(Math.abs(rm - sensorRadiusPx('MODIS', z, small)) < 1e-6);
      assert.ok(Math.abs(rv - sensorRadiusPx('VIIRS', z, small)) < 1e-6);
      assert.ok(rm / rv > 2.6 && rm / rv < 2.75, `zoom ${z}`);
    }
  }
});

test('glow sits under the points: radius 2.2x, opacity ~0.25, blur ~1, same fade', () => {
  assert.equal(GLOW_RADIUS_FACTOR, 2.2);
  assert.equal(GLOW_OPACITY, 0.25);
  assert.equal(GLOW_BLUR, 1);
  const ids = fireLayers(false).map((l) => l.id);
  for (const s of ['modis', 'viirs']) {
    assert.ok(ids.indexOf(`${s}-glow`) < ids.indexOf(`${s}-points`));
    const g = byId().get(`${s}-glow`)!;
    const p = byId().get(`${s}-points`)!;
    assert.equal(g.paint['circle-blur'], 1);
    assert.equal(evalZoomInterpolate(g.paint['circle-opacity'], 12), GLOW_OPACITY);
    assert.equal(evalZoomInterpolate(g.paint['circle-opacity'], POINTS_FADE_START_ZOOM), 0);
    for (let z = 0; z <= 20; z += 2) {
      const ratio = evalZoomInterpolate(g.paint['circle-radius'], z) / evalZoomInterpolate(p.paint['circle-radius'], z);
      assert.ok(Math.abs(ratio - GLOW_RADIUS_FACTOR) < 1e-6);
    }
  }
});

test('points have a dark translucent outline (no white stroke); only MODIS gets the light ring', () => {
  for (const s of ['modis', 'viirs']) {
    const p = byId().get(`${s}-points`)!;
    assert.equal(p.paint['circle-stroke-color'], POINT_STROKE_COLOR);
    assert.match(POINT_STROKE_COLOR, /^rgba\(\d{1,2},\d{1,2},\d{1,2},0\.\d+\)$/);
  }
  assert.ok(byId().has('modis-ring'));
  assert.ok(!byId().has('viirs-ring'));
  const ring = byId().get('modis-ring')!;
  assert.equal(ring.paint['circle-stroke-color'], SENSOR_RING_COLOR);
  assert.equal(ring.paint['circle-opacity'], 0, 'a ring, not a filled disc');
});

test('draw order: clouds, then glows, then cluster targets, then points; the first layer anchors the basemap', () => {
  const ids = fireLayers(false).map((l) => l.id);
  assert.equal(ids[0], FIRST_FIRE_LAYER_ID);
  const kind = (id: string) => id.split('-')[1];
  const order = ['heatmap', 'glow', 'clusters', 'points', 'ring'];
  const ranks = ids.map((id) => order.indexOf(kind(id)));
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test('fireLayerIds lists every layer exactly once and sensorLayerIds partitions it', () => {
  const all = fireLayerIds();
  assert.equal(new Set(all).size, all.length);
  assert.deepEqual([...sensorLayerIds('MODIS'), ...sensorLayerIds('VIIRS')].sort(), [...all].sort());
  assert.ok(all.includes('modis-glow') && all.includes('viirs-glow'));
});

test('nothing in the layer definitions uses the old orange / cyan colours', () => {
  const json = JSON.stringify(fireLayers(false)).toLowerCase();
  assert.ok(!json.includes('f97316') && !json.includes('06b6d4'));
});
