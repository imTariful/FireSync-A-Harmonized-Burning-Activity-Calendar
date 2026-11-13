/**
 * AI feature catalog for the AI Intelligence hub.
 *
 * Statuses describe what THIS deployment implements, not what the roadmap intends.
 * "available" means the UI and server route exist; "partial" means some sub-capabilities
 * are missing; "unavailable" means a required dataset, provider or infrastructure
 * component is absent. No entry promises a capability that is not present.
 */

export type AiFeatureStatus = 'available' | 'partial' | 'unavailable';

/** Tabs implemented by the global AI Investigator panel. */
export type AiTab = 'chat' | 'evidence' | 'cluster' | 'sensors' | 'audit' | 'watch' | 'scenario';

/** Layers implemented by the Geographic Analysis page. */
export type GeographicLayerId = 'density' | 'clusters' | 'coverage' | 'regions' | 'compare' | 'weather';

export type AiFeaturePhase =
  | 'Foundation'
  | 'Core intelligence'
  | 'Geographic intelligence'
  | 'Environmental enrichment'
  | 'Historical intelligence'
  | 'Advanced infrastructure';

export type AiFeaturePage = 'calendar' | 'hotspots' | 'geographic';

export type AiFeatureAction =
  | { kind: 'ai_tab'; tab: AiTab; label: string }
  | { kind: 'geo_layer'; layer: GeographicLayerId; label: string }
  | { kind: 'geo_report'; label: string }
  | { kind: 'page'; page: AiFeaturePage; label: string };

export interface AiFeatureSubCapability {
  label: string;
  status: AiFeatureStatus;
  note: string;
}

export interface AiFeatureEntry {
  id: number;
  title: string;
  phase: AiFeaturePhase;
  status: AiFeatureStatus;
  summary: string;
  availabilityNote: string;
  limitations: string[];
  action?: AiFeatureAction;
  subCapabilities?: AiFeatureSubCapability[];
}

export const AI_FEATURE_STATUS_LABELS: Record<AiFeatureStatus, string> = {
  available: 'Available',
  partial: 'Partial',
  unavailable: 'Unavailable',
};

export const AI_FEATURE_PHASES: readonly AiFeaturePhase[] = [
  'Foundation',
  'Core intelligence',
  'Geographic intelligence',
  'Environmental enrichment',
  'Historical intelligence',
  'Advanced infrastructure',
];

