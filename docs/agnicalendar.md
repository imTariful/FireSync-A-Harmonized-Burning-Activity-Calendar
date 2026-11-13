# AgniCalendar harmonized dataset

Integration of the `Harmonized Data Set/` package — a separate scientific product
from the FIRMS country archive (`data/historical/`). It is **never merged** with
the archive's country-level counts.

## Dataset

- Path: `Harmonized Data Set/AgniCalendar_Global_Harmonized_CellMonth/year=*/part-*.parquet`
  (override with `FIRESYNC_AGNICALENDAR_PARQUET`). Gitignored — generated data, never commit.
- Grain: `cell_id x utc_month x fire_type` — 30,361,118 rows, coverage 2002-07 to 2025-12.
- Grid: EPSG:8857 (Equal Earth), 10 km cells, origin (0,0). `grid_row`/`grid_col`
  are `floor(y/10000)` / `floor(x/10000)` indices; `src/utils/equalEarth.ts`
  converts bbox<->grid ranges and cell centres<->lat/lon (EPSG method 1078).
- Layers: `aqua` = original MODIS Aqua counts; `snpp` = original VIIRS Suomi-NPP
  counts (from 2012-01, Jan 2012 partial); `harmonized` = RF-B Aqua-scale
  estimates **only** where component `prediction_support_status_*` is
  `APPROVED_CONDITIONAL_JOINT_POSITIVE`.
- DAY / NIGHT / UNKNOWN-DN are always separate. `known` = DAY+NIGHT only when
  both components are observed, else NULL — partial sums are never fabricated.
- `fire_type='0'` is source-reported presumed vegetation (classification
  uncertainty retained); types 1/2/3/UNKNOWN stay separate.
- NULL = missing/unavailable, **never zero**. Absent cell-months are not
  fire-free proof. Estimates have no FRP counterpart.

## API (`/api/v1/agnicalendar/*`)

| Endpoint | Purpose |
|---|---|
| `GET /status` | Coverage, layer availability, support-status distribution, caveats |
| `GET /series?layer&daynight&fire_type&bbox&start_year&end_year` | Monthly detection sums + FRP (sensor layers) + contributing cell counts |
| `GET /calendar?...` | Same rows for the month x year calendar UI |
| `GET /cells?year&month&...&limit` | Top cells with cell_id, lat/lon centre, detections, FRP |
| `GET /cells.geojson?year&month&...&limit` | GeoJSON polygons for the top cells — map overlay source (limit-capped, `truncated` flag) |
| `GET /countries` | Country labels available via the cell->country lookup |
| `GET /export/series.csv?...` | CSV export of the monthly series |
| `GET /intelligence?year&...` | Twelve monthly baseline comparisons, valid years and descriptive seasonal summary |
| `GET /comparison?year&month&...` | Separate DAY/NIGHT raw observations, matched-support counts, estimates, FRP and source quality |
| `GET /provenance` | Frozen policy/model identifiers and available validation evidence |
| `GET /export/cell-months.csv?year&month&...` | Streaming selected-month grid aggregates with source/model/support provenance, not individual hotspots |

Common params: `layer=aqua|snpp|harmonized` (default aqua),
`daynight=day|night|unknown|known` (default known),
`fire_type=0|1|2|3|UNKNOWN|all` (default 0), `bbox=west,south,east,north`
(omit = global), `country=<name>` (majority-vote cell->country lookup;
overrides `bbox`). Geographic queries first prune projected grid ranges,
then select whole cells whose centres lie within the bbox or polygon;
boundary centres are included. This is not area-weighted intersection.
Polygon scope uses `aoi=lon,lat;lon,lat;...` (maximum 100 vertices).
An exact `year` takes precedence over `start_year` / `end_year`;
reversed year ranges are rejected. Cell-month export requires one UTC month.

## UI

- Open **Calendar → Monthly AgniCalendar**. Choose a country, region preset
  or selected map area, then layer / day-night / fire type and year range.
- The month x year heatmap uses grey for unavailable values. The selected-year
  bars/lines show monthly detections or explicitly labelled EXPLORATORY
  estimates, source FRP and cells with data. Inspect a month for its top cells,
  same-month sensor comparison, map overlay and CSV exports.
