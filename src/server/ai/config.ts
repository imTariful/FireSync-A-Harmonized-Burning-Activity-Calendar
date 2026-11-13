/**
 * Groq API configuration, read from server-only environment variables.
 *
 * Nothing here is sent to the browser except `model` and the capability flags: the API key is
 * held by this process only and never included in a response, a log line or an error message.
 */

import { FIRE_LEGEND } from '../../types/ai';
import type { AiStatusResponse } from '../../types/ai';

/** Default chat model; override with GROQ_MODEL. Never trusted to be valid without a live call. */
export const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
/** Groq's OpenAI-compatible endpoint; the transport speaks chat-completions + tool calls. */
export const GROQ_DEFAULT_API_BASE = 'https://api.groq.com/openai/v1';

export const AI_LIMITS = {
  requestsPerMinute: 12,
  maxMessageChars: 1_500,
  maxToolRounds: 3,
  maxToolCalls: 6,
  requestTimeoutMs: 60_000,
  maxOutputTokens: 1_400,
} as const;

export interface AiConfig {
  /** FIRESYNC_AI_ENABLED === 'true'; an unset flag keeps every AI route off. */
  enabled: boolean;
  /** A non-empty GROQ_API_KEY exists. */
  configured: boolean;
  apiKey: string | null;
  apiBase: string;
  model: string;
}

export function readAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const rawKey = env.GROQ_API_KEY?.trim() ?? '';
  const enabled = env.FIRESYNC_AI_ENABLED?.trim().toLowerCase() === 'true';
  // A model id is a single token; display names with spaces fall back to the default.
  // F57 fix: allow '/' for namespaced model IDs (e.g. "meta-llama/llama-3-8b-instruct").
  const rawModel = env.GROQ_MODEL?.trim() ?? '';
  const model = /^[A-Za-z0-9._\-/]+$/.test(rawModel) ? rawModel : DEFAULT_GROQ_MODEL;
  const apiBase = env.GROQ_API_BASE?.trim() || GROQ_DEFAULT_API_BASE;
  return {
    enabled,
    configured: rawKey.length > 0,
    apiKey: rawKey.length > 0 ? rawKey : null,
    apiBase,
    model,
  };
}

export const AI_GUARDRAILS: string[] = [
  FIRE_LEGEND,
  'MODIS and VIIRS detections are reported separately and are never added into one fire count.',
  'A hotspot is a satellite thermal anomaly: not a unique fire, a fire perimeter or burned area.',
  'Harmonized or combined figures are EXPLORATORY and are not validated science.',
  'No prediction, forecasting, ignition attribution or ground-truth claim is made.',
  'Missing observations are described as missing, never as zero fire activity.',
];

/** Truthful status: an unconfigured or disabled integration says so instead of pretending. */
export function aiStatus(config: AiConfig): AiStatusResponse {
  const status: AiStatusResponse['status'] = !config.enabled
    ? 'disabled'
    : !config.configured
      ? 'not_configured'
      : 'enabled';
  const ready = status === 'enabled';
  return {
    provider: 'groq',
    status,
    enabled: config.enabled,
    configured: config.configured,
    model: config.configured ? config.model : null,
    capabilities: {
      chat: ready,
      function_calling: ready,
      detection_explanation: ready,
      // Multimodal scene analysis needs a server-side image fetch pipeline that does not exist yet.
      image_analysis: false,
    },
    limits: {
      requests_per_minute: AI_LIMITS.requestsPerMinute,
      max_message_chars: AI_LIMITS.maxMessageChars,
      max_tool_rounds: AI_LIMITS.maxToolRounds,
      request_timeout_ms: AI_LIMITS.requestTimeoutMs,
    },
    guardrails: AI_GUARDRAILS,
    note:
      status === 'enabled'
        ? 'Groq explanations are generated from FireSync data tools. All numbers come from deterministic code, not from the model.'
        : status === 'disabled'
          ? 'AI features are turned off: set FIRESYNC_AI_ENABLED=true and GROQ_API_KEY on the server to enable them.'
          : 'No GROQ_API_KEY is configured on the server, so no AI request is sent.',
  };
}
