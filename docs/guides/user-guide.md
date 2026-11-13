# User Guide

This guide explains how to use the FireSync platform for exploring fire activity data,
viewing the exploratory harmonized metric, and exporting results.

**Current runtime:** the default area is **World**. The app requests **live NASA FIRMS NRT**
data for the rolling last **1–5 days**. There is no bundled archive, mock observation set
or synthetic fallback. The local store starts empty and only a completed real ingestion job
adds records to it.

---

## Platform Overview

FireSync provides a web interface for:

- **Global Map:** Interactive visualization of live fire hotspots
- **Calendar:** Observed burning days (missing dates are not zero)
- **Sensor Comparison:** MODIS vs VIIRS detection analysis
- **Methodology:** Documentation of the harmonization approach and its limits
- **Data Explorer:** Raw observation inspection and filtering
- **Exports:** CSV download of observations and analytics
- **Settings:** Live ingestion, storage status and server key state

---

## Getting Started

### Access the Platform

1. Start the development server:
```bash
npm run dev
```

2. Open your browser to:
```
http://localhost:3000
```

3. The platform loads with **World** selected by default and requests live NRT data.

Without a server-side `FIRMS_MAP_KEY`, live data is unavailable and the UI says so. It
does not substitute an archive or a synthetic sample.

---

## Navigation

The platform has a top navigation bar with the following sections:

- **Overview** — Dashboard with summary KPIs and charts
- **Map** — Interactive map of live fire hotspots
- **Calendar** — Observed burning activity
- **Sensor Comparison** — MODIS vs VIIRS analysis
- **Methodology** — Harmonization methodology and limitations
- **Data Explorer** — Filter and inspect observations
- **Exports** — Download data as CSV
- **Settings** — Real NRT ingestion, storage and key status

---

## Area and Date Selection

### Default Area

The app starts on **World** (`-180,-90,180,90`). The Explorer area chips also include:

- Central Africa (savanna belt)
- Eastern Australia
- Mediterranean Europe
- Canada (boreal forest)
- Siberia (Russia)
- The project study regions (including Bangladesh)

You can also search for a place or draw a polygon AOI on the map. The same area and AOI
are used by Overview, Calendar, Sensor Comparison and Exports. A polygon is applied after
the bounding-box prefilter.

### Date Window

Live NASA FIRMS NRT only covers the rolling last **1–5 days**. The date presets are:

- **Today (1 day)**
- **Last 2 days**
- **Last 3 days**
- **Last 5 days**

A date range outside that window is rejected with `400 LIVE_WINDOW`. The app does not
silently shorten the request or fill it from an archive.

---

## Overview Dashboard

The Overview page displays server-side aggregates for the selected area and live window.

### Summary KPIs

- **Total MODIS Detections** — MODIS observations in the current live window
- **Total VIIRS Detections** — VIIRS observations in the current live window
- **Spatial-Temporal Bins** — 1-km daily cells with at least one detection
- **Total FRP (MW)** — Total Fire Radiative Power, reported per sensor where applicable
- **Data Coverage** — `null` when observation opportunity is unknown, never a fabricated 100%

MODIS and VIIRS counts stay separate. Raw counts are never added together to represent a
single fire count.

### Time Series Charts

- **Daily Activity** — Exploratory harmonized activity over observed days
- **Sensor Comparison** — MODIS vs VIIRS detection counts
- **FRP Trends** — Fire intensity over observed days

With only one live day available, most multi-day trends are short or unavailable. The UI
shows an honest insufficient-data state rather than inventing history.

Use **Bars / Lines**, the measure selector and sensor legends to explore the available
series. Hover, focus or use the period slider to inspect exact values; **View data**
opens the table. Missing values break lines. Period rankings describe the supplied
observations, not a statistical critical-period classification or a forecast.

---

## Map

The Map page provides an interactive visualization of live fire hotspots.

### Map Controls

- **Zoom:** Mouse wheel or +/- buttons
- **Pan:** Click and drag
- **Layer Toggle:** Switch between heatmap, points, and clustering
- **Area chips:** Select World or a preset region
- **Place search:** Move to a named place
- **Draw AOI:** Draw a polygon; clear it to return to the bounding box

