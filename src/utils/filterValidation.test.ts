import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clampedLiveWindowNotice,
  clampToLiveWindow,
  datePresets,
  defaultFilters,
  filterConflicts,
  isWithinLiveWindow,
  liveDaysForRange,
  liveWindowStart,
} from './filterValidation';

test('default filters are today only, never in the future', () => {
  const f = defaultFilters('2026-11-08');
  assert.equal(f.startDate, '2026-11-08');
  assert.equal(f.endDate, '2026-11-08');
  // The area lives in one place (App's `area`), not in the filters.
  assert.equal('regionId' in f, false);
  assert.equal('customBbox' in f, false);
  assert.equal(f.sensorMode, 'ALL');
});

test('presets stay inside the live 1–5 day window', () => {
  const p = datePresets('2026-11-08');
  assert.deepEqual(p, [
    { id: '1d', label: 'Today (1 day)', start: '2026-11-08', end: '2026-11-08' },
    { id: '2d', label: 'Last 2 days', start: '2026-11-07', end: '2026-11-08' },
    { id: '3d', label: 'Last 3 days', start: '2026-11-06', end: '2026-11-08' },
    { id: '5d', label: 'Last 5 days', start: '2026-11-04', end: '2026-11-08' },
  ]);
  assert.ok(p.every((x) => x.end === '2026-11-08'));
});

test('the live window starts four days before today', () => {
  assert.equal(liveWindowStart('2026-11-08'), '2026-11-04');
  assert.equal(isWithinLiveWindow('2026-11-04', '2026-11-08', '2026-11-08'), true);
  assert.equal(isWithinLiveWindow('2026-11-03', '2026-11-08', '2026-11-08'), false);
  assert.equal(isWithinLiveWindow('2026-11-01', '2026-11-01', '2026-11-08'), false);
});

test('liveDaysForRange covers a requested range and clamps to 1..5', () => {
  assert.equal(liveDaysForRange('2026-11-08', '2026-11-08', '2026-11-08'), 1);
  assert.equal(liveDaysForRange('2026-11-07', '2026-11-08', '2026-11-08'), 2);
  assert.equal(liveDaysForRange('2026-11-04', '2026-11-08', '2026-11-08'), 5);
  assert.equal(liveDaysForRange('2026-10-01', '2026-11-08', '2026-11-08'), 5);
});

test('conflicts: reversed dates, outside the live window, and sensor/satellite mismatch', () => {
  assert.deepEqual(
    filterConflicts({ startDate: '2026-11-07', endDate: '2026-11-08', sensorMode: 'ALL', satellite: 'ALL' }, '2026-11-08'),
    []
  );
  assert.equal(
    filterConflicts({ startDate: '2026-11-09', endDate: '2026-11-08', sensorMode: 'ALL', satellite: 'ALL' }, '2026-11-08')
      .length,
    1
  );
  assert.equal(
    filterConflicts({ startDate: '2026-10-01', endDate: '2026-11-08', sensorMode: 'ALL', satellite: 'ALL' }, '2026-11-08')
      .length,
    1
  );
  assert.equal(
    filterConflicts({ startDate: '', endDate: '', sensorMode: 'MODIS_ONLY', satellite: 'Suomi-NPP' }, '2026-11-08')
      .length,
    1
  );
  assert.equal(
    filterConflicts({ startDate: '', endDate: '', sensorMode: 'VIIRS_ONLY', satellite: 'Aqua' }, '2026-11-08').length,
    1
  );
  assert.deepEqual(
    filterConflicts({ startDate: '', endDate: '', sensorMode: 'MODIS_ONLY', satellite: 'Terra' }, '2026-11-08'),
    []
  );
});

test('clampToLiveWindow keeps an in-window range untouched', () => {
  assert.deepEqual(clampToLiveWindow('2026-11-07', '2026-11-08', '2026-11-08'), {
    start: '2026-11-07',
    end: '2026-11-08',
  });
});

test('clampToLiveWindow pulls an older start date up to the live window start', () => {
  assert.deepEqual(clampToLiveWindow('2026-10-01', '2026-11-08', '2026-11-08'), {
    start: '2026-11-04',
    end: '2026-11-08',
  });
});

test('clampToLiveWindow never returns a future end date and keeps start <= end', () => {
  assert.deepEqual(clampToLiveWindow('2026-12-01', '2026-12-09', '2026-11-08'), {
    start: '2026-11-08',
    end: '2026-11-08',
  });
});

test('clampedLiveWindowNotice is null when the chosen range is inside the live window', () => {
  assert.equal(clampedLiveWindowNotice('2026-11-07', '2026-11-08', '2026-11-08'), null);
});

test('clampedLiveWindowNotice names the window actually displayed when start is too old', () => {
  const notice = clampedLiveWindowNotice('2026-10-01', '2026-11-08', '2026-11-08');
  assert.ok(notice);
  assert.match(notice, /2026-11-04 to 2026-11-08/);
  assert.match(notice, /2026-10-01 to 2026-11-08/);
  assert.match(notice, /last 5 days/);
});
