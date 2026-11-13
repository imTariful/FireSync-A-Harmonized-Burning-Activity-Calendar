/**
 * Typed client for fire watchlists and alerts.
 *
 * Alerts are delivered in-app only: this client polls the alert list, there is no push channel.
 */

export interface WatchCondition {
  trigger?: 'detections' | 'clusters';
  sensors: 'ALL' | 'MODIS' | 'VIIRS';
  days: number;
  min_detections: number;
  min_frp_mw?: number;
}

export interface Watchlist {
  last_error?: string | null;
  id: string;
  name: string;
  bbox: string;
  condition: WatchCondition;
  created_at: string;
  paused: boolean;
  last_evaluated_at: string | null;
  last_counts: { MODIS: number; VIIRS: number; total: number } | null;
}

export interface WatchAlert {
  new_detections?: number;
  first_acquisition_utc?: string;
  last_acquisition_utc?: string;
  id: string;
  watchlist_id: string;
  watchlist_name: string;
  date: string;
  triggered_at: string;
  reason: string;
  counts: { MODIS: number; VIIRS: number; total: number };
  condition: WatchCondition;
  acknowledged: boolean;
}

export interface WatchlistsMeta {
  storage: string;
  durable: boolean;
  location: string;
  scheduler: { running: boolean; interval_minutes: number | null };
  delivery: string;
  note: string;
}

export interface WatchlistsResponse {
  watchlists: Watchlist[];
  alerts: WatchAlert[];
  meta: WatchlistsMeta;
}

export interface WatchlistCheckResponse {
  watchlist: Watchlist;
  evaluation: { triggered: boolean; reason: string; counts: { MODIS: number; VIIRS: number; total: number } };
  alert: WatchAlert | null;
  meta: WatchlistsMeta;
}

export interface WatchlistAlertExplanation {
  alert_id: string;
  explanation: string | null;
  ai: { status: string; model: string | null; reason: string | null };
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `HTTP ${res.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export const watchlistApi = {
  list() {
    return req<WatchlistsResponse>('/api/v1/watchlists');
  },
  create(input: { name: string; bbox: string; condition: WatchCondition }) {
    return req<{ watchlist: Watchlist; meta: WatchlistsMeta }>('/api/v1/watchlists', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  setPaused(id: string, paused: boolean) {
    return req<{ watchlist: Watchlist }>(`/api/v1/watchlists/${encodeURIComponent(id)}/pause`, {
      method: 'POST',
      body: JSON.stringify({ paused }),
    });
  },
  remove(id: string) {
    return req<{ deleted: boolean }>(`/api/v1/watchlists/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  check(id: string) {
    return req<WatchlistCheckResponse>(`/api/v1/watchlists/${encodeURIComponent(id)}/check`, {
      method: 'POST',
      body: '{}',
    });
  },
  acknowledgeAlert(id: string) {
    return req<{ acknowledged: boolean }>(
      `/api/v1/watchlists/alerts/${encodeURIComponent(id)}/acknowledge`,
      { method: 'POST', body: '{}' }
    );
  },
  explainAlert(alertId: string) {
    return req<WatchlistAlertExplanation>('/api/v1/ai/watchlist-alert', {
      method: 'POST',
      body: JSON.stringify({ alert_id: alertId }),
    });
  },
};
