# Data Pipeline

**Implementation:** `data_pipeline/run_pipeline.py`
**Dependencies:** Python 3.10+ standard library only (`urllib`, `csv`, `hashlib`, `json`)
**Status:** real download/validation pipeline; no fabricated jobs or checksums

---

## What it does

1. Splits an inclusive date range into FIRMS Area API-safe windows (default 5 days).
2. Optionally downloads each product × window from the official NASA FIRMS Area API.
3. Preserves every raw CSV on disk and records its SHA-256 in a source manifest.
4. Normalizes rows into the FireSync `CanonicalObservation` schema, rejecting malformed rows.
5. Writes a run manifest, a JSON quality report and a Markdown quality report.
6. Resumes safely: a completed product/window job is skipped when the raw file still matches
   its recorded checksum. `--force` re-downloads.

It does **not**:

- claim that zero downloaded files is a successful ingestion;
- fabricate checksums, record counts, quality flags or idempotency;
- use the FIRMS bulk archive/Earthdata download service. The Area API is limited to short
  windows; multi-year archives must come from the official download service and then be
  validated here.

---

## Commands

```bash
# Plan only: prints windows, makes no request and writes no file
python data_pipeline/run_pipeline.py \
  --region bangladesh --start 2024-01-01 --end 2024-01-12 --dry-run

# Download short windows (requires FIRMS_MAP_KEY in the server environment)
python data_pipeline/run_pipeline.py \
  --region bangladesh --start 2024-01-01 --end 2024-01-31 \
  --products MODIS_SP VIIRS_NOAA20_SP --download

# Validate/normalize existing raw files without network access
python data_pipeline/run_pipeline.py \
  --start 2024-01-01 --end 2024-01-31 \
  --products MODIS_SP --raw-dir data/raw

# Custom bbox instead of a named region
python data_pipeline/run_pipeline.py \
  --bbox 88,20.5,92.8,26.7 --start 2024-03-01 --end 2024-03-10 --download
```

`fetch_firms_data.py` is a deprecated compatibility wrapper that forwards to
`run_pipeline.py`. New work should call `run_pipeline.py` directly.

---

## Options

| Option | Default | Meaning |
|---|---|---|
| `--region` | `bangladesh` | Named region (`bangladesh`, `indochina`, `amazon_arc`, `california`) |
| `--bbox` | — | Custom `west,south,east,north`; overrides the named region |
| `--start`, `--end` | required | Real inclusive dates |
| `--products` | `MODIS_SP VIIRS_NOAA20_SP` | Any supported product id |
| `--window-days` | `5` | Days per request (1–10) |
| `--raw-dir` | `data/raw` | Preserved raw CSV directory |
| `--output-dir` | `data/processed` | Canonical output directory |
| `--reports-dir` | `reports/data_pipeline` | Report directory |
| `--queue-path` | `data/pipeline_jobs.json` | Durable JSON job queue |
| `--download` | off | Download missing windows from FIRMS |
| `--force` | off | Re-download even when a valid raw file exists |
| `--key-env` | `FIRMS_MAP_KEY` | Environment variable holding the MAP_KEY |
| `--timeout` | `60` | HTTP timeout seconds |
| `--max-retries` | `4` | HTTP attempts per window |
| `--min-interval` | `0.2` | Minimum seconds between requests |
| `--dry-run` | off | Print the plan only |

| Product | Sensor / platform | Processing |
|---|---|---|
| `MODIS_SP` | MODIS Terra / Aqua | Standard |
| `VIIRS_SNPP_SP` | VIIRS Suomi-NPP | Standard |
| `VIIRS_NOAA20_SP` | VIIRS NOAA-20 | Standard |
| `MODIS_NRT` | MODIS Terra / Aqua | NRT |
| `VIIRS_NOAA20_NRT` | VIIRS NOAA-20 | NRT |
| `VIIRS_NOAA21_NRT` | VIIRS NOAA-21 | NRT |

Availability depends on the official source and requested date, not this product list.
Use the [official source references](data/data-sources.md) and the availability endpoint;
advisory date ranges do not prove that a source contains observations.

Area API limits: **1–5 days per request for NRT** and **1–10 days for standard processing**.
The previous 30-day window design was invalid and has been removed.

---

## Outputs

```
data/raw/<PRODUCT>/<start>_<end>_aoi_<hash>.csv  preserved raw responses
data/raw/source_manifest.json            URL (masked), HTTP status, attempts, SHA-256, bytes
data/processed/canonical_observations.json
data/pipeline_jobs.json                  durable job queue
reports/data_pipeline/<run_id>/manifest.json
reports/data_pipeline/<run_id>/quality_report.json
reports/data_pipeline/<run_id>/quality_report.md
reports/data_pipeline/latest_manifest.json
reports/data_pipeline/latest_quality_report.{json,md}
```

