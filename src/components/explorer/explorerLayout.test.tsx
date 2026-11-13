import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ExplorerToolbar } from './ExplorerToolbar';
import { ExplorerLegend } from './ExplorerLegend';
import { FOCUS_TARGET_IDS, type PanelSectionId } from './types';
import { AreaChip } from '../area/AreaChip';
import { DEFAULT_AREA } from '../../utils/area';
import { LEGEND_SWATCH_PX, SENSOR_COLOR } from '../../utils/sensorStyle';

test('toolbar: Map view, Timeline, Harmonize, Share, Help (no Area / Search / Layers / Region)', () => {
  const html = renderToString(<ExplorerToolbar onAction={() => undefined} />);
  for (const label of ['Map view', 'Timeline', 'Harmonize', 'Share', 'Help']) {
    assert.match(html, new RegExp(`>${label}<`), label);
  }
  for (const gone of ['Area', 'Search', 'Layers', 'Region']) assert.doesNotMatch(html, new RegExp(`>${gone}<`), gone);
  assert.equal((html.match(/<button/g) ?? []).length, 5);
});

test('panel sections are exactly area, mapview, detections; focus targets exist for the two with controls', () => {
  const ids: PanelSectionId[] = ['area', 'mapview', 'detections'];
  assert.equal(ids.length, 3);
  assert.deepEqual(Object.keys(FOCUS_TARGET_IDS).sort(), ['area', 'mapview']);
});

test('the one legend: separate counts, sized swatches in the sensor colours, size and cloud explained', () => {
  const html = renderToString(
    <ExplorerLegend counts={{ MODIS: 9, VIIRS: 21 }} sourceLabel="Live NASA FIRMS, last 1 day" />
  );
  assert.match(html, /data-testid="count-MODIS"[\s\S]*?>9</);
  assert.match(html, /data-testid="count-VIIRS"[\s\S]*?>21</);
  assert.doesNotMatch(html, />30</); // never summed
  assert.ok(html.toLowerCase().includes(SENSOR_COLOR.MODIS));
  assert.ok(html.toLowerCase().includes(SENSOR_COLOR.VIIRS));
  assert.match(html, new RegExp(`width:${LEGEND_SWATCH_PX.MODIS}px`));
  assert.match(html, new RegExp(`width:${LEGEND_SWATCH_PX.VIIRS}px`));
  assert.match(html, /Dot size = pixel footprint: MODIS 1 km, VIIRS 375 m; cloud intensity = FRP/);
  assert.match(html, /not confirmed wildfires/);
});

test('area chip is a labelled 44px button and names the default area', () => {
  const chip = renderToString(<AreaChip area={DEFAULT_AREA} onChange={() => undefined} />);
  assert.match(chip, /Area:/);
  assert.match(chip, /Change on map/);
  assert.match(chip, /min-h-touch/);
  assert.ok(chip.includes(`aria-label="Area: ${DEFAULT_AREA.name}`));
});
