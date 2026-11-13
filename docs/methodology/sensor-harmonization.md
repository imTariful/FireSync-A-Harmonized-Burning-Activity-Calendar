# FireSync — Scientific Harmonization Methodology & Mathematical Specification

**Project:** FireSync — Harmonized Fire Activity Intelligence  
**Competition:** NASA Space Apps Challenge 2026  
**Team:** BOT Battalion  
**Challenge:** Harmonization of MODIS and VIIRS Hot Spots  
**Version:** 1.2.0 (Post-Audit Verification Release)  

---

## 1. Official Data Sources & Product Identifiers

FireSync is grounded in authoritative satellite Earth-observation thermal anomaly products from the NASA Fire Information for Resource Management System (FIRMS) and MODAPS EOSDIS:

1. **MODIS Collection 6.1 (Terra & Aqua):**
   - **Product Identifiers:** `MODIS_C6_1` (Archive) / `MOD14` (Terra) / `MYD14` (Aqua)
   - **Sensor:** Moderate Resolution Imaging Spectroradiometer (36 spectral bands)
   - **Nominal Resolution:** 1.0 km at nadir; off-nadir expansion up to $2.0\text{ km} \times 4.8\text{ km}$ at scan edges (bow-tie effect).
   - **Detection Bands:** Band 21 / 22 ($3.96\,\mu\text{m}$, high/low saturation) and Band 31 ($11.0\,\mu\text{m}$).
   - **Temporal Coverage:** 2000-11-01 to Present (Terra); 2002-07-04 to Present (Aqua).
   - **Overpass Times:** Terra (~10:30 AM / 10:30 PM local solar time); Aqua (~13:30 PM / 01:30 AM local solar time).

2. **VIIRS 375 m Active Fire (Suomi-NPP & NOAA-20):**
   - **Product Identifiers:** `VIIRS_SNPP_NRT` / `VNP14IMGTDL_NRT` and `VIIRS_NOAA20_NRT` / `VJ114IMGTDL_NRT`
   - **Sensor:** Visible Infrared Imaging Radiometer Suite
   - **Nominal Resolution:** 375 m at nadir; onboard 3-to-1 pixel aggregation maintains resolution $<800\text{ m}$ at scan edges.
   - **Detection Bands:** Band I4 ($3.74\,\mu\text{m}$) and Band I5 ($11.45\,\mu\text{m}$) high-resolution imagery channels.
   - **Temporal Coverage:** 2012-01-20 to Present (Suomi-NPP); 2018-01-01 to Present (NOAA-20).
   - **Overpass Times:** Suomi-NPP (~13:30 PM / 01:30 AM); NOAA-20 (~12:40 PM / 00:40 AM, flying 50 minutes ahead of S-NPP).

