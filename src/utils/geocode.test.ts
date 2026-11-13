import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchUrl, parseNominatim } from './geocode';

test('parseNominatim reads coordinates and [south, north, west, east] bounding boxes', () => {
  const [p] = parseNominatim([
    { display_name: 'Dhaka, Bangladesh', lat: '23.76', lon: '90.38', boundingbox: ['23.6', '23.9', '90.3', '90.5'], addresstype: 'city' },
  ]);
  assert.equal(p.name, 'Dhaka, Bangladesh');
  assert.deepEqual(p.bbox, { south: 23.6, north: 23.9, west: 90.3, east: 90.5 });
  assert.equal(p.kind, 'city');
});

test('parseNominatim keeps antimeridian boxes (west > east) and drops unusable rows', () => {
  const out = parseNominatim([
    { display_name: 'Fiji', lat: '-17.7', lon: '178', boundingbox: ['-21.1', '-12.4', '176.8', '-178.2'] },
    { display_name: 'Bad', lat: 'x', lon: '1' },
    { lat: '1', lon: '1' },
    { display_name: 'Off-planet', lat: '95', lon: '0' },
  ]);
  assert.equal(out.length, 1);
  assert.ok(out[0].bbox && out[0].bbox.west > out[0].bbox.east);
  assert.deepEqual(parseNominatim('nope'), []);
});

test('buildSearchUrl encodes the query and asks for JSON', () => {
  const u = new URL(buildSearchUrl('  São Paulo & co  '));
  assert.equal(u.searchParams.get('q'), 'São Paulo & co');
  assert.equal(u.searchParams.get('format'), 'jsonv2');
  assert.equal(u.searchParams.get('limit'), '5');
});