export const AI_FEATURES: readonly AiFeatureEntry[] = [
  {
    id: 1,
    title: 'Ask FireSync: AI Map Copilot',
    phase: 'Foundation',
    status: 'available',
    summary:
      'Ask about the current map in plain language. The assistant can call FireSync data tools, apply typed sensor, date, FRP and confidence filters, and focus a region from the project region table.',
    availabilityNote:
      'Implemented in the global AI Investigator panel. Natural-language replies require Groq; every map action is validated by the server before it is applied.',
    limitations: [
      'The browser never receives the Groq API key.',
      'AI text is explanatory only; every number comes from FireSync data tools.',
    ],
    action: { kind: 'ai_tab', tab: 'chat', label: 'Open Ask FireSync' },
  },
  {
    id: 2,
    title: 'Fire Event Detective',
    phase: 'Core intelligence',
    status: 'available',
    summary:
      'Select a candidate hotspot group and review its observations, first and last detection, persistence, per-sensor counts, FRP and sensor composition.',
    availabilityNote:
      'Implemented in the AI Investigator Clusters tab. Groups are candidate spatial-temporal clusters, not confirmed wildfires.',
    limitations: [
      'Candidate groups are not fire perimeters.',
      'MODIS and VIIRS counts stay separate.',
    ],
    action: { kind: 'ai_tab', tab: 'cluster', label: 'Investigate a candidate group' },
  },
  {
    id: 3,
    title: 'Sensor Conflict Investigator',
    phase: 'Core intelligence',
    status: 'available',
    summary:
      'Compare MODIS and VIIRS acquisition timing, coverage, paired 1 km cells, confidence and FRP where the data supports it.',
    availabilityNote:
      'Implemented in the AI Investigator Sensors tab. Both sensors are loaded for this comparison regardless of the map sensor filter.',
    limitations: [
      'The comparison explains differences; it does not claim either sensor is wrong.',
      'Raw detections are never combined into a unique fire count.',
    ],
    action: { kind: 'ai_tab', tab: 'sensors', label: 'Compare MODIS vs VIIRS' },
  },
  {
    id: 4,
    title: 'AI Fire Detection Evidence Cards',
    phase: 'Foundation',
    status: 'available',
    summary:
      'Review real satellite metadata for a detection: coordinates, observation time, sensor, satellite, confidence, FRP, product and provenance, with an optional AI explanation.',
    availabilityNote:
      'Implemented in the AI Investigator Evidence tab. Clicking a hotspot on the map opens this tab with that detection pinned; the dropdown can also select any loaded detection.',
    limitations: [
      'Only fields returned by the server are shown; missing fields are reported as missing.',
      'A hotspot is a satellite thermal anomaly, not a confirmed wildfire.',
    ],
    action: { kind: 'ai_tab', tab: 'evidence', label: 'Open evidence cards' },
  },
  {
    id: 5,
    title: 'AI Seasonal Fire Historian',
    phase: 'Historical intelligence',
    status: 'available',
    summary:
      'Compare fire activity across years, months, seasons or countries from the ingested 2000-2025 MODIS/VIIRS archive and the AgniCalendar harmonized grid, with descriptive seasonal climatology.',
    availabilityNote:
      'Implemented: per-country and bbox seasonal climatology (/api/v1/history/climatology, /seasonal-status), month anomaly vs median, persistent-country and period rankings, plus the AgniCalendar month x year calendar. MODIS and VIIRS stay separate; the harmonized equivalent is labelled EXPLORATORY.',
    limitations: [
      'Climatology is descriptive historical pattern, never a forecast or fire-occurrence probability.',
      'Missing archive periods are unavailable data, not confirmed zero activity.',
      'Harmonized values are model estimates on approved support only.',
    ],
    action: { kind: 'page', page: 'calendar', label: 'Open calendar' },
  },
  {
    id: 6,
    title: 'Satellite Blind-Spot Detective',
    phase: 'Geographic intelligence',
    status: 'available',
    summary:
      'Inspect missing observation records, source errors, per-day coverage, single-sensor overpass gaps and durable ingestion job records for the selected area.',
    availabilityNote:
      'Implemented in the Geographic Analysis Coverage layer: observed vs no-record days, days reported by only one sensor (possible overpass gaps), live source errors, and the store\'s ingestion job history with per-job status and errors.',
    limitations: [
      'A day without an observation record is missing coverage, not zero fire.',
      'Coverage is limited to the live 1-5 day NRT window; a missing job does not prove a coverage gap.',
      'A single-sensor day cannot be distinguished from genuinely absent detections.',
    ],
    action: { kind: 'geo_layer', layer: 'coverage', label: 'Open coverage layer' },
  },
  {
    id: 7,
    title: 'Visual Satellite Scene Analyst',
    phase: 'Environmental enrichment',
    status: 'unavailable',
    summary:
      'Inspect correctly dated satellite imagery with Groq multimodal analysis for smoke-like features, clouds and landscape differences.',
    availabilityNote:
      'Unavailable: this deployment has no server-side image pipeline and the AI status reports image_analysis=false. No imagery is sent to Groq.',
    limitations: [
      'No burned perimeter or confirmed fire is claimed from visual interpretation.',
      'Imagery source, acquisition date and limitations would be required before enabling this feature.',
    ],
  },
  {
    id: 8,
    title: 'Weather–Fire Relationship Investigator',
    phase: 'Environmental enrichment',
    status: 'available',
    summary:
      'Compare Open-Meteo temperature, precipitation, humidity and wind observations with per-sensor daily detection counts using deterministic Pearson correlations.',
    availabilityNote:
      'Implemented as the Weather & fire layer in Geographic Analysis. Weather is a single-point Open-Meteo forecast-API estimate at the bbox centre for areas up to ~20°; correlations use at most five paired days.',
    limitations: [
      'Correlation is not ignition causation or an operational forecast.',
      'Days without an observation record are excluded from the pairs; missing coverage is not zero fire.',
      'Large areas get no point estimate rather than an unrepresentative one.',
    ],
    action: { kind: 'geo_layer', layer: 'weather', label: 'Open Weather & fire' },
  },
  {
    id: 9,
    title: 'Community Exposure Intelligence',
    phase: 'Environmental enrichment',
    status: 'unavailable',
    summary:
      'Calculate geodesic distances and buffers around verified settlements, hospitals, schools, roads and population grids.',
    availabilityNote:
      'Unavailable: no settlements, infrastructure, administrative-boundary or population dataset is bundled. The proximity endpoint runs only on features supplied explicitly in a request.',
    limitations: [
      'No claim is made that people are injured, affected or need evacuation.',
      'No exposure indicator is invented from an empty dataset.',
    ],
  },
  {
    id: 10,
    title: 'What Changed? AI Comparison Engine',
    phase: 'Core intelligence',
    status: 'available',
    summary:
      'Compare two supported periods with sensor-separated detection counts, FRP, active 1 km cells and per-day normalization; region comparison is available separately.',
    availabilityNote:
      'Implemented in the Geographic Analysis What changed layer. Both windows must fit inside the live 5-day NRT window.',
    limitations: [
      'Change is descriptive, not predictive.',
      'A zero-baseline percentage is reported as not defined.',
      'Coverage limits are shown with the comparison.',
    ],
    action: { kind: 'geo_layer', layer: 'compare', label: 'Open What changed' },
  },
  {
    id: 11,
    title: 'Intelligent Fire Watchlists and Alerts',
    phase: 'Advanced infrastructure',
    status: 'available',
    summary:
      'Save regions with sensor, window, detection-count and optional FRP thresholds; deterministic evaluation raises deduplicated in-app alerts with history, pause, resume, delete and AI explanation.',
    availabilityNote:
      'Implemented in the AI Investigator Watch tab and /api/v1/watchlists. Watchlists persist to FIRESYNC_WATCHLIST_PATH (JSON) when set, otherwise in memory; the scheduler evaluates every 30 minutes (FIRESYNC_WATCHLIST_INTERVAL_MINUTES) while the server runs.',
    limitations: [
      'Alerts are delivered in-app only: no email or push channel exists.',
      'The scheduler is in-process; windows missed while the server is down are not backfilled.',
      'A threshold alert means the configured detection count was reached, not a confirmed wildfire.',
    ],
    action: { kind: 'ai_tab', tab: 'watch', label: 'Open watchlists' },
  },
  {
    id: 12,
    title: 'Real-World Incident Verification Agent',
    phase: 'Environmental enrichment',
    status: 'available',
    summary:
      'Compare official US wildland-fire incident records (WFIGS/IRWIN) with satellite detections and classify corroborated, no-nearby-detection or unmatchable incidents with source attribution.',
    availabilityNote:
      'Implemented: GET /api/v1/incidents and the official_incidents AI tool query the public WFIGS Current Wildland Fire Incident Locations service (no key, ~5 min refresh, 5-minute server cache) and deterministically match detections within a radius and time window of each incident.',
    limitations: [
      'Coverage is US wildland fires reported to IRWIN only — non-US incidents cannot be verified.',
      'satellite_corroborated means detections near the incident in time and space; it is never a confirmed wildfire.',
      'RX records are prescribed fires; a satellite anomaly is not an official incident confirmation in either direction.',
      'Corroboration uses the live NRT observation window; older incidents may show no_nearby_detections for coverage reasons.',
    ],
    action: { kind: 'ai_tab', tab: 'chat', label: 'Ask about incidents' },
  },
  {
    id: 13,
    title: 'Fire Behavior Scenario Laboratory',
    phase: 'Advanced infrastructure',
    status: 'partial',
    summary:
      'Explore hypothetical wind, fuel, humidity, slope and fuel-moisture conditions in an educational interface with deterministic qualitative factors and an optional AI explanation.',
    availabilityNote:
      'Partial: the educational interface and qualitative assessment are implemented in the AI Investigator Lab tab and POST /api/v1/scenario/analyze. Simulation is explicitly unavailable — no validated specialist fire-behaviour model is integrated, so no spread rate, perimeter or arrival time is ever produced.',
    limitations: [
      'Output is qualitative direction only; no quantitative fire-spread prediction is computed or implied.',
      'A specialist, validated model is required before any quantitative output can be offered.',
      'The laboratory uses no satellite detections and makes no claim about observed fires.',
    ],
    action: { kind: 'ai_tab', tab: 'scenario', label: 'Open scenario lab' },
  },
  {
    id: 14,
    title: 'AI Scientific Integrity Auditor',
    phase: 'Core intelligence',
    status: 'available',
    summary:
      'Audit provenance, record integrity, coordinate validity, temporal coverage, duplicates and sensor-mixing errors with deterministic checks.',
    availabilityNote:
      'Implemented in the AI Investigator Audit tab. Results remain EXPLORATORY; Groq only summarizes the deterministic checks.',
    limitations: [
      'The auditor never upgrades an exploratory result to validated.',
      'Checks cover the loaded observation set and its source metadata.',
    ],
    action: { kind: 'ai_tab', tab: 'audit', label: 'Open scientific audit' },
  },
  {
    id: 15,
    title: 'AI Scientific Report Generator',
    phase: 'Core intelligence',
    status: 'available',
    summary:
      'Generate a source-aware report with statistics, methods, provenance, uncertainties and optional English or Bangla AI interpretation.',
    availabilityNote:
      'Implemented in Geographic Analysis. Markdown and HTML are generated; PDF export is unavailable because no rendering dependency is installed.',
    limitations: [
      'The AI narrative is optional; deterministic report content remains available if Groq is unavailable.',
      'Reports stay EXPLORATORY and include the required legend.',
    ],
    action: { kind: 'geo_report', label: 'Open report generator' },
  },
  {
    id: 16,
    title: 'AI Geographic Fire Intelligence Lab',
    phase: 'Geographic intelligence',
    status: 'partial',
    summary:
      'Use the shared map, filters and server-side geographic computations for density, candidate clusters, coverage, region comparison and change analysis.',
    availabilityNote:
      'Partial: density, candidate clusters, coverage, region comparison and What changed are implemented. Land cover, terrain, population exposure, cross-border analysis and proximity over bundled infrastructure are unavailable.',
    limitations: [
      'Country and region comparison uses the project approximate region table, not official administrative boundaries.',
      'Candidate cluster boxes are not fire perimeters.',
      'Missing datasets return available:false with a reason, never zeros.',
    ],
    action: { kind: 'geo_layer', layer: 'density', label: 'Open density layer' },
    subCapabilities: [
      {
        label: 'Hotspot density',
        status: 'available',
        note: 'Observed detections per 1000 km2 on the server grid, with area and coverage notes.',
      },
      {
        label: 'Country and district analysis',
        status: 'partial',
        note: 'Region comparison uses the project region table with approximate bounding boxes, not verified administrative boundaries.',
      },
      {
        label: 'Proximity analysis',
        status: 'unavailable',
        note: 'The proximity endpoint runs only on features supplied explicitly in a request; no settlements, roads, hospitals or schools are bundled.',
      },
      {
        label: 'Land-cover analysis',
        status: 'unavailable',
        note: 'No ESA WorldCover raster or class lookup is present.',
      },
      {
        label: 'Fire cluster evolution',
        status: 'available',
        note: 'Each candidate group reports per-day sensor-separated detections and a deterministic timing phase (single pass, increasing, steady, decreasing, fading) inside the live window; it is not fire-perimeter growth.',
      },
      {
        label: 'Terrain analysis',
        status: 'unavailable',
        note: 'No Copernicus DEM tiles are present; slope is undefined without them.',
      },
      {
        label: 'Geographic anomaly detection',
        status: 'unavailable',
        note: 'No historical geographic baseline is ingested for statistical anomaly detection.',
      },
      {
        label: 'Environmental context',
        status: 'unavailable',
        note: 'No weather or vegetation layer is configured.',
      },
      {
        label: 'Population exposure screening',
        status: 'unavailable',
        note: 'No population grid is present.',
      },
      {
        label: 'Cross-border activity analysis',
        status: 'unavailable',
        note: 'No international boundary dataset is bundled.',
      },
    ],
  },
];

export interface AiFeatureStatusCounts {
  total: number;
  available: number;
  partial: number;
  unavailable: number;
}

export function aiFeatureStatusCounts(
  features: readonly AiFeatureEntry[] = AI_FEATURES
): AiFeatureStatusCounts {
  const counts: AiFeatureStatusCounts = {
    total: features.length,
    available: 0,
    partial: 0,
    unavailable: 0,
  };
  for (const feature of features) counts[feature.status] += 1;
  return counts;
}

export interface AiFeatureGroup {
  phase: AiFeaturePhase;
  features: AiFeatureEntry[];
}

export function groupAiFeatures(
  features: readonly AiFeatureEntry[] = AI_FEATURES
): AiFeatureGroup[] {
  return AI_FEATURE_PHASES.map((phase) => ({
    phase,
    features: features.filter((feature) => feature.phase === phase),
  })).filter((group) => group.features.length > 0);
}

export function aiFeatureById(id: number): AiFeatureEntry | undefined {
  return AI_FEATURES.find((feature) => feature.id === id);
}
