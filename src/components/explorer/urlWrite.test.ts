import test from 'node:test';
import assert from 'node:assert/strict';
import { URL_WRITE_DEBOUNCE_MS, nextUrl } from './urlWrite';
import { parseShareParams, type ShareState } from '../../utils/shareHelpers';

const state: ShareState = { lat: 23.8, lng: 90.4, zoom: 6, days: 2, layers: ['viirs'], timeline: 0.75 };

test('debounce is at least 400 ms', () => {
  assert.ok(URL_WRITE_DEBOUNCE_MS >= 400);
});

test('nextUrl writes the view, keeps path, hash and unknown params', () => {
  const u = nextUrl({ pathname: '/app', search: '?utm=1&lat=1', hash: '#x' }, state);
  assert.ok(u.startsWith('/app?'));
  assert.ok(u.endsWith('#x'));
  const q = new URLSearchParams(u.slice(u.indexOf('?') + 1, u.indexOf('#')));
  assert.equal(q.get('utm'), '1');
  assert.equal(q.get('lat'), '23.8');
  assert.equal(q.getAll('lat').length, 1);
});

test('nextUrl output is read back as the same view (shared link opens the same view)', () => {
  const u = nextUrl({ pathname: '/', search: '', hash: '' }, state);
  const p = parseShareParams(u.slice(u.indexOf('?')));
  assert.deepEqual(p.state, state);
});

test('nextUrl(null) removes only the view params; empty query leaves a bare path', () => {
  assert.equal(nextUrl({ pathname: '/', search: '?lat=1&lng=2&z=3&utm=a', hash: '' }, null), '/?utm=a');
  assert.equal(nextUrl({ pathname: '/', search: '?lat=1&lng=2', hash: '#h' }, null), '/#h');
});

test('nextUrl never produces a protocol-relative URL', () => {
  assert.ok(nextUrl({ pathname: '//evil.test/x', search: '', hash: '' }, state).startsWith('/evil.test/x?'));
  assert.ok(nextUrl({ pathname: '', search: '', hash: '' }, state).startsWith('/?'));
});

test('hostile search strings do not throw', () => {
  assert.doesNotThrow(() => nextUrl({ pathname: '/', search: '?%E0%A4%A&lat=%', hash: '' }, state));
});

test('World map view survives the address bar round trip; the globe leaves no view param', () => {
  const map = nextUrl({ pathname: '/', search: '', hash: '' }, { ...state, view: 'map' });
  assert.equal(new URLSearchParams(map.slice(map.indexOf('?'))).get('view'), 'map');
  assert.equal(parseShareParams(map.slice(map.indexOf('?'))).state.view, 'map');
  const globe = nextUrl({ pathname: '/', search: '?view=map', hash: '' }, state);
  assert.equal(globe.includes('view='), false);
  assert.equal(nextUrl({ pathname: '/', search: '?view=map&utm=a', hash: '' }, null), '/?utm=a');
});
