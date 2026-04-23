import test from 'ava';
import { buildPlacementPlan, translateGrabCraftBlockName } from '../src/grabcraft-place.js';
import type { GrabCraftModelArtifact } from '../src/grabcraft-import.js';

test('translateGrabCraftBlockName maps legacy stairs and slab variants', (t) => {
  t.is(
    translateGrabCraftBlockName('Sandstone Stairs (North, Normal)'),
    'minecraft:sandstone_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]'
  );
  t.is(
    translateGrabCraftBlockName('Stone Slab (Upper)'),
    'minecraft:smooth_stone_slab[type=top,waterlogged=false]'
  );
  t.is(
    translateGrabCraftBlockName('Torch (Facing East)'),
    'minecraft:wall_torch[facing=east]'
  );
  t.is(
    translateGrabCraftBlockName('Stone Button (Facing South, Inactive)'),
    'minecraft:stone_button[face=wall,facing=south,powered=false]'
  );
});

test('translateGrabCraftBlockName preserves exact minecraft block states', (t) => {
  t.is(
    translateGrabCraftBlockName('minecraft:quartz_stairs[facing=west,half=top,shape=straight,waterlogged=false]'),
    'minecraft:quartz_stairs[facing=west,half=top,shape=straight,waterlogged=false]'
  );
  t.is(
    translateGrabCraftBlockName('minecraft:white_concrete'),
    'minecraft:white_concrete'
  );
});

test('buildPlacementPlan skips unsupported palette entries and offsets coordinates', (t) => {
  const artifact: GrabCraftModelArtifact = {
    schemaVersion: '1.0',
    kind: 'grabcraft-model',
    source: {
      pageUrl: 'https://example.com',
      fetchedAt: '2026-03-24T00:00:00.000Z',
      title: 'Sample'
    },
    stats: {
      importedBlocks: 3,
      paletteSize: 3,
      layerCount: 2,
      bounds: {
        minX: 10,
        maxX: 11,
        minY: 5,
        maxY: 6,
        minZ: 20,
        maxZ: 21
      }
    },
    palette: [
      {
        paletteKey: 'stone',
        materialId: '4',
        name: 'Stone',
        transparent: false,
        opacity: 1,
        count: 1
      },
      {
        paletteKey: 'torch',
        materialId: '50',
        name: 'Torch (Facing North)',
        transparent: true,
        opacity: 1,
        count: 1
      },
      {
        paletteKey: 'unsupported',
        materialId: '999',
        name: 'Impossible Legacy Block',
        transparent: false,
        opacity: 1,
        count: 1
      }
    ],
    layers: [],
    blocks: [
      { x: 10, y: 5, z: 20, paletteKey: 'stone' },
      { x: 11, y: 6, z: 21, paletteKey: 'torch' },
      { x: 10, y: 6, z: 21, paletteKey: 'unsupported' }
    ]
  };

  const plan = buildPlacementPlan(artifact, 100, 64, 200);
  t.is(plan.translatedBlocks.length, 2);
  t.is(plan.skippedPalette.length, 1);
  t.deepEqual(plan.translatedBlocks[0], {
    x: 100,
    y: 64,
    z: 200,
    blockState: 'minecraft:stone',
    blockName: 'stone',
    originalPaletteKey: 'stone'
  });
  t.deepEqual(plan.translatedBlocks[1], {
    x: 101,
    y: 65,
    z: 201,
    blockState: 'minecraft:wall_torch[facing=north]',
    blockName: 'wall_torch',
    originalPaletteKey: 'torch'
  });
});
