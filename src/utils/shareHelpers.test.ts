import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VISIBLE_DETECTIONS_DEFINITION,
  buildShareFilename,
  buildShareUrl,
  countBySensor,
  layoutCaptureFooter,
  parseShareParams,
  selectVisibleDetections,
  snapDays,
  timelineFractionFromStep,
  timelineStepFromFraction,
  type ShareState,
} from './shareHelpers';
import { DEFAULT_VIEW_STATE } from './urlState';
import { EXPORT_DISCLAIMER, detectionsToCsv, detectionsToGeoJson, type ExportDetection } from './export';

const state: ShareState = {
  lat: -12.5,
  lng: 130.25,
  zoom: 7.5,
  days: 3,
  layers: ['modis'],
  timeline: 0.5,
};

const det = (sensor: 'MODIS' | 'VIIRS', iso: string, over: Partial<ExportDetection> = {}): ExportDetection => ({
  sensor,
  datetime_utc: iso,
  latitude: 1,
  longitude: 2,
  satellite: sensor === 'MODIS' ? 'Terra' : 'NOAA-20',
  frp_mw: 5,
  confidence: 80,
  ...over,
});

// ---- URL ------------------------------------------------------------------

test('buildShareUrl round-trips through parseShareParams', () => {
  const url = buildShareUrl('https://firesync.example', '/explorer', state);
  assert.ok(url.startsWith('https://firesync.example/explorer?'));
  const p = parseShareParams(new URL(url).search);
  assert.deepEqual(p.state, { ...state, timeline: 0.5 });
  assert.ok(p.hasCamera && p.hasDays && p.hasLayers && p.hasTimeline && p.fromUrl);
});

test('no timeline: no t param, and nothing is applied for it on load', () => {
  const url = buildShareUrl('https://x.test', '/', { ...state, timeline: null });
  assert.ok(!new URL(url).searchParams.has('t'));
  assert.equal(parseShareParams(new URL(url).search).hasTimeline, false);
});

test('empty layers round-trip as "no layers", not as the default', () => {
  const url = buildShareUrl('https://x.test', '/', { ...state, layers: [] });
  const p = parseShareParams(new URL(url).search);
  assert.deepEqual(p.state.layers, []);
  assert.equal(p.hasLayers, true);
});

