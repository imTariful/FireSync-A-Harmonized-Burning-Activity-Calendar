# Deployment Guide

This guide describes what the current code actually supports and what remains future work.
It does not claim a production database, queue or global archive that is not implemented.

---

## Current deployment reality

| Component | Current state |
|---|---|
| Application | Express API + built React frontend, one Node process |
| Frontend serving | Vite middleware in development; static `dist/` in production |
| Default area | World |
| Live data | Official NASA FIRMS NRT Area API, rolling 1–5 days, shared server cache |
| Storage | In-memory, **empty at startup**; optional JSON file adapter (`FIRESYNC_STORE_PATH`) |
| PostgreSQL/PostGIS | **Not integrated.** Optional compose profile only. |
| Redis | **Not used.** The Python queue is a local JSON file. |
| Server ingestion | Real FIRMS NRT Area API (1–5 day windows) when `FIRMS_MAP_KEY` is set |
| Historical ingestion | Python pipeline + official FIRMS download/Earthdata files; not yet run |
| Auth / multi-tenancy | Not implemented |
| Horizontal scaling | Not implemented; the JSON store is single-process |

This is suitable for a local demo or a single small VM. It is not a validated global
production deployment. The map uses a capped world overview; non-map pages use server-side
aggregates so ~100k world detections are not shipped to the browser repeatedly.

---

## Production build

Use the [README production commands](../../README.md#checks-and-production-startup)
for the maintained build/start sequence in PowerShell and macOS/Linux, and its
[quick start](../../README.md#quick-start) for Node prerequisites and configuration.

`server.ts` serves `dist/` and returns `index.html` for non-API GET routes. If
`dist/index.html` is missing, startup exits with a clear error. Vite is not loaded in
production.

Health check:

```bash
curl -s http://localhost:3000/api/v1/health
```

The response truthfully reports storage kind/durability, **local store** provenance and
whether the FIRMS key is configured. It does not report a bundled archive.

Live world check (requires a configured key):

```bash
curl -s "http://localhost:3000/api/v1/hotspots?source=live&days=1&bbox=-180,-90,180,90&limit=5"
```

A historical live request returns `400` with code `LIVE_WINDOW`; there is no archive
fallback.

---

## Docker

The multi-stage `Dockerfile` builds the frontend and runs Express with
`NODE_ENV=production`:

```bash
docker build -t firesync .
docker run --rm -p 3000:3000 \
  -e FIRMS_MAP_KEY="" \
  -e FIRESYNC_STORE_PATH=/app/data/store/firesync_store.json \
  -v firesync_data:/app/data \
  firesync
```

Open http://localhost:3000. The image serves the built `dist/` frontend; it never mounts
Vite and fails explicitly if the build is absent.

### Compose profiles

`POSTGRES_PASSWORD` has no default. Set it explicitly in the shell before running
Compose; the configuration contains a required-variable expression and fails when
it is unset. This does not enable the optional PostGIS profile.

```bash
# App only
docker compose up --build

# Optional containers; neither is integrated into the application
docker compose --profile postgis up
docker compose --profile redis up
```

| Service | Required | Used by the app? | Notes |
|---|---|---|---|
| `app` | yes | yes | Express + built frontend; healthcheck on `/api/v1/health` |
| `postgis` | no | no | Optional profile; requires explicit `POSTGRES_PASSWORD` |
| `redis` | no | no | Optional profile; the Python queue is a local JSON file |

### Container verification

Image build and container startup remain unverified in this environment. On a host
with a running Docker daemon, run the build/run commands above, then request
`http://localhost:3000/api/v1/health`. Use the README production commands to check
the same static-serving path outside Docker.

---

## Environment

| Variable | Notes |
|---|---|
| `PORT` | Default 3000; Docker run maps host 3000, while Compose uses `${PORT:-3000}` on the host |
| `NODE_ENV=production` | Required for static serving |
| `FIRMS_MAP_KEY` | Server-side secret; rotate if exposed |
| `FIRMS_BASE_URL` | Optional alternate FIRMS endpoint for offline tests only; leave unset in production |
| `FIRESYNC_STORE_PATH` | JSON file path; Compose uses `/app/data/store/firesync_store.json` and mounts `/app/data` |
| `DATABASE_URL` | Reserved; not used by the app |

Never bake secrets into an image or commit `.env`.

---

## Persistence and backup

If `FIRESYNC_STORE_PATH` is set, back up that JSON file. Writes are atomic
(temp-file-then-replace), but there is no multi-process locking. Do not run multiple app
replicas against the same file. Without it, the store is memory-only and **starts empty on
every restart**; ingested observations disappear.

Live NRT responses are cached in process memory for a short period and are not written to
the store unless an ingestion job is explicitly run.

Raw pipeline files and manifests under `data/raw/` and `reports/data_pipeline/` should be
backed up separately. A SHA-256 checksum proves integrity of the preserved bytes, not NASA
authenticity.

---

## Operational checks

```bash
curl -s /api/v1/health
curl -s /api/v1/data-availability
curl -s /api/v1/ingestion/jobs
curl -s "/api/v1/hotspots?source=live&days=1&bbox=-180,-90,180,90&limit=5"
```

- `api_configured: false` means live data and ingestion are intentionally disabled.
- `storage_type: "memory"` means data will be lost on restart.
- `local_store_status: "UNVERIFIED"` with `total_records: 0` means the store is empty. That
  is not a zero-fire claim.
- `live_nrt_max_days: 5` means only the rolling last 5 days are available.
- A failed ingestion job has `status: "failed"`, `records_imported: 0` and `checksum: null`.
- A historical `source=live` request returns `400` with code `LIVE_WINDOW`.

---

## Future scaling (not implemented)

The following are design directions, not current capabilities:

- PostgreSQL + PostGIS storage adapter with migrations
- Multi-process job execution with a real queue
- Object storage for raw FIRMS archives
- Authentication and per-user rate limits
- Multi-year bulk archive ingestion via the official FIRMS download service
- Independent calibration/validation with enough paired cells
- Load benchmarking for world live aggregates (~100k detections per day)

Do not describe these as active until they are implemented and tested.
