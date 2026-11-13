# CHANGES: FireSync সংশোধনের তালিকা

এই ফাইলে লেখা আছে কী বদলানো হয়েছে, কী যাচাই হয়েছে, আর কী এখনো বাকি।

## নতুন রাউন্ড: Global live NRT, no mock/archive runtime (2026-11-10)

**যাচাই (এই রাউন্ডে সত্যিই চালানো হয়েছে):** `npm run lint` পাস; `npm test` **422/422, 36 files, 0 failed, 0 skipped**; `npm run build` পাস; production server (`PORT=4173`, `NODE_ENV=production`) চালিয়ে live world endpoints যাচাই করা হয়েছে।

### কী বদলেছে
1. **Default area এখন `World`।** `src/utils/area.ts`-এ `WORLD_BBOX` ও ১০টি quick region (World প্রথমে)। পুরোনো Bangladesh-only default, archive coverage helper ও "No archive data for this area" message সরানো হয়েছে।
2. **Runtime-এ কোনো bundled/mock archive নেই।** `src/data/nasa_firms_archive.ts` মুছে ফেলা হয়েছে। `src/server/store.ts`-এর default seed এখন empty; শুধু completed real FIRMS ingestion job record যোগ করতে পারে। `/health` ও `/data-availability` এখন `local_store` দেখায়, `local_store_status` শুরুতে `UNVERIFIED`।
3. **Frontend live-only।** map ও সব non-map page `source=live` পাঠায়; live fail করলে archive fallback নেই, শুধু honest error/unavailable chip। `src/utils/dataSource.ts` থেকে archive decision সরানো হয়েছে। date presets 1/2/3/5 দিনের live window-এ সীমিত।
4. **এক shared live service।** `src/server/liveFires.ts` (`LiveFiresService`) `/api/v1/fires` এবং সব `source=live` endpoint-এর জন্য একই TTL cache, in-flight map ও rate budget ব্যবহার করে। `src/server/app.ts`-এ `resolveBaseObservations(req)` দিয়ে hotspots/calendar/analytics/exports live data পায়।
5. **World live data server-side aggregate + capped map overview।** Non-map pages live aggregate নেয়; map zoomed-out অবস্থায় `WORLD_OVERVIEW_CAP = 5000` per source সহ capped overview নেয় এবং `truncated` দেখায়। 2026-11-09-এ final world 1-day live aggregate মাপা হয়েছে **103,131 detections** (MODIS **7,073**, VIIRS **96,058**), **58,265** spatial-temporal bins।
6. **Historical request honestly rejected।** live NRT শুধু 1–5 দিন; এর বাইরের date range `400` + code `LIVE_WINDOW`, সাথে 5-day window-এর স্পষ্ট message। কোনো historical coverage claim নেই।
7. **Calibration আরও strict।** `evaluateCalibrationModel` in-sample diagnostic, তাই status এখন সবসময় `INSUFFICIENT`; `evaluateTemporalHoldout` শুধু সব explicit criterion পূরণ হলে `VALIDATED` দেয়। `R²` undefined হলে `null`, কখনো `0` নয়। `EXPLORATORY` শুধু harmonization layer-কে বোঝায়, calibration result-কে নয়।
8. **Offline evidence scripts explicit input ছাড়া চলে না।** `scripts/lib/load_observations.ts` real store/JSON path নেয়; input না থাকলে exit code `2` ও ব্যাখ্যা, bundled fallback নেই। `timeBetweenMinutes`-এর hardcoded `60` placeholder সরানো হয়েছে; এখন observed MODIS–VIIRS time difference থেকে হিসাব হয়, না থাকলে `null`।
9. **Docs/reports live/no-mock বাস্তবতার সাথে reconciled।** README, API reference, data schema/sources, architecture, limitations, test results ও remediation reports-এ 30-record runtime/archive claim সরানো বা historical snapshot হিসেবে চিহ্নিত করা হয়েছে।

