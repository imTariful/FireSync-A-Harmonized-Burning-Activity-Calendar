import test from 'node:test';
import assert from 'node:assert/strict';
import {
  equalEarthForward,
  equalEarthInverse,
  cellCenterLatLon,
  cellCenterM,
  cellCornersLatLon,
  gridIndex,
  bboxToGridRange,
  GRID_RESOLUTION_M,
} from './equalEarth';

const roundTrip = (lon: number, lat: number) => {
  const { x, y } = equalEarthForward(lon, lat);
  return equalEarthInverse(x, y);
};

test('origin maps to origin', () => {
  const { x, y } = equalEarthForward(0, 0);
  assert.ok(Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6);
});

test('forward/inverse round-trips across the globe', () => {
  const points: Array<[number, number]> = [
    [0, 0],
    [10, 45],
    [-75, -15],
    [135, -25],
    [179, 80],
    [-179, -80],
    [0, 89],
    [42, -55],
    [100, 10],
  ];
  for (const [lon, lat] of points) {
    const back = roundTrip(lon, lat);
    assert.ok(Math.abs(back.lon - lon) < 1e-6, `lon ${lon}: got ${back.lon}`);
    assert.ok(Math.abs(back.lat - lat) < 1e-6, `lat ${lat}: got ${back.lat}`);
  }
});

test('forward easting is symmetric and bounded like EPSG:8857', () => {
  const east = equalEarthForward(180, 0).x;
  const west = equalEarthForward(-180, 0).x;
  assert.ok(east > 15e6 && east < 18e6, `easting at 180°: ${east}`);
  assert.ok(Math.abs(west + east) < 1, 'easting should be antisymmetric about lon 0');
});

test('cell center of index (0,0) sits just inside the first cell', () => {
  const { x, y } = cellCenterM(0, 0);
  assert.equal(x, GRID_RESOLUTION_M / 2);
  assert.equal(y, GRID_RESOLUTION_M / 2);
  const ll = equalEarthInverse(x, y);
  assert.ok(ll.lat > -0.1 && ll.lat < 0.1);
});

test('cellCenterLatLon round-trips through grid indices', () => {
  // Real data ranges: rows -840..827, cols -1680..1688 (verified on year=2019).
  const ll = cellCenterLatLon(400, -300);
  const fwd = equalEarthForward(ll.lon, ll.lat);
  assert.equal(gridIndex(fwd.y), 400);
  assert.equal(gridIndex(fwd.x), -300);
});

test('gridIndex uses floor semantics for negative coordinates', () => {
  assert.equal(gridIndex(-1), -1);
  assert.equal(gridIndex(-GRID_RESOLUTION_M), -1);
  assert.equal(gridIndex(-GRID_RESOLUTION_M - 1), -2);
  assert.equal(gridIndex(0), 0);
});

test('bboxToGridRange contains the projected bbox corners', () => {
  // Amazon-like box.
  const range = bboxToGridRange(-75, -15, -50, 5);
  const corners: Array<[number, number]> = [
    [-75, -15],
    [-50, 5],
    [-75, 5],
    [-50, -15],
  ];
  for (const [lon, lat] of corners) {
    const { x, y } = equalEarthForward(lon, lat);
    const r = gridIndex(y);
    const c = gridIndex(x);
    assert.ok(r >= range.rowMin && r <= range.rowMax, `row ${r} outside ${JSON.stringify(range)}`);
    assert.ok(c >= range.colMin && c <= range.colMax, `col ${c} outside ${JSON.stringify(range)}`);
  }
});

test('bboxToGridRange row bounds are monotone in latitude', () => {
  const north = bboxToGridRange(0, 40, 10, 50);
  const south = bboxToGridRange(0, -50, 10, -40);
  assert.ok(north.rowMin > south.rowMax, 'northern box should have higher row indices');
});

test('cellCornersLatLon returns 4 corners bracketing the cell centre', () => {
  const row = 500;
  const col = -300;
  const corners = cellCornersLatLon(row, col);
  assert.equal(corners.length, 4);
  const centre = cellCenterLatLon(row, col);
  const lons = corners.map((c) => c.lon);
  const lats = corners.map((c) => c.lat);
  assert.ok(Math.min(...lons) <= centre.lon && centre.lon <= Math.max(...lons));
  assert.ok(Math.min(...lats) <= centre.lat && centre.lat <= Math.max(...lats));
  // Adjacent cell shares an edge: east corners of col equal west corners of col+1.
  const next = cellCornersLatLon(row, col + 1);
  const eastEdge = [corners[1], corners[2]].map((c) => [c.lon, c.lat]);
  const westEdge = [next[0], next[3]].map((c) => [c.lon, c.lat]);
  for (let i = 0; i < 2; i++) {
    assert.ok(Math.abs(eastEdge[i][0] - westEdge[i][0]) < 1e-6, 'shared edge longitude');
    assert.ok(Math.abs(eastEdge[i][1] - westEdge[i][1]) < 1e-6, 'shared edge latitude');
  }
});
