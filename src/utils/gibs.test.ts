import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GIBS_CONFIG,
  GIBS_FALLBACK_BASEMAP,
  UNVERIFIED_MARKER,
  buildFallbackRasterLayer,
  buildFallbackRasterSource,
  buildGibsLayer,
  buildGibsRasterSource,
  buildGibsTileUrl,
  clampGibsDate,
  formatGibsDate,
  gibsSourceId,
  latestGibsDate,
  stepGibsDate,
  canStepGibsDate,
  parseGibsDate,
  shouldUseFallback,
} from './gibs';

// Fixed clock so nothing depends on the real date. No test touches the network.
const NOW = new Date('2026-11-06T12:00:00Z');

test('config sanity: layer ids, tile matrix sets, zoom, hosts', () => {
  const { baseMap, trueColor } = GIBS_CONFIG.layers;
  assert.equal(trueColor.id, 'VIIRS_NOAA20_CorrectedReflectance_TrueColor');
  assert.equal(trueColor.tileMatrixSet, 'GoogleMapsCompatible_Level9');
  assert.equal(trueColor.maxZoom, 9);
  assert.equal(trueColor.hasTime, true);
  assert.equal(baseMap.hasTime, false);
  for (const l of [baseMap, trueColor]) {
    assert.match(l.tileMatrixSet, /^GoogleMapsCompatible_Level\d$/);
    assert.equal(l.maxZoom, Number(l.tileMatrixSet.slice(-1)));
  }
  assert.ok(GIBS_CONFIG.endpoint.startsWith('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best'));
  assert.ok(GIBS_CONFIG.hosts.every((h) => h.endsWith('earthdata.nasa.gov')));
  assert.equal(GIBS_CONFIG.tileSize, 256);
  assert.ok(parseGibsDate(trueColor.minDate));
});

test('every unverified value is flagged with the marker', () => {
  const entries = Object.entries(GIBS_CONFIG.unverified);
  assert.ok(entries.length > 0);
  for (const [, note] of entries) assert.ok(note.startsWith(UNVERIFIED_MARKER));
  assert.ok('layers.trueColor.minDate' in GIBS_CONFIG.unverified);
});

test('true-color tile URL has the REST WMTS shape with a time segment', () => {
  const url = buildGibsTileUrl('trueColor', { date: '2026-11-01', now: NOW });
  assert.equal(
    url,
    'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_NOAA20_CorrectedReflectance_TrueColor/default/2026-11-01/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg',
  );
  assert.equal([...url.matchAll(/\{(\w)\}/g)].map((m) => m[1]).join(''), 'zyx');
});

test('base map URL is static: no date segment', () => {
  const url = buildGibsTileUrl('baseMap', { date: '2026-11-01', now: NOW });
  assert.ok(url.includes('/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.'));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(url));
});

test('host override accepts only known GIBS hosts', () => {
  assert.ok(buildGibsTileUrl('trueColor', { host: 'gibs-a.earthdata.nasa.gov', now: NOW }).startsWith('https://gibs-a.earthdata.nasa.gov/wmts/'));
  assert.throws(() => buildGibsTileUrl('trueColor', { host: 'evil.example.com' }), RangeError);
});

test('formatGibsDate uses UTC, not local time', () => {
  assert.equal(formatGibsDate(new Date('2026-11-06T23:59:59Z')), '2026-11-06');
  assert.equal(formatGibsDate(new Date('2026-11-07T00:00:00Z')), '2026-11-07');
  assert.equal(formatGibsDate(new Date('2026-11-06T23:30:00-05:00')), '2026-11-07');
  assert.throws(() => formatGibsDate(new Date('nope')), RangeError);
});

test('parseGibsDate is strict', () => {
  assert.ok(parseGibsDate('2024-02-29'));
  assert.equal(parseGibsDate('2026-02-30'), null);
  assert.equal(parseGibsDate('2026-2-3'), null);
  assert.equal(parseGibsDate('2026-11-06T00:00:00Z'), null);
  assert.equal(parseGibsDate(''), null);
});

test('latestGibsDate is one day before today (UTC) by default and respects lagDays', () => {
  assert.equal(latestGibsDate(NOW), '2026-11-05');
  assert.equal(latestGibsDate(new Date('2026-11-06T00:00:01Z')), '2026-11-05');
  assert.equal(latestGibsDate(new Date('2026-03-01T10:00:00Z')), '2026-02-28');
  assert.equal(latestGibsDate(NOW, 2), '2026-11-04');
  assert.equal(latestGibsDate(NOW, 3), '2026-11-03');
});

test('clampGibsDate: no future dates, no today, nothing before minDate', () => {
  assert.equal(clampGibsDate('2099-01-01', { now: NOW }), '2026-11-05');
  assert.equal(clampGibsDate('2026-11-06', { now: NOW }), '2026-11-05');
  assert.equal(clampGibsDate('2026-11-05', { now: NOW }), '2026-11-05');
  assert.equal(clampGibsDate('2026-10-15', { now: NOW }), '2026-10-15');
  assert.equal(clampGibsDate('2000-01-01', { now: NOW }), GIBS_CONFIG.layers.trueColor.minDate);
  assert.equal(clampGibsDate(new Date('2026-10-20T08:00:00Z'), { now: NOW }), '2026-10-20');
});

test('clampGibsDate falls back to the latest date for missing or invalid input', () => {
  assert.equal(clampGibsDate(undefined, { now: NOW }), '2026-11-05');
  assert.equal(clampGibsDate(null, { now: NOW }), '2026-11-05');
  assert.equal(clampGibsDate('garbage', { now: NOW }), '2026-11-05');
  assert.equal(clampGibsDate(new Date('nope'), { now: NOW }), '2026-11-05');
});