### যাচাইয়ের ফল
- `GET /api/v1/health` → `healthy`, empty local store, `local_store_status: UNVERIFIED`, FIRMS key configured, `live_nrt_max_days: 5`.
- `GET /api/v1/fires?area=world&days=1&cap=5` → per-source minimum cap-এর কারণে `3,000` returned (MODIS `1,000`, VIIRS `2,000`), `truncated: true`, errors `0`; upstream aggregate total আলাদা endpoint-এ `103,131`।
- `GET /api/v1/hotspots?source=live&days=1&bbox=-180,-90,180,90&limit=5` → total `103,131`, returned `5`, `provenance_status: VERIFIED`, `truncated: false`, `live_area: world`.
- `GET /api/v1/calendar?source=live&days=1&bbox=...` → period `2026-11-09` to `2026-11-09`, 1 observed/active day, `cached: true`, errors `0`.
- `GET /api/v1/analytics/summary?source=live&days=1&bbox=...` → MODIS `7,073`, VIIRS `96,058`, bins `58,265`, completeness `null`, errors `0`.
- `GET /api/v1/analytics/calibration?source=live&days=1&bbox=...` → **`status: INSUFFICIENT`**, `independent_validation: false`, R² `0` (defined in-sample; not a validation claim). Restart-এর আগে এটি ভুলভাবে `EXPLORATORY` দেখাচ্ছিল; fix-এর পর যাচাই করা হয়েছে।
- `GET /api/v1/export/csv?source=live&days=1&bbox=...&dataset=modis` → `200`; metadata-তে `data_source,live`, `provenance_status,VERIFIED`, `cached,true`, `calibration_status,INSUFFICIENT`; কোনো `archive_provenance` নেই।
- Historical request (`start_date=2026-11-01`) → `400`, code `LIVE_WINDOW`, honest 5-day-window message.

### যা এখনো ব্লকড (সৎভাবে)
- **Historical standard-science archive download:** NRT Area API verified, কিন্তু FIRMS/Earthdata bulk historical ingestion চালানো হয়নি; historical coverage claim করা যাবে না।
- **Calibration:** `INSUFFICIENT`; কোনো validated model নেই। Live world data-তে paired cells থাকলেও সেগুলো in-sample, independent holdout নয়।
- **Docker:** image build/startup এই environment-এ চালানো হয়নি।
- **Browser E2E:** committed Playwright/Cypress suite নেই; iOS Safari unverified।
- **Security:** chat-এ share করা valid FIRMS key rotate করতে হবে। Ingestion endpoints-এ auth/rate limiting নেই।
- **Store durability:** `FIRESYNC_STORE_PATH` ছাড়া ingested records restart-এ হারিয়ে যায়।

> **Correction to the earlier round below:** that round described a bundled 30-observation archive and archive fallback. Both were removed on 2026-11-10. The old archive file no longer exists, and the runtime store no longer has a seed. Statements below about the bundled archive are historical changelog entries, not current behavior.

## পুরোনো রাউন্ড: Complete remediation — scientific honesty, provenance, AOI, real ingestion (2026-11-09)

**যাচাই (এই রাউন্ডে সত্যিই চালানো হয়েছে):** `npm run lint` পাস; `npm test` **422/422, 36 files, 0 failed, 0 skipped**; `npm run build` পাস (শুধু large-chunk ও `__dirname` warning); production API smoke test পাস; Python `py_compile` পাস, 12-day dry-run = 3 windows/no files, empty raw = `failed` exit 1, key ছাড়া `--download` = exit 2/no request, synthetic fixture = 2 accepted + 2 rejected with reasons.

**2026-11-10 live update:** a valid 32-character NASA FIRMS key was used to verify the NRT Area API. `POST /api/v1/ingestion/test-key` returned `valid: true`; `GET /api/v1/fires` returned 31 detections (MODIS 2, VIIRS 29, 0 errors); a real 1-day ingestion across `MODIS_NRT`, `VIIRS_NOAA20_NRT` and `VIIRS_NOAA21_NRT` completed with 31 records, 3 preserved raw CSVs and 3/3 matching SHA-256 values. `provenance_status` is `VERIFIED`. The historical standard-science/Earthdata archive download was **not** run.

