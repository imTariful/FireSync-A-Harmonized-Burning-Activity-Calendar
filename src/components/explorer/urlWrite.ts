/** Pure address-bar helpers for the share link (no React, no DOM). */
import { clearViewParams, mergeViewParams, type ShareState } from '../../utils/shareHelpers';

/** Address-bar writes wait this long after the last change (never per animation frame). */
export const URL_WRITE_DEBOUNCE_MS = 500;

export interface UrlLocation {
  pathname: string;
  search: string;
  hash: string;
}

/**
 * The address-bar URL (path + query + hash, same origin) after replacing the view params with `state`, or
 * removing them when `state` is null. Unknown params and the hash are kept. Pure.
 */
export function nextUrl(loc: UrlLocation, state: ShareState | null): string {
  const query = state ? mergeViewParams(loc.search, state) : clearViewParams(loc.search);
  // A path starting with "//" would be read as another host: collapse it.
  const path = loc.pathname.replace(/^\/{2,}/, '/') || '/';
  return `${path}${query ? `?${query}` : ''}${loc.hash}`;
}