test('tile URL clamps a future date before building', () => {
  assert.ok(buildGibsTileUrl('trueColor', { date: '2099-12-31', now: NOW }).includes('/default/2026-11-05/'));
});

test('raster source: type, tile size, zoom range, attribution', () => {
  const s = buildGibsRasterSource('trueColor', { date: '2026-11-01', now: NOW });
  assert.equal(s.type, 'raster');
  assert.equal(s.tileSize, 256);
  assert.equal(s.minzoom, 0);
  assert.equal(s.maxzoom, 9);
  assert.deepEqual(s.tiles, [buildGibsTileUrl('trueColor', { date: '2026-11-01', now: NOW })]);
  assert.ok(s.attribution && /NASA/.test(s.attribution) && /GIBS/.test(s.attribution));
});

test('buildGibsLayer: ids line up and change with the date', () => {
  const a = buildGibsLayer('trueColor', { date: '2026-11-01', now: NOW });
  const b = buildGibsLayer('trueColor', { date: '2026-11-02', now: NOW });
  assert.equal(a.sourceId, 'gibs-trueColor-2026-11-01');
  assert.equal(a.layer.source, a.sourceId);
  assert.equal(a.layer.id, a.layerId);
  assert.notEqual(a.sourceId, b.sourceId);
  assert.equal(gibsSourceId('baseMap'), 'gibs-baseMap');
});

test('fallback basemap config and builders', () => {
  const f = GIBS_FALLBACK_BASEMAP;
  assert.ok(f.tiles[0].includes('{z}') && f.tiles[0].includes('{y}') && f.tiles[0].includes('{x}'));
  assert.match(f.backgroundColor, /^#[0-9a-f]{6}$/i);
  assert.ok(!f.tiles[0].includes('earthdata.nasa.gov'), 'fallback must not depend on GIBS');
  const src = buildFallbackRasterSource();
  assert.equal(src.type, 'raster');
  assert.equal(buildFallbackRasterLayer().source, f.sourceId);
  assert.equal(shouldUseFallback(f.errorThreshold - 1), false);
  assert.equal(shouldUseFallback(f.errorThreshold), true);
});

test('default lagDays is 1', () => {
  assert.equal(GIBS_CONFIG.lagDays, 1);
});

const STEP_OPTS = { now: NOW, minDate: '2026-10-30' };

test('stepGibsDate steps one day back and forward inside the range', () => {
  assert.equal(stepGibsDate('2026-11-03', 1, STEP_OPTS), '2026-11-04');
  assert.equal(stepGibsDate('2026-11-03', -1, STEP_OPTS), '2026-11-02');
});

test('stepGibsDate clamps at the newest allowed date and at minDate', () => {
  assert.equal(stepGibsDate('2026-11-05', 1, STEP_OPTS), '2026-11-05');
  assert.equal(stepGibsDate('2026-10-30', -1, STEP_OPTS), '2026-10-30');
  assert.equal(stepGibsDate('2026-11-05', 5, STEP_OPTS), '2026-11-05');
  assert.equal(stepGibsDate('2026-11-01', -30, STEP_OPTS), '2026-10-30');
});

test('stepGibsDate handles month and year rollover', () => {
  const o = { now: new Date('2027-03-10T12:00:00Z'), minDate: '2018-01-05' };
  assert.equal(stepGibsDate('2026-12-31', 1, o), '2027-01-01');
  assert.equal(stepGibsDate('2027-01-01', -1, o), '2026-12-31');
  assert.equal(stepGibsDate('2027-03-01', -1, o), '2027-02-28');
  assert.equal(stepGibsDate('2028-03-01', -1, { now: new Date('2028-06-01T00:00:00Z'), minDate: '2018-01-05' }), '2028-02-29');
});

test('stepGibsDate resolves an out-of-range or invalid current date without throwing', () => {
  assert.equal(stepGibsDate('2099-01-01', -1, STEP_OPTS), '2026-11-04');
  assert.equal(stepGibsDate('garbage', -1, STEP_OPTS), '2026-11-04');
  assert.equal(stepGibsDate('2000-01-01', 1, STEP_OPTS), '2026-10-31');
});

test('stepGibsDate reads no clock: the result depends only on the injected now', () => {
  const a = stepGibsDate('2026-11-05', 1, { now: new Date('2026-11-06T00:00:00Z'), minDate: '2026-10-30' });
  const b = stepGibsDate('2026-11-05', 1, { now: new Date('2026-11-07T00:00:00Z'), minDate: '2026-10-30' });
  assert.equal(a, '2026-11-05');
  assert.equal(b, '2026-11-06');
});

test('canStepGibsDate is false at both ends and true in between', () => {
  assert.equal(canStepGibsDate('2026-11-05', 1, STEP_OPTS), false);
  assert.equal(canStepGibsDate('2026-11-05', -1, STEP_OPTS), true);
  assert.equal(canStepGibsDate('2026-10-30', -1, STEP_OPTS), false);
  assert.equal(canStepGibsDate('2026-10-30', 1, STEP_OPTS), true);
  assert.equal(canStepGibsDate('2026-11-02', 1, STEP_OPTS), true);
  assert.equal(canStepGibsDate('2026-11-02', -1, STEP_OPTS), true);
});

test('canStepGibsDate treats a date beyond the end as the end', () => {
  assert.equal(canStepGibsDate('2099-01-01', 1, STEP_OPTS), false);
  assert.equal(canStepGibsDate('2099-01-01', -1, STEP_OPTS), true);
});
