import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CalendarPage, type CalendarView } from './CalendarPage';
import { Navbar } from '../components/layout/Navbar';
import { DEFAULT_AREA } from '../utils/area';
import { defaultFilters } from '../utils/filterValidation';
import { FIRE_LEGEND } from '../types/ai';

const noop = () => undefined;
const render = (view: CalendarView, selectedArea: typeof DEFAULT_AREA | null = null) => renderToStaticMarkup(
  <CalendarPage dailySummaries={[]} area={DEFAULT_AREA} filters={defaultFilters()}
    view={view} onViewChange={noop} selectedArea={selectedArea}
    onNavigateToMapWithDate={noop} />
);

test('one calendar offers the existing daily, monthly and monitoring views', () => {
  const html = render('daily');
  for (const label of ['Daily calendar', 'Monthly AgniCalendar', 'Early monitoring', FIRE_LEGEND]) assert.ok(html.includes(label));
  assert.match(html, /Daily Burning/);
  assert.doesNotMatch(html, /New watchlist/);
});

test('monthly view keeps monthly resolution and does not render live daily statistics', () => {
  const html = render('monthly', DEFAULT_AREA);
  assert.match(html, /10 km harmonized grid/);
  assert.match(html, /2002–2025/);
  assert.doesNotMatch(html, /Days in range|New watchlist|Historical Fire Intelligence/);
});

test('monitoring works without an AI status and embeds area selection instead of coordinates or navigation', () => {
  const html = render('monitoring');
  assert.match(html, /Flat monitoring area map/);
  assert.match(html, /Search monitoring place/);
  assert.match(html, /Draw an area/);
  assert.match(html, /independent of the calendar date filters/);
  assert.match(html, /Save watchlist/);
  assert.match(html, /disabled=""[^>]*>.*?Save watchlist/);
  assert.doesNotMatch(html, /Watchlist bounding box|bbox west,south,east,north|Daily Burning|Choose area on map|Change area on map/);
});

test('monitoring identifies the selected area and states its rectangular extent', () => {
  const html = render('monitoring', { ...DEFAULT_AREA, name: 'Dhaka test area' });
  assert.match(html, /Monitoring area: Dhaka test area/);
  assert.match(html, /Clear selection/);
  assert.match(html, /shaded rectangle/);
  assert.match(html, /not an administrative boundary/);
  assert.match(html, /in-app alerts only|No email or push/);
});

test('drawn area monitoring warns that its enclosing rectangle includes outside locations', () => {
  const html = render('monitoring', { ...DEFAULT_AREA, polygon: [[88, 20], [89, 20], [89, 21]] });
  assert.match(html, /includes locations outside your drawn polygon/);
});

test('navigation exposes a single Calendar destination', () => {
  const html = renderToStaticMarkup(<Navbar activeTab="calendar" setActiveTab={noop} />);
  assert.match(html, />Calendar</);
  assert.doesNotMatch(html, /AgniCalendar|Fire Intelligence|Burning Calendar/);
});