### কী বদলেছে
1. **Fake ingestion সম্পূর্ণ সরানো।** `records_imported: 4`, random checksum, seeded job, placeholder success নেই। `FIRMS_MAP_KEY` না থাকলে `503 FIRMS_KEY_NOT_CONFIGURED`, কোনো job তৈরি হয় না। Job states: pending/running/completed/failed/cancelled; সবই real execution record.
2. **R² ও calibration সঠিক।** Zero variance / insufficient data-তে R² `null` (0 নয়)। `evaluateCalibrationModel` fixed coefficient in-sample diagnostic, কখনো `VALIDATED` নয়। `evaluateTemporalHoldout`-এ explicit criteria (≥30 train, ≥10 validation, temporal separation, non-zero variance, finite metrics)। Actual status **INSUFFICIENT**: 9 paired cells, R² null, holdout 6/3.
3. **Archive provenance UNVERIFIED।** 30-record bundled archive-এর raw NASA file/manifest/checksum নেই; `/health`, `/data-availability`, export ও UI-তে `UNVERIFIED` দেখায়। Checksum = file integrity, NASA authenticity নয়।
4. **Polygon AOI।** `src/utils/polygon.ts`: validation, boundary-inside point-in-polygon, bbox prefilter, antimeridian-safe ring, compact `aoi=lon,lat;...` URL state। Explorer draw/edit/clear; Overview/Calendar/Comparison/analytics/export একই AOI ব্যবহার করে। Invalid AOI = `400`.
5. **Calendar honesty।** শুধু observed dates emit হয়; missing dates zero নয়, dashed "no observation record"; `observation_coverage_pct` unknown হলে `null`; historical comparison opportunity না থাকলে `insufficient_history`।
6. **Real ingestion paths।** Express server: official FIRMS NRT Area API, 1–5 day window, raw CSV preservation, SHA-256, manifest, dedupe, key masking. Python pipeline: stdlib-only, configurable bbox/dates/products, 1–10 day windows, durable JSON queue, retry/resume, raw+manifest+quality reports, statuses completed/completed_empty/partial/failed.
7. **Storage ও API।** Express primary API; optional `FIRESYNC_STORE_PATH` JSON adapter (durable, but not PostGIS); production `server.ts` serves `dist/` and fails explicitly if build missing; FastAPI optional/experimental, `"database": "not integrated"`.
8. **Exports।** 8 separate exports; metadata rows include AOI, date range, sensors, provenance, processing version, harmonization/calibration status, BAU definition, coverage status; CSV formula sanitization preserved.
9. **Status consistency।** Health/data-availability calibration status now `INSUFFICIENT`; harmonization layer remains `EXPLORATORY`; validation panel heading uses actual status. `CALIBRATED`/`VALIDATED` শুধু documented criteria পূরণ হলে।
10. **Docs/reports।** `reports/remediation/`-এ 8টি report; README, CHANGES, API, pipeline, Docker, methodology, ingestion guide reconciled। পুরোনো `global-audit`, `test-results`, `test_inventory`, scientific-validation snapshot-এ superseded/reconciliation banner যুক্ত; stale test counts, 30-day window, active-PostGIS/Redis, GLM ও R²=0 claim সংশোধন।

### যা এখনো ব্লকড (সৎভাবে)
- **Real historical archive download:** NRT Area API verified (31 records), but the standard-science FIRMS/Earthdata archive download হয়নি; historical coverage claim করা যাবে না।
- **Calibration:** `INSUFFICIENT`; কোনো validated model নেই।
- **Docker:** image build/startup এই environment-এ চালানো হয়নি।
- **Browser/network:** GIBS tiles, iOS Safari, real live-FIRMS UI with the key unverified.
- **Security manual action:** chat-এ share করা valid FIRMS key rotate করতে হবে; Git history-তে পুরোনো `POSTGRES_PASSWORD: password` আছে, সেটি আর ব্যবহার করা যাবে না।

## নতুন রাউন্ড: এক Area, এক map, নতুন রঙ, মেঘের মতো fire (Explorer redesign)

