import test from 'ava';
import {
  classifyBlockNature,
  enforceDensityGuard,
  assessManMadeDensity,
  shouldEnforceOccupiedAreaGuard,
  validateSafetyLimits
} from '../src/build-safety.js';
import { normalizeBounds } from '../src/build-coordination.js';

test('validateSafetyLimits rejects oversized footprint', (t) => {
  const error = t.throws(() => validateSafetyLimits({
    bounds: normalizeBounds(0, 60, 0, 100, 65, 100),
    plannedOperations: 100,
    plannedAirOperations: 0
  }));

  t.truthy(error?.message.includes('footprint'));
});

test('validateSafetyLimits rejects excessive air edits', (t) => {
  const error = t.throws(() => validateSafetyLimits({
    bounds: normalizeBounds(0, 60, 0, 8, 68, 8),
    plannedOperations: 200,
    plannedAirOperations: 5000
  }));

  t.truthy(error?.message.includes('air edits'));
});

test('classifyBlockNature classifies empty, natural, and manmade blocks', (t) => {
  t.is(classifyBlockNature('air'), 'empty');
  t.is(classifyBlockNature('grass_block'), 'natural');
  t.is(classifyBlockNature('stone_bricks'), 'manmade');
});

test('assessManMadeDensity identifies dense occupied area', (t) => {
  const bounds = normalizeBounds(0, 60, 0, 10, 66, 10);
  const assessment = assessManMadeDensity(bounds, () => 'stone_bricks');
  t.true(assessment.sampledBlocks > 0);
  t.true(assessment.ratio > 0.9);
});

test('enforceDensityGuard throws when manmade ratio is too high', (t) => {
  const error = t.throws(() => enforceDensityGuard({
    manMadeBlocks: 30,
    naturalBlocks: 0,
    sampledBlocks: 30,
    ratio: 1
  }));
  t.truthy(error?.message.includes('occupied'));
});

test('shouldEnforceOccupiedAreaGuard only runs for destructive edits', (t) => {
  const bounds = normalizeBounds(0, 63, 0, 10, 68, 10);

  t.false(shouldEnforceOccupiedAreaGuard({
    bounds,
    plannedOperations: 500,
    plannedAirOperations: 0
  }));

  t.true(shouldEnforceOccupiedAreaGuard({
    bounds,
    plannedOperations: 120,
    plannedAirOperations: 4
  }));
});