### Capped World Overview

A full world day can contain ~100,000 detections. The map requests a capped overview
(`WORLD_OVERVIEW_CAP = 5000` per source) and labels it as truncated. It is **not** a
complete global count. Use Overview, Calendar, Sensor Comparison or an export for complete
aggregate values.

### Filter Panel

- **Date Range:** Within the live 1–5 day window
- **Sensor:** MODIS, VIIRS, or All
- **Satellite:** Terra, Aqua, Suomi-NPP, NOAA-20, NOAA-21, or All
- **Confidence:** High, Nominal, Low, or All
- **Minimum FRP:** Filter by minimum fire intensity

### Observation Details

Click on any observation to view:

- **Source Record ID** — NASA FIRMS identifier
- **Product** — Live NRT product (for example `MODIS_NRT`, `VIIRS_NOAA20_NRT`)
- **Satellite** — Terra, Aqua, NOAA-20, or NOAA-21
- **Confidence** — Detection confidence
- **FRP (MW)** — Fire Radiative Power
- **Brightness** — Thermal brightness temperature
- **Scan/Track** — Scan and track angles
- **Day/Night** — D (day) or N (night)
- **Source File** — Original CSV filename when available
- **Record Hash** — SHA-256 hash for deduplication

---

## Share and Export (3D Globe)

The **Share** button in the Explorer toolbar works in 3D Globe mode only (in the other
modes it is inactive and says so).

- **Copy link** copies a link that reopens the same view: camera, zoom, day range, sensor
  layers and, when the timeline is open, its position. The link contains only those view
  settings (no keys, no secrets). The address bar also follows the view as you move
  (without adding history entries).
- **Capture PNG** saves the map as an image with a footer: the legend sentence, NASA FIRMS
  and the active basemap credit, the UTC time of the capture, and the MODIS and VIIRS
  counts shown separately.
- **Download CSV / GeoJSON** export the visible detections (one `sensor` column / property
  per detection; GeoJSON metadata carries the legend sentence).

**Visible detections** means: the detections loaded for the current globe area whose
sensor layer is switched on and, while the timeline is active, whose time is at or before
the timeline position. The menu shows how many there are per sensor. MODIS and VIIRS are
never summed.

Satellite thermal anomalies, not confirmed wildfires or burned area.

---

## Calendar

The Calendar page displays **observed** burning activity by day.

### Calendar Grid

- Each cell represents one day
- **Color intensity** — Higher activity (more detections)
- **Missing dates** — Drawn as "no observation record", **not** as a zero-fire day
- **Hover** — View daily statistics

### Daily Statistics

- **MODIS Count** — Number of MODIS detections
- **VIIRS Count** — Number of VIIRS detections
- **Harmonized Activity** — Exploratory activity index
- **FRP Total** — Total fire intensity

Live NRT normally provides only one observed day, so multi-year and seasonal comparisons
are usually unavailable. They are not fabricated.

### Historical and monthly views

**Historical Daily Calendar** uses the local archive. Its chart is global, independent
of the map selection. Separate MODIS and VIIRS stripes have independent yearly scales;
hatched cells are unavailable, while a faint solid stripe represents a reported zero.

**Monthly AgniCalendar** uses the separate 10 km cell-month product. Choose the scope,
layer, day/night component and year, then inspect a month for its cells, map overlay
and exports. Monthly observations are never expanded into daily or weekly results.
See the [AgniCalendar guide](../agnicalendar.md) for baseline rules, source limitations
and data verification commands.

### Early monitoring

Open **Calendar → Early monitoring**. Search for a city, district or country on the
inline map and choose a result. Alternatively, use **Tap a place** for an approximate
10, 25 or 50 km wide rectangle, **Draw an area** with a mouse drag or two corner taps,
or **Use visible area** after zooming in. Cancel/Escape abandons drawing; **Clear
selection** requires a new selection before saving. Enter a watch name, choose the
sensor, observation window and per-sensor threshold, then save the monitor.

