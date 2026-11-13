# Data Coverage Report

**Date:** 2026-11-10
**Scope:** live NRT world coverage, local store, calendar semantics, historical pipeline

---

## 1. Summary

| Dataset | Days with observations | Observations | Provenance | Verified historical coverage |
|---|---|---|---|---|
| Live NRT world (2026-11-09) | 1 | 103,131 (7,073 MODIS, 96,058 VIIRS) | `VERIFIED` | NRT only, **not historical** |
| Local store at startup | 0 | 0 | `UNVERIFIED` (empty) | **0 days** |
| Server NRT ingestion | 1 (2026-11-09) | 31 (2 MODIS, 29 VIIRS) | `VERIFIED` | NRT only, **not historical** |
| Python historical pipeline | 0 executed | 0 | Not applicable | 0 |

The Express NRT Area API path was exercised with a valid NASA key on 2026-11-10: 31
records, three preserved raw CSVs and matching SHA-256 values. This is near-real-time data,
not a verified historical standard-science record. The Python historical pipeline was
exercised only with dry-run, empty-directory and synthetic-fixture checks; its real archive
download has not been run. The old 30-observation bundled demonstration archive was removed
on 2026-11-10.

---

## 2. Live NRT coverage

### 2.1 World 1-day aggregate

| Metric | Value |
|---|---:|
| Total observations | 103,131 |
| MODIS observations | 7,073 |
| VIIRS observations | 96,058 |
| Distinct dates | 1 (2026-11-09) |
| Spatial-temporal 1 km cells | 58,265 |
| Concurrent MODIS+VIIRS cells | 2,034 |
| Data source | live NASA FIRMS NRT |
| Source errors | 0 |
| Coverage completeness | `null` (unknown) |

This is a single day of near-real-time detections. It is **not** a complete global fire
record: clouds, overpass gaps, quality filtering and the 1–5 day NRT window all affect what
is observed.

### 2.2 Per-sensor separation

MODIS and VIIRS counts are reported separately. The raw total (103,131) is the sum of two
sensor detection counts, not a harmonized fire count. The harmonized index is a separate
exploratory quantity.

### 2.3 Map cap

The map requests a capped world overview (`WORLD_OVERVIEW_CAP = 5000` per source) and
labels it. `/api/v1/fires` enforces a minimum cap of 1,000 per source; a world request with
`cap=5` returns 3,000 detections and `truncated: true`. Complete counts are available from
the aggregate endpoints, not from the capped map payload.

---

## 3. Calendar and missing-data semantics

The corrected implementation follows these rules:

1. `buildDailySummariesFromCells` emits only dates that have at least one observed
   detection. Each emitted day carries `coverage_status: 'observed'`.
2. Missing dates are **not** emitted as zero rows. The calendar renders them distinctly
   (dashed / "no observation record"), not as quiet days.
3. `observation_coverage_pct` is `null` when coverage cannot be established. It is never
   defaulted to 100%.
4. Historical medians use eligible observation opportunities, not arbitrary calendar days.
   When opportunities cannot be established, the comparison returns `insufficient_history`.
5. The calendar export emits observed days only and states `missing_dates: not emitted;
   missing is not zero` in its metadata.
6. A date with a record is a confirmed detection, not proof that the whole day or region
   was observed.
7. Live calendar responses state that NRT covers only the rolling last 5 days.

This prevents the most dangerous error in fire analytics: interpreting absence of a record
as absence of fire.

---

## 4. Observation-opportunity coverage

| Requirement | Status |
|---|---|
| Satellite overpass schedule per cell | Not available |
| Cloud/quality mask per overpass | Not available |
| Zero-detection observation opportunities | Not available |
| Sensor-specific footprint and scan geometry | Partially documented, not used as an opportunity model |
| Co-detection vs single-sensor detection | Co-detections counted; single-sensor cells counted separately |
| Non-detection cells | Not represented |

The live world batch contains 2,034 co-detection cells. It does not include cells where one
sensor detected a fire and the other did not, nor observation opportunities with zero
detections. Historical medians and anomaly baselines must therefore remain conditional on
the observed dates, and any comparison that requires a complete opportunity set must return
`insufficient_history`.

---

