# Configuration Guide

FireSync reads configuration from environment variables. `.env` is gitignored; `.env.example`
contains placeholders only. Never commit a real key.

---

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PORT` | no | `3000` | HTTP port for the Express server |
| `NODE_ENV` | no | `development` | `production` serves `dist/` statically and does not mount Vite |
| `FIRMS_MAP_KEY` | conditional | empty | Server-side NASA FIRMS MAP_KEY. Required for live fires and NRT ingestion. |
| `FIRMS_BASE_URL` | no | NASA production URL | Alternate FIRMS base URL for offline integration tests only; leave unset in production |
| `FIRESYNC_STORE_PATH` | no | empty (in-memory, starts empty) | Path to a durable JSON observation/job store |
| `DATABASE_URL` | no | empty | Reserved for future work. The app does **not** use PostgreSQL/PostGIS yet. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | no | — | Only for the optional `postgis` compose profile |
| `CORS_ORIGINS` | no | empty | Reserved; CORS is not enabled in this build |
| `GROQ_API_KEY` | conditional | empty | Server-only Groq key for `/api/v1/ai/*`. Never sent to the browser. |
| `GROQ_MODEL` | no | `openai/gpt-oss-120b` | Groq model id (must support tool calling) |
| `GROQ_API_BASE` | no | `https://api.groq.com/openai/v1` | OpenAI-compatible base URL override |
| `FIRESYNC_AI_ENABLED` | no | `false` | Set `true` to enable AI routes (still needs `GROQ_API_KEY`) |
| `FIRESYNC_HISTORICAL_ROOT` | no | `Modis and Virs Data` | FIRMS ZIP archive root read by `import_historical.py` |
| `FIRESYNC_HISTORICAL_STAGING` | no | `data/historical/staging` | Staging dir read/written by the historical pipeline |
| `FIRESYNC_HISTORICAL_PARQUET` | no | `data/historical/parquet` | Historical Parquet store root (server queries + builder output) |
| `FIRESYNC_HISTORICAL_OBS` | no | `<historical parquet root>/obs/sensor=*/year=*/data_*.parquet` | Optional input glob for the country-lookup builder; overrides the derived archive path |
| `FIRESYNC_AGNICALENDAR_PARQUET` | no | `Harmonized Data Set/AgniCalendar_Global_Harmonized_CellMonth/year=*/part-*.parquet` | AgniCalendar cell-month Parquet glob |
| `FIRESYNC_AGNI_CELL_COUNTRY` | no | `data/agnicalendar/cell_country.parquet` | Cell→country lookup built by `build_agni_country.py` |
| `FIRESYNC_WATCHLIST_PATH` | no | empty | Durable JSON path for watchlists/alerts |
| `FIRESYNC_WATCHLIST_INTERVAL_MINUTES` | no | scheduler default | Watchlist check interval |

---

## FIRMS_MAP_KEY

Request a free key: <https://firms.modaps.eosdis.nasa.gov/api/map_key>

```ini
FIRMS_MAP_KEY=your_key_here
```

Behaviour without a key:
- `GET /api/v1/fires` returns an explicit "not configured" response.
- `POST /api/v1/ingestion/trigger` returns `503` with `code: "FIRMS_KEY_NOT_CONFIGURED"`.
- `POST /api/v1/ingestion/test-key` returns `400`, `valid: false`, and makes no NASA request.
- The Python pipeline's `--download` mode exits with code 2 and writes nothing.

The key is only used server-side. It is masked in URLs stored in job records, manifests,
errors and logs. The browser never supplies or receives it.

If a key was ever committed or shared, rotate it through NASA FIRMS. `.env` is gitignored.
In the verification environment it contains a valid key that was shared in chat; treat that
key as exposed and rotate it before any public use.

---

## Storage

Default: in-memory (`storage_type: "memory"`, `durable: false`) and **empty at startup**.
There is no bundled seed or demo fixture. Data is lost on restart, and only a completed real
FIRMS ingestion job adds records.

Durable adapter:

```ini
FIRESYNC_STORE_PATH=./data/store/firesync_store.json
```

This is a plain JSON file adapter, **not** PostgreSQL/PostGIS. It preserves observations and
ingestion job records atomically (write-temp-then-replace) and still deduplicates by canonical
record hash.

PostGIS and Redis are available only as optional Docker Compose profiles. The application does
not read or write through them; `postgis_active` in `/health` is always `false`.

---

## Pipeline configuration

### Local data paths for a code-only upload

Run npm and pipeline commands from the repository root containing `package.json`.
Relative paths resolve from that working directory; absolute overrides may point to
datasets outside the checkout. Use forward slashes in `.env` path values to avoid
backslash escape ambiguity. No path needs a particular username or drive letter.

The default local layout is:

```text
data/historical/parquet/
  obs/sensor=<SENSOR>/year=<YYYY>/data_*.parquet
  agg/*.parquet
data/agnicalendar/cell_country.parquet
Harmonized Data Set/
  AgniCalendar_Global_Harmonized_CellMonth/year=<YYYY>/part-*.parquet
  deployment_policy.json  (optional local provenance)
```

`FIRESYNC_HISTORICAL_PARQUET` is a directory; `FIRESYNC_AGNICALENDAR_PARQUET`
is a file/glob, and `FIRESYNC_AGNI_CELL_COUNTRY` is a file. The country builder
checks its configured observation glob, not a different default folder. Its explicit
`FIRESYNC_HISTORICAL_OBS` override wins over the derived historical-root glob.

Large datasets and the real `.env` stay outside the source upload. Without those local
products, the server still starts and reports historical/monthly data unavailable.
Live observations independently require the server-side FIRMS key. Missing data does
not activate a synthetic fallback or establish zero fire.

The Python pipeline reads the key from the environment and uses filesystem paths:

```bash
FIRMS_MAP_KEY=... python data_pipeline/run_pipeline.py \
  --region bangladesh --start 2024-01-01 --end 2024-01-31 \
  --products MODIS_SP VIIRS_NOAA20_SP --download
```

See [Data Pipeline](../pipeline.md) for all options.

---

## Production

```bash
npm run build
NODE_ENV=production npm start
```

Production requires `dist/index.html`. The server exits with an explicit error if it is
missing; it does not fall back to Vite.
