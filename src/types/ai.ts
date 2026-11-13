/**
 * Shared AI contracts for the FireSync Groq integration.
 *
 * These types are used by BOTH the Express routes (src/server/ai) and the React client, so a
 * map action the model proposes can only ever be one of the shapes below. Everything the model
 * says is prose; every number and every state change is validated here or on the server.
 */

import type { CanonicalObservation, ProvenanceStatus } from './fire';

/** Legend required by AGENTS.md, reused verbatim in prompts, UI and reports. */
export const FIRE_LEGEND = 'Satellite thermal anomalies, not confirmed wildfires or burned area.';

export type AiProviderStatus = 'enabled' | 'disabled' | 'not_configured';

export interface AiStatusResponse {
  provider: 'groq';
  status: AiProviderStatus;
  enabled: boolean;
  configured: boolean;
  /** Model id only. The API key never leaves the server and is never returned. */
  model: string | null;
  capabilities: {
    chat: boolean;
    function_calling: boolean;
    detection_explanation: boolean;
    image_analysis: boolean;
  };
  limits: {
    requests_per_minute: number;
    max_message_chars: number;
    max_tool_rounds: number;
    request_timeout_ms: number;
  };
  guardrails: string[];
  note: string;
}

/** A map filter change the assistant is allowed to request. Applied only by the browser UI. */
export interface AiApplyFiltersAction {
  type: 'apply_filters';
  sensors?: 'ALL' | 'MODIS' | 'VIIRS';
  /** Number of days back from today (1 = today only), inside the live NRT window. */
  days?: number;
  min_frp?: number;
  min_confidence?: number;
}

/** Fly the map to a region that exists in the project's own region table. */
export interface AiFocusRegionAction {
  type: 'focus_region';
  region_id: string;
  name: string;
  bbox: string;
}

export type AiMapAction = AiApplyFiltersAction | AiFocusRegionAction;

export interface AiRequestContext {
  area_name?: string;
  bbox?: string;
  sensors?: 'ALL' | 'MODIS' | 'VIIRS';
  start_date?: string;
  end_date?: string;
  active_view?: string;
}

export interface AiChatRequest {
  message: string;
  context?: AiRequestContext;
}

export interface AiToolCallRecord {
  name: string;
  ok: boolean;
  summary: string;
}

export interface AiChatResponse {
  reply: string;
  actions: AiMapAction[];
  tool_calls: AiToolCallRecord[];
  model: string;
  guardrails: string[];
  /** Deterministic notes from the data tools (source, window, truncation, source errors). */
  data_notes: string[];
}

/**
 * Detection evidence payload. Only these fields are ever sent to the model or rendered in the
 * evidence card; anything else in a client payload is discarded.
 */
export interface AiDetectionEvidence {
  id: string;
  sensor: 'MODIS' | 'VIIRS';
  satellite: string;
  latitude: number;
  longitude: number;
  acq_date: string;
  acq_time: string;
  datetime_utc: string;
  confidence: number | string;
  frp_mw: number;
  product: string;
  brightness?: number;
  bright_ti4?: number;
  bright_ti5?: number;
  daynight?: string;
  scan?: number;
  track?: number;
  provenance_status?: ProvenanceStatus;
}

export interface AiDetectionExplanationRequest {
  observation: unknown;
}

export interface AiDetectionExplanationResponse {
  explanation: string;
  model: string;
  guardrails: string[];
  evidence: AiDetectionEvidence;
  fields_provided: string[];
  fields_missing: string[];
  data_notes: string[];
}

/** Compact, deterministic tool output handed back to the model (never invented values). */
export interface AiHotspotSummary {
  window_days: number;
  bbox_used: string;
  filters: {
    sensors: 'ALL' | 'MODIS' | 'VIIRS';
    min_frp: number | null;
    min_confidence: number | null;
  };
  total_matching: number;
  by_sensor: { MODIS: number; VIIRS: number };
  frp_mw: { MODIS: number; VIIRS: number };
  active_1km_cells: number;
  first_detection_utc: string | null;
  last_detection_utc: string | null;
  sample: AiDetectionEvidence[];
  source: 'live' | 'store';
  provenance_status: ProvenanceStatus;
  retrieved_at: string | null;
  source_errors: string[];
  truncated: boolean;
  notes: string[];
}

/** The server-side data source the tools read from. Implemented in app.ts over live/store data. */
export interface AiObservationPayload {
  observations: CanonicalObservation[];
  source: 'live' | 'store';
  provenance: ProvenanceStatus;
  retrieved_at: string | null;
  errors: string[];
  truncated: boolean;
}

export type AiObservationLoader = (query: { days: number; bbox: string | null }) => Promise<AiObservationPayload>;