**যাচাই (এই রাউন্ডে সত্যিই চালানো হয়েছে):** `npm run lint` পাস, `npm test` **392টা, ৩৯২টাই পাস**, `npm run build` পাস। `npm run dev` চালিয়ে Chromium (Playwright, software WebGL) দিয়ে 1440×900 ও 390×844-এ দেখা হয়েছে। সীমাবদ্ধতা নিচে "যা যাচাই করা যায়নি" অংশে।

### কী বদলেছে
1. **এক Area ব্যবস্থা।** নতুন `src/utils/area.ts` (`Area`, `areaFromQuickRegion`, `areaFromPlace`, `areaToScope`, `DEFAULT_AREA` = বাংলাদেশ)। App-এর state এখন `area`; `selectedRegionId` আর `filters.regionId`/`customBbox` নেই। Navbar থেকে region `<select>` ও "Hotspots" সংখ্যা সরানো। Region chip ও place search map-এ উড়ে যায় **এবং** App-এর area বদলায়; সক্রিয় chip হাইলাইট (`aria-pressed`)। Overview, Calendar, Comparison, Exports-এ "Area: নাম · Change on map" chip; archive-এ ওই area-র কোনো row না থাকলে স্পষ্ট ফাঁকা অবস্থা ("No archive data for this area in the loaded dataset. The bundled sample covers Bangladesh only.")। এই যাচাই date/sensor filter-নিরপেক্ষ (`limit=1`, শুধু bbox দিয়ে), তাই সরু filter-কে "dataset-এ নেই" ভাবা হয় না।
2. **এক map engine, দুই view।** `HotspotMap.tsx`, `DataMode`-এর archive/live-region/live-world, "Data source & export", `[&>*]:h-full!` hack, দ্বিতীয় legend মুছে ফেলা। "3D Globe | World map" toggle একই MapLibre instance-এ `setProjection` (globe/mercator)। World map north-up, ঘোরে না। `?view=map` URL-এ থাকে (globe default, লেখা হয় না)।
3. **Data source যুক্তি (`src/utils/dataSource.ts`, pure)।** আগে live চেষ্টা; ব্যর্থ বা খালি হলে চুপচাপ archive (বর্তমান area + FilterBar-এর তারিখসীমা) আর একটাই ছোট chip: "Live data unavailable, showing archive"। সার্ভারের কাঁচা error শুধু console-এ। Calendar "Inspect Day on Map": `pinnedDate` (App state), ওই দিনের archive detection-এ উড়ে যায়, ছাড়ার chip "Showing archive for {date} · Back to live"। পুরোনো `archiveRequest`/`filterSlot` সরানো।
4. **বাঁ panel এখন ৩ section:** Area, Map view, Detections। নিজের ভেতরেই scroll করে, কিছু কাটা পড়ে না। Toolbar: Area, Map view, Timeline, Harmonize, Share, Help।
5. **রঙ ও আকার (`src/utils/sensorStyle.ts`, একমাত্র উৎস)।** MODIS `#b81d3f` (crimson), VIIRS `#ff2d1a`, আংটি `#ffd0d8`। আকার = pixel footprint (MODIS 1 km, VIIRS 375 m): equal-area বৃত্ত ≈ 564 m / 212 m, zoom অনুযায়ী exponential, ন্যূনতম pixel floor (অনুপাত বজায় রেখে), তাই সব zoom-এ MODIS ≈ 2.7× বড়। FRP এখন শুধু মেঘের তীব্রতা ও inspector-এ। সাদা stroke বদলে গাঢ় স্বচ্ছ stroke; MODIS-এ হালকা আংটি।
6. **মেঘ ও বিন্দু (`src/components/explorer/fireLayers.ts`, pure)।** কম zoom-এ নরম heatmap মেঘ (zoom 6 পর্যন্ত পূর্ণ, 9-এ শেষ), `clusterMaxZoom` 7 (বিন্দু zoom 8 থেকে), বিন্দু 7.5→9-এ fade-in, বিন্দুর নিচে glow (২.২×, ০.২৫, blur ১)। দৃশ্যমান cluster বৃত্ত ও সংখ্যা নেই; cluster layer অদৃশ্য click target (opacity 0), মেঘে ক্লিক করলে zoom-in। সব threshold নামওয়ালা ধ্রুবক।
7. **Layout।** Attribution এখন নিচের একটা স্থায়ী strip (non-compact), toolbar/legend/panel সবই তার ওপরে (`--attr-h` CSS variable)। শুরুর globe panel ও নিচের stack বাদ দেওয়া খালি জায়গার মাঝে (camera padding + zoom 1.7/0.75)। Legend একটাই (`ExplorerLegend`)।

