# Historical Archive Audit — MODIS & VIIRS (verified 2025-11-12)

> Point-in-time audit of the source ZIPs. For the current built-store totals
> (392,568,431 deduplicated observations) see `docs/historical-archive.md` —
> additional VIIRS archives were audited separately after this document.

Read-only inventory of `Modis and Virs Data/` (2.9 GB zipped, ~14 GB uncompressed CSV).
Method: streamed every CSV inside every ZIP; counted rows, tracked min/max `acq_date`,
and collected distinct `satellite` / `instrument` / `confidence` / `version` / `daynight`
values. No ZIP was modified. Raw per-archive stats: `.tmp_analysis/archive_audit.json`.

## Inventory

| Folder | Archives | Rows | Coverage |
|---|---|---|---|
| `modis/` | 26 year-ZIPs (2000–2025) | 114,955,886 | 2000-11-01 → 2025-12-31 |
| `viirs_snpp/` | 14 year-ZIPs (2012–2025) | 261,082,318 | 2012-01-20 → 2025-12-31 |
| **Total** | **40 ZIPs, ~220 country CSVs each** | **376,038,204** | ~6.5 GB zipped, ~25 GB CSV |

VIIRS note: 2012 begins **2012-01-20** (S-NPP launch/commissioning); all other
years are full Jan 1 → Dec 31. VIIRS per-year rows grew from ~19–21M (2012–2024)
to 18.4M in 2025 (partial-year effect depends on archive cutoff — verify at query time).

Malformed rows: **0** across all 40 archives (every row had all expected fields).

## Verified schema (real CSV headers)

MODIS (all years identical):
`latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type`

VIIRS (all years identical):
`latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight,type`

Both are the standard FIRMS export schema — the existing
`data_pipeline/run_pipeline.py::canonical_from_row` validator covers nearly every field
(`bright_ti4/ti5` map to `bright_ti4/bright_ti5`; VIIRS `brightness` is absent, MODIS
`bright_t31` is present).

## Coverage matrix (verified, not assumed)

| Period | MODIS Terra | MODIS Aqua | VIIRS S-NPP |
|---|---|---|---|
| 2000-11 → 2001 | yes | — (pre-launch) | — |
| 2002 → 2011 | yes | yes | — (pre-launch) |
| 2012-01-20 → 2025 | yes | yes | yes |

- MODIS 2000 starts **2000-11-01**, not Jan 1 (Terra-only, ~261k rows).
- Aqua first appears in the **2002** archive (~1.86M rows vs 1.84M Terra).
- Processing versions observed: MODIS `6.2`, `6.03` (2000–2017), `61.03` (2023–2025);
  VIIRS `2` throughout. Version strings kept verbatim — do not normalize silently.
- MODIS `confidence` is numeric 0–100; VIIRS `confidence` is `l`/`n`/`h`.
- VIIRS `satellite` field is literally `N` (Suomi-NPP). **No NOAA-20 or NOAA-21 exists.**
- VIIRS `daynight`: ~73% D / 27% N. MODIS similar ratio.

## Critical gaps (must be surfaced in UI, never hidden)

1. **No sensor overlap before 2012-01-20** — MODIS-only era 2000–2011.
2. MODIS 2000 is partial (Nov–Dec only); VIIRS 2012 starts Jan 20.
3. VIIRS `satellite` is `N` for all 261M rows — **S-NPP only; no NOAA-20/21**,
   so "VIIRS" here means one spacecraft, not the full VIIRS series.
4. `type` column is `0` on all sampled rows; `quality_flags` semantics UNKNOWN.
5. Country attribution comes from the **filename** (e.g. `modis_2010_Australia.csv`),
   not from a spatial join — boundaries are whatever the archive author used.
6. VIIRS produces ~4.5× more rows/year than MODIS (375 m vs 1 km pixels plus
   different detection sensitivity) — never compare raw counts as equivalents.
7. No per-day coverage manifest: a missing `(country, date)` pair means "no rows in
   that file", which is *not* proof of zero fire activity (cloud, outage, or simply
   no detections above threshold).

## Scale implications

- 376M observations → must NOT enter the JSON/`ObservationStore` (memory or file).
- Per-year MODIS ≈ 4–5M rows ≈ 350–400 MB CSV; VIIRS years ≈ 17–22M rows ≈ 1.5–1.7 GB CSV.
- Country partitioning is a gift: ingestion, queries and exports can be country-scoped.
- DuckDB + partitioned Parquet (by sensor/year[/country]) is the right fit; the Node
  server queries aggregates only, never raw rows at scale.

## Implementation plan (phased, one commit each)

1. **HIST-AUDIT** (this task): audit report + `.gitignore` for the 2.9 GB archive.
2. **HIST-STORE**: `data_pipeline/import_historical.py` — stream ZIPs → validate with
   the existing `canonical_from_row` rules (relaxed: no bbox/window) → write
   `data/historical/{sensor}/year=YYYY/part-*.parquet` + `import_manifest.json`
   (per-zip rows, sha256, date range, satellites, versions). DuckDB not required for
   v1 storage; add `duckdb` later only if analytical latency demands it.
   *Python deps needed: `pyarrow` (or `fastparquet`) — currently absent; confirm before use.*
3. **HIST-API**: `src/server/historical.ts` — read-only query service over the Parquet
   store via a small Python sidecar OR a Node DuckDB binding; REST routes under
   `/api/v1/history/*` (coverage, daily counts, observations w/ bbox+date+sensor+limit,
   monthly/yearly aggregates, CSV export). All MODIS/VIIRS counts kept separate.
4. **HIST-UI-SOURCE**: `Live | Historical` source switch in App state; historical mode
   bypasses the 5-day live clamp; Hotspot Explorer + Calendar read from `/api/v1/history`.
5. **HIST-CALENDAR**: year/month/day historical calendar with per-day observation
   status (observed / no_rows_in_archive / sensor_unavailable / outside_coverage),
   MODIS/VIIRS toggles, country filter, CSV export, click-through to map.
6. **HIST-ANALYTICS**: overview charts, sensor overlap comparison (2012/2015/2017 only!),
   YoY, day/night, FRP extremes, recurring zones — each labelled with real coverage.
7. **HIST-AI**: historical tools for the existing Groq loop (deterministic queries
   only; no provider change).
8. **HIST-VERIFY**: lint/test/build + real-data checks per Phase 8 list.

## Open questions for the user

- Parquet writer dependency (`pyarrow`) is not installed — approve adding it, or
  should the store be partitioned CSV.gz instead (no new deps, slower queries)?
- Query path: Python sidecar process vs Node `duckdb` npm package (new dep either way
  for real performance at 173M rows)?
- VIIRS is S-NPP-only for all 14 years — confirm no NOAA-20/21 archives exist elsewhere.