The canonical output also records its own SHA-256 in the run manifest. Pipeline output is
**not** loaded into the Express runtime automatically. A file under `data/processed/` is a
pipeline artifact until it is explicitly ingested or imported; the local store remains
empty by default.

Raw files are written atomically. Reuse requires a matching manifest checksum; a mismatch
fails explicitly. Current downloads include the AOI hash in the filename so different
regions cannot share a cached response. The filename without that suffix is retained
for calls that do not supply a bbox to the path helper.

## Validation and security

Accepted rows require valid numeric coordinates inside the requested bbox, a real
acquisition date inside the request and source window, a valid UTC `HHMM` time,
non-negative FRP and scan/track dimensions, valid sensor-specific confidence and a
satellite identifiable from the row or product. Rejections carry explicit reasons in
the quality report. Source filename, record number, masked source URL, retrieval time
and record hash preserve provenance; records are deduplicated by a deterministic hash.

`FIRMS_MAP_KEY` is read from the environment. Stored URLs, job records and errors mask
the key. A missing key prevents download rather than producing a success report.
Never paste the key into a command, browser URL, recording or tracked file.

---

## Status semantics

| Status | Meaning |
|---|---|
| `completed` | At least one usable source and at least one accepted record; no failed/missing sources |
| `completed_empty` | Sources were usable but contained no accepted records (not treated as success with data) |
| `partial` | Some sources were usable, but at least one source failed or is missing |
| `failed` | No usable source at all |

Provenance:

| Status | Meaning |
|---|---|
| `VERIFIED` | Usable raw files were preserved and no source failed; checksums match recorded bytes |
| `PARTIAL` | Some raw files were preserved, but at least one source failed |
| `UNVERIFIED` | No usable raw file |

A SHA-256 checksum proves **file integrity**, not NASA authenticity. Use the official FIRMS
source and publication metadata for authenticity.

---

## Coverage

A date without a record is **not** a zero-fire day. It may reflect no overpass, cloud,
processing latency, a failed download or a genuinely fire-free day. The pipeline cannot
distinguish those causes and says so in every report.

MODIS and VIIRS counts are always reported separately. They are never summed into one fire
count.

---

## Verification

Use the [testing guide](testing/testing-strategy.md) for syntax checks, dry runs and
failure-path checks. The [dated NRT verification](../reports/remediation/FINAL_VERIFICATION_REPORT.md)
records a separate Express ingestion run with preserved raw CSVs and matching hashes;
it is not evidence that this Python command downloaded a multi-year archive.
Global parallel workers, Redis queues, PostgreSQL ingestion and automatic bulk archive
downloads are not implemented by this short-window pipeline.

---

## Historical archive pipeline (bulk FIRMS ZIPs)

Separate from `run_pipeline.py`: the 2000–2025 archive is built from official FIRMS
**download ZIPs** (not the Area API) placed in `Modis and Virs Data/` (gitignored).
Requires Python 3.13 + `duckdb`.

```bash
# On Windows call the interpreter directly — `py`/`python` may resolve to an
# interpreter without duckdb via the scripts' shebang.
PY="C:/Users/GIGRBYTE/AppData/Local/Programs/Python/Python313/python.exe"

"$PY" data_pipeline/import_historical.py --force     # ZIPs -> staging CSV.gz + manifest
"$PY" data_pipeline/build_historical_db.py           # staging -> obs + daily/monthly agg Parquet
"$PY" data_pipeline/build_climate.py                 # -> monthly climatology grids
"$PY" data_pipeline/build_agni_country.py            # -> AgniCalendar cell->country lookup
```

- `import_historical.py` is resumable via `data/historical/import_manifest.json`;
  `--force` reprocesses. `country_from_member` restores full multi-word country
  names from ZIP member filenames.
- `build_historical_db.py` deduplicates on the natural FIRMS key, writes
  `data/historical/parquet/{obs,agg}/`, retries per-file builds on Windows file
  locks, and merges `build_report.json` across partial/`--only` runs.
- `build_climate.py` writes `climate_{SENSOR}.parquet` (1-degree grid) and
  `climate_country_{SENSOR}.parquet` (country × day-of-year) used by the
  climatology and seasonal-status endpoints.
- Verified totals: MODIS 111,424,405 (2000-11-01→2025-12-31), VIIRS Suomi-NPP
  281,144,026 (2012-01-20→2025-12-31) = 392,568,431 deduplicated rows.

See [historical-archive.md](historical-archive.md) for coverage details and
[agnicalendar.md](agnicalendar.md) for the harmonized dataset.
