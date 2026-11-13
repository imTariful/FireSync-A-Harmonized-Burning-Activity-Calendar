import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGEND_SWATCH_PX,
  MODIS_VIIRS_RADIUS_RATIO,
  RADIUS_MAX_ZOOM,
  SENSOR_COLOR,
  SENSOR_FOOTPRINT_M,
  SENSOR_RING_COLOR,
  equalAreaRadiusM,
  floorCrossoverZoom,
  heatmapRamp,
  lighten,
  minRadiusPx,
  sensorRadiusPx,
  sensorRadiusStops,
  trueRadiusPx,
} from './sensorStyle';

test('colours are defined for both sensors and match the design (crimson / yellow / light ring)', () => {
  assert.equal(SENSOR_COLOR.MODIS, '#b81d3f');
  assert.equal(SENSOR_COLOR.VIIRS, '#eab308');
  assert.equal(SENSOR_RING_COLOR, '#ffd0d8');
  assert.notEqual(SENSOR_COLOR.MODIS, SENSOR_COLOR.VIIRS);
  for (const c of [...Object.values(SENSOR_COLOR), SENSOR_RING_COLOR]) assert.match(c, /^#[0-9a-f]{6}$/i);
});

test('no old orange / cyan sensor colour is left in the palette', () => {
  const all = Object.values(SENSOR_COLOR).join(' ').toLowerCase();
  assert.ok(!all.includes('f97316') && !all.includes('06b6d4'));
});

test('footprints are the pixel sizes: MODIS 1 km, VIIRS 375 m', () => {
  assert.deepEqual({ ...SENSOR_FOOTPRINT_M }, { MODIS: 1000, VIIRS: 375 });
});

test('equal-area radii are about 564 m (MODIS) and 212 m (VIIRS)', () => {
  assert.ok(Math.abs(equalAreaRadiusM('MODIS') - 564.19) < 0.1);
  assert.ok(Math.abs(equalAreaRadiusM('VIIRS') - 211.57) < 0.1);
});

test('MODIS radius is larger than VIIRS at every zoom, ratio about 2.7 (desktop and phone)', () => {
  for (const small of [false, true]) {
    for (let z = 0; z <= RADIUS_MAX_ZOOM; z += 0.25) {
      const m = sensorRadiusPx('MODIS', z, small);
      const v = sensorRadiusPx('VIIRS', z, small);
      assert.ok(m > v, `zoom ${z}: ${m} > ${v}`);
      const ratio = m / v;
      assert.ok(Math.abs(ratio - MODIS_VIIRS_RADIUS_RATIO) < 0.01, `zoom ${z}: ratio ${ratio}`);
      assert.ok(ratio > 2.6 && ratio < 2.75, `zoom ${z}: ratio ${ratio}`);
    }
  }
});

test('the radius never drops below the minimum pixel floor', () => {
  for (const s of ['MODIS', 'VIIRS'] as const) {
    for (const small of [false, true]) {
      const floor = minRadiusPx(s, small);
      assert.ok(floor > 0);
      for (let z = 0; z <= RADIUS_MAX_ZOOM; z += 0.5) assert.ok(sensorRadiusPx(s, z, small) >= floor - 1e-9);
    }
  }
  assert.ok(minRadiusPx('VIIRS', true) < minRadiusPx('VIIRS', false), 'phones use a smaller floor');
});

test('at high zoom the radius is true to scale (metres per pixel halves per zoom level)', () => {
  const z = 16;
  assert.equal(sensorRadiusPx('VIIRS', z), trueRadiusPx('VIIRS', z));
  assert.ok(Math.abs(trueRadiusPx('MODIS', z + 1) / trueRadiusPx('MODIS', z) - 2) < 1e-9);
  // 564 m at zoom 16 on the equator: 564.19 / (78271.517 / 65536) ~= 472 px
  assert.ok(Math.abs(trueRadiusPx('MODIS', 16) - 472.4) < 1);
});

test('the stop list reproduces sensorRadiusPx exactly (base-2 exponential interpolation)', () => {
  for (const s of ['MODIS', 'VIIRS'] as const) {
    const stops = sensorRadiusStops(s);
    assert.equal(stops.length, 3);
    assert.ok(stops[0][0] < stops[1][0] && stops[1][0] < stops[2][0], 'stop zooms strictly increase');
    assert.equal(stops[0][1], stops[1][1], 'constant floor up to the crossover');
    assert.ok(Math.abs(stops[1][0] - floorCrossoverZoom(s)) < 1e-12);
    const [z0, r0] = stops[1];
    const [z1, r1] = stops[2];
    for (let z = z0; z <= z1; z += 1.5) {
      // MapLibre exponential interpolation, base 2
      const t = (2 ** (z - z0) - 1) / (2 ** (z1 - z0) - 1);
      const interpolated = r0 + t * (r1 - r0);
      assert.ok(Math.abs(interpolated - sensorRadiusPx(s, z)) < 1e-6, `${s} zoom ${z}`);
    }
  }
});

test('MODIS and VIIRS floors cross over to true scale at the same zoom (that is what keeps the ratio)', () => {
  assert.ok(Math.abs(floorCrossoverZoom('MODIS') - floorCrossoverZoom('VIIRS')) < 1e-9);
});

test('legend swatches keep the sensor size ratio', () => {
  assert.ok(LEGEND_SWATCH_PX.MODIS > LEGEND_SWATCH_PX.VIIRS);
  const r = LEGEND_SWATCH_PX.MODIS / LEGEND_SWATCH_PX.VIIRS;
  assert.ok(Math.abs(r - MODIS_VIIRS_RADIUS_RATIO) < 0.15);
});

test('lighten mixes toward white and clamps', () => {
  assert.equal(lighten('#000000', 1), '#ffffff');
  assert.equal(lighten('#336699', 0), '#336699');
  assert.equal(lighten('#336699', 5), '#ffffff');
  assert.throws(() => lighten('red', 0.5));
});

test('heatmap ramp: transparent first, strictly increasing density, sensor colour inside, lighter core last', () => {
  for (const s of ['MODIS', 'VIIRS'] as const) {
    const ramp = heatmapRamp(s);
    assert.ok(ramp[0][1].endsWith(',0)'), 'first stop is fully transparent');
    for (let i = 1; i < ramp.length; i++) assert.ok(ramp[i][0] > ramp[i - 1][0]);
    assert.ok(ramp.some(([, c]) => c === SENSOR_COLOR[s]), 'the pure sensor colour appears');
    assert.ok(ramp.some(([, c]) => c.endsWith(',0.35)')), 'a ~35 % opacity stop appears');
    assert.equal(ramp[ramp.length - 1][1], lighten(SENSOR_COLOR[s], 0.8));
  }
});
