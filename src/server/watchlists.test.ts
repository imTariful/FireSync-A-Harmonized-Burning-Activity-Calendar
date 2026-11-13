/**
 * Watchlist tests: deterministic threshold evaluation, dedup, pause/delete and the scheduler.
 * No network: observations are fixtures and the clock/id generators are injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CanonicalObservation } from '../types/fire';
import {
  createWatchlistScheduler,
  evaluateWatchlist,
  MemoryWatchlistStore,
  JsonWatchlistStore,
  parseWatchlistCreate,
  recordWatchlistEvaluation,
  publicWatchlist,
  type Watchlist,
} from './watchlists';

function obs(partial: Partial<CanonicalObservation> & Pick<CanonicalObservation, 'id' | 'sensor'>): CanonicalObservation {
  const { id, sensor, ...rest } = partial;
  return {
    id,
    sensor,
    source_record_id: id,
    latitude: 22.1,
    longitude: 90.1,
    acq_date: '2026-11-10',
    acq_time: '0610',
    datetime_utc: '2026-11-10T06:10:00Z',
    satellite: sensor === 'MODIS' ? 'Terra' : 'NOAA-20',
    product: sensor === 'MODIS' ? 'MODIS_NRT' : 'VIIRS_NOAA20_NRT',
    processing_version: '6.1NRT',
    confidence: 80,
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

const FIXTURES = [
  obs({ id: 'm1', sensor: 'MODIS', frp_mw: 50 }),
  obs({ id: 'm2', sensor: 'MODIS', frp_mw: 5, acq_time: '0611', datetime_utc: '2026-11-10T06:11:00Z' }),
  obs({ id: 'v1', sensor: 'VIIRS', frp_mw: 20 }),
];

function watchlist(overrides: Partial<Watchlist> = {}): Watchlist {
  return {
    id: 'w1',
    name: 'Test area',
    bbox: '90,22,91,23',
    condition: { sensors: 'ALL', days: 1, min_detections: 2 },
    created_at: '2026-11-10T00:00:00Z',
    paused: false,
    last_evaluated_at: null,
    last_counts: null,
    ...overrides,
  };
}

const NOW = () => new Date('2026-11-10T12:00:00Z');
test('public watchlists do not serialize potentially large dedup state', () => {
  const w = watchlist({ seen_observations: { test: '2026-11-10T00:00:00Z' } });
  assert.equal('seen_observations' in publicWatchlist(w), false);
  assert.equal(publicWatchlist(w).id, w.id);
  assert.equal(w.seen_observations?.test, '2026-11-10T00:00:00Z');
});
test('observation dedup survives durable store reload and the next UTC day', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'watchlist-unit-'));
  const file = path.join(dir, 'state.json');
  const store = new JsonWatchlistStore(file);
  const w = watchlist({ condition: { sensors: 'ALL', days: 2, min_detections: 2 } });
  store.saveWatchlist(w);
  assert.ok(recordWatchlistEvaluation(store, w, FIXTURES, NOW, IDS).alert);
  const restored = new JsonWatchlistStore(file);
  const record = recordWatchlistEvaluation(restored, restored.getWatchlist(w.id)!, FIXTURES, () => new Date('2026-11-11T12:00:00Z'), IDS);
  assert.equal(record.alert, null);
  assert.equal(restored.listAlerts().length, 1);
  assert.ok(Object.keys(restored.getWatchlist(w.id)!.seen_observations!).length > 0);
});
const IDS = (() => {
  let n = 0;
  return (prefix: string) => `${prefix}-${++n}`;
})();

test('threshold evaluation counts sensors separately and respects the FRP floor', () => {
  const all = evaluateWatchlist(watchlist(), FIXTURES);
  assert.equal(all.triggered, true);
  assert.deepEqual(all.counts, { MODIS: 2, VIIRS: 1, total: 3 });

  const modisOnly = evaluateWatchlist(
    watchlist({ condition: { sensors: 'MODIS', days: 1, min_detections: 2 } }),
    FIXTURES
  );
  assert.equal(modisOnly.triggered, true);
  assert.equal(modisOnly.counts.VIIRS, 0);

  const frpFloor = evaluateWatchlist(
    watchlist({ condition: { sensors: 'ALL', days: 1, min_detections: 2, min_frp_mw: 15 } }),
    FIXTURES
  );
  // Only m1 (50) and v1 (20) reach 15 MW; m2 (5) does not.
  assert.equal(frpFloor.counts.total, 2);
  assert.equal(frpFloor.triggered, false); // each sensor has only one, not two

  const unmet = evaluateWatchlist(
    watchlist({ condition: { sensors: 'ALL', days: 1, min_detections: 5 } }),
    FIXTURES
  );
  assert.equal(unmet.triggered, false);
  assert.match(unmet.reason, /of 5 required/);
});

test('watchlist creation validation bounds every field', () => {
  assert.equal(parseWatchlistCreate(null).ok, false);
  assert.equal(parseWatchlistCreate({ name: '', bbox: '90,22,91,23', condition: { min_detections: 1 } }).ok, false);
  assert.equal(
    parseWatchlistCreate({ name: 'x', bbox: '91,22,90,23', condition: { min_detections: 1 } }).ok,
    false
  );
  assert.equal(
    parseWatchlistCreate({ name: 'x', bbox: '90,22,91,23', condition: { days: 9, min_detections: 1 } }).ok,
    false
  );
  assert.equal(
    parseWatchlistCreate({ name: 'x', bbox: '90,22,91,23', condition: { min_detections: 0 } }).ok,
    false
  );
  const ok = parseWatchlistCreate({
    name: '  Farm belt  ',
    bbox: '90,22,91,23',
    condition: { sensors: 'VIIRS', days: 3, min_detections: 4, min_frp_mw: 12 },
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.name, 'Farm belt');
    assert.deepEqual(ok.value.condition, { sensors: 'VIIRS', days: 3, min_detections: 4, min_frp_mw: 12 });
  }
});

test('evaluation deduplicates observations across polls and UTC days', () => {
  const store = new MemoryWatchlistStore();
  const w = watchlist();
  store.saveWatchlist(w);

  const first = recordWatchlistEvaluation(store, w, FIXTURES, NOW, IDS);
  assert.equal(first.evaluation.triggered, true);
  assert.ok(first.alert);
  assert.equal(first.alert.date, '2026-11-10');
  assert.equal(store.listAlerts().length, 1);
  assert.deepEqual(store.getWatchlist('w1')?.last_counts, { MODIS: 2, VIIRS: 1, total: 3 });

  // Same day, still triggered: deduplicated, no second alert.
  const second = recordWatchlistEvaluation(store, store.getWatchlist('w1')!, FIXTURES, NOW, IDS);
  assert.equal(second.alert, null);
  assert.equal(store.listAlerts().length, 1);

  // The same observations never become new merely because the UTC date changes.
  const nextDay = recordWatchlistEvaluation(
    store,
    store.getWatchlist('w1')!,
    FIXTURES,
    () => new Date('2026-11-11T00:30:00Z'),
    IDS
  );
  assert.equal(nextDay.alert, null);
  assert.equal(store.listAlerts().length, 1);
});

test('new observations can alert again the same day, platform identity stays distinct', () => {
  const store = new MemoryWatchlistStore();
  const w = watchlist();
  store.saveWatchlist(w);
  recordWatchlistEvaluation(store, w, FIXTURES, NOW, IDS);
  const newObs = obs({ id: 'new', sensor: 'MODIS', satellite: 'Aqua' });
  const next = recordWatchlistEvaluation(store, w, [...FIXTURES, newObs], NOW, IDS);
  assert.ok(next.alert);
  assert.equal(next.alert.new_detections, 1);
  assert.equal(next.alert.first_acquisition_utc, newObs.datetime_utc);
  assert.equal(recordWatchlistEvaluation(store, w, [...FIXTURES, newObs], NOW, IDS).alert, null);
});

test('cluster trigger uses newly seen source observations and validates trigger type', () => {
  const w = watchlist({ condition: { sensors: 'ALL', days: 1, min_detections: 2, trigger: 'clusters' } });
  const store = new MemoryWatchlistStore();
  store.saveWatchlist(w);
  // Distinct coordinates: repeated source rows are not new detections.
  const data = [FIXTURES[0], obs({ id: 'second', sensor: 'MODIS', latitude: 22.11 })];
  assert.ok(recordWatchlistEvaluation(store, w, data, NOW, IDS).alert);
  assert.equal(recordWatchlistEvaluation(store, w, data, NOW, IDS).alert, null);
  assert.equal(parseWatchlistCreate({ name: 'x', bbox: w.bbox, condition: { min_detections: 2, trigger: 'bad' } }).ok, false);
});

test('deleting a watchlist removes its alerts; acknowledging marks the alert', () => {
  const store = new MemoryWatchlistStore();
  store.saveWatchlist(watchlist());
  recordWatchlistEvaluation(store, watchlist(), FIXTURES, NOW, IDS);
  const alertId = store.listAlerts()[0].id;
  assert.equal(store.acknowledgeAlert(alertId), true);
  assert.equal(store.getAlert(alertId)?.acknowledged, true);
  assert.equal(store.deleteWatchlist('w1'), true);
  assert.equal(store.listAlerts().length, 0);
  assert.equal(store.deleteWatchlist('w1'), false);
});

test('scheduler evaluates unpaused watchlists, skips paused ones and dedups alerts', async () => {
  const store = new MemoryWatchlistStore();
  store.saveWatchlist(watchlist({ id: 'active' }));
  store.saveWatchlist(watchlist({ id: 'paused', paused: true }));

  const scheduler = createWatchlistScheduler({
    store,
    load: async () => FIXTURES,
    now: NOW,
    newId: IDS,
  });
  const result = await scheduler.runOnce();
  assert.deepEqual(result, { evaluated: 1, alerts: 1 });
  assert.equal(store.getWatchlist('paused')?.last_evaluated_at, null);
  assert.equal(store.listAlerts().length, 1);

  const again = await scheduler.runOnce();
  assert.deepEqual(again, { evaluated: 1, alerts: 0 });
  assert.equal(store.listAlerts().length, 1);
});

test('a failing watchlist does not block the others', async () => {
  const store = new MemoryWatchlistStore();
  store.saveWatchlist(watchlist({ id: 'bad' }));
  store.saveWatchlist(watchlist({ id: 'good' }));
  const errors: string[] = [];
  const scheduler = createWatchlistScheduler({
    store,
    load: async (w) => {
      if (w.id === 'bad') throw new Error('upstream down');
      return FIXTURES;
    },
    now: NOW,
    newId: IDS,
    onError: (id) => errors.push(id),
  });
  const result = await scheduler.runOnce();
  assert.equal(result.evaluated, 1);
  assert.equal(result.alerts, 1);
  assert.deepEqual(errors, ['bad']);
});