Cyan outlines show the selected area, amber outlines active monitors and gray outlines
paused monitors. These rectangles are monitoring boundaries, not detections or
administrative borders. A previously selected polygon uses its enclosing rectangle.
Dateline-crossing and polar selections are rejected explicitly.

Alerts report newly seen source observations, not new ignitions. The first check can
report existing acquisitions. The optional potential-cluster trigger uses 5 km / 24 h
single linkage on newly seen observations; chaining can span a wider area, and groups
are not confirmed incidents. Clustering is capped at 5,000 observations. Partial or
truncated source responses fail evaluation rather than producing a misleading alert.
The live parser can reject a source missing required fields; other successful sources
then remain explicitly partial. An empty successful response means no reported
detections in that response, not proof that no fire occurred.

Delivery is **in-app only** and requires the server to remain running; downtime is not
backfilled. Configure `FIRESYNC_WATCHLIST_PATH` for durable state. Deduplication uses
sensor, platform, coordinates and acquisition time with six-day retention across the
five-day live horizon. Changed source identities can appear new, and old alerts without
fingerprints cannot reconstruct that history. Each watch is bounded at 100,000 identities;
an over-broad area fails explicitly. Check the displayed scheduler or evaluation errors
if a monitor stops updating. Monitoring does not predict future fires.

Satellite thermal anomalies, not confirmed wildfires or burned area.

---

## Sensor Comparison

The Sensor Comparison page analyzes MODIS vs VIIRS detection patterns using real paired
1-km cells.

### Detection Comparison Chart

- **X-axis:** Date
- **Y-axis:** Detection count
- **Blue line:** MODIS
- **Orange line:** VIIRS

### Satellite Breakdown

View detection counts by satellite:

- Terra (MODIS)
- Aqua (MODIS)
- NOAA-20 (VIIRS)
- NOAA-21 (VIIRS)

### Confidence Distribution

- **MODIS:** Histogram of numeric confidence values
- **VIIRS:** Distribution of confidence categories (high, nominal, low)

### Calibration Status

- **Current status:** `INSUFFICIENT`
- **Example live world run (2026-11-09):** 2,034 paired in-sample cells, R² `0`,
  MAE `0.5544`, RMSE `0.7078`, mean bias `−0.2091`
- **Temporal holdout:** 1,423 training / 611 validation cells, but all data is from one
  day, so temporal separation fails and `independent_validation` is `false`
- **R² when undefined:** `null`, never `0` as a substitute

An in-sample diagnostic is not validation. No model is labelled `VALIDATED`.

---

## Methodology

The Methodology page documents the harmonization approach and its limits.

### Harmonization Formula

```
BAU = 0.5 * MODIS_count + 0.5 * (0.294 * VIIRS_count) + 0.005 * ln(1 + FRP_total)
```

### Key Concepts

- **BAU (Burning Activity Units):** An exploratory dimensionless index, not a fire count,
  burned area or physical unit
- **Scaling Factor (β = 0.294):** A fixed assumption from the literature, not fitted on
  this dataset
- **FRP Term:** Logarithmic adjustment for fire intensity, not independently calibrated

### Important Notes

- Hotspots are satellite thermal anomalies, not unique fires
- The fixed coefficient is exploratory and must not be used for scientific conclusions
- Regional calibration may be required for global applicability
- Missing observation dates are not zero fire

---

## Data Explorer

The Data Explorer allows filtering and inspection of observations.

### Filters

- **Date Range** — Within the live 1–5 day window
- **Sensor** — MODIS, VIIRS, or All
- **Satellite** — Terra, Aqua, Suomi-NPP, NOAA-20, NOAA-21, or All
- **Confidence** — High, Nominal, Low, or All
- **Minimum FRP** — Filter by fire intensity

### Data Table

Displays filtered observations with:

- Date, Time, Latitude, Longitude
- Sensor, Satellite, Product
- Confidence, FRP (MW)
- Source File, Record Hash

### Pagination

- **Per Page:** 10, 25, 50, or 100 records
- **Page Navigation:** Previous/Next buttons

---

## Exports

The Exports page downloads CSV data for the current area, date window, sensors and AOI.

### Available Exports

