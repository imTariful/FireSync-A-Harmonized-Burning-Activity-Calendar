import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InteractiveActivityChart } from './InteractiveActivityChart';
import { DAILY_VISUAL_METRICS, TimeseriesChart } from './TimeseriesChart';
import { CalibrationDiagnosticChart } from './CalibrationDiagnosticChart';
import { ObservationFlowDiagram } from './ObservationFlowDiagram';
import { MonthlyActivityExplorer } from '../calendar/MonthlyActivityExplorer';
import { SensorVisualDashboard } from '../comparison/SensorVisualDashboard';
import type { CalibrationModelMetrics } from '../../types/fire';

const metrics: CalibrationModelMetrics = { model_id: 'test', model_version: 'test', algorithm: 'test fixture', target_grid_km: 1, sample_size_paired_cells: 1, training_period: 'unavailable', validation_period: 'unavailable', mae: null, rmse: null, mean_bias: null, r_squared: null, calibration_slope: 0.25, calibration_intercept: 0, status: 'EXPLORATORY', limitations: ['Not a fire count.'] };

test('daily visual controls and unavailable values are accessible without requiring a pointer', () => {
  const html = renderToStaticMarkup(<InteractiveActivityChart title="Test chart" description="fixture" points={[{ key: '2025-01-01', label: '2025-01-01', values: { modis: 0, viirs: null } }]} metrics={DAILY_VISUAL_METRICS} />);
  for (const label of ['Test chart measure', 'Test chart inspect period', 'Bars', 'Lines', 'View data', 'Unavailable', 'MODIS', 'VIIRS']) assert.ok(html.includes(label), label);
  assert.match(html, /0 detections/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('empty daily chart retains honest state and controls', () => {
  const html = renderToStaticMarkup(<TimeseriesChart dailySummaries={[]} />);
  assert.match(html, /No available values/);
  assert.match(html, /EXPLORATORY harmonized activity/);
});

test('non-date labels remain intact on a sensor window chart axis', () => {
  const html = renderToStaticMarkup(<InteractiveActivityChart title="Window" description="fixture" points={[{ key: 'window', label: 'Selected window', values: { modis: 2, viirs: 5 } }]} metrics={DAILY_VISUAL_METRICS} />);
  assert.match(html, /text-anchor="middle">Selected window<\/text>/);
});

test('monthly explorer labels resolution and estimated product explicitly', () => {
  const html = renderToStaticMarkup(<MonthlyActivityExplorer rows={[]} startYear={2024} endYear={2025} layer="harmonized" onInspect={() => {}} />);
  assert.match(html, /Monthly chart year/);
  assert.match(html, /Monthly values stay monthly/);
  assert.match(html, /EXPLORATORY/);
  assert.doesNotMatch(html, /daily predictions/);
});

test('scatter uses raw sensor counts, not an invented fitted line or slope-transformed observations', () => {
  const html = renderToStaticMarkup(<CalibrationDiagnosticChart metrics={metrics} pairedPoints={[{ modis: 10, viirs: 20, date: '2025-01-01', cell_id: 'cell1' }]} />);
  assert.match(html, /VIIRS raw detections/);
  assert.match(html, /Inspect paired cell/);
  assert.match(html, /cx="275" cy="160"/);
  assert.match(html, /not a fitted regression/);
  assert.match(html, /Unavailable/);
  assert.match(html, /Cell cell1/);
});

test('sensor schematic has exact shared-scale footprint proportions and clear science context', () => {
  const html = renderToStaticMarkup(<SensorVisualDashboard data={null} loading={false} error={null} />);
  assert.match(html, /width="160" height="160"/);
  assert.match(html, /width="60" height="60"/);
  assert.match(html, /Footprint focus/);
  assert.match(html, /Schematic only/);
  assert.match(html, /Satellite thermal anomalies, not confirmed wildfires or burned area\./);
});

test('flow diagram has three selectable stages rather than unsupported measured flow counts', () => {
  const html = renderToStaticMarkup(<ObservationFlowDiagram />);
  assert.equal((html.match(/aria-pressed=/g) ?? []).length, 3);
  assert.match(html, /Satellite observations/);
  assert.match(html, /Shared spatial support/);
  assert.match(html, /Calendar &amp; monitoring/);
});
