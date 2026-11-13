import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CSV_HEADERS,
  EXPORT_DISCLAIMER,
  detectionsToCsv,
  detectionsToGeoJson,
  detectionsToGeoJsonString,
  type ExportDetection,
} from './export';

const modis: ExportDetection = {
  sensor: 'MODIS',
  satellite: 'Terra',
  latitude: -12.5,
  longitude: 130.25,
  datetime_utc: '2026-08-15T03:10:00Z',
  frp_mw: 42.1,
  confidence: 85,
};
const viirs: ExportDetection = {
  sensor: 'VIIRS',
  satellite: 'NOAA-20',
  latitude: 23.8,
  longitude: 90.4,
  datetime_utc: '2026-08-15T07:42:00Z',
  frp_mw: 3.2,
  confidence: 'nominal',
};
const NOW = new Date('2026-11-06T00:00:00Z');

test('CSV has header with sensor column and one row per detection', () => {
  const lines = detectionsToCsv([modis, viirs]).split('\r\n');
  assert.equal(lines[0], CSV_HEADERS.join(','));
  assert.ok(CSV_HEADERS.includes('sensor'));
  assert.equal(lines.length, 3);
  assert.equal(lines[1], 'MODIS,Terra,-12.5,130.25,2026-08-15T03:10:00Z,42.1,85');
  assert.equal(lines[2], 'VIIRS,NOAA-20,23.8,90.4,2026-08-15T07:42:00Z,3.2,nominal');
});

test('CSV of no detections is just the header', () => {
  assert.equal(detectionsToCsv([]), CSV_HEADERS.join(','));
});

test('CSV neutralises formula injection (=cmd|... and @SUM)', () => {
  const evil = {
    ...modis,
    satellite: "=cmd|' /C calc'!A0" as unknown as ExportDetection['satellite'],
    confidence: '@SUM(1+1)',
    datetime_utc: '+1+1',
  };
  const row = detectionsToCsv([evil]).split('\r\n')[1];
  assert.ok(row.includes("'=cmd|"), row);
  assert.ok(row.includes("'@SUM(1+1)"), row);
  assert.ok(row.includes("'+1+1"), row);
  for (const cell of row.split(',')) {
    assert.ok(!/^[=@]/.test(cell), `cell starts with trigger: ${cell}`);
  }
});

test('CSV quotes commas, quotes and newlines (RFC 4180)', () => {
  const row = detectionsToCsv([
    { ...modis, satellite: 'a,b"c\nd' as unknown as ExportDetection['satellite'] },
  ]);
  assert.ok(row.includes('"a,b""c\nd"'));
});

test('negative coordinates stay numeric (not treated as formulas)', () => {
  const row = detectionsToCsv([{ ...modis, latitude: -33.9, longitude: -70.6 }]).split('\r\n')[1];
  assert.ok(row.startsWith('MODIS,Terra,-33.9,-70.6,'), row);
});

test('invalid records are skipped, not repaired', () => {
  const rows = detectionsToCsv([
    modis,
    { ...viirs, latitude: NaN },
    { ...viirs, longitude: 999 },
    { ...viirs, sensor: 'OTHER' as unknown as ExportDetection['sensor'] },
  ]).split('\r\n');
  assert.equal(rows.length, 2);
});

test('missing FRP is blank in CSV and null in GeoJSON, never 0', () => {
  const d = { ...modis, frp_mw: NaN };
  assert.ok(detectionsToCsv([d]).split('\r\n')[1].includes('2026-08-15T03:10:00Z,,85'));
  assert.equal(detectionsToGeoJson([d], NOW).features[0].properties.frp_mw, null);
});

test('GeoJSON is a FeatureCollection of Points with [lng, lat]', () => {
  const g = detectionsToGeoJson([modis, viirs], NOW);
  assert.equal(g.type, 'FeatureCollection');
  assert.equal(g.features.length, 2);
  const f = g.features[0];
  assert.equal(f.type, 'Feature');
  assert.equal(f.geometry.type, 'Point');
  assert.deepEqual(f.geometry.coordinates, [130.25, -12.5]);
  assert.deepEqual(f.properties, {
    sensor: 'MODIS',
    satellite: 'Terra',
    frp_mw: 42.1,
    time: '2026-08-15T03:10:00Z',
    confidence: 85,
  });
  assert.equal(g.features[1].properties.sensor, 'VIIRS');
  assert.equal(g.features[1].properties.confidence, 'nominal');
});

test('GeoJSON metadata has the mandatory disclaimer sentence', () => {
  const g = detectionsToGeoJson([modis], NOW);
  assert.equal(
    g.metadata.disclaimer,
    'Satellite thermal anomalies, not confirmed wildfires or burned area.',
  );
  assert.equal(EXPORT_DISCLAIMER, g.metadata.disclaimer);
  assert.ok(detectionsToGeoJsonString([], NOW).includes(EXPORT_DISCLAIMER));
  assert.equal(g.metadata.generated_at, '2026-11-06T00:00:00.000Z');
});

test('metadata keeps sensors separate: per-sensor counts, no combined total', () => {
  const g = detectionsToGeoJson([modis, modis, viirs, { ...viirs, latitude: NaN }], NOW);
  assert.deepEqual(g.metadata.counts_by_sensor, { MODIS: 2, VIIRS: 1 });
  assert.equal(g.metadata.skipped_invalid_records, 1);
  assert.equal(g.metadata.sensors_kept_separate, true);
  assert.ok(!('total' in g.metadata) && !('total_count' in g.metadata));
});

test('GeoJSON string round-trips through JSON.parse, injection text stays inert data', () => {
  const evil = { ...modis, satellite: '=cmd|x' as unknown as ExportDetection['satellite'] };
  const parsed = JSON.parse(detectionsToGeoJsonString([evil], NOW));
  assert.equal(parsed.features[0].properties.satellite, '=cmd|x');
});
