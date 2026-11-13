import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BASEMAP_OPTIONS,
  DEFAULT_BASEMAP,
  FIRST_FIRE_LAYER_ID,
  GIBS_ATTRIBUTION,
  buildBasemap,
  hasImageryDate,
  imageryDateNote,
  isGibsBasemap,
  satelliteCredit,
  satelliteDate,
  nextErrorCount,
  shouldFallBackToDark,
} from './basemap';

const NOW = new Date('2026-11-06T12:00:00Z');

test('default basemap is satellite and all three options exist', () => {
  assert.equal(DEFAULT_BASEMAP, 'satellite');
  assert.deepEqual(BASEMAP_OPTIONS.map((o) => o.id), ['satellite', 'bluemarble', 'dark']);
});

test('satellite uses VIIRS NOAA-20 true color one day before today (UTC)', () => {
  const b = buildBasemap('satellite', NOW);
  const url = (b.source as { tiles: string[] }).tiles[0];
  assert.match(url, /VIIRS_NOAA20_CorrectedReflectance_TrueColor\/default\/2026-11-05\/GoogleMapsCompatible_Level9\/\{z\}\/\{y\}\/\{x\}\.jpg$/);
  assert.equal(b.layer.source, b.sourceId);
  assert.equal(b.layer.id, b.layerId);
});

test('blue marble is the static shaded-relief layer', () => {
  const url = (buildBasemap('bluemarble', NOW).source as { tiles: string[] }).tiles[0];
  assert.match(url, /BlueMarble_ShadedRelief_Bathymetry\/default\/GoogleMapsCompatible_Level8\//);
});

test('dark is the Esri dark gray raster', () => {
  const b = buildBasemap('dark', NOW);
  assert.match((b.source as { tiles: string[] }).tiles[0], /World_Dark_Gray_Base/);
});

test('attribution: GIBS basemaps credit NASA GIBS, every basemap keeps FIRMS', () => {
  for (const id of ['satellite', 'bluemarble'] as const) {
    assert.match(String(buildBasemap(id, NOW).source.attribution), new RegExp(GIBS_ATTRIBUTION));
  }
  assert.ok(!String(buildBasemap('dark', NOW).source.attribution).includes('GIBS'));
  for (const id of ['satellite', 'bluemarble', 'dark'] as const) {
    assert.match(String(buildBasemap(id, NOW).source.attribution), /NASA FIRMS/);
  }
});

test('basemap source ids never collide with fire sources', () => {
  for (const id of ['satellite', 'bluemarble', 'dark'] as const) {
    assert.doesNotMatch(buildBasemap(id, NOW).sourceId, /^(modis|viirs)-/);
  }
  assert.equal(FIRST_FIRE_LAYER_ID, 'modis-heatmap');
});

test('fallback after 3 consecutive GIBS errors; a good tile resets; dark never falls back', () => {
  let n = 0;
  n = nextErrorCount(n, 'error');
  n = nextErrorCount(n, 'error');
  assert.equal(shouldFallBackToDark('satellite', n), false);
  n = nextErrorCount(n, 'ok');
  assert.equal(n, 0);
  n = nextErrorCount(n, 'error');
  n = nextErrorCount(n, 'error');
  n = nextErrorCount(n, 'error');
  assert.equal(shouldFallBackToDark('satellite', n), true);
  assert.equal(shouldFallBackToDark('bluemarble', n), true);
  assert.equal(shouldFallBackToDark('dark', n), false);
  assert.equal(isGibsBasemap('dark'), false);
});

test('satellite takes an explicit date: tiles, source id and credit all carry it', () => {
  const b = buildBasemap('satellite', NOW, '2026-11-02');
  assert.match((b.source as { tiles: string[] }).tiles[0], /\/default\/2026-11-02\/GoogleMapsCompatible_Level9\//);
  assert.equal(b.sourceId, 'gibs-trueColor-2026-11-02');
  assert.equal(b.layerId, 'gibs-trueColor-2026-11-02-layer');
  assert.match(String(b.source.attribution), /Imagery: NASA EOSDIS GIBS \(VIIRS NOAA-20 true color, 2026-11-02\)/);
  assert.match(String(b.source.attribution), /NASA FIRMS/);
});

test('different dates give different source ids (swap, not reload); the same date gives the same id', () => {
  const a = buildBasemap('satellite', NOW, '2026-11-02');
  const b = buildBasemap('satellite', NOW, '2026-11-03');
  assert.notEqual(a.sourceId, b.sourceId);
  assert.equal(buildBasemap('satellite', NOW, '2026-11-02').sourceId, a.sourceId);
});

test('satellite date is clamped; the credit shows the clamped date, not the requested one', () => {
  const future = buildBasemap('satellite', NOW, '2099-01-01');
  assert.equal(future.sourceId, 'gibs-trueColor-2026-11-05');
  assert.match(String(future.source.attribution), /2026-11-05\)/);
  assert.equal(satelliteDate(undefined, NOW), '2026-11-05');
  assert.equal(satelliteDate('garbage', NOW), '2026-11-05');
  assert.equal(satelliteDate('2000-01-01', NOW), '2018-01-05');
});

test('Blue Marble and Dark ignore a date and show no date control', () => {
  for (const id of ['bluemarble', 'dark'] as const) {
    assert.equal(hasImageryDate(id), false);
    const withDate = buildBasemap(id, NOW, '2026-11-02');
    const without = buildBasemap(id, NOW);
    assert.equal(withDate.sourceId, without.sourceId);
    assert.deepEqual(withDate.source, without.source);
    assert.doesNotMatch(String(withDate.source.attribution), /2026-11-02/);
  }
  assert.equal(hasImageryDate('satellite'), true);
});

test('date note and credit text', () => {
  assert.equal(satelliteCredit('2026-11-04'), 'Imagery: NASA EOSDIS GIBS (VIIRS NOAA-20 true color, 2026-11-04)');
  assert.equal(
    imageryDateNote('2026-11-04'),
    'Daily composite for 2026-11-04 (UTC). Black areas mean no imagery for that day (gaps, or polar night), not absence of fire.',
  );
});