- **Observations CSV** — Raw hotspots; filter by `dataset=all|raw|modis|viirs`
- **Matched Pairs CSV** — MODIS/VIIRS co-located pairs and matching method
- **Harmonized Activity CSV** — 1-km cell BAU values (status `EXPLORATORY`)
- **Calendar CSV** — Observed days only; missing dates are not zero
- **Validation CSV** — Calibration diagnostics with `null` R² when undefined
- **Provenance CSV** — Data source, live cache state, local-store provenance, storage kind
  and checksum notes. There is no `archive_provenance` field.

### Export Procedure

1. Select export type
2. Configure filters (date range, region, sensor, AOI)
3. Click "Download CSV"
4. File downloads with formula injection protection

### CSV Format

- **UTF-8 encoding**
- **Formula injection protection** (CWE-1236)
- **Metadata rows:** `#`-prefixed comment rows precede the header (data source, provenance,
  live cache state, filters, calibration status)
- **Headers:** Field names follow the metadata rows
- **Rows:** One record per row

---

## Settings

The Settings page shows what is actually active and can run a real NRT ingestion.

### Area

The current area is shown at the top. Change it on the map (area chips, place search or
drawn AOI); the selection follows every page.

### API Connection Status

- **FIRMS API:** Configured if `FIRMS_MAP_KEY` is set server-side
- **Database:** PostgreSQL/PostGIS is optional and not integrated with the running server
- **Storage Type:** In-memory by default; JSON file if `FIRESYNC_STORE_PATH` is set
- **Local store provenance:** Starts empty and `UNVERIFIED`; only a completed real FIRMS
  ingestion job adds records

### Real NRT Ingestion

Settings can trigger a real ingestion job for the current area and a 1–5 day window. The
job is executed server-side, raw CSVs are preserved with SHA-256 checksums and manifests,
and the real `records_imported` count is reported. A failed job is shown as failed; it is
never reported as success.

---

## Important Scientific Notes

### Data Interpretation

- **Hotspots ≠ Fires:** Hotspots are satellite thermal anomalies, not unique wildfires
- **Missing ≠ Zero:** Missing observations do not indicate no fire activity
- **NRT ≠ Science Quality:** Near Real-Time products are not suitable for retrospective
  analysis
- **Capped map ≠ Complete count:** The map overview is capped; aggregate endpoints are
  complete for the live window

### Calibration Limitations

- **INSUFFICIENT Status:** Calibration is not validated
- **In-sample only:** The fixed coefficient is evaluated on the same paired cells used to
  describe it
- **No temporal separation:** Live NRT covers one day in the final run, so the holdout
  cannot be independent
- **No Observation Opportunity:** Cannot distinguish "no fire" from "no observation"

### Current Dataset

- **Live NRT:** Rolling last 1–5 days from the official NASA FIRMS Area API
- **Historical archive:** Local Parquet store (MODIS 2000-11→2025, VIIRS SNPP
  2012-01→2025; 392.5M observations) when `data_pipeline/` has been run on the
  local FIRMS ZIPs — data is gitignored, so a fresh clone has none until then

---

## Troubleshooting

### Map Not Loading

- Ensure the development server is running
- Check browser console for errors
- Verify internet connection (map tiles require online access)

### No Data Showing

- Confirm `FIRMS_MAP_KEY` is configured server-side for live data
- Check that the date range is inside the last 1–5 days
- Check that filters are not too restrictive
- An empty local store is expected until a real ingestion job completes

### Historical Dates Rejected

Live NRT only covers the last 1–5 days. A request outside that window returns
`400 LIVE_WINDOW`; this is intentional and not a bug. Historical questions are
answered from the local archive (`/api/v1/history/*`, AgniCalendar) when the
pipeline has been run; without it they report unavailable coverage, never zero.

### Export Fails

- Ensure the selected date range is inside the live window
- Check browser download permissions
- Verify server is running

---

## Support

For additional help:

- Review the [API Reference](../api/api-reference.md)
- Check the [README quick start](../../README.md#quick-start)
- Consult the [Scientific Validation Report](../../reports/remediation/SCIENTIFIC_VALIDATION_REPORT.md)
