import { SENSOR_COLOR } from '../../utils/sensorStyle';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import type { CanonicalObservation, SensorType } from '../../types/fire';
import { buildTimelineAxis, indexTimeline } from '../../utils/timeline';
import { TIMELINE_NOTE, TimelineBar, formatStepRange } from './TimelineBar';

// Run with: npx tsx --test src/components/explorer/TimelineBar.test.tsx
// Included in the `npm test` script.

function obs(id: string, sensor: SensorType, datetime_utc: string): CanonicalObservation {
  return {
    id,
    source_record_id: id,
    latitude: 0,
    longitude: 0,
    acq_date: datetime_utc.slice(0, 10),
    acq_time: '0000',
    datetime_utc,
    sensor,
    satellite: sensor === 'MODIS' ? 'Aqua' : 'NOAA-20',
    product: 't',
    processing_version: 'x',
    confidence: 50,
    confidence_category: 'nominal',
    frp_mw: 1,
    scan: 1,
    track: 1,
    daynight: 'D',
    source_file: 't',
    retrieved_at: '2026-11-06T12:00:00Z',
    quality_flags: '',
    record_hash: id,
  };
}

// 01:00 MODIS, 02:00 gap, 03:00 VIIRS (partial: now is 03:30)
const data = [obs('m', 'MODIS', '2026-11-04T01:10:00Z'), obs('v', 'VIIRS', '2026-11-04T03:10:00Z')];
const axis = buildTimelineAxis(data, Date.parse('2026-11-04T03:30:00Z'));
const index = indexTimeline(data, axis);

const render = (step: number) =>
  renderToString(
    <TimelineBar
      axis={axis}
      index={index}
      step={step}
      playing={false}
      speedMs={1200}
      onToggle={() => undefined}
      onStepBy={() => undefined}
      onSeek={() => undefined}
      onSpeed={() => undefined}
      onClose={() => undefined}
    />,
  );

test('shows the UTC acquisition timestamp and the science sentence', () => {
  const html = render(2);
  assert.match(html, /2026-11-04 03:00–04:00 UTC/);
  assert.ok(html.includes(TIMELINE_NOTE));
  assert.match(TIMELINE_NOTE, /when satellites observed, not how fires spread/);
});

test('slider exposes the timestamp as aria-valuetext; controls keep 44px targets', () => {
  const html = render(0);
  assert.match(html, /aria-valuetext="2026-11-04 01:00–02:00 UTC acquisition time"/);
  assert.match(html, /type="range"/);
  assert.match(html, /min-h-touch/);
  assert.doesNotMatch(html, /aria-live/);
});

test('MODIS and VIIRS have separate tracks with separate counts (this step · so far)', () => {
  const html = render(2);
  assert.match(html, /data-testid="timeline-track-MODIS"/);
  assert.match(html, /data-testid="timeline-track-VIIRS"/);
  assert.ok(html.toLowerCase().includes(SENSOR_COLOR.MODIS));
  assert.ok(html.toLowerCase().includes(SENSOR_COLOR.VIIRS));
  assert.doesNotMatch(html, /f97316|06b6d4/i); // the old orange / cyan are gone
  assert.match(html, />0<!-- --> · <!-- -->1</); // MODIS at step 2: 0 this step, 1 so far
});

test('gap step is dashed and says "no data loaded"; partial step is hatched', () => {
  const html = render(1);
  assert.match(html, /border-dashed/);
  assert.match(html, /no data loaded/);
  assert.match(html, /repeating-linear-gradient/); // the partial 03:00 step
  assert.match(html, /not “no fire activity”/);
});

test('formatStepRange shows the end date when a step crosses UTC midnight', () => {
  const s = Date.parse('2026-11-04T18:00:00Z');
  assert.equal(formatStepRange({ startMs: s, endMs: s + 6 * 3_600_000 }), '2026-11-04 18:00–2026-11-05 00:00 UTC');
});

test('empty axis renders a plain message and disabled controls', () => {
  const e = buildTimelineAxis([], 0);
  const html = renderToString(
    <TimelineBar
      axis={e}
      index={indexTimeline([], e)}
      step={0}
      playing={false}
      speedMs={1200}
      onToggle={() => undefined}
      onStepBy={() => undefined}
      onSeek={() => undefined}
      onSpeed={() => undefined}
      onClose={() => undefined}
    />,
  );
  assert.match(html, /No detections are loaded yet/);
  assert.match(html, /disabled/);
});