### আপনার brief-এর সঙ্গে কোডের গরমিল (যা পেয়েছি ও করেছি)
- Brief বলেছিল Exports "ইতিমধ্যে একই area ও sensor scope ব্যবহার করে"। **করত না:** archive CSV ও calendar CSV কোনো bbox পাঠাত না। এখন দুটোই `scope` (bbox + sensor) পাঠায়।
- Comparison page `getSensorComparison({})` ডাকত, area বা তারিখ ছাড়া। এখন area-র bbox ও FilterBar-এর তারিখ পাঠায় (server আগে থেকেই bbox মানে)।
- Comparison page-এর MODIS/VIIRS কার্ডে amber/cyan sensor রঙ ছিল (hex নয়, class); সেগুলোও বদলানো হয়েছে।

### সিদ্ধান্ত যা আমাকে নিতে হয়েছে
- **লেখা সবসময় neutral, রঙ বিন্দু/রেখা/ভরাটে।** `#b81d3f` গাঢ় পটভূমিতে ≈ 2.9:1, ছোট লেখার জন্য কম। তাই "MODIS" লেখা neutral, পাশে রঙিন বিন্দু (`SensorDot`)।
- **Live "খালি" হলে** chip-এর লেখা আলাদা: "No live detections here, showing archive" (live তো চলছিল, তাই "unavailable" বলা ভুল হতো)। শুধু live **error** হলে brief-এর হুবহু লেখা।
- **Zoom-out অবস্থায়** (live চাওয়া হয়নি) archive চুপচাপ দেখায় (chip ছাড়া, আগের "Zoom in to load live fires" pill থাকে); legend-এ উৎস লেখা থাকে ("Archive (bundled sample)" / "Live NASA FIRMS, last N days")।
- Area-তে archive না থাকলে (যেমন Amazon) fallback-এ chip বলে "Live data unavailable. No archive data for this area."
- `heatmap` layer-এর `maxzoom` 14 থেকে 9.5 করা হয়েছে (fade 9-এ শেষ, তাই কাটে না; খরচ কমে)।
- ছোট VIIRS বিন্দু বড় MODIS pixel-এর ভেতরে থাকলে ক্লিকে ওপরের (VIIRS) detection খোলে।
- `FilterBar`-এর `compact` prop এখন অব্যবহৃত, মুছিনি (নিরীহ)।
- পুরোনো `docs/HANDOFF-*.md` ইতিহাস হিসেবে রেখেছি (HotspotMap উল্লেখ আছে, এখন অপ্রাসঙ্গিক); `docs/data/attributions.md` হালনাগাদ করেছি।
- `filterValidation.test.ts`: `regionId` assertion বদলে এখন নিশ্চিত করে যে filter-এ region **নেই**।
- দুটো পুরোনো test (`TimelineBar`, `HarmonizedActivitySection`) পুরোনো hex খুঁজত; এখন `SENSOR_COLOR` থেকে নেওয়া রঙ খোঁজে এবং পুরোনো hex-এর অনুপস্থিতিও যাচাই করে।
- কোনো নতুন dependency যোগ করিনি।

