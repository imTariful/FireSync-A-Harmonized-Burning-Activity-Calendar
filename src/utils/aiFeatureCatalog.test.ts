/**
 * AI feature catalog tests.
 *
 * The catalog is the single source of truth for the AI Intelligence hub, so these tests pin
 * completeness (all 16 features), honest status counts and the deep-link targets.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_FEATURES,
  AI_FEATURE_PHASES,
  aiFeatureById,
  aiFeatureStatusCounts,
  groupAiFeatures,
} from './aiFeatureCatalog';

test('the catalog lists all 16 features exactly once', () => {
  assert.equal(AI_FEATURES.length, 16);
  assert.deepEqual(
    AI_FEATURES.map((feature) => feature.id),
    Array.from({ length: 16 }, (_, index) => index + 1)
  );
  assert.equal(new Set(AI_FEATURES.map((feature) => feature.title)).size, 16);
});

test('status counts describe the current deployment honestly', () => {
  assert.deepEqual(aiFeatureStatusCounts(), {
    total: 16,
    available: 12,
    partial: 2,
    unavailable: 2,
  });
});

test('every feature is assigned to a known phase and every phase is represented', () => {
  const groups = groupAiFeatures();
  assert.equal(groups.length, AI_FEATURE_PHASES.length);
  assert.deepEqual(
    groups.map((group) => group.phase),
    [...AI_FEATURE_PHASES]
  );
  assert.equal(
    groups.reduce((total, group) => total + group.features.length, 0),
    AI_FEATURES.length
  );
  for (const feature of AI_FEATURES) {
    assert.ok(AI_FEATURE_PHASES.includes(feature.phase), `${feature.title} has an unknown phase`);
  }
});

test('every feature states its availability and limitations', () => {
  for (const feature of AI_FEATURES) {
    assert.ok(feature.summary.length > 0, `feature ${feature.id} has no summary`);
    assert.ok(feature.availabilityNote.length > 0, `feature ${feature.id} has no availability note`);
    assert.ok(feature.limitations.length > 0, `feature ${feature.id} has no limitations`);
    for (const limitation of feature.limitations) {
      assert.ok(limitation.trim().length > 0, `feature ${feature.id} has an empty limitation`);
    }
  }
});

test('unavailable features never point at a fake simulation surface', () => {
  for (const feature of AI_FEATURES.filter((entry) => entry.status === 'unavailable')) {
    assert.doesNotMatch(
      feature.availabilityNote,
      /^available:/i,
      `${feature.title} must not claim availability`
    );
    assert.doesNotMatch(
      feature.summary,
      /simulated result|predicted perimeter|confirmed wildfire/i,
      `${feature.title} must not claim a result it does not have`
    );
  }
});

test('feature 16 exposes all ten geographic sub-capabilities', () => {
  const feature = aiFeatureById(16);
  assert.ok(feature);
  assert.equal(feature.status, 'partial');
  assert.equal(feature.subCapabilities?.length, 10);
  assert.deepEqual(
    feature.subCapabilities?.map((sub) => sub.label),
    [
      'Hotspot density',
      'Country and district analysis',
      'Proximity analysis',
      'Land-cover analysis',
      'Fire cluster evolution',
      'Terrain analysis',
      'Geographic anomaly detection',
      'Environmental context',
      'Population exposure screening',
      'Cross-border activity analysis',
    ]
  );
  assert.equal(feature.subCapabilities?.filter((sub) => sub.status === 'available').length, 2);
  assert.equal(feature.subCapabilities?.filter((sub) => sub.status === 'partial').length, 1);
  assert.equal(feature.subCapabilities?.filter((sub) => sub.status === 'unavailable').length, 7);
});

test('deep links target implemented AI tabs and geographic layers', () => {
  const actions = AI_FEATURES.flatMap((feature) => (feature.action ? [feature.action] : []));
  assert.ok(actions.length >= 8);
  for (const action of actions) {
    assert.ok(action.label.trim().length > 0);
    if (action.kind === 'ai_tab') {
      assert.ok(['chat', 'evidence', 'cluster', 'sensors', 'audit', 'watch', 'scenario'].includes(action.tab));
    }
    if (action.kind === 'geo_layer') {
      assert.ok(['density', 'clusters', 'coverage', 'regions', 'compare', 'weather'].includes(action.layer));
    }
    if (action.kind === 'page') {
      assert.ok(['calendar', 'hotspots', 'geographic'].includes(action.page));
    }
  }
});

test('feature lookup returns the requested entry and nothing for unknown ids', () => {
  assert.equal(aiFeatureById(1)?.title, 'Ask FireSync: AI Map Copilot');
  assert.equal(aiFeatureById(16)?.title, 'AI Geographic Fire Intelligence Lab');
  assert.equal(aiFeatureById(99), undefined);
});
