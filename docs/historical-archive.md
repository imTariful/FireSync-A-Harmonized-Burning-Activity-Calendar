# Historical MODIS & VIIRS archive (2000–2025)

FireSync ships a local historical store built from the FIRMS year ZIP archives in
`Modis and Virs Data/` (git-ignored, ~6.5 GB). It is completely separate from the
live NASA FIRMS NRT pipeline and the in-memory/JSON observation store.

## Verified totals (2025 build)

| Sensor | Observations | Coverage | Satellites in archive |
|---|---|---|---|
| MODIS | 111,424,405 | 2000-11-01 → 2025-12-31 | Terra (2000–01 Terra only), Terra + Aqua from 2002 |
| VIIRS | 281,144,026 | 2012-01-20 → 2025-12-31 | Suomi-NPP only (`satellite='N'` on every row) |

- 40 ZIPs imported, ~330 rows rejected as malformed (logged in `import_manifest.json`),
  ~170 duplicate rows removed during the Parquet build.
- VIIRS yields roughly 2.5× more detections per year than MODIS because of its
  375 m pixels and different overpass timing — raw counts are never equated.
- `bright_t31` (MODIS) and `bright_ti4`/`bright_ti5` (VIIRS) are preserved in Parquet;
  `bright_t31` is not part of the canonical API record.

## Pipeline (Python, resumable)

```bash
# 1. Stream ZIPs -> validated compressed CSV.gz staging + manifest (sha256, rejections)
python data_pipeline/import_historical.py "Modis and Virs Data" --force

# 2. Staging -> partitioned Parquet + daily/monthly/coverage aggregates
python data_pipeline/build_historical_db.py

# 3. Parquet -> climatology aggregates (1-degree grid + country day-of-year)
python data_pipeline/build_climate.py
```

- Staging: `data/historical/staging/*.csv.gz` + `import_manifest.json`
- Store: `data/historical/parquet/obs/sensor=*/year=*/data_*.parquet` and
  `data/historical/parquet/agg/{daily,monthly,coverage}_*.parquet`
- Climatology: `data/historical/parquet/agg/climate_<SENSOR>.parquet`
  (1° grid × month × year) and `climate_country_<SENSOR>.parquet`
  (country × day-of-year × year); verified totals MODIS 111,424,405 / VIIRS
  281,144,026 detections — identical to the obs store.
- Re-running any script resumes/skips completed work; `--force` reprocesses all archives.
- Country labels come from the ZIP member filename
  (`<sensor>_<year>_<Country_With_Underscores>.csv`) with underscores restored to
  spaces. `import_historical.py --force` is required to repair labels after the
  earlier last-token parsing bug ("States"/"Faso" artifacts); rebuilt staging and
  Parquet must then be regenerated with `build_historical_db.py` and
  `build_climate.py`. Source-name abbreviations (e.g. "Dem Rep Korea", "Cote d
  Ivoire", "Timor Leste") are kept as-is — they are the archive's own labels,
  not ISO names.
- All generated data under `data/historical/` (staging, Parquet obs/agg/climate,
  manifest) is reproducible from the source ZIPs and is gitignored — never commit
  it. Local audit scratch lives in `.tmp_analysis/` (also gitignored).

## API (`/api/v1/history/*`)

| Endpoint | Purpose |
|---|---|
| `GET /status` | Archive availability, per-sensor years, row totals, date ranges |
| `GET /daily?year&month&sensor&country&level=daily\|monthly&global` | Per-period detections, FRP sums/max, day/night split |
| `GET /observations?date&sensor&bbox&country&satellite&daynight&min_frp&limit` | Canonical observation rows for one day (≤100k, FRP-ordered) |
| `GET /coverage?sensor` | Dates with any archive rows (absent ≠ zero activity) |
| `GET /year/:sensor/:year` | Yearly totals per sensor |
| `GET /rankings?year&sensor` | Per-country totals for a year (≤500 rows) |
| `GET /frp-extremes`, `/persistence`, `/month-anomaly` | Daily-aggregate FRP maxima, recurring-country ranking, month-vs-median anomaly |
| `GET /countries` | Distinct country labels for pickers |
| `GET /climatology?country\|bbox&sensor&start_year&end_year` | Monthly seasonal climatology: per-sensor medians/quartiles, activity classes, peak/low months |
| `GET /seasonal-status?country&observed_modis&observed_viirs` | Day-of-year window distribution + upcoming-month classes; optional observed counts → period_status |
| `GET /export/{daily,observations,coverage,frp-extremes,persistence,month-anomaly,climatology}.csv` | Sanitized CSV downloads |

All responses carry the legend: *"Satellite thermal anomalies, not confirmed
wildfires or burned area."* Historical records are `provenance_status: UNVERIFIED`
(local archive integrity is not NASA authenticity).

## UI

- **Hotspot Explorer** — Live | Historical toggle; archive date picker (bounds from
  real coverage); viewport-filtered map queries, world view capped at 20k rows.
- **Calendar** — Historical mode: 2000–2025 archive calendar; clicking a day opens
  the map on that exact date.
- **Overview** — `HistoricalArchivePanel`: per-year MODIS/VIIRS totals + CSV links.
- **Sensor Comparison** — `HistoricalOverlapTable`: yearly MODIS vs VIIRS totals,
  2012–2025 overlap only, on demand.
- **Geographic Analysis** — `HistoricalCountryRankings`: top-10 countries per sensor.
- **Exports** — `HistoricalExports`: daily/monthly summary, observations (date
  required) and coverage CSVs.
- **AI copilot (Groq)** — `history_year_summary`, `history_daily_series`,
  `history_period_summary`, `history_country_rankings`, `history_frp_extremes`,
  `history_persistent_countries`, `history_month_anomaly`,
  `history_seasonal_profile`, `history_seasonal_status`; all numbers come from
  the deterministic endpoints above.
- **Seasonal outlook** — `SeasonalOutlookPanel` (Calendar, historical mode):
  12-month activity-class strip + per-sensor medians for a country.
- **Seasonal risk card** — `SeasonalRiskCard` (Geographic Analysis): current
  day-of-year typical range + next-3-months classes per country.

### Seasonal climatology semantics

Climatology = "what was typical in 2000–2025", computed from archive monthly
(country scope) or 1°-grid (bbox scope, cell-center approximation) aggregates.
`activity_class` ranks each month's harmonized-equivalent median against the
scope's own quartiles (low/typical/elevated/high). `harmonized_equivalent_median`
= MODIS median + 0.294 × VIIRS median — the fixed EXPLORATORY coefficient, never
a validated calibration. `period_status` compares a caller-supplied observed
count to the same-day-of-year window's quartiles. **None of this is a forecast.**

## Honest limitations

- VIIRS is Suomi-NPP only — no NOAA-20/21 archives were supplied.
- MODIS-only era 2000-11 → 2011; VIIRS coverage begins 2012-01-20 (launch).
- A missing day in the archive means no rows were delivered, not confirmed zero fires.
- Country labels come from source ZIP filenames, not a spatial join.
- Historical queries are single-day + bbox (or aggregate scans); multi-day ranges
  are supported via `start_date`/`end_date` on `/daily` and the analytics endpoints.
- Bbox climatology uses 1° cells by center point — boundary approximation.
- Daily-resolution "current vs typical" comparison exists at country scope only
  (the archive is country-partitioned; arbitrary polygons cannot be resolved).
- Seasonal outlook/climatology is historical typical-activity description, not forecasting.
- Live historical weather is not integrated — no genuine historical weather dataset
  is shipped.
