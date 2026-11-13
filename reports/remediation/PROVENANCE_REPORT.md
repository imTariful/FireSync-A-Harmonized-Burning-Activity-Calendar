# Provenance Report

**Date:** 2026-11-10
**Scope:** live NRT, local store, server ingestion, Python pipeline, checksums, reproducibility

---

## 1. Summary

| Dataset | Provenance status | Evidence |
|---|---|---|
| Live NRT world response (2026-11-09) | **VERIFIED** | Official NASA FIRMS Area API; cached response metadata; 0 source errors |
| Live NRT ingestion batch (2026-11-09, 31 records) | **VERIFIED** | 3 raw CSVs, SHA-256 per file, source manifest, completed job |
| Local store at startup | **UNVERIFIED** | Empty; no observation, archive or placeholder record is pre-seeded |
| Server NRT ingestion | **VERIFIED on success** | Raw CSV preserved, SHA-256, source manifest |
| Python pipeline downloads | **VERIFIED / PARTIAL / UNVERIFIED** | Source manifest + SHA-256 per file; status reflects failures |
| Bundled 30-observation archive | **REMOVED** | `src/data/nasa_firms_archive.ts` deleted on 2026-11-10; no runtime seed |
| FastAPI skeleton | Not applicable | Does not ingest data |

A SHA-256 checksum proves that the preserved bytes match the recorded digest. It does **not**
by itself prove NASA authenticity. Authenticity requires the official source URL, product
metadata and publication record.

---

## 2. Runtime local store

### What exists
- `src/server/store.ts` — in-memory store, optional JSON file persistence.
- Default state: **zero records**.
- `/health` reports `records_count: 0`, `storage_type: memory`, `durable: false`.
- `/data-availability` reports `local_store.data_status: "empty"` and
  `local_store.provenance_status: "UNVERIFIED"` with the reason:
  "The local store is empty. No observation, archive or placeholder record is pre-seeded."

### What is missing by design
- No bundled archive.
- No synthetic seed.
- No placeholder observations.
- No archive fallback in the frontend or API.

### Decision
The store remains empty until a completed real NASA FIRMS ingestion job adds records.
A record is marked `VERIFIED` only when it came through that real ingestion path. An empty
or mixed store stays `UNVERIFIED`; it is not promoted by association.

---

## 3. Live NRT provenance

`LiveFiresService` fetches the official FIRMS Area API for:

- `MODIS_NRT`
- `VIIRS_NOAA20_NRT`
- `VIIRS_NOAA21_NRT`

Only the rolling last 1–5 days are available. A request outside that window returns
`400 LIVE_WINDOW`; it is never converted into a shorter request or filled from an archive.

Live responses carry:

- `data_source: "live"`
- `provenance_status: "VERIFIED"`
- `retrieved_at`
- `cached`
- `source_errors`
- `truncated`

A failed source is listed in `source_errors`. If every source fails, the endpoint returns a
classified `502`; no observation is invented. The shared service caches identical requests
for 30 minutes, deduplicates in-flight requests and enforces a local rate budget.

The final 2026-11-09 world 1-day aggregate returned 103,131 detections (MODIS 7,073;
VIIRS 96,058) and 58,265 spatial-temporal bins with zero source errors.

---

## 4. Server ingestion provenance

When `FIRMS_MAP_KEY` is configured, `src/server/ingestion.ts`:

1. Requests each selected NRT product for a 1–5 day window.
2. Preserves the raw CSV under `data/raw/<product>/`.
3. Computes SHA-256 of the response and of the written file; a mismatch fails the job.
4. Writes `source_manifest.json` with:
   - product, bbox, day range, requested date;
   - masked URL, HTTP status, attempts, bytes, SHA-256;
   - retrieval timestamp and note.
5. Writes `checksums.json` for the preserved files.
6. Deduplicates by canonical record hash and records the real `records_imported` count.
7. Marks the job `VERIFIED` only when at least one download succeeded; failures remain
   explicit.

A job record never contains the MAP_KEY. Tests assert this.

### Verified NRT batch (2026-11-10)