test('link carries only the view params: no secrets, keys, credentials, hash or foreign query', () => {
  const url = buildShareUrl('https://user:hunter2@host.test:8443/ignored?api_key=SECRET#frag', '/app?key=SECRET2#h', state);
  assert.ok(url.startsWith('https://host.test:8443/app?'));
  assert.doesNotMatch(url, /hunter2|SECRET|user|key|#/i);
  const names = [...new URL(url).searchParams.keys()].sort();
  assert.deepEqual(names, ['d', 'lat', 'layers', 'lng', 't', 'z']);
});

test('invalid or non-http origin falls back to a relative link', () => {
  assert.ok(buildShareUrl('not a url', '/a', state).startsWith('/a?'));
  assert.ok(buildShareUrl('javascript:alert(1)', '/a', state).startsWith('/a?'));
  assert.ok(buildShareUrl('file:///x', 'a', state).startsWith('/a?'));
});

test('malformed or hostile query strings fall back to defaults and never throw', () => {
  const bad = [
    '',
    '?',
    '?lat=abc&lng=&z=NaN&d=99&layers=<script>&t=zzz',
    '?lat=%E0%A4%A&lng=%',
    '?lat=Infinity&lng=-Infinity&z=1e999',
    '?__proto__=x&constructor=y&lat[]=1',
    `?lat=${'9'.repeat(5000)}`,
  ];
  for (const q of bad) {
    const p = parseShareParams(q);
    assert.equal(p.state.days, DEFAULT_VIEW_STATE.days, q);
    assert.deepEqual(p.state.layers, DEFAULT_VIEW_STATE.layers, q);
    assert.equal(p.hasCamera, false, q);
    assert.equal(p.hasTimeline, false, q);
    assert.equal(p.fromUrl, false, q);
  }
  assert.doesNotThrow(() => parseShareParams(null));
  assert.doesNotThrow(() => parseShareParams(undefined));
  assert.doesNotThrow(() => parseShareParams(42 as unknown as string));
});

test('unknown params are ignored; view params still apply', () => {
  const p = parseShareParams('?utm_source=x&lat=10&lng=20&foo=bar');
  assert.equal(p.hasCamera, true);
  assert.equal(p.state.lat, 10);
  assert.equal(p.state.lng, 20);
});

test('only lat without lng gives no camera', () => {
  assert.equal(parseShareParams('?lat=10').hasCamera, false);
});

test('antimeridian: longitude wraps and +-180 survive the round trip', () => {
  assert.equal(parseShareParams('?lat=0&lng=190').state.lng, -170);
  assert.equal(parseShareParams('?lat=0&lng=-190').state.lng, 170);
  for (const lng of [180, -180, 179.9999, -179.9999]) {
    const url = buildShareUrl('https://x.test', '/', { ...state, lng });
    assert.equal(parseShareParams(new URL(url).search).state.lng, lng);
  }
  const wrapped = buildShareUrl('https://x.test', '/', { ...state, lng: 190 });
  assert.equal(parseShareParams(new URL(wrapped).search).state.lng, -170);
});

test('out-of-range lat / zoom are clamped, t is clamped into 0..1', () => {
  const p = parseShareParams('?lat=123&lng=0&z=99&t=7');
  assert.equal(p.state.lat, 90);
  assert.equal(p.state.zoom, 22);
  assert.equal(p.state.timeline, 1);
  assert.equal(parseShareParams('?t=-3').state.timeline, 0);
  assert.equal(parseShareParams('?t=-3').hasTimeline, true);
});

test('snapDays picks the nearest offered option, ties to the smaller window', () => {
  const opts = [1, 2, 3, 5];
  assert.equal(snapDays(4, opts), 3);
  assert.equal(snapDays(5, opts), 5);
  assert.equal(snapDays(1, opts), 1);
});

test('timeline fraction <-> step mapping is clamped', () => {
  assert.equal(timelineStepFromFraction(0, 10), 0);
  assert.equal(timelineStepFromFraction(1, 10), 9);
  assert.equal(timelineStepFromFraction(5, 10), 9);
  assert.equal(timelineStepFromFraction(-1, 10), 0);
  assert.equal(timelineStepFromFraction(0.5, 1), 0);
  assert.equal(timelineStepFromFraction(0.5, 0), 0);
  assert.equal(timelineStepFromFraction(NaN, 10), 0);
  assert.equal(timelineFractionFromStep(9, 10), 1);
  assert.equal(timelineFractionFromStep(0, 10), 0);
  assert.equal(timelineFractionFromStep(0, 1), 1);
});

// ---- visible detections ---------------------------------------------------

const sample = [
  det('MODIS', '2026-08-01T00:00:00Z'),
  det('VIIRS', '2026-08-01T06:00:00Z'),
  det('MODIS', '2026-08-01T12:00:00Z'),
  det('VIIRS', '2026-08-01T18:00:00Z'),
];

test('visible detections: layer filter, no cutoff', () => {
  assert.equal(selectVisibleDetections(sample, ['modis', 'viirs'], null).length, 4);
  assert.deepEqual(countBySensor(selectVisibleDetections(sample, ['modis'], null)), { MODIS: 2, VIIRS: 0 });
  assert.deepEqual(countBySensor(selectVisibleDetections(sample, ['viirs'], undefined)), { MODIS: 0, VIIRS: 2 });
  assert.equal(selectVisibleDetections(sample, [], null).length, 0);
});

test('visible detections: cutoff is inclusive and combines with the layer filter', () => {
  const cutoff = Date.parse('2026-08-01T12:00:00Z');
  assert.equal(selectVisibleDetections(sample, ['modis', 'viirs'], cutoff).length, 3);
  assert.deepEqual(countBySensor(selectVisibleDetections(sample, ['modis'], cutoff)), { MODIS: 2, VIIRS: 0 });
  assert.equal(selectVisibleDetections(sample, ['modis', 'viirs'], cutoff - 1).length, 2);
});

test('visible detections: drops unknown sensors and does not mutate the input', () => {
  const input = [...sample, { ...det('MODIS', '2026-08-01T00:00:00Z'), sensor: 'AVHRR' as never }];
  const copy = JSON.stringify(input);
  assert.equal(selectVisibleDetections(input, ['modis', 'viirs'], null).length, 4);
  assert.equal(JSON.stringify(input), copy);
});

test('empty detections: selector, counts, CSV and GeoJSON stay valid', () => {
  const v = selectVisibleDetections([], ['modis', 'viirs'], 123);
  assert.deepEqual(v, []);
  assert.deepEqual(countBySensor(v), { MODIS: 0, VIIRS: 0 });
  assert.equal(detectionsToCsv(v), 'sensor,satellite,latitude,longitude,datetime_utc,frp_mw,confidence');
  const g = detectionsToGeoJson(v, new Date('2026-08-01T00:00:00Z'));
  assert.equal(g.features.length, 0);
  assert.equal(g.metadata.disclaimer, EXPORT_DISCLAIMER);
  assert.deepEqual(g.metadata.counts_by_sensor, { MODIS: 0, VIIRS: 0 });
});

test('formula injection is still blocked on the visible-detections export path', () => {
  const evil = [det('MODIS', '2026-08-01T00:00:00Z', { satellite: '=HYPERLINK("http://evil")' as never, confidence: '@SUM(A1)' })];
  const csv = detectionsToCsv(selectVisibleDetections(evil, ['modis'], null));
  const row = csv.split('\r\n')[1];
  assert.match(row, /'=HYPERLINK/);
  assert.match(row, /'@SUM/);
  assert.doesNotMatch(row, /(^|,)=HYPERLINK/);
});

test('the definition text names layer and timeline conditions', () => {
  assert.match(VISIBLE_DETECTIONS_DEFINITION, /layer/);
  assert.match(VISIBLE_DETECTIONS_DEFINITION, /timeline/);
});

// ---- file names -----------------------------------------------------------

const NOW = new Date('2026-11-07T17:46:05.123Z');

test('filename: view fallback, days, UTC timestamp, extension', () => {
  assert.equal(
    buildShareFilename({ view: { lat: 20, lng: 60 }, days: 2, ext: 'csv', now: NOW }),
    'firesync_20.00N-60.00E_2d_20261107T174605Z.csv',
  );
  assert.equal(
    buildShareFilename({ view: { lat: -33.8688, lng: -190 }, days: 1, ext: 'png', now: NOW }),
    'firesync_33.87S-170.00E_1d_20261107T174605Z.png',
  );
});

test('filename: area slug is ASCII only and safe', () => {
  const n = buildShareFilename({ area: 'São Paulo / Brasil "x"', days: 3, ext: 'geojson', now: NOW });
  assert.equal(n, 'firesync_sao-paulo-brasil-x_3d_20261107T174605Z.geojson');
  assert.match(n, /^[\x20-\x7E]+$/);
  assert.doesNotMatch(n, /[\\/:*?"<>| ]/);
  const evil = buildShareFilename({ area: '../../etc/passwd\u0000', days: 1, ext: 'csv', now: NOW });
  assert.doesNotMatch(evil, /\.\.|\/|\u0000/);
});

test('filename: non-ASCII-only area falls back to the view, bad days to 1, never throws', () => {
  assert.equal(
    buildShareFilename({ area: '東京', view: { lat: 35.68, lng: 139.69 }, days: 0, ext: 'csv', now: NOW }),
    'firesync_35.68N-139.69E_1d_20261107T174605Z.csv',
  );
  assert.match(buildShareFilename({ days: 1, ext: 'csv', now: new Date(NaN) }), /^firesync_view_1d_19700101T000000Z\.csv$/);
});

// ---- footer ---------------------------------------------------------------

test('footer: legend, separate counts, UTC time, attribution; no combined total', () => {
  const lines = layoutCaptureFooter({
    viewTime: NOW,
    counts: { MODIS: 1200, VIIRS: 34 },
    attribution: ['Fire data: NASA FIRMS', 'Imagery: NASA EOSDIS GIBS'],
    days: 2,
    maxChars: 200,
  });
  assert.equal(lines[0], 'Satellite thermal anomalies, not confirmed wildfires or burned area.');
  const text = lines.join('\n');
  assert.match(text, /MODIS 1,200 · VIIRS 34 \(shown separately, not summed\)/);
  assert.match(text, /View time \(UTC\): 2026-11-07T17:46:05Z/);
  assert.match(text, /NASA FIRMS/);
  assert.match(text, /GIBS/);
  assert.doesNotMatch(text, /1,234|1234/);
  assert.doesNotMatch(text, /EXPLORATORY/);
});

test('footer: timeline cutoff shown only when active; wraps to maxChars; empty counts fine', () => {
  const none = layoutCaptureFooter({ viewTime: NOW, counts: { MODIS: 0, VIIRS: 0 }, attribution: [] });
  assert.doesNotMatch(none.join('\n'), /timeline/);
  assert.match(none.join('\n'), /MODIS 0 · VIIRS 0/);
  const cut = layoutCaptureFooter({
    viewTime: NOW,
    counts: { MODIS: 1, VIIRS: 2 },
    attribution: ['a'],
    timelineCutoffMs: Date.parse('2026-11-07T12:00:00Z'),
    maxChars: 30,
  });
  assert.match(cut.join(' '), /timeline up to 2026-11-07T12:00:00Z/);
  for (const l of cut) assert.ok(l.length <= 30, l);
});

// ---- address-bar merge ----------------------------------------------------

import { VIEW_PARAM_KEYS, buildShareQuery, clearViewParams, mergeViewParams } from './shareHelpers';

test('mergeViewParams replaces view params, keeps unknown ones, and is idempotent', () => {
  const once = mergeViewParams('?utm=1&lat=1&lng=2&z=3&d=1&layers=&t=0.2&date=2026-01-01', state);
  const q = new URLSearchParams(once);
  assert.equal(q.get('utm'), '1');
  assert.equal(q.get('lat'), '-12.5');
  assert.equal(q.getAll('lat').length, 1);
  assert.equal(q.has('date'), false);
  assert.equal(mergeViewParams(once, state), once);
});

test('mergeViewParams without timeline drops t; clearViewParams removes only view params', () => {
  const q = new URLSearchParams(mergeViewParams('?t=0.4', { ...state, timeline: null }));
  assert.equal(q.has('t'), false);
  assert.equal(clearViewParams('?a=b&lat=1&z=2&layers=modis&t=1'), 'a=b');
  assert.equal(clearViewParams(undefined), '');
});

test('view param: written only for the World map, read back, and flagged as coming from the URL', () => {
  const state = { lat: 1, lng: 2, zoom: 5, days: 2, layers: ['modis' as const], timeline: null };
  assert.equal(new URLSearchParams(buildShareQuery(state)).has('view'), false);
  const q = buildShareQuery({ ...state, view: 'map' });
  assert.equal(new URLSearchParams(q).get('view'), 'map');
  const p = parseShareParams(`?${q}`);
  assert.equal(p.state.view, 'map');
  assert.equal(p.hasView, true);
  assert.equal(parseShareParams('?view=map').fromUrl, true);
  assert.equal(parseShareParams('?view=globe').hasView, true);
  assert.equal(parseShareParams('?view=nope').hasView, false);
  assert.equal(parseShareParams('?view=nope').fromUrl, false);
  assert.ok(VIEW_PARAM_KEYS.includes('view' as never));
  assert.ok(!clearViewParams('?view=map&utm=1').includes('view='));
  assert.ok(clearViewParams('?view=map&utm=1').includes('utm=1'));
});
