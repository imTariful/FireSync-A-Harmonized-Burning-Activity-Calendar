/**
 * Tests for the deterministic intelligence layer: clustering, period comparison and auditing.
 * Pure functions only; no network, no model.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalObservation } from '../types/fire';
import { auditDataset, clusterObservations, comparePeriods } from './fireIntelligence';

function obs(partial: Partial<CanonicalObservation> & Pick<CanonicalObservation, 'id' | 'sensor'>): CanonicalObservation {
  const { id, sensor, ...rest } = partial;
  return {
    id,
    sensor,
    source_record_id: id,
    latitude: 22.1,
    longitude: 90.1,
    acq_date: '2026-11-09',
    acq_time: '0610',
    datetime_utc: '2026-11-09T06:10:00Z',
    satellite: sensor === 'MODIS' ? 'Terra' : 'NOAA-20',
    product: sensor === 'MODIS' ? 'MODIS_NRT' : 'VIIRS_NOAA20_NRT',
    processing_version: '6.1NRT',
    confidence: sensor === 'MODIS' ? 80 : 'nominal',
    confidence_category: 'nominal',
    frp_mw: 10,
    scan: 1,
    track: 1,
    daynight: 'D',
    source_file: 'fixture.csv',
    retrieved_at: '2026-11-10T00:00:00Z',
    quality_flags: 'fixture',
    record_hash: `hash-${id}`,
    provenance_status: 'VERIFIED',
    ...rest,
  };
}

const near = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test('clustering links nearby detections in time and splits distant ones', () => {
  const result = clusterObservations([
    obs({ id: 'a', sensor: 'MODIS', latitude: 22.1, longitude: 90.1 }),
    obs({ id: 'b', sensor: 'VIIRS', latitude: 22.11, longitude: 90.11, datetime_utc: '2026-11-09T08:10:00Z' }),
    obs({ id: 'c', sensor: 'MODIS', latitude: 23.5, longitude: 91.5 }),
  ]);

  assert.equal(result.clusters.length, 2);
  const largest = result.clusters[0];
  assert.equal(largest.detection_count, 2);
  assert.deepEqual(largest.by_sensor, { MODIS: 1, VIIRS: 1 });
  assert.equal(largest.label, 'candidate_hotspot_group');
  assert.ok(largest.notes.some((n) => /not a confirmed wildfire/i.test(n)));
});

test('clustering does not link detections separated by more than the time window', () => {
  const result = clusterObservations(
    [
      obs({ id: 'a', sensor: 'MODIS', datetime_utc: '2026-11-09T00:00:00Z' }),
      obs({ id: 'b', sensor: 'MODIS', datetime_utc: '2026-11-11T00:00:00Z', acq_date: '2026-11-11' }),
    ],
    { linkHours: 24 }
  );
  assert.equal(result.clusters.length, 2);
});

test('clustering keeps sensor FRP sums separate and reports persistence', () => {
  const result = clusterObservations([
    obs({ id: 'a', sensor: 'MODIS', frp_mw: 10 }),
    obs({ id: 'b', sensor: 'MODIS', frp_mw: 30, datetime_utc: '2026-11-10T06:10:00Z', acq_date: '2026-11-10' }),
    obs({ id: 'c', sensor: 'VIIRS', frp_mw: 4 }),
  ]);
  const cluster = result.clusters[0];
  near(cluster.frp_mw.MODIS, 40);
  near(cluster.frp_mw.VIIRS, 4);
  near(cluster.frp_mw.max, 30);
  assert.equal(cluster.active_days, 2);
  near(cluster.duration_hours, 24);
  assert.deepEqual(cluster.satellites.sort(), ['NOAA-20', 'Terra']);
});

test('clustering caps the analysed input and says so', () => {
  const many = Array.from({ length: 30 }, (_, i) => obs({ id: `o${i}`, sensor: 'MODIS' }));
  const result = clusterObservations(many, { maxDetections: 10 });
  assert.equal(result.analysed_detections, 10);
  assert.equal(result.truncated, true);
  assert.ok(result.notes.some((n) => /first 10 detections/.test(n)));
});

test('cluster evolution reports per-day sensor-separated counts', () => {
  const result = clusterObservations([
    obs({ id: 'a', sensor: 'MODIS', datetime_utc: '2026-11-09T00:00:00Z', acq_date: '2026-11-09' }),
    obs({ id: 'b', sensor: 'VIIRS', datetime_utc: '2026-11-10T00:00:00Z', acq_date: '2026-11-10' }),
    obs({ id: 'c', sensor: 'VIIRS', datetime_utc: '2026-11-10T12:00:00Z', acq_date: '2026-11-10' }),
  ]);
  assert.equal(result.clusters.length, 1);
  assert.deepEqual(result.clusters[0].daily_counts, [
    { date: '2026-11-09', MODIS: 1, VIIRS: 0 },
    { date: '2026-11-10', MODIS: 0, VIIRS: 2 },
  ]);
});

test('cluster evolution marks a sub-24h group as single_pass', () => {
  const result = clusterObservations([
    obs({ id: 'a', sensor: 'MODIS' }),
    obs({ id: 'b', sensor: 'VIIRS', datetime_utc: '2026-11-09T08:10:00Z' }),
  ]);
  assert.equal(result.clusters[0].evolution.phase, 'single_pass');
});

test('cluster evolution compares the two halves of a multi-day span', () => {
  // Span 60 h; midpoint leaves 2 detections early and 3 late -> increasing.
  const result = clusterObservations([
    obs({ id: 'a', sensor: 'MODIS', datetime_utc: '2026-11-09T00:00:00Z', acq_date: '2026-11-09' }),
    obs({ id: 'b', sensor: 'MODIS', datetime_utc: '2026-11-10T00:00:00Z', acq_date: '2026-11-10' }),
    obs({ id: 'c', sensor: 'MODIS', datetime_utc: '2026-11-10T12:00:00Z', acq_date: '2026-11-10' }),
    obs({ id: 'd', sensor: 'MODIS', datetime_utc: '2026-11-11T00:00:00Z', acq_date: '2026-11-11' }),
    obs({ id: 'e', sensor: 'MODIS', datetime_utc: '2026-11-11T12:00:00Z', acq_date: '2026-11-11' }),
  ]);
  assert.equal(result.clusters.length, 1);
  const evolution = result.clusters[0].evolution;
  assert.equal(evolution.phase, 'increasing');
  assert.equal(evolution.early_half_detections, 2);
  assert.equal(evolution.late_half_detections, 3);
});

test('cluster evolution marks an older group fading when nothing is recent', () => {
  const result = clusterObservations(
    [
      // Old group: three detections chained inside the 24 h link rule, spanning 34 h,
      // ending 2026-11-09 — far from the window's latest activity.
      obs({ id: 'old-a', sensor: 'MODIS', latitude: 20, longitude: 80, datetime_utc: '2026-11-08T00:00:00Z', acq_date: '2026-11-08' }),
      obs({ id: 'old-b', sensor: 'MODIS', latitude: 20, longitude: 80, datetime_utc: '2026-11-08T20:00:00Z', acq_date: '2026-11-08' }),
      obs({ id: 'old-c', sensor: 'MODIS', latitude: 20, longitude: 80, datetime_utc: '2026-11-09T10:00:00Z', acq_date: '2026-11-09' }),
      // Recent group elsewhere: activity at the window end.
      obs({ id: 'new-a', sensor: 'VIIRS', latitude: 30, longitude: 90, datetime_utc: '2026-11-11T00:00:00Z', acq_date: '2026-11-11' }),
      obs({ id: 'new-b', sensor: 'VIIRS', latitude: 30, longitude: 90, datetime_utc: '2026-11-11T12:00:00Z', acq_date: '2026-11-11' }),
    ],
    { linkKm: 200 }
  );
  assert.equal(result.clusters.length, 2);
  const oldCluster = result.clusters.find((c) => c.id.includes('cluster'));
  const fading = result.clusters.filter((c) => c.evolution.phase === 'fading');
  const active = result.clusters.filter((c) => c.evolution.phase !== 'fading');
  assert.equal(fading.length, 1);
  assert.equal(active.length, 1);
  assert.ok(oldCluster);
});

test('a capped cluster list still reports the true number of groups found', () => {
  const spread = Array.from({ length: 6 }, (_, i) =>
    obs({ id: `far-${i}`, sensor: 'MODIS', latitude: 20 + i * 2, longitude: 80 + i * 2 })
  );
  const result = clusterObservations(spread, { maxClusters: 2 });
  assert.equal(result.found_clusters, 6);
  assert.equal(result.clusters.length, 2);
});

test('an empty input clusters to nothing rather than inventing a group', () => {
  const result = clusterObservations([]);
  assert.equal(result.clusters.length, 0);
  assert.equal(result.found_clusters, 0);
  assert.equal(result.total_detections, 0);
});

test('period comparison reports per-sensor change and null percent on a zero baseline', () => {
  const a = { label: 'day 1', days: 1, observations: [obs({ id: 'a1', sensor: 'MODIS' })] };
  const b = {
    label: 'day 2',
    days: 1,
    observations: [obs({ id: 'b1', sensor: 'MODIS' }), obs({ id: 'b2', sensor: 'MODIS' }), obs({ id: 'b3', sensor: 'VIIRS' })],
  };
  const comparison = comparePeriods(a, b);
  assert.equal(comparison.a.by_sensor.MODIS, 1);
  assert.equal(comparison.b.by_sensor.MODIS, 2);
  assert.equal(comparison.change.MODIS.absolute, 1);
  assert.equal(comparison.change.MODIS.percent, 100);
  assert.equal(comparison.change.MODIS.direction, 'increase');
  assert.equal(comparison.change.VIIRS.percent, null, 'a zero baseline has no percentage');
  assert.equal(comparison.change.VIIRS.absolute, 1);
  assert.equal(comparison.normalized.b_per_day.MODIS, 2);
});

test('period comparison never combines sensors into one count', () => {
  const comparison = comparePeriods(
    { label: 'a', days: 1, observations: [] },
    { label: 'b', days: 1, observations: [obs({ id: 'x', sensor: 'MODIS' })] }
  );
  assert.equal((comparison as unknown as Record<string, unknown>).total, undefined);
  assert.equal(comparison.b.by_sensor.MODIS, 1);
  assert.equal(comparison.b.by_sensor.VIIRS, 0);
});

test('audit passes clean records and flags coordinates, dates, FRP and duplicates', () => {
  const clean = auditDataset(
    [obs({ id: 'a', sensor: 'MODIS' }), obs({ id: 'b', sensor: 'VIIRS' })],
    '2026-11-10'
  );
  assert.equal(clean.summary.fail, 0);
  assert.equal(clean.summary.not_applicable, 0);
  assert.equal(clean.scientific_status, 'EXPLORATORY');
  assert.equal(clean.by_sensor.MODIS, 1);

  const dirty = auditDataset(
    [
      obs({ id: 'a', sensor: 'MODIS', latitude: 120 }),
      obs({ id: 'b', sensor: 'VIIRS', acq_date: '2026-02-31' }),
      obs({ id: 'c', sensor: 'MODIS', frp_mw: -5 }),
      obs({ id: 'd', sensor: 'MODIS', acq_date: '2027-01-01', datetime_utc: '2027-01-01T00:00:00Z' }),
      obs({ id: 'e', sensor: 'MODIS', record_hash: 'same' }),
      obs({ id: 'f', sensor: 'MODIS', record_hash: 'same' }),
      obs({ id: 'g', sensor: 'MODIS', provenance_status: 'UNVERIFIED' }),
    ],
    '2026-11-10'
  );
  const statuses = Object.fromEntries(dirty.checks.map((c) => [c.id, c.status]));
  assert.equal(statuses.coordinates, 'fail');
  assert.equal(statuses.dates, 'fail');
  assert.equal(statuses.future, 'fail');
  assert.equal(statuses.frp, 'fail');
  assert.equal(statuses.duplicates, 'fail');
  assert.equal(statuses.provenance, 'fail');
  assert.equal(dirty.by_provenance.UNVERIFIED, 1);
});

test('audit reports not_applicable instead of pass for an empty dataset', () => {
  const report = auditDataset([], '2026-11-10');
  assert.equal(report.checked_records, 0);
  assert.ok(report.checks.every((c) => c.status === 'not_applicable'));
  assert.equal(report.summary.pass, 0);
});
