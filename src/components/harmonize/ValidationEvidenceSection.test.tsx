import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ValidationEvidenceSection } from './ValidationEvidenceSection';
import { HarmonizationPanel } from './HarmonizationPanel';
import { VALIDATION_EVIDENCE } from '../../data/validationEvidence';

// Run with: npx tsx --test src/components/harmonize/ValidationEvidenceSection.test.tsx

test('shows the sentence, sample sizes, metrics, status and sources', () => {
  const html = renderToString(<ValidationEvidenceSection />);
  assert.match(html, /Validation evidence \(INSUFFICIENT\)/);
  assert.ok(html.includes(VALIDATION_EVIDENCE.sentence.replace(/&/g, '&amp;')) || html.includes('Evaluated on 3 paired cells of the demo archive'));
  assert.match(html, /the scale factor is not validated/);
  for (const k of ['MAE', 'RMSE', 'Bias', 'Cells evaluated', 'Status in file']) assert.match(html, new RegExp(k));
  assert.match(html, /0\.362/);
  assert.match(html, /0\.4344/);
  assert.match(html, /Training split/);
  assert.match(html, /Validation split/);
  assert.match(html, /INSUFFICIENT/);
  assert.match(html, /did not re-run or modify the scripts/);
  assert.match(html, /calibration_validation\.json/);
  assert.match(html, /calibration_reassessment\.json/);
  assert.match(html, /paired_observations_analysis\.json/);
});

test('the stale overpass limitation is shown with the note, not as current fact', () => {
  const html = renderToString(<ValidationEvidenceSection />);
  assert.match(html, /data-stale="true"/);
  assert.match(html, /Terra 10:30 vs Aqua\/SNPP 13:30/);
  assert.match(html, /Do not read it as current fact/);
  assert.match(html, /Observed overpass time/);
});

test('says plainly that nothing was fitted and that it is not a test of the index', () => {
  const html = renderToString(<ValidationEvidenceSection />);
  assert.match(html, /fits nothing/);
  assert.match(html, /not a test of the harmonized activity index/);
});

test('the panel mounts it (when there is something to compare)', () => {
  const mk = (sensor: 'MODIS' | 'VIIRS', k: number) => {
    const id = `${sensor}-${k}`;
    return {
      id, source_record_id: id, latitude: 10 + k * 0.1, longitude: 20, acq_date: '2026-01-15', acq_time: '1000', datetime_utc: '2026-01-15T10:00:00Z',
      sensor, satellite: sensor === 'MODIS' ? 'Aqua' : 'NOAA-20', product: 't', processing_version: 'x', confidence: 50, confidence_category: 'nominal',
      frp_mw: 10, scan: 1, track: 1, daynight: 'D', source_file: 't', retrieved_at: '2026-01-20T00:00:00Z', quality_flags: '', record_hash: id,
    } as const;
  };
  const now = Date.parse('2026-01-20T08:00:00Z');
  const html = renderToString(<HarmonizationPanel modis={[mk('MODIS', 1)]} viirs={[mk('VIIRS', 1)]} now={now} />);
  assert.match(html, /Validation evidence \(INSUFFICIENT\)/);
  assert.match(html, /Harmonized activity \(EXPLORATORY\)/);
  const empty = renderToString(<HarmonizationPanel modis={[]} viirs={[]} now={now} />);
  assert.doesNotMatch(empty, /Validation evidence/);
});
