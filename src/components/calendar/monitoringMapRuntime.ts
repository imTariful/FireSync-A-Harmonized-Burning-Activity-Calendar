import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';

// Load only in the browser effect; server-side calendar render tests do not need WebGL or CSS.
maplibregl.setWorkerUrl(workerUrl);
export { maplibregl };
