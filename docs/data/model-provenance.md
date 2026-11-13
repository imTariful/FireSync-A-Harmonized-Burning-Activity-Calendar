# Data and model provenance — 2026-11-12

## Three distinct data paths

1. **Round 2 approved scientific product:** `Harmonized Data Set/AgniCalendar_Global_Harmonized_CellMonth/year=*/part-*.parquet`. Physically inspected through installed DuckDB: 24 partitions, 144 columns, 30,361,118 records, 2002-07 through 2025-12. Grain CELL_ID × UTC_MONTH × FIRE_TYPE; DN components in separate columns. EPSG:8857, 10000 m, origin (0,0); signed floor indices. This is the source for the new historical intelligence, comparison and grid exports.
2. **Existing detection archive:** `data/historical/parquet/{obs,agg}`. Actual status: MODIS 111,424,405 observations, 2000-11-01–2025-12-31; VIIRS 281,144,026, 2012-01-20–2025-12-31. MODIS includes Terra and Aqua, VIIRS is SNPP. This separately processed archive is not the Round 2 model population. Existing archive pages remain separate.
3. **Live NRT:** NASA FIRMS Area API; MODIS_NRT, VIIRS_NOAA20_NRT, VIIRS_NOAA21_NRT. Server-side MAP_KEY, original platform/product/version retained, 30-minute cache. No new NRT rows are written into either frozen historical product. Actual small-region live verification in `reports/audit/live-bangladesh.json` returned 1 MODIS and 20 VIIRS source observations with no source errors. These are thermal anomalies, not 21 distinct fires.

## Existing scientific evidence inspected, not rerun

Read `ROUND2_FINAL_QA_REPORT.md`, `round2_data_integrity_report.json`, `round2_sensor_pairing_audit.json`, `round2_schema.json`, `round2_final_partition_manifest.json`, grid validation, model preflight, deployment policy, model card and sampled prediction-verification CSV. Existing reports state 40 ZIPs/8337 CSV members, 392,568,931 raw valid rows, 3 exact duplicates removed, 392,568,928 unique detections. Sensor totals: Aqua 71,742,290; Terra auxiliary 39,682,127; SNPP 281,144,511. Existing pairing report states full outer equality join on cell/month/type/DN, 36,460,906 paired-DN rows, nulls preserved and count conservation passed. These are report assertions, not a new global duplicate or conservation audit.

Archive totals differ from Round 2 by 497 observations because the earlier archive used different validation/dedup rules (existing docs report roughly 330 rejections and 170 duplicates). No attempt was made to force agreement or overwrite either dataset. Source-member/version/confidence maps and raw quality flags are present in Round 2. Numeric version strings do **not** prove standard processing or corrected monthly revision: `product_version_status` explicitly preserves uncertainty.

## Frozen Phase C method

`deployment_policy.json`: model RANDOM_FOREST_B; reference MODIS_AQUA; predictor VIIRS_SNPP; training years 2013/2019; separate DAY/NIGHT estimators; target is same-key source-reported type-0 Aqua counts on strictly joint-positive population. Nine features: VIIRS count, FRP sum/mean/max, l/n/h confidence counts, month sine/cosine. Model output is conditional Aqua-equivalent counts, never occurrence/ignition probability. Floor=max(native,1), no integer rounding or upper cap. Unsupported type, unknown DN, one-sided rows, unapproved versions retain null estimates. Terra is never passed through this model.

Recomputed SHA-256 of the **local bytes** without deserializing estimators:

| Artifact | Local path | SHA-256 / result |
|---|---|---|
| DAY | models/RANDOM_FOREST_B/DAY.joblib | 6539fa43918a71857f74d1794a44e2575556d8a90f40989ba6668d309946076e — matches policy |
| NIGHT | models/RANDOM_FOREST_B/NIGHT.joblib | 1171599a5a4fb9f77f8932da29087272540cdbef892cc588d2c698220e00dd94 — matches policy |

Policy pair hash: `3aa51fffe01e36b1df7c190028932d3e8736dbef1aabb7717b59e8ba0e80aeed`. Manifest packaged subpaths include `TEMPORAL_HOLDOUT_2025/`, whereas this copy stores the same-hash files directly under RANDOM_FOREST_B. Original Phase C registry/config and auxiliary sensor tables refer to `D:/nasa_data/...`, unavailable here. Do not claim original model validation metrics were recovered. `/agnicalendar/provenance` returns `validation_metrics: null` with that reason. Existing prediction replay checks prove reproduction, not generalization accuracy. No training, inference rerun, model mutation or dataset regeneration occurred.

## Selection and baseline rules

Country: existing source-derived majority-vote grid-cell lookup, not fabricated administrative geometry. Missing lookup fails closed. Bbox/polygon: conservative projected-grid filter then cell-centre membership using existing Equal Earth/polygon code; boundary centres included. A clipped geographic shape does not fractionally allocate a cell count. Antimeridian polygons use existing longitude unwrapping and conservative world-spanning bbox. UI map polygon/place selections now propagate into Round 2 queries and CSVs.

Monthly comparison keeps layer, DN, fire type, AOI and exact reported version-population signature identical; excludes the target year, nonfinite/null totals and explicitly partial start months; requires five other years. No verified exposure dataset is present. Comparisons are therefore EXPLORATORY descriptive statistics on observed sparse records. Actual Bangladesh March 2025 Aqua-day comparison has only one matching other year and correctly returns null median/percentile. It does not manufacture a longer comparable baseline.

Physical evidence and benchmark: `reports/audit/dataset-inspection.json`; actual API results: `reports/audit/api-verification.json`.
