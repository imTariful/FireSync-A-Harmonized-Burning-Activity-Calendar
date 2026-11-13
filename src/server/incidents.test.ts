/**
 * Incident verification tests: WFIGS/IRWIN parsing, deterministic
 * corroboration and caching. No real network — fetch is mocked.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { CanonicalObservation } from '../types/fire';
import {
  corroborateIncidents,
  fetchOfficialIncidents,
  haversineKm,
  verifyIncidents,
  type OfficialIncident,
} from './incidents';

function obs(partial: Partial<CanonicalObservation> & Pick<CanonicalObservation, 'id'>): CanonicalObservation {
  return {
    source_record_id: partial.id,
    latitude: 40.1,
    longitude: -106.5,
    acq_date: '2026-11-10',
    acq_time: '0600',
    datetime_utc: '2026-11-10T06:00:00Z',
    sensor: 'VIIRS',
    satellite: 'NOAA-20',
    product: 'VIIRS_NOAA20_NRT',
    processing_version: '2.0NRT',
    confidence: 80,
    confidence_category: 'nominal',
    frp_mw: 12,
    scan: 1,
    track: 1,
    daynight: 'D',
    source_file: 'fixture.csv',
    retrieved_at: '2026-11-10T00:00:00Z',
    quality_flags: 'fixture',
    record_hash: partial.id,
    ...partial,
  } as CanonicalObservation;
}

function incident(partial: Partial<OfficialIncident> = {}): OfficialIncident {
  return {
    id: 'IRWIN-1',
    name: 'Test Fire',
    type_category: 'WF',
    type_kind: 'WF',
    state: 'US-CO',
    city: 'Test',
    county: 'Test County',
    lat: 40.1,
    lon: -106.5,
    size_acres: 120,
    percent_contained: 10,
    discovered_at: '2026-11-10T05:00:00Z',
    out_at: null,
    cause: 'Lightning',
    gacc: 'NRCC',
    ...partial,
  };
}

const NOW = () => new Date('2026-11-12T00:00:00Z');

test('haversineKm: known distance ~111 km per degree latitude', () => {
  const d = haversineKm(0, 0, 1, 0);
  assert.ok(d > 110 && d < 112, `got ${d}`);
  assert.equal(haversineKm(40, -106, 40, -106), 0);
});

test('corroborateIncidents: detection within radius+window corroborates', () => {
  const inc = incident();
  const observations = [obs({ id: 'a' }), obs({ id: 'b', latitude: 40.5, longitude: -106.0 })];
  const out = corroborateIncidents([inc], observations, { now: NOW });
  assert.equal(out.length, 1);
  // obs a is ~0 km; obs b is ~57 km away -> outside 10 km radius
  assert.equal(out[0].nearby_detections, 1);
  assert.equal(out[0].match, 'satellite_corroborated');
  assert.ok(out[0].nearest_detection_km !== null && out[0].nearest_detection_km < 1);
});

test('corroborateIncidents: distant or stale detections do not corroborate', () => {
  const inc = incident();
  const far = obs({ id: 'far', latitude: 41.5, longitude: -106.5 }); // ~155 km
  const stale = obs({ id: 'stale', datetime_utc: '2026-11-01T06:00:00Z', acq_date: '2026-11-01' });
  const out = corroborateIncidents([inc], [far, stale], { now: NOW });
  assert.equal(out[0].nearby_detections, 0);
  assert.equal(out[0].match, 'no_nearby_detections');
});

test('corroborateIncidents: days and state filters apply', () => {
  const old = incident({ id: 'old', discovered_at: '2026-10-01T00:00:00Z' });
  const other = incident({ id: 'other', state: 'US-WY' });
  const out = corroborateIncidents([old, other, incident()], [], { days: 14, state: 'US-CO', now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'IRWIN-1');
});

test('fetchOfficialIncidents parses geojson features and caches', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        features: [
          {
            properties: {
              IrwinID: 'IRWIN-X',
              IncidentName: 'Ruby Fire',
              IncidentTypeCategory: 'WF',
              POOState: 'US-MT',
              IncidentSize: 500,
              PercentContained: 25,
              FireDiscoveryDateTime: 1760000000000,
            },
            geometry: { type: 'Point', coordinates: [-111.5, 46.8] },
          },
          { properties: { IncidentName: 'no coords' }, geometry: null },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;

  const r1 = await fetchOfficialIncidents({ fetchImpl, now: NOW, bypassCache: true });
  assert.equal(r1.incidents.length, 1);
  assert.equal(r1.incidents[0].name, 'Ruby Fire');
  assert.equal(r1.incidents[0].lat, 46.8);
  assert.equal(r1.incidents[0].state, 'US-MT');
  assert.ok(r1.incidents[0].discovered_at?.endsWith('Z'));
  assert.equal(r1.cached, false);

  const r2 = await fetchOfficialIncidents({ fetchImpl, now: NOW });
  assert.equal(r2.cached, true);
  assert.equal(calls.length, 1, 'second call should use cache');
});

test('verifyIncidents returns summary, source metadata and legend', async () => {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        features: [
          {
            properties: {
              IrwinID: 'IRWIN-1',
              IncidentName: 'Test Fire',
              IncidentTypeCategory: 'WF',
              POOState: 'US-CO',
              FireDiscoveryDateTime: Date.parse('2026-11-10T05:00:00Z'),
            },
            geometry: { type: 'Point', coordinates: [-106.5, 40.1] },
          },
        ],
      }),
      { status: 200 }
    )) as typeof fetch;

  const out = await verifyIncidents([obs({ id: 'a' })], {
    fetchImpl,
    now: NOW,
    bypassCache: true,
    days: 14,
  });
  assert.equal(out.summary.total, 1);
  assert.equal(out.summary.satellite_corroborated, 1);
  assert.equal(out.source.coverage.includes('United States'), true);
  assert.equal(out.legend, 'Satellite thermal anomalies, not confirmed wildfires or burned area.');
});