| Product | Data rows | Bytes | SHA-256 |
|---|---:|---:|---|
| `MODIS_NRT` | 2 | 292 | `483591ff96bbed584fe0119fa8b26317b1fb5eb9c30ac248020b76432c52c1e8` |
| `VIIRS_NOAA20_NRT` | 12 | 1,111 | `7f26594fbe9a40d6ace7f35e3829219eda5651dddf6a4e12c1dfa76fa87bc66e` |
| `VIIRS_NOAA21_NRT` | 17 | 1,527 | `87b3ad1f01720f56a9295af876091c795d94e8cca93ba49790f7fdfaf0cc4714` |

Manifest checksum: `a77c56f289963faaa5df5b2f9e853539482b7c7f756777dd6fa615ca762489e8`.
Job: `completed`, `records_imported: 31`, `provenance_status: VERIFIED`.

An invalid-key run failed honestly with `records_imported: 0`, `checksum: null`, no raw
file and no manifest.

---

## 5. Python pipeline provenance

### Outputs
```
data/raw/<PRODUCT>/<start>_<end>.csv
data/raw/source_manifest.json
data/processed/canonical_observations.json
data/pipeline_jobs.json
reports/data_pipeline/<run_id>/manifest.json
reports/data_pipeline/<run_id>/quality_report.{json,md}
```

### Manifest fields
Each raw source entry records:
- product, bbox, window, date;
- path, SHA-256, bytes;
- masked source URL, HTTP status, attempts;
- retrieval timestamp;
- status (`downloaded`, `reused`, `missing`, `failed`);
- raw row count and error (if any).

### Checksum behaviour
- Existing raw files are reused only when their checksum matches the manifest.
- A mismatch is a hard failure; the file is not silently used or overwritten.
- `--force` re-downloads deliberately.
- The canonical output file's SHA-256 is recorded in the run manifest.

### Provenance statuses
| Status | Condition |
|---|---|
| `VERIFIED` | Usable raw files preserved and no source failed |
| `PARTIAL` | Some raw files preserved, at least one source failed |
| `UNVERIFIED` | No usable raw file |

---

## 6. Reproducibility procedure

1. Obtain the raw files from the official NASA FIRMS download service / Earthdata.
2. Place them at `data/raw/<PRODUCT>/<start>_<end>.csv`.
3. Run:
   ```bash
   python data_pipeline/run_pipeline.py \
     --start <start> --end <end> --products <products> \
     --raw-dir data/raw
   ```
4. Compare `data/processed/canonical_observations.json` SHA-256 with the manifest.
5. Inspect `quality_report.json` for accepted/rejected/duplicate counts and rejection reasons.
6. Keep the raw files, manifest and reports together.

The pipeline is deterministic for the same raw files and configuration, except for
timestamps in the report. Record hashes are derived from
`product|satellite|lat|lon|date|time`, not random values.

Offline evidence scripts require an explicit real observation store path. They exit with
code `2` and an explanation when no input is supplied; they never fall back to bundled
data.

---

## 7. What was verified here

- The local store starts empty and reports `UNVERIFIED` with an explicit reason.
- Live world NRT aggregation returned 103,131 detections on 2026-11-09 with zero source
  errors; the map response is capped and reports truncation.
- A historical live request returned `400 LIVE_WINDOW`; no archive fallback was used.
- Pipeline dry-run, empty-run and synthetic-fixture run behaved as documented.
- The server NRT path was exercised with a valid NASA key on 2026-11-10: 31 records, three
  preserved raw CSVs and 3/3 matching SHA-256 values. The job and manifest are `VERIFIED`.
- The first successful run exposed a metadata-ordering bug (`ingestion_log.json` recorded
  the `running` snapshot). It was fixed and the rerun confirmed the terminal state.
- The historical standard-science/Earthdata archive download was not run.

---

## 8. Required to claim historical provenance

1. Download the original historical NASA files from the official FIRMS download service /
   Earthdata.
2. Record source URLs, products, retrieval timestamps and file sizes.
3. Compute SHA-256 checksums and store a manifest.
4. Run normalization and compare record hashes/counts.
5. Keep the manifest with the data and reference it in the UI/API.
6. Only then describe the dataset as historical and `VERIFIED`.

Until then, there is no historical dataset, no archive fallback, and no claim of
historical coverage or NASA authenticity beyond the verified live NRT responses.