- Historical comparisons display their baseline years and sample size.
  Missing history or unavailable original validation evidence stays unavailable.

## Historical comparison rules

Comparisons are **EXPLORATORY**, descriptive statistics, not validated fire-risk
thresholds or future predictions. The target month is compared with the same
calendar month in other years, keeping layer, DN, fire type, geographic scope
and exact reported product-version population signature identical.

- Exclude the target year, nonfinite/null observations and explicitly partial
  months. At least five distinct other years are required; ambiguous duplicate
  year/month rows invalidate the baseline. Report `baseline_years` and `valid_years`.
- The baseline is the historical median. Empirical percentile is
  `100 × (number below target + 0.5 × number tied) / valid_years`.
- Percentile ≥95 means unusually high; ≤5 means unusually low. These thresholds
  are coarse at small sample sizes. The target/median ratio is unavailable when
  the median is zero. Missing/partial targets do not receive an unusual label.
- Seasonal peaks rank the eligible historical monthly medians, excluding the
  target year. They describe recurring observed activity, not current alerts.

Matching version signatures does not prove equal observation opportunity or
standard-quality monthly revisions. Sparse records and observed-cell counts
are not measured exposure or overpass coverage. The older country archive has
a mixed Aqua/Terra population and its separate exploratory 0.294 framework;
it cannot substitute for this product's comparison population or Phase C validation.

## Cell -> country mapping

`data_pipeline/build_agni_country.py` forward-projects every historical
FIRMS observation onto the EPSG:8857 grid and keeps the majority country per
cell (`data/agnicalendar/cell_country.parquet`, generated/ignored). Border
cells take their dominant country; cells without archive observations stay
unmapped — they are excluded from `country=` queries, never guessed. Country
scopes are therefore approximate at borders and depend on archive coverage.

## AI tools

`agnicalendar_series` (yearly totals + peak months), `agnicalendar_calendar`
(per-calendar-month activity profile), `agnicalendar_cells` (top cells for one
month). All accept `country` or `bbox` scope. All carry the dataset caveats;
missing data is reported as missing.

## Limitations

- Country scope uses a majority-vote mapping from archive observations —
  approximate at borders and unavailable for cells with no archive coverage.
- Monthly resolution only; no daily series, no FRP for harmonized estimates.
- Harmonized-only views describe supported joint-positive observations — not a
  complete corrected VIIRS series. Aqua counts and estimates are never added.
- RF-B support is restricted to source-reported type 0, known DN and approved
  version pairs. It excludes Terra, NOAA20/21, live NRT, unknown DN, other fire
  types and one-sided source rows. DAY+NIGHT requires both components.
- Original Phase C registry/validation tables are unavailable at the supplied
  external paths. Accuracy metrics remain null; integrity hashes and prediction
  replay do not establish generalization accuracy. See
  [data and model provenance](data/model-provenance.md).
- NRT products are provisional and remain separate from this frozen historical
  product. No complete-current-month versus historical-month comparison is made.
- Queries prune year partitions and projected grid ranges. Each historical
  DuckDB pool uses two threads and a 2 GB memory limit; these are not total
  process-memory caps. Full-history/version-matched queries can take longer than
  selected-month queries. GeoJSON/top-cell results are capped and disclose
  truncation; selected-month cell CSV streams the scoped aggregates.

Satellite thermal anomalies, not confirmed wildfires or burned area.

## Reproducing the local data checks

Install and configure the app using the [main README](../README.md). The local
Parquet products and frozen policy/model files must be present; the scripts do
not download, train or regenerate them. From the repository root:

```sh
node scripts/audit_dataset.mjs
node --import tsx scripts/audit_apis.ts
```

The first script inspects physical schema, partitions and model hashes and runs
a bounded worker benchmark. The second starts an isolated offline API instance
against the local products, asserts real Bangladesh March 2025 observations,
scope/baseline/export contracts and the missing-live-key error. Neither seeds
synthetic fire observations. They overwrite their respective local evidence files:
[dataset inspection](../reports/audit/dataset-inspection.json) and
[API verification](../reports/audit/api-verification.json). Existing measurements
are historical evidence, not a guarantee of current latency or source availability.
For inline monitoring controls and live-source limitations, use the
[user guide](guides/user-guide.md#early-monitoring).
