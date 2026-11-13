/**
 * Static, real NASA FIRMS product metadata.
 *
 * This file contains no observations, no synthetic records and no validation metrics. It only
 * describes the official products and endpoints that the runtime can query.
 */

export const NASA_DATASET_METADATA = {
  data_source: 'NASA Fire Information for Resource Management System (FIRMS)',
  archive_download_url: 'https://firms.modaps.eosdis.nasa.gov/download/',
  api_documentation_url:
    'https://firms.modaps.eosdis.nasa.gov/content/academy/data_api/firms_api_use.html',
  citation:
    'NASA Near Real-Time and Archive Fire Information for Resource Management System (FIRMS). NASA Goddard Space Flight Center. DOI: 10.5067/FIRMS/MODIS/C6.1, DOI: 10.5067/FIRMS/VIIRS/375M.',
  checksum_note: 'A SHA-256 checksum verifies file integrity, not NASA authenticity.',
  products_covered: [
    {
      product: 'MODIS_NRT',
      sensor: 'MODIS',
      satellites: ['Terra', 'Aqua'],
      resolution: '1000 m (nadir) to 2000 x 4800 m (edge)',
      processing_level: 'Near Real-Time',
      coverage: 'rolling 1-5 day Area API window',
    },
    {
      product: 'VIIRS_NOAA20_NRT',
      sensor: 'VIIRS',
      satellites: ['NOAA-20'],
      resolution: '375 m (nadir) to ~800 m (edge)',
      processing_level: 'Near Real-Time',
      coverage: 'rolling 1-5 day Area API window',
    },
    {
      product: 'VIIRS_NOAA21_NRT',
      sensor: 'VIIRS',
      satellites: ['NOAA-21'],
      resolution: '375 m (nadir) to ~800 m (edge)',
      processing_level: 'Near Real-Time',
      coverage: 'rolling 1-5 day Area API window',
    },
    {
      product: 'MODIS_SP / VNP14IMG',
      sensor: 'MODIS / VIIRS',
      satellites: ['Terra', 'Aqua', 'NOAA-20', 'NOAA-21'],
      resolution: '1 km / 375 m',
      processing_level: 'Standard Science Quality',
      coverage: 'historical archive via the separate FIRMS download / Earthdata workflow',
    },
  ],
} as const;
