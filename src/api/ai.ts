/**
 * Typed client for the FireSync AI routes.
 *
 * The browser never holds the Groq key: it only talks to these same-origin routes, which answer
 * 503 when AI is not configured and 429 when the rate limit is reached.
 */

import type {
  AiChatRequest,
  AiChatResponse,
  AiDetectionExplanationResponse,
  AiStatusResponse,
} from '../types/ai';

async function requestAi<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

export const aiApi = {
  async getStatus(): Promise<AiStatusResponse> {
    return requestAi<AiStatusResponse>('/api/v1/ai/status');
  },

  async chat(request: AiChatRequest): Promise<AiChatResponse> {
    return requestAi<AiChatResponse>('/api/v1/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  },

  async explainDetection(observation: unknown): Promise<AiDetectionExplanationResponse> {
    return requestAi<AiDetectionExplanationResponse>('/api/v1/ai/detection-explanation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ observation }),
    });
  },
};
