import React, { useEffect, useRef, useState } from 'react';
import type { Map as LibreMap, GeoJSONSource } from 'maplibre-gl';
import type { Watchlist } from '../../api/watchlists';
import { bboxToString } from '../../utils/area';
import { NOMINATIM_ATTRIBUTION, searchPlaces, type PlaceResult } from '../../utils/geocode';
import { monitoringBoxFromCorners, monitoringBoxFromTap, monitoringRectangle, parseMonitoringBox, validMonitoringBox, type MonitoringSelection } from '../../utils/monitoringArea';
import type { BoundingBox } from '../../types/fire';

interface Props {
  value: MonitoringSelection | null;
  onChange: (value: MonitoringSelection | null) => void;
  watchlists: Watchlist[];
}

const buttonClass = 'min-h-11 rounded-control border border-line px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-50';
const idleClass = 'bg-raised text-fg hover:text-accent';

/** Flat, north-up map. Its geometry is the exact rectangle submitted to the watch API. */
export function MonitoringAreaMap({ value, onChange, watchlists }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const latest = useRef({ value, onChange, watchlists });
  latest.current = { value, onChange, watchlists };
  const [ready, setReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [draw, setDraw] = useState(false);
  const [draft, setDraft] = useState<BoundingBox | null>(null);
  const anchor = useRef<{ x: number; y: number } | null>(null);
  const secondCorner = useRef(false);
  const [waitingCorner, setWaitingCorner] = useState(false);
  const [tapWidth, setTapWidth] = useState(10);
  const widthRef = useRef(tapWidth);
  widthRef.current = tapWidth;
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PlaceResult[]>([]);
  const [searching, setSearching] = useState(false);
  const request = useRef<AbortController | null>(null);

  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    let disposed = false;
    let map: LibreMap | undefined;
    let observer: ResizeObserver | undefined;
    setReady(false);
    setMapError(null);
    void (async () => {
      try {
        const { maplibregl: lib } = await import('./monitoringMapRuntime');
        if (disposed || !container.current) return;
        map = new lib.Map({
          container: container.current, center: [25, 15], zoom: 1.2, maxZoom: 18,
          maxPitch: 0, dragRotate: false, renderWorldCopies: false,
          attributionControl: { compact: true },
          style: {
            version: 8, projection: { type: 'mercator' },
            sources: {
              streets: { type: 'raster', tileSize: 256, maxzoom: 19,
                tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'],
                attribution: 'Tiles © Esri &amp; contributors · <a href="https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer" target="_blank" rel="noopener noreferrer">Full map credits</a>' },
              regions: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
            },
            layers: [
              { id: 'background', type: 'background', paint: { 'background-color': '#dae4e9' } },
              { id: 'streets', type: 'raster', source: 'streets' },
              { id: 'regions-fill', type: 'fill', source: 'regions', paint: {
                'fill-color': ['match', ['get', 'kind'], 'selected', '#0891b2', 'paused', '#64748b', '#d97706'],
                'fill-opacity': ['case', ['==', ['get', 'kind'], 'selected'], 0.24, 0.09],
              } },
              { id: 'regions-line', type: 'line', source: 'regions', paint: {
                'line-color': ['match', ['get', 'kind'], 'selected', '#007c91', 'paused', '#64748b', '#b45309'],
                'line-width': ['case', ['==', ['get', 'kind'], 'selected'], 3, 2],
              } },
            ],
          },
        });
        mapRef.current = map;
        map.touchZoomRotate.disableRotation();
        map.boxZoom.disable();
        map.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
        // Apply bounds after the Mercator transform has initialized its projection matrices.
        map.on('load', () => { if (!disposed) { map?.setMaxBounds([[-179.99999, -85], [179.99999, 85]]); setReady(true); } });
        map.on('error', () => { if (!disposed) setMapError('Some map tiles could not load. Check your connection or retry the map.'); });
        map.on('click', (e) => {
          const box = monitoringBoxFromTap(e.lngLat.lng, e.lngLat.lat, widthRef.current);
          if (!box) { setSelectionError('Choose an area away from the poles and date line, or draw a smaller box.'); return; }
          setSelectionError(null);
          latest.current.onChange({ name: 'Tapped map area', bbox: box, note: `Approximately ${widthRef.current} × ${widthRef.current} km around your tap.` });
        });
        observer = new ResizeObserver(() => map?.resize());
        observer.observe(container.current);
      } catch (err) {
        if (!disposed) setMapError(err instanceof Error ? err.message : 'The map could not start.');
      }
    })();
    return () => { disposed = true; observer?.disconnect(); map?.remove(); mapRef.current = null; };
  }, [retry]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const features = watchlists.flatMap((watch) => {
      const box = parseMonitoringBox(watch.bbox);
      return box ? [monitoringRectangle(box, { kind: watch.paused ? 'paused' : 'watch', name: watch.name })] : [];
    });
    const selected = draft ?? value?.bbox;
    if (selected) features.push(monitoringRectangle(selected, { kind: 'selected', name: value?.name ?? 'Selection' }));
    (map.getSource('regions') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }, [ready, watchlists, value, draft]);

  useEffect(() => {
    const box = value?.bbox;
    if (ready && box && validMonitoringBox(box)) mapRef.current?.fitBounds([[box.west, box.south], [box.east, box.north]], { padding: 45, maxZoom: 12, duration: 300 });
  }, [ready, value]);

  const search = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setSearching(true); setSelectionError(null); setResults([]);
    try {
      const found = await searchPlaces(query, controller.signal);
      if (!controller.signal.aborted) { setResults(found); if (!found.length) setSelectionError('No places found. Try a city, district or country name.'); }
    } catch (err) {
      if (!controller.signal.aborted) setSelectionError(err instanceof Error ? err.message : 'Search failed.');
    } finally { if (!controller.signal.aborted) setSearching(false); }
  };

  const choosePlace = (place: PlaceResult) => {
    const box = place.bbox ?? monitoringBoxFromTap(place.lng, place.lat, tapWidth);
    if (!box || !validMonitoringBox(box)) { setSelectionError('This place crosses the date line or map limits. Draw a smaller monitoring area.'); return; }
    setSelectionError(null); setResults([]);
    onChange({ name: place.name, bbox: box, note: place.bbox ? 'Place search extent; not an administrative boundary.' : `No place extent supplied; approximately ${tapWidth} × ${tapWidth} km around the result.` });
  };

  const resetDraw = () => { setDraw(false); setDraft(null); anchor.current = null; setWaitingCorner(false); };
  const pointerPoint = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(rect.width, e.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, e.clientY - rect.top)) };
  };
  const boxAt = (point: { x: number; y: number }) => {
    const map = mapRef.current;
    return map && anchor.current ? monitoringBoxFromCorners(map.unproject([anchor.current.x, anchor.current.y]), map.unproject([point.x, point.y])) : null;
  };

  return <div className="rounded-control border border-line p-3 space-y-3 min-w-0">
    <h4 className="text-xs font-semibold">Monitoring area: {value?.name ?? 'Choose a place here'}</h4>
    <div role="search" aria-label="Find monitoring area" className="flex flex-wrap gap-2">
      <input aria-label="Search monitoring place" placeholder="City, district or country" value={query} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && query.trim().length >= 2 && !searching) { e.preventDefault(); void search(); } }}
        className="min-w-0 min-h-11 flex-1 rounded-control border border-line bg-canvas p-2 text-xs" />
      <button type="button" disabled={searching || query.trim().length < 2} onClick={() => void search()} className={`${buttonClass} ${idleClass}`}>{searching ? 'Searching…' : 'Find place'}</button>
    </div>
    <p className="text-2xs text-fg-subtle">{NOMINATIM_ATTRIBUTION}</p>
    {!!results.length && <ul aria-label="Monitoring place results" className="space-y-1 max-h-44 overflow-auto">{results.map((place, i) => <li key={i}><button type="button" onClick={() => choosePlace(place)} className="w-full text-left text-xs p-2 rounded-control bg-raised hover:text-accent">{place.name}</button></li>)}</ul>}
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Map selection tools">
      <button type="button" aria-pressed={!draw} onClick={resetDraw} className={`${buttonClass} ${!draw ? 'bg-accent text-accent-fg' : idleClass}`}>Tap a place</button>
      <button type="button" disabled={!ready} aria-pressed={draw} onClick={() => { resetDraw(); setDraw(true); }} className={`${buttonClass} ${draw ? 'bg-accent text-accent-fg' : idleClass}`}>Draw an area</button>
      <button type="button" disabled={!ready} className={`${buttonClass} ${idleClass}`} onClick={() => {
        const bounds = mapRef.current?.getBounds();
        const box = bounds ? monitoringBoxFromCorners(bounds.getSouthWest(), bounds.getNorthEast()) : null;
        if (!box) { setSelectionError('Zoom in before choosing the visible map area.'); return; }
        resetDraw(); setSelectionError(null); onChange({ name: 'Visible map area', bbox: box });
      }}>Use visible area</button>
      {value && <button type="button" onClick={() => { resetDraw(); onChange(null); }} className={`${buttonClass} ${idleClass}`}>Clear selection</button>}
      <label className="text-2xs text-fg-muted">Tap area width <select aria-label="Tap area width" value={tapWidth} onChange={(e) => setTapWidth(Number(e.target.value))} className="min-h-11 bg-canvas border border-line rounded-control p-1 ml-1">{[10, 25, 50].map((km) => <option key={km} value={km}>{km} km</option>)}</select></label>
    </div>
    <p role="status" className="text-xs text-fg-muted">{draw ? waitingCorner ? 'Now tap the opposite corner, or cancel drawing.' : 'Drag a box with the mouse, or tap two opposite corners. The shaded box is your monitoring area.' : 'Tap anywhere to select its surrounding area. Drag the map to move; zoom in for a smaller region.'}</p>
    {draw && <button type="button" onClick={resetDraw} className="text-xs text-accent">Cancel drawing</button>}
    <div className="relative overflow-hidden rounded-control border border-line [&_.maplibregl-ctrl-group_button]:h-11! [&_.maplibregl-ctrl-group_button]:w-11!" style={{ height: 360 }}>
      <div ref={container} role="region" aria-label="Flat monitoring area map" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
      {!ready && !mapError && <p className="absolute top-3 left-3 bg-canvas p-2 rounded-control text-xs">Loading map…</p>}
      {draw && ready && <div role="application" aria-label="Draw monitoring rectangle" tabIndex={0} className="absolute inset-0 cursor-crosshair" style={{ touchAction: 'none' }}
        onKeyDown={(e) => { if (e.key === 'Escape') resetDraw(); }}
        onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); secondCorner.current = !!anchor.current; if (!anchor.current) anchor.current = pointerPoint(e); e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerMove={(e) => { if (anchor.current) setDraft(boxAt(pointerPoint(e))); }}
        onPointerCancel={resetDraw}
        onPointerUp={(e) => {
          if (!anchor.current) return;
          const point = pointerPoint(e);
          if (!secondCorner.current && Math.hypot(point.x - anchor.current.x, point.y - anchor.current.y) < 8) { setWaitingCorner(true); return; }
          const box = boxAt(point);
          if (!box) { setSelectionError('Draw a larger box within the map limits; date-line crossing areas need separate monitors.'); resetDraw(); return; }
          setSelectionError(null); onChange({ name: 'Drawn monitoring area', bbox: box }); resetDraw();
        }} >{waitingCorner && anchor.current && <span aria-label="First rectangle corner" className="absolute h-3 w-3 rounded-full border-2 border-white bg-cyan-500 pointer-events-none" style={{ left: anchor.current.x, top: anchor.current.y, transform: 'translate(-50%, -50%)' }} />}</div>}
    </div>
    {mapError && <div role="alert" className="text-xs text-danger">{mapError} <button type="button" onClick={() => { resetDraw(); setRetry((n) => n + 1); }} className="underline">Retry map</button></div>}
    {selectionError && <p role="alert" className="text-xs text-danger">{selectionError}</p>}
    <p className="text-2xs text-fg-muted"><span className="text-cyan-400">■ Selected area</span> · <span className="text-amber-400">■ Active saved monitors</span> · <span className="text-slate-400">■ Paused monitors</span>. Boundaries only; these are not fire detections.</p>
    {value && <div className="space-y-1 text-2xs text-fg-muted"><p>{value.note} The monitor covers the shaded rectangle, not an administrative boundary.</p><details><summary className="cursor-pointer">Selected extent details</summary><p className="font-mono break-all">{bboxToString(value.bbox)}</p></details></div>}
  </div>;
}
