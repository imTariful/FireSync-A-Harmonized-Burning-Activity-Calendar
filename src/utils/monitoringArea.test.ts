import test from 'node:test';
import assert from 'node:assert/strict';
import { monitoringBoxFromCorners, monitoringBoxFromTap, monitoringRectangle, parseMonitoringBox, validMonitoringBox } from './monitoringArea';

test('monitoring extent parser rejects blanks, zero area, reversed and nonfinite limits', () => {
  assert.deepEqual(parseMonitoringBox('88,20,93,27'), { west: 88, south: 20, east: 93, north: 27 });
  for (const value of ['', '1,,2,3', '0,0,0,1', '5,0,1,2', '0,0,Infinity,1', '-181,0,5,2', '1,80,2,86', '1,2,3,4,5']) assert.equal(parseMonitoringBox(value), null, value);
  assert.equal(validMonitoringBox({ west: NaN, east: 5, south: 0, north: 2 }), false);
});

test('tap selection uses the chosen kilometre width and compensates for latitude', () => {
  const equator = monitoringBoxFromTap(90, 0, 10)!;
  const north = monitoringBoxFromTap(90, 60, 10)!;
  assert.ok(Math.abs((equator.north - equator.south) * 111.195 - 10) < 1e-8);
  assert.ok(Math.abs((north.east - north.west) / (equator.east - equator.west) - 2) < 1e-8);
  assert.ok(equator.west < 90 && equator.east > 90);
  assert.ok(Math.abs((monitoringBoxFromTap(90, 0, 50)!.east - 90) / (equator.east - 90) - 5) < 1e-8);
});

test('tap selection never silently clips at poles or date line', () => {
  for (const args of [[180, 0, 10], [-180, 0, 10], [0, 85, 10], [0, -85, 10], [0, 0, -1], [NaN, 0, 10]]) assert.equal(monitoringBoxFromTap(...args as [number, number, number]), null);
});

test('drawing works in either direction and rejects zero-area/date-line spans', () => {
  const a = { lng: 88, lat: 20 }, b = { lng: 93, lat: 27 };
  assert.deepEqual(monitoringBoxFromCorners(a, b), { west: 88, south: 20, east: 93, north: 27 });
  assert.deepEqual(monitoringBoxFromCorners(b, a), monitoringBoxFromCorners(a, b));
  assert.equal(monitoringBoxFromCorners(a, a), null);
  assert.equal(monitoringBoxFromCorners({ lng: -179, lat: 20 }, { lng: 179, lat: 21 }), null);
});

test('visual rectangle preserves exact API extent, closed ring and monitor state', () => {
  const feature = monitoringRectangle({ west: 88, south: 20, east: 93, north: 27 }, { kind: 'paused' });
  assert.deepEqual(feature.geometry.coordinates[0], [[88, 20], [93, 20], [93, 27], [88, 27], [88, 20]]);
  assert.equal(feature.properties.kind, 'paused');
});
