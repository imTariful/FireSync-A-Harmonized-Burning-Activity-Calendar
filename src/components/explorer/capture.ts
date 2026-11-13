/**
 * PNG capture of the 3D Globe: map canvas + a text footer, downloaded as a file.
 *
 * The map canvas is NOT created with preserveDrawingBuffer, so its pixels are only readable inside the render
 * event that painted them. FireGlobe therefore copies the canvas inside that event (GlobeShareApi.capture);
 * everything here works on that copy and never touches MapLibre.
 *
 * The footer text comes from layoutCaptureFooter (legend sentence, per-sensor counts, UTC time, attribution).
 * Nothing in this file throws to the caller: failures become a CaptureError with a friendly message.
 */
import { buildBasemap, type BasemapId } from './basemap';
import { CAPTURE_FIRMS_CREDIT, layoutCaptureFooter, type CaptureFooterInput } from '../../utils/shareHelpers';

export const CAPTURE_FAILED_MESSAGE =
  'The map image could not be captured in this browser. You can still copy the link or download the data, or take a screenshot.';

export class CaptureError extends Error {
  constructor(message: string = CAPTURE_FAILED_MESSAGE, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CaptureError';
  }
}

/** Layout numbers for the footer band, from the width of the captured canvas (device pixels). Pure. */
export interface FooterGeometry {
  fontPx: number;
  lineHeightPx: number;
  paddingPx: number;
  /** Wrap width for layoutCaptureFooter, in characters. */
  maxChars: number;
}

export function footerGeometry(widthPx: number): FooterGeometry {
  const w = Number.isFinite(widthPx) && widthPx > 0 ? widthPx : 640;
  const fontPx = Math.max(12, Math.min(28, Math.round(w / 70)));
  const paddingPx = Math.round(fontPx * 0.9);
  // Average glyph width of a sans-serif face is about 0.55 em.
  const maxChars = Math.max(20, Math.floor((w - 2 * paddingPx) / (fontPx * 0.55)));
  return { fontPx, lineHeightPx: Math.round(fontPx * 1.4), paddingPx, maxChars };
}

export function footerHeightPx(lineCount: number, g: FooterGeometry): number {
  return 2 * g.paddingPx + Math.max(1, lineCount) * g.lineHeightPx;
}

const ENTITIES: Record<string, string> = { '&copy;': '©', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/**
 * Credits for the footer: NASA FIRMS (always) + the credit(s) of the active basemap. The basemap's own
 * attribution string is the single source of truth (basemap.ts); its FIRMS part is dropped because the
 * FIRMS credit is added once, explicitly. For Satellite, `imageryDate` (UTC) goes into the credit.
 */
export function captureAttribution(basemap: BasemapId, imageryDate?: string | null): string[] {
  let raw = '';
  try {
    const a = (buildBasemap(basemap, undefined, imageryDate).source as { attribution?: unknown }).attribution;
    raw = typeof a === 'string' ? a : '';
  } catch {
    raw = '';
  }
  const text = raw.replace(/&(?:copy|amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);
  const credits = text
    .split(' · ')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !/FIRMS/i.test(s));
  return [CAPTURE_FIRMS_CREDIT, ...credits];
}

/** Draws `source` plus the footer band onto a new 2D canvas. Needs a DOM; throws CaptureError on failure. */
export function composeCapture(
  source: HTMLCanvasElement,
  footer: Omit<CaptureFooterInput, 'maxChars'>,
): HTMLCanvasElement {
  try {
    const g = footerGeometry(source.width);
    const lines = layoutCaptureFooter({ ...footer, maxChars: g.maxChars });
    const band = footerHeightPx(lines.length, g);
    const out = document.createElement('canvas');
    out.width = source.width;
    out.height = source.height + band;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('2D canvas not available');
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(source, 0, 0);
    ctx.fillStyle = '#0d131b';
    ctx.fillRect(0, source.height, out.width, band);
    ctx.fillStyle = '#f1f5f9';
    ctx.font = `${g.fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      ctx.fillText(line, g.paddingPx, source.height + g.paddingPx + i * g.lineHeightPx);
    });
    return out;
  } catch (e) {
    throw new CaptureError(CAPTURE_FAILED_MESSAGE, { cause: e });
  }
}

/** canvas.toBlob as a promise. A tainted canvas (SecurityError) or a null blob becomes a CaptureError. */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new CaptureError());
      }, 'image/png');
    } catch (e) {
      reject(new CaptureError(CAPTURE_FAILED_MESSAGE, { cause: e }));
    }
  });
}

/**
 * Whole capture: map copy (from FireGlobe) -> footer -> PNG blob. Rejects with CaptureError only.
 */
export async function captureGlobePng(
  getMapCanvas: () => Promise<HTMLCanvasElement>,
  footer: Omit<CaptureFooterInput, 'maxChars'>,
): Promise<Blob> {
  let source: HTMLCanvasElement;
  try {
    source = await getMapCanvas();
  } catch (e) {
    throw e instanceof CaptureError ? e : new CaptureError(CAPTURE_FAILED_MESSAGE, { cause: e });
  }
  if (!source || source.width === 0 || source.height === 0) throw new CaptureError();
  return canvasToPngBlob(composeCapture(source, footer));
}

/** Saves a blob as a file through a temporary link. Returns false when the browser refuses. */
export function downloadBlob(blob: Blob, filename: string): boolean {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch {
    return false;
  }
}
