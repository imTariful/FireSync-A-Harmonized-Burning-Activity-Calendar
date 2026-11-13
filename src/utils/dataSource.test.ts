import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_UNAVAILABLE_CHIP,
  dataSourceChipText,
  dataSourceLabel,
  decideDataSource,
} from './dataSource';

test('live ok: live detections are shown, no chip', () => {
  const d = decideDataSource({ pinnedDate: null, liveStatus: 'ready', liveCount: 120 });
  assert.deepEqual(d, { source: 'live', reason: 'live-ok', fallbackChip: false });
  assert.equal(dataSourceChipText(d), null);
});

test('live error (for example no FIRMS key): live only, with the one honest chip and never the server text', () => {
  const d = decideDataSource({ pinnedDate: null, liveStatus: 'error', liveCount: 0 });
  assert.deepEqual(d, { source: 'live', reason: 'live-error', fallbackChip: true });
  assert.equal(dataSourceChipText(d), LIVE_UNAVAILABLE_CHIP);
  assert.ok(!/FIRMS_MAP_KEY|\.env|key/i.test(LIVE_UNAVAILABLE_CHIP));
});

test('live returned nothing: honest empty result, never a bundled fallback', () => {
  const d = decideDataSource({ pinnedDate: null, liveStatus: 'ready', liveCount: 0 });
  assert.deepEqual(d, { source: 'live', reason: 'live-empty', fallbackChip: false });
  assert.equal(dataSourceChipText(d), null);
});

test('a capped world overview is labelled as such, with no fallback chip', () => {
  const d = decideDataSource({ pinnedDate: null, liveStatus: 'ready', liveCount: 5000, overview: true });
  assert.deepEqual(d, { source: 'live', reason: 'world-overview', fallbackChip: false });
  assert.equal(dataSourceChipText(d), null);
});

test('pinned date always wins and stays live, whatever the live status', () => {
  for (const liveStatus of ['idle', 'loading', 'ready', 'error'] as const) {
    for (const liveCount of [0, 50]) {
      const d = decideDataSource({ pinnedDate: '2025-03-04', liveStatus, liveCount });
      assert.deepEqual(d, { source: 'live', reason: 'pinned-date', fallbackChip: false });
    }
  }
});

test('idle and loading show live only; nothing is silently substituted', () => {
  assert.deepEqual(decideDataSource({ pinnedDate: null, liveStatus: 'idle', liveCount: 0 }), {
    source: 'live',
    reason: 'live-loading',
    fallbackChip: false,
  });
  assert.deepEqual(decideDataSource({ pinnedDate: null, liveStatus: 'loading', liveCount: 40 }), {
    source: 'live',
    reason: 'live-loading',
    fallbackChip: false,
  });
});

test('labels say what is on screen', () => {
  const live = decideDataSource({ pinnedDate: null, liveStatus: 'ready', liveCount: 3 });
  const failed = decideDataSource({ pinnedDate: null, liveStatus: 'error', liveCount: 0 });
  const pin = decideDataSource({ pinnedDate: '2025-03-04', liveStatus: 'ready', liveCount: 3 });
  const overview = decideDataSource({ pinnedDate: null, liveStatus: 'ready', liveCount: 5000, overview: true });
  assert.equal(dataSourceLabel(live, 2, null), 'Live NASA FIRMS, last 2 days');
  assert.equal(dataSourceLabel(live, 1, null), 'Live NASA FIRMS, last 1 day');
  assert.equal(dataSourceLabel(failed, 2, null), 'Live NASA FIRMS unavailable');
  assert.equal(dataSourceLabel(pin, 2, '2025-03-04'), 'Live NASA FIRMS, 2025-03-04');
  assert.equal(dataSourceLabel(overview, 1, null), 'Live NASA FIRMS, world overview (last 1 day)');
});
