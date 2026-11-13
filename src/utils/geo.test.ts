import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bboxToArea,
  bboxesKey,
  clampBbox,
  dedupeById,
  bboxFromSamples,
  minZoomForLngSpan,
  unwrapLngNear,
  shouldLoadViewport,
  snapBboxOutward,
  splitBboxAtAntimeridian,
  viewportToBboxes,
  wrapLng,
} from './geo';

test('wrapLng maps any longitude into [-180, 180)', () => {
  assert.equal(wrapLng(0), 0);
  assert.equal(wrapLng(190), -170);
  assert.equal(wrapLng(-190), 170);
  assert.equal(wrapLng(540), -180);
  assert.equal(wrapLng(-180), -180);
});

test('clampBbox clamps lat/lng to valid ranges', () => {
  assert.deepEqual(clampBbox({ west: -200, south: -95, east: 200, north: 95 }), {
    west: -180,
    south: -90,
    east: 180,
    north: 90,
  });
});

test('normal viewport -> single box', () => {
  const boxes = splitBboxAtAntimeridian(88, 20, 92, 27);
  assert.deepEqual(boxes, [{ west: 88, south: 20, east: 92, north: 27 }]);
});

test('viewport crossing +180 (un-wrapped east > 180) is split in two', () => {
  const boxes = splitBboxAtAntimeridian(170, -10, 190, 10);
  assert.deepEqual(boxes, [
    { west: 170, south: -10, east: 180, north: 10 },
    { west: -180, south: -10, east: -170, north: 10 },
  ]);
});

test('viewport crossing -180 (un-wrapped west < -180) is split in two', () => {
  const boxes = splitBboxAtAntimeridian(-190, 0, -170, 20);
  assert.deepEqual(boxes, [
    { west: 170, south: 0, east: 180, north: 20 },
    { west: -180, south: 0, east: -170, north: 20 },
  ]);
});

test('already-wrapped input (west > east) is read as crossing the antimeridian', () => {
  const boxes = splitBboxAtAntimeridian(175, 0, -175, 5);
  assert.equal(boxes.length, 2);
  assert.deepEqual(boxes[0], { west: 175, south: 0, east: 180, north: 5 });
  assert.deepEqual(boxes[1], { west: -180, south: 0, east: -175, north: 5 });
});

test('viewport touching exactly 180 does not produce an empty second box', () => {
  assert.deepEqual(splitBboxAtAntimeridian(170, 0, 180, 5), [{ west: 170, south: 0, east: 180, north: 5 }]);
});

test('viewport 360 deg or wider -> whole world in one box, lat clamped', () => {
  assert.deepEqual(splitBboxAtAntimeridian(-250, -100, 250, 100), [
    { west: -180, south: -90, east: 180, north: 90 },
  ]);
});

test('swapped latitudes are reordered; non-finite input yields no boxes', () => {
  assert.deepEqual(splitBboxAtAntimeridian(0, 10, 5, -10), [{ west: 0, south: -10, east: 5, north: 10 }]);
  assert.deepEqual(splitBboxAtAntimeridian(NaN, 0, 5, 5), []);
});

test('snapBboxOutward expands to whole degrees and never collapses', () => {
  assert.deepEqual(snapBboxOutward({ west: 88.2, south: 20.7, east: 91.1, north: 23.01 }), {
    west: 88,
    south: 20,
    east: 92,
    north: 24,
  });
  const tiny = snapBboxOutward({ west: 10, south: 5, east: 10, north: 5 });
  assert.ok(tiny.east > tiny.west && tiny.north > tiny.south);
  const atEdge = snapBboxOutward({ west: 180, south: 90, east: 180, north: 90 });
  assert.ok(atEdge.east > atEdge.west && atEdge.north > atEdge.south);
  assert.ok(atEdge.east <= 180 && atEdge.north <= 90);
});

test('viewportToBboxes: split + snap, every box is valid FIRMS input', () => {
  const boxes = viewportToBboxes({ west: 172.3, south: -8.4, east: 187.9, north: 3.2 });
  assert.equal(boxes.length, 2);
  for (const b of boxes) {
    assert.ok(b.west >= -180 && b.east <= 180 && b.south >= -90 && b.north <= 90);
    assert.ok(b.west < b.east && b.south < b.north);
  }
  assert.equal(bboxToArea(boxes[0]), '172,-9,180,4');
  assert.equal(bboxToArea(boxes[1]), '-180,-9,-172,4');
});

test('bboxToArea avoids exponent notation and trailing zeros', () => {
  assert.equal(bboxToArea({ west: -0.00000001, south: 1.50004, east: 2, north: 3 }), '0,1.5,2,3');
  assert.equal(bboxesKey([{ west: 1, south: 2, east: 3, north: 4 }]), '1,2,3,4');
});

test('shouldLoadViewport needs zoom >= 3 and a small enough area', () => {
  const small = [{ west: 88, south: 20, east: 93, north: 27 }];
  assert.equal(shouldLoadViewport(2.9, small), false);
  assert.equal(shouldLoadViewport(3, small), true);
  assert.equal(shouldLoadViewport(5, [{ west: -180, south: -90, east: 180, north: 90 }]), false);
  assert.equal(shouldLoadViewport(4, []), false);
  // two halves of an antimeridian view count together
  const halves = [
    { west: 100, south: 0, east: 180, north: 10 },
    { west: -180, south: 0, east: -100, north: 10 },
  ];
  assert.equal(shouldLoadViewport(4, halves), false);
});

test('minZoomForLngSpan: wider screens need more zoom, never below the minimum', () => {
  assert.equal(minZoomForLngSpan(380), 3);
  const desktop = minZoomForLngSpan(1440);
  assert.ok(desktop > 3.5 && desktop < 4.2, `got ${desktop}`);
  assert.equal(minZoomForLngSpan(0), 3);
});

test('dedupeById keeps first occurrence across lists', () => {
  const merged = dedupeById([[{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]]);
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c']);
});

test('minZoomForLngSpan is latitude-aware (higher latitude needs more zoom)', () => {
  assert.ok(minZoomForLngSpan(1440, 70, 60) > minZoomForLngSpan(1440, 70, 0));
  assert.equal(minZoomForLngSpan(380, 70, 89), minZoomForLngSpan(380, 70, 89)); // finite near the pole
  assert.ok(Number.isFinite(minZoomForLngSpan(1440, 70, 90)));
});

test('unwrapLngNear / bboxFromSamples handle samples on both sides of the antimeridian', () => {
  assert.equal(unwrapLngNear(-178, 179), 182);
  assert.equal(unwrapLngNear(170, -179), -190);
  const box = bboxFromSamples(
    [
      { lng: 176, lat: -20 },
      { lng: 179.5, lat: -16 },
      { lng: -178, lat: -12 },
    ],
    179
  );
  assert.deepEqual(box, { west: 176, east: 182, south: -20, north: -12 });
  const boxes = viewportToBboxes(box!);
  assert.equal(boxes.length, 2);
  assert.equal(bboxFromSamples([], 0), null);
  assert.equal(bboxFromSamples([{ lng: NaN, lat: 0 }], 0), null);
});
