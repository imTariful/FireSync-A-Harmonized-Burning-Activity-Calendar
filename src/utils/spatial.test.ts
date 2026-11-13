import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectToEqualAreaKm,
  invertEqualAreaKm,
  computeGridCellIndex,
  haversineDistanceKm,
  isPointInBbox,
} from './spatial';

test('projectToEqualAreaKm and invertEqualAreaKm are reversible', () => {
  const lat = 23.685;
  const lon = 90.3563;
  const { xKm, yKm } = projectToEqualAreaKm(lat, lon);
  const inverted = invertEqualAreaKm(xKm, yKm);

  assert.ok(Math.abs(inverted.lat - lat) < 0.0001, 'Latitude inverted within precision');
  assert.ok(Math.abs(inverted.lon - lon) < 0.0001, 'Longitude inverted within precision');
});

test('projectToEqualAreaKm matches independent analytical reference coordinates', () => {
  // Equator, 10 deg East: y must be 0, x = R * (10*pi/180) * cos(23.5 deg) ~ 1019.74 km
  const eqPoint = projectToEqualAreaKm(0, 10, 0, 23.5);
  assert.ok(Math.abs(eqPoint.yKm) < 0.001, 'Equator y-coordinate must be 0');
  assert.ok(Math.abs(eqPoint.xKm - 1019.74) < 0.2, `Expected ~1019.74km, got ${eqPoint.xKm}`);

  // Prime Meridian, 30 deg North: x must be 0, y = R * sin(30 deg) / cos(23.5 deg) ~ 3473.60 km
  const northPoint = projectToEqualAreaKm(30, 0, 0, 23.5);
  assert.ok(Math.abs(northPoint.xKm) < 0.001, 'Prime Meridian x-coordinate must be 0');
  assert.ok(Math.abs(northPoint.yKm - 3473.60) < 0.2, `Expected ~3473.60km, got ${northPoint.yKm}`);
});

test('computeGridCellIndex generates consistent 1-km cell identifiers', () => {
  const cell1 = computeGridCellIndex(23.500, 90.500, 1.0);
  const cell2 = computeGridCellIndex(23.500, 90.500, 1.0);
  assert.equal(cell1.cellKey, cell2.cellKey);
  assert.equal(typeof cell1.gridX, 'number');
  assert.equal(typeof cell1.gridY, 'number');
});

test('haversineDistanceKm calculates accurate geographical distance', () => {
  // Distance from Dhaka (23.8103, 90.4125) to Chittagong (22.3569, 91.7832) is ~210 km
  const dist = haversineDistanceKm(23.8103, 90.4125, 22.3569, 91.7832);
  assert.ok(dist > 200 && dist < 225, `Expected ~210km, got ${dist}`);
});

test('isPointInBbox correctly checks geographical bounds', () => {
  const bbox = { west: 88.0, south: 20.5, east: 92.8, north: 26.7 };
  assert.equal(isPointInBbox(23.6, 90.3, bbox), true);
  assert.equal(isPointInBbox(15.0, 90.3, bbox), false); // south of bbox
  assert.equal(isPointInBbox(23.6, 95.0, bbox), false); // east of bbox
});