### যা যাচাই করা যায়নি (সৎভাবে)
- **তিনটি basemap-এ রঙের পাঠযোগ্যতা।** এই পরিবেশে NASA GIBS/Esri tile লোড হয় না (নেটওয়ার্ক বন্ধ), তাই শুধু গাঢ় পটভূমিতে দেখা গেছে। Satellite ও Blue Marble-এর উজ্জ্বল মেঘ/স্থলের ওপর MODIS/VIIRS আলাদা চেনা যায় কি না আপনার পিসিতে দেখে নিন; না হলে `sensorStyle.ts`/`fireLayers.ts`-এর stroke ও আংটির ধ্রুবক বদলান।
- **কয়েক হাজার বিন্দুর performance।** Bundled sample-এ মাত্র ৩০টি detection; লোড-test করিনি। (Live data ছাড়া বড় data পাওয়া যায়নি।)
- **World map-এ আসল imagery** (tile ছাড়া শুধু projection, fire layer, camera, capture ও URL দেখেছি)। একই কারণে Capture PNG-র ভেতরের ছবির চেহারা দেখিনি, কিন্তু ফাইল তৈরি হয় (globe ও world map দু'ভাবেই)।
- **iOS Safari/বাস্তব ফোন।** শুধু Chromium 390px।
- Live fire (আসল FIRMS key দিয়ে) চালিয়ে দেখা হয়নি; key নেই, তাই live-ok পথ শুধু unit test-এ।

## যাচাইয়ের অবস্থা (সৎভাবে)

- `npm test`-এর সমতুল্য unit test: **305টা চালানো হয়েছে, ৩০৫টাই pass।** (`firmsHandler.test.ts` আর ৫টা React component test এই পরিবেশে চালানো যায়নি, কারণ `express` ও `lucide-react` ছিল না। আপনার পিসিতে `npm install && npm test` চালিয়ে দেখুন।)
- `tsc`: নতুন ও বদলানো ফাইলে কোনো type error নেই (dependency ছাড়া, শিথিল মোডে)। পুরোনো ২টা ফাইলে যে error দেখা গেছে (`HarmonizeDrawer.tsx`, `firmsHandler.ts:180`) সেগুলো আমার পরিবর্তনের আগেও ছিল।
- **যা করা হয়নি:** `vite build`, browser-এ চালিয়ে দেখা, server (`server.ts`) চালানো। তাই UI-র চেহারা, responsive আচরণ আর server route সরাসরি যাচাই হয়নি। আপনার পিসিতে `npm install && npm run dev` চালিয়ে একবার সব page ঘুরে দেখুন।

## ঠিক করা সমস্যা

### বিজ্ঞান/সংখ্যার সততা
| # | সমস্যা | সমাধান |
|---|---|---|
| B1 | App-এর default calibration "validated, R² 0.884, n=8" (বানানো সংখ্যা) | নিরপেক্ষ placeholder: `exploratory`, কোনো metric/period দাবি নেই। `evaluateCalibrationModel`-এ বানানো `training_period '2023-01…'` সরানো; limitation-এ n কম, reference variance শূন্য, holdout নেই লেখা হয়। |
| B2 | Anomaly: baseline-এ ফাঁকা দিন মিলিয়ে median=MAD=0, "z" ছিল কাঁচা পার্থক্য, দিনটা নিজের baseline-এ ছিল, ভবিষ্যৎ দিন "normal" | `applyHistoricalBaselines` নতুন করে লেখা: একই মাসের **অন্য বছর** থেকে baseline (ঐ দিনের বছর বাদ), কমপক্ষে **৩ বছর** না থাকলে `insufficient_data`, MAD=0 হলে Iglewicz–Hoaglin fallback, ভবিষ্যৎ দিন কখনো score হয় না। |
| — | ভবিষ্যৎ ৫৩ দিন "শান্ত দিন" হিসেবে সিরিজে ঢুকত | `buildDailySummariesFromCells` আজকের পরে আর দিন তৈরি করে না। |
| — | `observation_coverage_pct` সবসময় 100 | এখন `null` (অজানা)। CSV-তে ফাঁকা। |
| — | "Data Provenance 100%" KPI | KPI সরানো, "Days with detections" দেখায়। Server `null` পাঠায়। |
| — | Job record ২৪ (৮+১৬), আসলে ৩০ (৯+২১); satellite ভুল | Job record এখন data থেকেই হিসাব হয়। |

### Fake/ভুল আচরণ
| # | সমস্যা | সমাধান |
|---|---|---|
| B3 | "Trigger ingestion" সবসময় "৪টা record সফল" বলত, কিছুই আনত না | Server `501` + স্পষ্ট বার্তা; Settings-এ বোতাম বন্ধ ও ব্যাখ্যা। |
| B4 | CSV export-এ `sensors=HARMONIZED` গেলে ০ row | Explorer শুধু MODIS/VIIRS পাঠায়; server অচেনা sensor নাম উপেক্ষা করে (আর ০ row দেয় না)। |
| B5 | "Harmonized Calibration Mode" option কিছুই বদলাত না | Option সরানো। |
| B6 | MODIS + Suomi-NPP বাছলে নীরবে ০ result | Filter-এ লাল সতর্কতা। তারিখ উল্টো হলেও। |
| B7 | Calendar → "map-এ দেখো" কাজ করত না (globe date filter উপেক্ষা করে) | Calendar থেকে এলে Explorer archive mode-এ খোলে। |
| B8 | `FilterBar` Explorer-এর overlay-র নিচে ঢাকা পড়ত, panel-এ placeholder লেখা | `FilterBar` এখন Explorer panel-এর ভেতরে (compact), আলাদা করে ঢাকা পড়ে না। |
| B10 | Region বদলালে `filters.regionId` বদলাত না | একটাই `changeRegion` দুটোই বদলায়। |
| — | Calendar CSV-তে area ও sensor বাদ পড়ত (পর্দায় যা দেখা যায় তার সাথে মিলত না) | `scope` (bbox + sensor) পাস করা হয়। |
| — | Calendar-এ বছর হার্ডকোড `[2024, 2025, 2026]` | বছর data থেকে আসে (২০০০–আজ কাজ করবে)। |
| — | API ব্যর্থ হলে নীরবে পুরোনো সংখ্যা | লাল সতর্কতা ব্যানার; পুরোনো request-এর উত্তর উপেক্ষা। |
| — | Filter default `endDate = 2026-12-31` (ভবিষ্যৎ), preset হার্ডকোড | `endDate = আজ`; preset আজকের সাপেক্ষে। |

### Map-first ও নতুন যা যোগ হয়েছে
- **Default tab = Hotspot Explorer (map)।**
- **Overview থেকে দ্বিতীয় map সরানো।** KPI, timeseries, "unusual days", "এই মাস বনাম ইতিহাস" আর map-এ যাওয়ার CTA রাখা হয়েছে।
- **Calendar page-এ নতুন:** বছর × মাস heatmap (viridis, colour-blind safe, প্রতি ঘরে সংখ্যা লেখা, tooltip-এ MODIS/VIIRS আলাদা), আর **"চলতি মাস বনাম একই দিনগুলোর ঐতিহাসিক median"** কার্ড।
- `FilterBar` design token-এ আনা হয়েছে, label ও 44px touch target সহ।
- নতুন test: anomaly (৬), calendarStats (৫), filterValidation (৩), harmonization (৩)।

## এখনো বাকি (আমি পারিনি)

1. **আসল দীর্ঘমেয়াদি data (২০০০–আজ):** আমার network নেই। FIRMS archive নামিয়ে `data/processed/`-এ রাখুন, তারপর `DEFAULT_START_DATE` (`src/utils/filterValidation.ts`) `'2000-11-01'` করুন। এটা না হলে heatmap/anomaly/"মাস বনাম median" সব "insufficient history" দেখাবে। এটাই ঠিক আচরণ।
2. **Data থেকে calibration:** overlap-সময়ে অনুপাত শেখা, time-holdout, confidence interval। এখনো `0.294` তাত্ত্বিক ধ্রুবক।
3. **AOI আঁকা / lat-lon ইনপুট** (challenge-এ উল্লেখিত)।
4. বাকি page (`BurningCalendar` ভেতরের, `SettingsPage`, `ExportsPage`, `MethodologyPage`, charts, `HotspotMap`) এখনো raw `slate-*` রঙে। token-এ আনা বাকি।
5. দ্বিতীয় backend (FastAPI stub) ও `docker-compose`-এর hardcoded password।
6. `minConfidence`/`dayNight` filter-এর UI।
7. Event-এর আগে কাজ করা নিয়ে ২০২৬-এর নিয়ম যাচাই।
