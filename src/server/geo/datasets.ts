/**
 * Geographic dataset registry.
 *
 * The application ships no land-cover, elevation, population or administrative-boundary dataset.
 * Rather than inventing categories or distances, each dataset reports `configured: false` with the
 * provider it would need and the resolution it would carry. The rules from AGENTS.md apply: a
 * missing dataset is reported as unavailable, never as an empty (zero) result.
 */

export interface GeoDataset {
  id: 'firms_nrt' | 'landcover' | 'terrain' | 'population' | 'admin_boundaries' | 'settlements';
  name: string;
  provider: string;
  resolution: string;
  configured: boolean;
  used_for: string;
  note: string;
}

const DATASETS: GeoDataset[] = [
  {
    id: 'firms_nrt',
    name: 'NASA FIRMS active fire detections (NRT)',
    provider: 'NASA FIRMS Area API (MODIS_NRT, VIIRS_NOAA20_NRT, VIIRS_NOAA21_NRT)',
    resolution: 'MODIS 1 km, VIIRS 375 m at nadir',
    configured: true,
    used_for: 'Detection counts, density, clustering, coverage and proximity inputs',
    note: 'Live NRT only (1-5 days). Requires a server-side FIRMS_MAP_KEY.',
  },
  {
    id: 'landcover',
    name: 'ESA WorldCover land cover',
    provider: 'ESA WorldCover v200 (2021)',
    resolution: '10 m',
    configured: false,
    used_for: 'Detections summarised by land-cover class',
    note: 'No land-cover raster or class lookup is present in this deployment, so no class summary is produced.',
  },
  {
    id: 'terrain',
    name: 'Copernicus DEM elevation',
    provider: 'Copernicus DEM GLO-30',
    resolution: '30 m',
    configured: false,
    used_for: 'Elevation and slope context around detections',
    note: 'No DEM tiles are present; slope is undefined without them.',
  },
  {
    id: 'population',
    name: 'Gridded population',
    provider: 'WorldPop / GHSL',
    resolution: '100 m - 1 km',
    configured: false,
    used_for: 'Proximity-based exposure screening indicators',
    note: 'No population grid is present, so no exposure indicator is calculated.',
  },
  {
    id: 'admin_boundaries',
    name: 'Administrative boundaries',
    provider: 'geoBoundaries / Natural Earth',
    resolution: 'Vector',
    configured: false,
    used_for: 'Country and district aggregation, cross-border analysis',
    note: 'No boundary file is present. Country analysis uses the project region table (approximate bounding boxes), not official borders.',
  },
  {
    id: 'settlements',
    name: 'Settlements, hospitals, schools, roads',
    provider: 'OpenStreetMap extract (not bundled)',
    resolution: 'Vector',
    configured: false,
    used_for: 'Distance and buffer screening around mapped infrastructure',
    note: 'No OSM extract is bundled. Proximity runs only on features supplied explicitly in the request.',
  },
];

export function geoDatasetStatus(): {
  datasets: GeoDataset[];
  available_count: number;
  unavailable_count: number;
  note: string;
} {
  const configured = DATASETS.filter((d) => d.configured).length;
  return {
    datasets: DATASETS,
    available_count: configured,
    unavailable_count: DATASETS.length - configured,
    note: 'Unavailable datasets are reported explicitly; the application never substitutes an empty result for missing geographic data.',
  };
}

export function dataset(id: GeoDataset['id']): GeoDataset {
  const found = DATASETS.find((d) => d.id === id);
  if (!found) throw new Error(`Unknown dataset ${id}`);
  return found;
}

export type UnavailableDatasetId = Exclude<GeoDataset['id'], 'firms_nrt'>;

export interface UnavailableDatasetResult {
  available: false;
  dataset: GeoDataset;
  reason: string;
  expected_resolution: string;
  would_provide: string;
  note: string;
}

/**
 * One honest response shape for every capability whose dataset is not bundled.
 * It never contains a feature list or a zero-valued result that could be read as "no exposure".
 */
export function unavailableDatasetResult(id: UnavailableDatasetId): UnavailableDatasetResult {
  const meta = dataset(id);
  return {
    available: false,
    dataset: meta,
    reason: meta.note,
    expected_resolution: meta.resolution,
    would_provide: meta.used_for,
    note: 'This capability is reported unavailable instead of returning an empty or invented result.',
  };
}