3. **Current Live Data Window:**
   - **Study Area:** World (default), with preset regions available in the Explorer.
   - **Live Products:** `MODIS_NRT`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`.
   - **Temporal Coverage:** rolling last 1–5 days. The final world aggregate covered one
     observed day (2026-11-09).
   - **Historical Archive:** local Parquet store built from official FIRMS download
     ZIPs via `data_pipeline/` (MODIS 2000-11→2025, VIIRS SNPP 2012-01→2025);
     gitignored, so absent on a fresh clone until the pipeline runs. The old
     2024-03-15 to 2026-03-22 demonstration archive was removed on 2026-11-10.

---

## 2. Canonical Observation Schema

Every ingested satellite record is normalized into an immutable, type-safe representation preserving raw provenance:

| Field | Type | Description | Provenance Rule |
|---|---|---|---|
| `id` | `string` | Deterministic system identifier | `firms-{sensor}-{date}-{hash}` |
| `source_record_id` | `string` | Original upstream NASA identifier | Preserved from raw source CSV |
| `latitude` | `float` | Geographic latitude (WGS84, degrees) | Validated within study bounds |
| `longitude` | `float` | Geographic longitude (WGS84, degrees) | Validated within study bounds |
| `acq_date` | `string` | Acquisition date (`YYYY-MM-DD`) | ISO 8601 calendar format |
| `acq_time` | `string` | Acquisition time (`HHMM`) | UTC satellite overpass minute |
| `datetime_utc` | `string` | Full UTC timestamp | Combined date & time ISO 8601 |
| `sensor` | `enum` | Sensor instrument: `MODIS` or `VIIRS` | Primary discriminator |
| `satellite` | `enum` | Spacecraft: `Terra`, `Aqua`, `Suomi-NPP`, `NOAA-20` | Orbit platform |
| `product` | `string` | NASA dataset product name | Collection / processing level |
| `confidence` | `mixed` | Numeric (0–100%) or categorical (`low`, `nominal`, `high`) | Preserved in original type |
| `confidence_category` | `enum` | Unified level: `low` (<30%), `nominal` (30–79%), `high` ($\ge 80\%$) | Standardized cross-sensor |
| `frp_mw` | `float` | Fire Radiative Power in Megawatts (MW) | Primary energy metric |
| `bright_ti4` / `brightness` | `float` | Mid-infrared 4 $\mu$m brightness temperature (Kelvin) | Thermal intensity |
| `bright_ti5` | `float` | Thermal infrared 11 $\mu$m brightness temperature (Kelvin) | Background reference |
| `scan` / `track` | `float` | Along-scan and along-track pixel dimensions in km | Optical geometry |
| `daynight` | `enum` | Day (`D`) or Night (`N`) overpass | Solar illumination |
| `record_hash` | `string` | Cryptographic SHA-256 fingerprint (first 16 hex digits) | Ingestion deduplication key |

---

## 3. Spatial Framework: Cylindrical Equal-Area Projection

To prevent distortion from naive latitude/longitude degree bins (which shrink dramatically poleward), FireSync projects geographic coordinates onto an equal-area planar coordinate system.

### 3.1 Mathematical Formulation
For geographic coordinates $(\phi, \lambda)$ in radians with standard parallel $\phi_0 = 23.5^\circ\text{N}$ (Tropic of Cancer) and central meridian $\lambda_0 = 0$:

$$x = R \cdot (\lambda - \lambda_0) \cdot \cos(\phi_0)$$

$$y = \frac{R \cdot \sin(\phi)}{\cos(\phi_0)}$$

Where:
- $R = 6371.0088\text{ km}$ (IUGG authalic sphere mean radius).
- $\phi_0 = 23.5^\circ = 0.410152374\text{ rad}$ ($\cos(\phi_0) \approx 0.917060074$).

### 3.2 Inverse Projection Formulation
Given projected coordinates $(x, y)$ in kilometers:

$$\phi = \arcsin\left(\frac{y \cdot \cos(\phi_0)}{R}\right)$$

$$\lambda = \lambda_0 + \frac{x}{R \cdot \cos(\phi_0)}$$

### 3.3 1-km Equal-Area Grid Indexing
Grid indices $(i, j)$ and unique cell key are computed via floor division with cell size $d = 1.0\text{ km}$:

$$i = \left\lfloor \frac{x}{d} \right\rfloor, \quad j = \left\lfloor \frac{y}{d} \right\rfloor$$

$$\text{cell\_id} = \text{cell}\_{i}\_{j}$$

Cell center coordinates $(x_c, y_c)$ for inverse mapping:

$$x_c = (i + 0.5) \cdot d, \quad y_c = (j + 0.5) \cdot d$$

---

## 4. Scientific Harmonization: Burning Activity Units (BAU)

### 4.1 Target Definition & Scientific Scope
Harmonization does **NOT** claim that MODIS and VIIRS observed the identical physical combustion flame or that detections equal unique wildfire incidents. Rather, the objective is to establish a **dimensionless, sensor-harmonized fire activity indicator** over a common spatial-temporal support ($1\text{ km} \times 1\text{ km} \times 1\text{ day}$).

### 4.2 The Sensor Disparity Problem
Due to VIIRS's $375\text{ m}$ nadir footprint and onboard pixel aggregation (maintaining $<800\text{ m}$ at scan edges vs MODIS's $2.0 \times 4.8\text{ km}$ bow-tie expansion), VIIRS detects fires down to $3 - 5\text{ MW}$, whereas MODIS Collection 6.1 typically requires $10 - 20\text{ MW}$. Consequently, VIIRS records approximately $3.4\times$ more hotspot detections than MODIS over equivalent fire regimes (Schroeder et al., 2014; Giglio et al., 2016).

### 4.3 Calibration Formula
For grid cell $(i, j)$ on day $t$:

$$\text{BAU}_{i,t} = \begin{cases}
0.5 \cdot N_{\text{MODIS}} + 0.5 \cdot (\beta \cdot N_{\text{VIIRS}}) + \gamma \cdot \ln(1 + \text{FRP}_{\text{total}}) & \text{if concurrent } (N_{\text{MODIS}} > 0 \land N_{\text{VIIRS}} > 0) \\
N_{\text{MODIS}} + \gamma \cdot \ln(1 + \text{FRP}_{\text{MODIS}}) & \text{if MODIS-only } (N_{\text{MODIS}} > 0) \\
\beta \cdot N_{\text{VIIRS}} + \gamma \cdot \ln(1 + \text{FRP}_{\text{VIIRS}}) & \text{if VIIRS-only } (N_{\text{VIIRS}} > 0)
\end{cases}$$

Where:
- $\beta = 0.294 = \frac{1}{3.4}$: **Fixed exploratory assumption** from the literature, used to scale VIIRS 375 m counts toward a 1-km MODIS-equivalent baseline. It is **not** a fitted Bangladesh coefficient and has not been validated.
- $\gamma = 0.005$: Logarithmic energy regularizer incorporating Fire Radiative Power (MW) without allowing high-intensity fires to distort spatial activity metrics. This is also a fixed, exploratory choice.
- Output units: Dimensionless 1-km Equivalent Burning Activity Units (BAU). The index is exploratory and must not be reported as a validated physical quantity.

---

## 5. Temporal Holdout Diagnostic (Not Validation)

### 5.1 Experimental Setup
The temporal split is a diagnostic that can only become validation when every explicit criterion
is met. It is not described as valid merely because it runs.
- **Current live world run (2026-11-09):** 1,423 training cells / 611 validation cells from a single day.
- **Temporal separation:** fails because every observation shares one date.

Required for `VALIDATED`: ≥30 training paired cells, ≥10 independent validation paired cells,
strict temporal separation, non-zero reference variance and finite metrics. The single-day live
batch meets the size minimums but not temporal separation.

### 5.2 Evaluation Metrics
For $N$ held-out paired spatial-temporal cells with observed reference $y_k$ (MODIS 1-km count) and calibrated prediction $\hat{y}_k = \alpha + \beta \cdot N_{\text{VIIRS}, k}$:

$$\text{MAE} = \frac{1}{N} \sum_{k=1}^N \left| \hat{y}_k - y_k \right|$$

$$\text{RMSE} = \sqrt{\frac{1}{N} \sum_{k=1}^N \left( \hat{y}_k - y_k \right)^2}$$

$$\text{Mean Bias} = \frac{1}{N} \sum_{k=1}^N \left( \hat{y}_k - y_k \right)$$

$$R^2 = 1 - \frac{\sum_{k=1}^N (y_k - \hat{y}_k)^2}{\sum_{k=1}^N (y_k - \bar{y})^2}$$

### 5.3 Current Diagnostic Result (live world, 2026-11-09)
- **Paired 1-km cells:** 2,034 in-sample; holdout split 1,423 training / 611 validation
- **In-sample fixed-coefficient diagnostic:** MAE $0.5544$, RMSE $0.7078$, bias $-0.2091$
- **Coefficient of Determination ($R^2$):** $0$ in-sample; $0.0127$ on the same-day holdout split
- **Temporal holdout status:** `INSUFFICIENT`
- **Independent validation:** `false` — all observations are from one day

The split sizes are adequate, but a single day cannot satisfy strict temporal separation. The
holdout error metrics do not override that failed criterion. The status remains `INSUFFICIENT`
and the value must not be reported as validation.

> **Provenance:** live NRT responses are `VERIFIED` as official NASA FIRMS responses. They are
> not a standard-science historical archive, and the local store is empty at startup. Treat
> every calibration number here as a diagnostic, not a scientific validation result.

---

## 6. Historical Seasonal Baseline & Robust Anomaly Scoring

### 6.1 Non-Parametric Dispersion (Median & MAD)
Because active fire distributions exhibit extreme right-skewness and zero-inflation, parametric Gaussian statistics ($\mu \pm 2\sigma$) produce biased baselines. FireSync employs non-parametric seasonal Medians and Median Absolute Deviation (MAD):

$$\text{Median}(X) = \text{middle element of sorted } X$$

$$\text{MAD} = \text{Median}\left( \left| X_k - \text{Median}(X) \right| \right)$$

### 6.2 Robust Standardized Z-Score
For observed daily activity $x_t$ in calendar month $m$:

$$Z_{\text{robust}} = \frac{x_t - \text{Median}_m}{1.4826 \cdot \text{MAD}_m} \equiv 0.67448975 \cdot \frac{x_t - \text{Median}_m}{\text{MAD}_m}$$

The consistency constant $1.4826 \approx \frac{1}{\Phi^{-1}(0.75)}$ guarantees that for normally distributed asymptotic samples, $1.4826 \cdot \text{MAD} \approx \sigma$.

### 6.3 Edge-Case Policies
1. **Zero MAD ($\text{MAD} = 0$):** Occurs when the majority of historical days in month $m$ have identical activity (e.g., zero).
   - If $x_t = \text{Median}_m$, $Z_{\text{robust}} = 0.0$.
   - If $x_t \ne \text{Median}_m$, $Z_{\text{robust}} = \frac{x_t - \text{Median}_m}{1.0}$ (pseudo-variance regularizer).
2. **Insufficient Historical Data:** If historical samples in month $m < 5$, anomaly evaluation is suppressed and labeled `insufficient_data`.
3. **Classification Thresholds:**
   - Normal: $Z_{\text{robust}} < 1.5$
   - Moderate Anomaly: $1.5 \le Z_{\text{robust}} < 2.5$
   - High Anomaly: $2.5 \le Z_{\text{robust}} < 3.5$
   - Extreme Anomaly: $Z_{\text{robust}} \ge 3.5$

*Notice: Historical activity anomalies quantify statistical variance from seasonal baselines, NOT predictive fire forecasts.*

---

## 7. Uncertainty, Limitations & Boundary Conditions

1. **Hotspot Counts $\ne$ Fire Perimeters:** Satellite thermal anomalies register sub-pixel radiant emitters; one large fire front may trigger 20 VIIRS pixels, whereas 5 small agricultural fires may trigger 1 MODIS pixel.
2. **Diurnal Cycle Sampling:** Polar-orbiting sun-synchronous satellites provide at most 2 daylight and 2 nighttime overpasses per 24 hours. Fires ignited and extinguished between overpass windows are unrecorded.
3. **Monsoon Cloud Masking:** Heavy cloud cover over South Asia during June–September impedes thermal infrared detection. Unobserved cells during cloudy periods must not be interpreted as zero fire activity.
4. **Bow-Tie Effect:** MODIS off-nadir spatial resolution degrades from 1 km to $2.0 \times 4.8\text{ km}$, resulting in duplicate geometric detections of adjacent pixels along scan tracks.

---

## 8. Authoritative Scientific Citations

1. **Schroeder, W., Oliva, P., Giglio, L., & Csiszar, I. A. (2014).** The New VIIRS 375 m active fire detection data product—Algorithm description and initial evaluation. *Remote Sensing of Environment*, 143, 85–96. [DOI: 10.1016/j.rse.2013.12.008](https://doi.org/10.1016/j.rse.2013.12.008)
2. **Giglio, L., Schroeder, W., & Justice, C. O. (2016).** The collection 6 MODIS active fire detection algorithm and fire products. *Remote Sensing of Environment*, 178, 31–41. [DOI: 10.1016/j.rse.2016.02.054](https://doi.org/10.1016/j.rse.2016.02.054)
3. **Wooster, M. J., Roberts, G., Perry, G. L. W., & Kaufman, Y. J. (2005).** Retrieval of biomass combustion rates and smoke flux using satellite data. *Remote Sensing of Environment*, 99(4), 438–454.
4. **Csiszar, I., et al. (2014).** Active fires from the Visible Infrared Imaging Radiometer Suite (VIIRS) with focal plane pixel aggregation. *Journal of Geophysical Research: Atmospheres*, 119(2), 775–788.
5. **Rousseeuw, P. J., & Croux, C. (1993).** Alternatives to the median absolute deviation. *Journal of the American Statistical Association*, 88(424), 1273–1283.
