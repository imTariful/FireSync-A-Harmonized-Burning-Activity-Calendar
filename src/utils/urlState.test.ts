import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VIEW_STATE,
  decodeViewState,
  encodeViewState,
  wrapLng,
  type ViewState,
} from './urlState';

const sample: ViewState = {
  lat: 37.7749,
  lng: -122.4194,
  zoom: 6.5,
  days: 3,
  layers: ['modis'],
  timeline: 0.25,
  date: '2026-08-15',
};

test('round-trips a full state', () => {
  assert.deepEqual(decodeViewState(encodeViewState(sample)), sample);
});

test('round-trips without optional date and with both layers', () => {
  const s: ViewState = { ...sample, layers: ['modis', 'viirs'], date: undefined };
  const decoded = decodeViewState(encodeViewState(s));
  assert.equal(decoded.date, undefined);
  assert.deepEqual(decoded.layers, ['modis', 'viirs']);
});

test('round-trips an empty layer set (all layers hidden)', () => {
  const decoded = decodeViewState(encodeViewState({ ...sample, layers: [] }));
  assert.deepEqual(decoded.layers, []);
});

test('empty / missing input yields defaults', () => {
  assert.deepEqual(decodeViewState(''), DEFAULT_VIEW_STATE);
  assert.deepEqual(decodeViewState(null), DEFAULT_VIEW_STATE);
  assert.deepEqual(decodeViewState(undefined), DEFAULT_VIEW_STATE);
});

test('accepts leading "?" and URLSearchParams', () => {
  const q = encodeViewState(sample);
  assert.deepEqual(decodeViewState('?' + q), sample);
  assert.deepEqual(decodeViewState(new URLSearchParams(q)), sample);
});

test('malformed values fall back to defaults and never throw', () => {
  const bad = [
    'lat=abc&lng=&z=NaN&d=x&t=--&date=nope&layers=%%%',
    'lat=Infinity&lng=-Infinity&z=1e999&d=1.5&t=2',
    'lat=%E0%A4%A&lng=%FF',
    'lat=12abc&z=3 4',
    'date=2026-02-30',
    'date=2026-13-01',
  ];
  for (const q of bad) {
    assert.doesNotThrow(() => decodeViewState(q), q);
  }
  const d = decodeViewState('lat=abc&lng=&z=NaN&d=x&t=--&date=nope&layers=%%%');
  assert.equal(d.lat, DEFAULT_VIEW_STATE.lat);
  assert.equal(d.lng, DEFAULT_VIEW_STATE.lng);
  assert.equal(d.zoom, DEFAULT_VIEW_STATE.zoom);
  assert.equal(d.days, DEFAULT_VIEW_STATE.days);
  assert.equal(d.timeline, DEFAULT_VIEW_STATE.timeline);
  assert.equal(d.date, undefined);
  assert.deepEqual(d.layers, [...DEFAULT_VIEW_STATE.layers]);
});

test('non-finite numbers are rejected, not clamped', () => {
  const d = decodeViewState('lat=Infinity&z=1e999');
  assert.equal(d.lat, DEFAULT_VIEW_STATE.lat);
  assert.equal(d.zoom, DEFAULT_VIEW_STATE.zoom);
});

test('lat and zoom are clamped', () => {
  const d = decodeViewState('lat=123&z=99');
  assert.equal(d.lat, 90);
  assert.equal(d.zoom, 22);
  const e = decodeViewState('lat=-123&z=-4');
  assert.equal(e.lat, -90);
  assert.equal(e.zoom, 0);
});

test('longitude wraps across the antimeridian', () => {
  assert.equal(decodeViewState('lng=190').lng, -170);
  assert.equal(decodeViewState('lng=-190').lng, 170);
  assert.equal(decodeViewState('lng=360').lng, 0);
  assert.equal(decodeViewState('lng=540').lng, 180);
  assert.equal(decodeViewState('lng=-540').lng, -180);
  assert.equal(decodeViewState('lng=180').lng, 180);
  assert.equal(decodeViewState('lng=-180').lng, -180);
  assert.equal(decodeViewState('lng=725').lng, 5);
  assert.equal(wrapLng(wrapLng(1234.5)), wrapLng(1234.5));
});

test('encode normalises out-of-range state', () => {
  const q = encodeViewState({ ...sample, lat: 500, lng: 200, zoom: 40, days: 9, timeline: -1 });
  const d = decodeViewState(q);
  assert.equal(d.lat, 90);
  assert.equal(d.lng, -160);
  assert.equal(d.zoom, 22);
  assert.equal(d.days, DEFAULT_VIEW_STATE.days);
  assert.equal(d.timeline, DEFAULT_VIEW_STATE.timeline);
});

test('days must be an integer 1..5', () => {
  for (const v of ['0', '6', '-1', '2.5', 'abc', '']) {
    assert.equal(decodeViewState(`d=${v}`).days, DEFAULT_VIEW_STATE.days, v);
  }
  for (const v of [1, 2, 3, 4, 5]) {
    assert.equal(decodeViewState(`d=${v}`).days, v);
  }
});

test('layers: unknown ignored, case-insensitive, deduped, canonical order', () => {
  assert.deepEqual(decodeViewState('layers=VIIRS,foo,viirs').layers, ['viirs']);
  assert.deepEqual(decodeViewState('layers=viirs,modis').layers, ['modis', 'viirs']);
  assert.deepEqual(decodeViewState('layers=foo,bar').layers, [...DEFAULT_VIEW_STATE.layers]);
  assert.deepEqual(decodeViewState('layers=').layers, []);
});

test('timeline must be within 0..1', () => {
  assert.equal(decodeViewState('t=0').timeline, 0);
  assert.equal(decodeViewState('t=0.5').timeline, 0.5);
  assert.equal(decodeViewState('t=1.01').timeline, DEFAULT_VIEW_STATE.timeline);
  assert.equal(decodeViewState('t=-0.1').timeline, DEFAULT_VIEW_STATE.timeline);
});

test('date must be a real calendar date', () => {
  assert.equal(decodeViewState('date=2024-02-29').date, '2024-02-29');
  assert.equal(decodeViewState('date=2026-02-29').date, undefined);
  assert.equal(decodeViewState('date=2026-8-1').date, undefined);
  assert.equal(decodeViewState('date=<script>').date, undefined);
});

test('decode returns fresh objects (defaults are not shared/mutable)', () => {
  const a = decodeViewState('');
  a.layers.push('modis');
  assert.deepEqual(decodeViewState('').layers, ['modis', 'viirs']);
  assert.deepEqual(DEFAULT_VIEW_STATE.layers, ['modis', 'viirs']);
});

test('view: "map" round-trips; the default globe is never written', () => {
  const base = { lat: 10, lng: 20, zoom: 3, days: 2, layers: ['modis', 'viirs'] as const, timeline: 1 };
  const q = encodeViewState({ ...base, layers: [...base.layers], view: 'map' });
  assert.equal(new URLSearchParams(q).get('view'), 'map');
  assert.equal(decodeViewState(q).view, 'map');
  const g = encodeViewState({ ...base, layers: [...base.layers], view: 'globe' });
  assert.equal(new URLSearchParams(g).has('view'), false);
  assert.equal(encodeViewState({ ...base, layers: [...base.layers] }), g);
  assert.equal(decodeViewState(g).view, undefined);
});

test('view: unknown values fall back to the default (no view key)', () => {
  for (const v of ['', 'globe', 'MAP', 'flat', '1', '<script>']) {
    assert.equal(decodeViewState(`view=${encodeURIComponent(v)}`).view, undefined, v);
  }
});
