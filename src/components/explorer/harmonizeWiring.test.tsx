import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ExplorerToolbar } from './ExplorerToolbar';
import { HarmonizeSkeleton } from './HarmonizeSkeleton';

// Run with: npx tsx --test src/components/explorer/harmonizeWiring.test.tsx
// Included in the `npm test` script.

test('toolbar has a Harmonize button that reports closed state and keeps the 44px touch class', () => {
  const html = renderToString(<ExplorerToolbar onAction={() => undefined} harmonizeOpen={false} />);
  assert.match(html, /Harmonize/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /min-h-touch/);
});

test('toolbar reflects the open state of the drawer', () => {
  const html = renderToString(<ExplorerToolbar onAction={() => undefined} harmonizeOpen />);
  assert.match(html, /aria-expanded="true"/);
});

test('skeleton is announced to assistive tech and only animates when motion is allowed', () => {
  const html = renderToString(<HarmonizeSkeleton />);
  assert.match(html, /role="status"/);
  assert.match(html, /motion-safe:animate-pulse/);
  assert.doesNotMatch(html, /(^|[\s"])animate-pulse/);
});
