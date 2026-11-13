import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ShareMenu } from './ShareMenu';
import { ExplorerToolbar } from './ExplorerToolbar';
import { VISIBLE_DETECTIONS_DEFINITION } from '../../utils/shareHelpers';
import { EXPORT_DISCLAIMER } from '../../utils/export';
import type { CanonicalObservation } from '../../types/fire';

// Run with: npx tsx --test src/components/explorer/ShareMenu.test.tsx
// Server-side markup only: clicks, clipboard, focus and Esc need a browser.

const obs = (sensor: 'MODIS' | 'VIIRS', i: number) =>
  ({
    id: `${sensor}-${i}`,
    sensor,
    latitude: 1,
    longitude: 2,
    datetime_utc: '2026-08-01T00:00:00Z',
    satellite: sensor === 'MODIS' ? 'Terra' : 'NOAA-20',
    frp_mw: 3,
    confidence: 50,
  }) as unknown as CanonicalObservation;

const noop = () => undefined;
const props = {
  getView: () => null,
  timeline: null,
  timelineCutoffMs: null,
  capture: () => Promise.reject(new Error('n/a')),
  anchorRef: { current: null },
  onClose: noop,
};

test('menu lists the four actions and counts MODIS and VIIRS separately', () => {
  const html = renderToString(<ShareMenu {...props} detections={[obs('MODIS', 1), obs('MODIS', 2), obs('VIIRS', 1)]} />);
  for (const label of ['Copy link', 'Capture PNG', 'Download CSV', 'Download GeoJSON']) assert.match(html, new RegExp(label));
  assert.match(html, /MODIS<\/span>\s*<span class="numeric">2</);
  assert.match(html, /VIIRS<\/span>\s*<span class="numeric">1</);
  assert.doesNotMatch(html, /numeric">3</); // no combined total
});

test('menu states the visible-detections definition and the legend sentence', () => {
  const html = renderToString(<ShareMenu {...props} detections={[]} />);
  assert.ok(html.includes(VISIBLE_DETECTIONS_DEFINITION));
  assert.ok(html.includes(EXPORT_DISCLAIMER));
});

test('confirmations go to a polite live region, not an alert', () => {
  const html = renderToString(<ShareMenu {...props} detections={[]} />);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /role="alert"/);
});

test('with nothing visible, CSV and GeoJSON are inactive and say why', () => {
  const html = renderToString(<ShareMenu {...props} detections={[]} />);
  assert.equal((html.match(/Nothing visible to export/g) ?? []).length, 2);
  assert.equal((html.match(/aria-disabled="true"/g) ?? []).length, 2);
});

test('toolbar Share is enabled, reports its open state, and explains itself when unavailable', () => {
  const open = renderToString(<ExplorerToolbar onAction={noop} shareOpen />);
  assert.equal((open.match(/aria-expanded="true"/g) ?? []).length, 1);
  const off = renderToString(<ExplorerToolbar onAction={noop} shareUnavailableReason="Share works in 3D Globe mode" />);
  assert.match(off, /Share works in 3D Globe mode/);
  assert.match(off, /role="tooltip"/);
  const on = renderToString(<ExplorerToolbar onAction={noop} />);
  assert.doesNotMatch(on, /Share: coming soon/);
});
