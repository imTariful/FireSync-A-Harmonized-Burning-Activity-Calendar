import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTURE_FAILED_MESSAGE,
  CaptureError,
  captureAttribution,
  captureGlobePng,
  footerGeometry,
  footerHeightPx,
} from './capture';
import { layoutCaptureFooter } from '../../utils/shareHelpers';

test('footer geometry scales with width and stays within sane bounds', () => {
  const small = footerGeometry(360);
  const big = footerGeometry(3840);
  assert.ok(small.fontPx >= 12 && big.fontPx <= 28);
  assert.ok(big.fontPx >= small.fontPx);
  assert.ok(small.maxChars >= 20);
  for (const bad of [0, -5, NaN, Infinity]) assert.ok(footerGeometry(bad).maxChars >= 20);
});

test('footer height grows with the number of lines and never collapses', () => {
  const g = footerGeometry(1200);
  assert.ok(footerHeightPx(6, g) > footerHeightPx(2, g));
  assert.equal(footerHeightPx(0, g), footerHeightPx(1, g));
});

test('attribution always names NASA FIRMS once plus the active basemap credit', () => {
  for (const id of ['satellite', 'bluemarble', 'dark'] as const) {
    const a = captureAttribution(id);
    assert.equal(a.filter((x) => /FIRMS/i.test(x)).length, 1, id);
    assert.ok(a.length >= 2, id);
    assert.ok(a.every((x) => !/&[a-z#0-9]+;/i.test(x)), `${id}: html entities decoded`);
  }
  assert.ok(captureAttribution('satellite').some((x) => /GIBS/.test(x)));
  assert.ok(captureAttribution('dark').some((x) => /Esri/.test(x)));
});

test('satellite capture credit includes the imagery date; other basemaps ignore it', () => {
  const sat = captureAttribution('satellite', '2026-11-04');
  assert.ok(sat.some((x) => x === 'Imagery: NASA EOSDIS GIBS (VIIRS NOAA-20 true color, 2026-11-04)'));
  assert.equal(sat.filter((x) => /FIRMS/i.test(x)).length, 1);
  assert.ok(!captureAttribution('dark', '2026-11-04').some((x) => /2026-11-04/.test(x)));
  assert.ok(!captureAttribution('bluemarble', '2026-11-04').some((x) => /2026-11-04/.test(x)));
});

test('the footer built from the real attribution fits its wrap width', () => {
  const g = footerGeometry(900);
  const lines = layoutCaptureFooter({
    viewTime: new Date('2026-11-07T00:00:00Z'),
    counts: { MODIS: 10, VIIRS: 20 },
    attribution: captureAttribution('dark'),
    maxChars: g.maxChars,
  });
  for (const l of lines) assert.ok(l.length <= g.maxChars);
  assert.match(lines.join(' '), /Satellite thermal anomalies, not confirmed wildfires or burned area\./);
});

const footer = { viewTime: new Date(), counts: { MODIS: 0, VIIRS: 0 }, attribution: [] as string[] };

test('capture failure becomes a friendly CaptureError, not a crash', async () => {
  await assert.rejects(
    captureGlobePng(() => Promise.reject(new Error('tainted')), footer),
    (e: unknown) => e instanceof CaptureError && e.message === CAPTURE_FAILED_MESSAGE,
  );
  await assert.rejects(
    captureGlobePng(() => Promise.resolve({ width: 0, height: 0 } as HTMLCanvasElement), footer),
    CaptureError,
  );
});