## 5. Historical ingestion pipeline coverage

### 5.1 Implemented capabilities

`data_pipeline/run_pipeline.py` supports:

- configurable region (`bangladesh` default) or custom `--bbox west,south,east,north`;
- configurable `--start` and `--end` dates;
- product selection (`MODIS_SP`, `VIIRS_SNPP_SP`, `VIIRS_NOAA20_SP`, `MODIS_NRT`,
  `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`);
- 1–10 day windows (default 5; NRT 1–5);
- `--download` or validation-only mode;
- `--force` re-download;
- durable local JSON job queue with `pending`, `running`, `completed`, `failed`,
  `cancelled`;
- retry/backoff and resume;
- raw-file preservation under `data/raw/<product>/<start>_<end>.csv`;
- SHA-256 checksums, source manifests and quality reports;
- canonical normalization with explicit rejection reasons;
- statuses `completed`, `completed_empty`, `partial`, `failed`;
- provenance `VERIFIED`, `PARTIAL`, `UNVERIFIED`.

### 5.2 What was actually executed

| Check | Result |
|---|---|
| `python -m py_compile` on pipeline modules | PASS (exit 0) |
| Dry-run 2024-01-01..2024-01-12 | 3 five-day windows, 2 products, no request, no file |
| Empty raw directory | `failed`, exit 1 |
| `--download` without `FIRMS_MAP_KEY` | Exit 2, no request, no report presented as a run |
| Synthetic fixture | 2 accepted, 2 rejected with explicit reasons |
| Server NRT Area API (real key) | 31 records, 3 raw CSVs, 3/3 SHA-256 match, `VERIFIED` |
| Live world NRT aggregate | 103,131 detections, 58,265 bins, 0 source errors |
| Python historical archive download | **NOT RUN** — NRT key works; standard-science/Earthdata bulk download not executed |

### 5.3 Current data directory

```
data/processed/canonical_observations.json   (23,708 bytes)
```

There is **no** `data/raw/` tree, no `source_manifest.json`, no `checksums.json`, and no
pipeline run report for this processed file. It is a legacy output; without its raw inputs
and manifest it cannot be treated as verified. The local runtime store is empty and this
processed file is not loaded automatically.

### 5.4 Product availability notes

The pipeline queries NASA for availability and treats the official response as
authoritative. Approximate mission starts (not a guarantee of FIRMS product availability):

| Product family | Approximate start |
|---|---|
| MODIS Terra | November 2000 |
| MODIS Aqua | July 2002 |
| VIIRS Suomi-NPP | January 2012 |
| VIIRS NOAA-20 | 2018 |
| VIIRS NOAA-21 | Where supported by the relevant archive/product |

The server's live NRT products are `MODIS_NRT`, `VIIRS_NOAA20_NRT` and
`VIIRS_NOAA21_NRT`. Suomi-NPP is supported as a standard-processing archive product, not
as a current server live product. The Area API is not a bulk historical archive service;
multi-year work must use the official FIRMS download service / Earthdata and then run the
pipeline in validation-only mode.

---

## 6. Coverage status vocabulary

| Status | Meaning |
|---|---|
| `observed` | At least one detection was recorded on that date/cell |
| `missing` | The date/cell is inside the requested range but has no record; cause unknown |
| `unknown` | Coverage cannot be established from the available metadata |
| `incomplete` | Some sources or dates are missing from an otherwise usable archive |

The UI must show `missing` and `unknown` distinctly from zero activity. It must not colour
them as quiet days.

---

## 7. What is needed for real historical coverage

1. Configure `FIRMS_MAP_KEY` server-side.
2. Run the pipeline with official standard-science products, preserving raw files and
   manifests.
3. Record product availability responses and download failures per window.
4. Add an observation-opportunity dataset (overpass, cloud/quality) before computing
   historical medians or sensor sensitivity.
5. Repeat across multiple seasons and years; a single day cannot represent a fire season.
6. Publish the coverage report with every dataset and mark unverified data explicitly.

Until then:

- verified historical coverage = **0 days**;
- live NRT coverage = **1 day** (rolling 1–5 days available on request);
- the runtime local store = **0 records**;
- missing dates are **not zero**;
- calibration remains `INSUFFICIENT`.
