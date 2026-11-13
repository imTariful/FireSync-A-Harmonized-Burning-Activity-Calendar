import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AREA,
  WORLD_AREA,
  PLACE_FALLBACK_HALF_SPAN_DEG,
  archiveCoverageFromTotal,
  areaFromPlace,
  areaFromQuickRegion,
  areaToScope,
  bboxToString,
} from './area';
import { QUICK_REGIONS } from './fireRegions';

test('every quick region converts to a preset area with the same id, name and bbox', () => {
  for (const r of QUICK_REGIONS) {
    const a = areaFromQuickRegion(r);
    assert.equal(a.id, r.id);
    assert.equal(a.name, r.name);
    assert.deepEqual(a.bbox, r.bbox);
    assert.equal(a.kind, 'preset');
  }
});

test('areaFromQuickRegion copies the bbox (no shared mutable object)', () => {
  const r = QUICK_REGIONS[0];
  const a = areaFromQuickRegion(r);
  assert.notEqual(a.bbox, r.bbox);
});

test('there are 8 quick regions and the default area is Bangladesh', () => {
  assert.equal(QUICK_REGIONS.length, 8);
  assert.equal(DEFAULT_AREA.id, 'bangladesh');
  assert.equal(DEFAULT_AREA.kind, 'preset');
  assert.deepEqual(DEFAULT_AREA.bbox, { west: 88.0, south: 20.5, east: 92.8, north: 26.7 });
});

test('bboxToString is west,south,east,north', () => {
  assert.equal(bboxToString({ west: 88, south: 20.5, east: 92.8, north: 26.7 }), '88,20.5,92.8,26.7');
});

test('areaToScope gives the bbox string and only adds sensors when asked', () => {
  assert.deepEqual(areaToScope(DEFAULT_AREA), { bbox: '88,20.5,92.8,26.7' });
  assert.deepEqual(areaToScope(DEFAULT_AREA, 'MODIS'), { bbox: '88,20.5,92.8,26.7', sensors: 'MODIS' });
  assert.equal('sensors' in areaToScope(DEFAULT_AREA, undefined), false);
});

test('areaFromPlace keeps the place bbox when there is one', () => {
  const a = areaFromPlace({ name: 'Dhaka', lat: 23.8, lng: 90.4, bbox: { west: 90.3, south: 23.7, east: 90.5, north: 23.9 } });
  assert.equal(a.kind, 'place');
  assert.equal(a.name, 'Dhaka');
  assert.deepEqual(a.bbox, { west: 90.3, south: 23.7, east: 90.5, north: 23.9 });
  assert.equal(a.id, 'place:23.8,90.4');
});

test('areaFromPlace builds a small box around a point without bbox, clamped to the globe', () => {
  const a = areaFromPlace({ name: 'Pole', lat: 89.9, lng: 179.9 });
  const h = PLACE_FALLBACK_HALF_SPAN_DEG;
  assert.equal(a.bbox.south, 89.9 - h);
  assert.equal(a.bbox.north, 90);
  assert.equal(a.bbox.east, 180);
  assert.ok(a.bbox.west < a.bbox.east && a.bbox.south < a.bbox.north);
});

test('archiveCoverageFromTotal: unknown until a number arrives, none for 0, covered for > 0', () => {
  assert.equal(archiveCoverageFromTotal(null), 'unknown');
  assert.equal(archiveCoverageFromTotal(undefined), 'unknown');
  assert.equal(archiveCoverageFromTotal(Number.NaN), 'unknown');
  assert.equal(archiveCoverageFromTotal(0), 'none');
  assert.equal(archiveCoverageFromTotal(30), 'covered');
});

test('the page fallback area covers the whole globe', () => {
  assert.equal(WORLD_AREA.id, 'world');
  assert.equal(WORLD_AREA.name, 'World');
  assert.deepEqual(WORLD_AREA.bbox, { west: -180, south: -90, east: 180, north: 90 });
});
