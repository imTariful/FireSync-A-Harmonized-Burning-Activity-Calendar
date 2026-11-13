/**
 * Polygon AOI tests: validation, point-in-polygon (boundary + holes are NOT supported),
 * bbox prefilter, compact URL encoding and antimeridian rings.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodePolygon,
  encodePolygon,
  filterByPolygon,
  isPointInPolygon,
  polygonBbox,
  validatePolygon,
} from './polygon';
import type { AoiPolygon } from '../types/fire';

const SQUARE: AoiPolygon = [
  [90, 22],
  [91, 22],
  [91, 23],
  [90, 23],
];

test('validatePolygon accepts an open ring and drops an explicit closing vertex', () => {
  const open = validatePolygon(SQUARE);
  assert.equal(open.ok, true);
  if (!open.ok) return;
  assert.equal(open.polygon.length, 4);

  const closed = validatePolygon([...SQUARE, [90, 22]]);
  assert.equal(closed.ok, true);
  if (!closed.ok) return;
  assert.equal(closed.polygon.length, 4);
  assert.deepEqual(closed.polygon[0], [90, 22]);
  assert.notDeepEqual(closed.polygon[closed.polygon.length - 1], [90, 22]);
});

test('validatePolygon rejects too few, non-numeric, out-of-range and degenerate rings', () => {
  assert.equal(validatePolygon([[90, 22], [91, 22]]).ok, false);
  assert.equal(validatePolygon([[90, 22], ['x', 22], [91, 23]]).ok, false);
  assert.equal(validatePolygon([[90, 22], [181, 22], [91, 23]]).ok, false);
  assert.equal(validatePolygon([[90, 22], [90.5, 22], [91, 22]]).ok, false);
  assert.equal(validatePolygon('not a polygon').ok, false);
});

test('isPointInPolygon: interior, exterior and boundary points', () => {
  assert.equal(isPointInPolygon(22.5, 90.5, SQUARE), true);
  assert.equal(isPointInPolygon(22.0, 90.5, SQUARE), true, 'boundary edge counts as inside');
  assert.equal(isPointInPolygon(22.5, 90.0, SQUARE), true, 'boundary vertex counts as inside');
  assert.equal(isPointInPolygon(21.9, 90.5, SQUARE), false);
  assert.equal(isPointInPolygon(22.5, 91.1, SQUARE), false);
  assert.equal(isPointInPolygon(Number.NaN, 90.5, SQUARE), false);
  assert.equal(isPointInPolygon(22.5, 90.5, [[90, 22], [91, 22]] as AoiPolygon), false);
});

test('filterByPolygon keeps only observations inside the drawn AOI', () => {
  const observations = [
    { id: 'inside', latitude: 22.5, longitude: 90.5 },
    { id: 'outside', latitude: 25.0, longitude: 90.5 },
    { id: 'boundary', latitude: 23.0, longitude: 90.5 },
  ];
  const kept = filterByPolygon(observations, SQUARE).map((o) => o.id);
  assert.deepEqual(kept, ['inside', 'boundary']);
  assert.equal(filterByPolygon(observations, null).length, 3);
});

test('polygonBbox is a preliminary filter, not the AOI itself', () => {
  assert.deepEqual(polygonBbox(SQUARE), { west: 90, south: 22, east: 91, north: 23 });
  const triangle: AoiPolygon = [
    [90, 22],
    [91, 22],
    [90, 23],
  ];
  // The bbox includes the upper-right corner, which the triangle does NOT contain.
  const bbox = polygonBbox(triangle);
  assert.equal(isPointInPolygon(22.9, 90.9, triangle), false);
  assert.ok(22.9 <= bbox.north && 90.9 <= bbox.east);
});

test('compact encoding round-trips and rejects malformed strings', () => {
  const encoded = encodePolygon(SQUARE);
  assert.equal(encoded, '90,22;91,22;91,23;90,23');
  assert.deepEqual(decodePolygon(encoded), SQUARE);
  assert.equal(decodePolygon('90,22;91,22'), null);
  assert.equal(decodePolygon('90,22;oops;91,23'), null);
  assert.equal(decodePolygon(''), null);
});

test('antimeridian ring stays small: 179.5°E and 179.5°W are inside, 0° is outside', () => {
  const crossing: AoiPolygon = [
    [170, 10],
    [-170, 10],
    [-170, -10],
    [170, -10],
  ];
  assert.equal(isPointInPolygon(0, 179.5, crossing), true);
  assert.equal(isPointInPolygon(0, -179.5, crossing), true);
  assert.equal(isPointInPolygon(0, 0, crossing), false, 'the ring must not span the whole globe');
  assert.equal(isPointInPolygon(20, 179.5, crossing), false);

  // bbox widens to the full longitude range because the ring crosses the dateline.
  assert.deepEqual(polygonBbox(crossing), { west: -180, south: -10, east: 180, north: 10 });
});

test('a non-crossing ring is unaffected by the antimeridian logic', () => {
  assert.equal(isPointInPolygon(0, -179.5, SQUARE), false);
  assert.equal(isPointInPolygon(22.5, 90.5, SQUARE), true);
});
