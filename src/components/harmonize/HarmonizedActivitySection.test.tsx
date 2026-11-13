import { SENSOR_COLOR } from '../../utils/sensorStyle';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { CanonicalObservation } from '../../types/fire';
import { HarmonizedActivitySection } from './HarmonizedActivitySection';
import { HarmonizationPanel } from './HarmonizationPanel';

// Run with: npx tsx --test src/components/harmonize/HarmonizedActivitySection.test.tsx
// Included in the `npm test` script.

let seq = 0;
function obs(sensor: 'MODIS' | 'VIIRS', date: string, lat: number): CanonicalObservation {
  const id = `${sensor}-${seq++}`;
  return {
    id, source_record_id: id, latitude: lat, longitude: 20, acq_date: date, acq_time: '1000', datetime_utc: `${date}T10:00:00Z`,
    sensor, satellite: sensor === 'MODIS' ? 'Aqua' : 'NOAA-20', product: 't', processing_version: 'x', confidence: 50,
    confidence_category: 'nominal', frp_mw: 10, scan: 1, track: 1, daynight: 'D', source_file: 't', retrieved_at: '2026-01-20T00:00:00Z',
    quality_flags: '', record_hash: id,
  };
}
const modis = [obs('MODIS', '2026-01-15', 10.1), obs('MODIS', '2026-01-15', 10.2), obs('MODIS', '2026-01-16', 10.1), obs('MODIS', '2026-01-20', 10.1)];
const viirs = [obs('VIIRS', '2026-01-15', 10.1), obs('VIIRS', '2026-01-15', 10.3), obs('VIIRS', '2026-01-16', 10.4), obs('VIIRS', '2026-01-20', 10.1)];
const NOW = Date.parse('2026-01-20T08:00:00Z');

const render = (extra: Partial<React.ComponentProps<typeof HarmonizedActivitySection>> = {}) =>
  renderToString(<HarmonizedActivitySection modis={modis} viirs={viirs} now={NOW} includePartial={false} {...extra} />);

test('renders the EXPLORATORY heading, separate counts, three terms, hint, sensitivity and the "What this is not" box', () => {
  const html = render();
  assert.match(html, /Harmonized activity \(EXPLORATORY\)/);
  assert.match(html, /What this is not/);
  assert.match(html, /Not a calibration/);
  assert.match(html, /Not validated/);
  assert.match(html, /Not a prediction/);
  assert.match(html, /MODIS term/);
  assert.match(html, /scaled VIIRS term/);
  assert.match(html, /FRP term/);
  assert.match(html, /Scale constant vs this view/);
  assert.match(html, /Sensitivity to the VIIRS scale/);
  assert.match(html, /data-date="2026-01-15"/);
  assert.match(html, /data-date="2026-01-16"/);
  assert.doesNotMatch(html, /data-date="2026-01-20"/); // partial day not listed as a row
});

test('partial day is named as excluded, and listed (with a strong warning) when the panel toggle is on', () => {
  assert.match(render(), /Partial UTC day\(s\) excluded from the index/);
  const on = render({ includePartial: true });
  assert.match(on, /data-date="2026-01-20"/);
  assert.match(on, /Partial day included: do not quote these numbers/);
});

test('slider range, default marker, reset button and fixed-parameter note', () => {
  const html = render();
  assert.match(html, /type="range"/);
  assert.match(html, /min="0.1"/);
  assert.match(html, /max="1"/);
  assert.match(html, /data-marker="default"/);
  assert.match(html, /default 0.294/);
  assert.match(html, /Reset to default/);
  assert.match(html, /<button type="button" disabled/); // reset is disabled at the default
  assert.match(html, /h-touch/);
  assert.match(html, /min-h-touch/);
  assert.match(html, /day bucketing is the UTC date/);
  // at a non-default slider value the reset button is enabled (no disabled attribute on it)
  const moved = render({ initialViirsScale: 0.5 });
  assert.match(moved, /<button type="button" class="[^"]*"[^>]*>(?:<svg[\s\S]*?<\/svg>)?Reset to default/);
  assert.doesNotMatch(moved, /<button type="button" disabled/);
});

test('sensor colours appear only on the raw counts, never on the index bars', () => {
  const html = render();
  const bars = [...html.matchAll(/data-bar="[^"]+"[^>]*>(.*?)<\/div>/g)].map((m) => m[1]);
  assert.ok(bars.length >= 2);
  for (const b of bars) {
    assert.ok(!b.toLowerCase().includes(SENSOR_COLOR.MODIS) && !b.toLowerCase().includes(SENSOR_COLOR.VIIRS));
  }
  assert.ok(html.toLowerCase().includes(SENSOR_COLOR.MODIS));
  assert.ok(html.toLowerCase().includes(SENSOR_COLOR.VIIRS));
  assert.doesNotMatch(html, /f97316|06b6d4/i);
});

test('no MODIS + VIIRS sum of raw counts is printed', () => {
  const html = render();
  assert.doesNotMatch(html, /total detections|combined detections|MODIS \+ VIIRS (count|detections)/i);
});

test('the panel mounts the section with its own include-partial toggle', () => {
  const html = renderToString(<HarmonizationPanel modis={modis} viirs={viirs} now={NOW} />);
  assert.match(html, /Harmonized activity \(EXPLORATORY\)/);
  assert.match(html, /Include partial day\(s\) anyway/);
  assert.equal((html.match(/Include partial day/g) ?? []).length >= 1, true);
  assert.match(html, /Satellite thermal anomalies, not confirmed wildfires or burned area\./);
});
