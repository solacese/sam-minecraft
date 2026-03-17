import test from 'ava';
import {
  parseSetblockPlacement,
  validateGroundedPlacement
} from '../src/placement-guard.js';

test('parseSetblockPlacement parses coordinates and block states', (t) => {
  const parsed = parseSetblockPlacement('/setblock 12 65 -7 minecraft:torch[facing=north]');
  t.deepEqual(parsed, {
    x: 12,
    y: 65,
    z: -7,
    blockType: 'minecraft:torch[facing=north]'
  });
});

test('validateGroundedPlacement rejects unsupported floating placement', (t) => {
  const message = validateGroundedPlacement({
    blockType: 'minecraft:stone',
    y: 70,
    targetOccupied: false,
    hasSolidNeighbor: false,
    surfaceY: 65,
    belowIsSolid: false,
    aboveIsAir: true
  });

  t.truthy(message?.includes('Refusing floating placement'));
});

test('validateGroundedPlacement enforces flower and torch surface placement', (t) => {
  const flowerMessage = validateGroundedPlacement({
    blockType: 'minecraft:poppy',
    y: 66,
    targetOccupied: false,
    hasSolidNeighbor: true,
    surfaceY: 65,
    belowIsSolid: true,
    aboveIsAir: true
  });
  t.truthy(flowerMessage?.includes('surface level'));

  const torchMessage = validateGroundedPlacement({
    blockType: 'minecraft:torch',
    y: 65,
    targetOccupied: false,
    hasSolidNeighbor: true,
    surfaceY: 65,
    belowIsSolid: false,
    aboveIsAir: true
  });
  t.truthy(torchMessage?.includes('solid block directly below'));
});

test('validateGroundedPlacement enforces path blocks on ground layer', (t) => {
  const wrongLayerMessage = validateGroundedPlacement({
    blockType: 'minecraft:gravel',
    y: 65,
    targetOccupied: false,
    hasSolidNeighbor: true,
    surfaceY: 65,
    belowIsSolid: true,
    aboveIsAir: true
  });
  t.truthy(wrongLayerMessage?.includes('ground layer'));

  const blockedAboveMessage = validateGroundedPlacement({
    blockType: 'minecraft:dirt_path',
    y: 64,
    targetOccupied: false,
    hasSolidNeighbor: true,
    surfaceY: 65,
    belowIsSolid: true,
    aboveIsAir: false
  });
  t.truthy(blockedAboveMessage?.includes('open air above'));
});

test('validateGroundedPlacement allows supported grounded placements', (t) => {
  const stoneMessage = validateGroundedPlacement({
    blockType: 'minecraft:stone',
    y: 64,
    targetOccupied: false,
    hasSolidNeighbor: true,
    surfaceY: 65,
    belowIsSolid: true,
    aboveIsAir: true
  });
  t.is(stoneMessage, null);

  const torchMessage = validateGroundedPlacement({
    blockType: 'minecraft:torch',
    y: 65,
    targetOccupied: false,
    hasSolidNeighbor: true,
    surfaceY: 65,
    belowIsSolid: true,
    aboveIsAir: true
  });
  t.is(torchMessage, null);
});
