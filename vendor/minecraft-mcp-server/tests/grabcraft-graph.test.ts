import test from 'ava';
import type { GrabCraftModelArtifact } from '../src/grabcraft-import.js';
import { createGrabCraftPlacementArtifact } from '../src/grabcraft-graph.js';

test('createGrabCraftPlacementArtifact builds sequential bands with exact block counts', (t) => {
  const artifact: GrabCraftModelArtifact = {
    schemaVersion: '1.0',
    kind: 'grabcraft-model',
    source: {
      pageUrl: 'https://example.com/model',
      fetchedAt: '2026-03-25T00:00:00.000Z',
      title: 'Sample Monument'
    },
    stats: {
      importedBlocks: 8,
      paletteSize: 1,
      layerCount: 8,
      bounds: {
        minX: 1,
        maxX: 2,
        minY: 1,
        maxY: 8,
        minZ: 1,
        maxZ: 1
      }
    },
    palette: [
      {
        paletteKey: 'stone',
        materialId: '4',
        name: 'Stone',
        transparent: false,
        opacity: 1,
        count: 8
      }
    ],
    layers: [],
    blocks: [
      { x: 1, y: 1, z: 1, paletteKey: 'stone' },
      { x: 2, y: 1, z: 1, paletteKey: 'stone' },
      { x: 1, y: 2, z: 1, paletteKey: 'stone' },
      { x: 2, y: 2, z: 1, paletteKey: 'stone' },
      { x: 1, y: 7, z: 1, paletteKey: 'stone' },
      { x: 2, y: 7, z: 1, paletteKey: 'stone' },
      { x: 1, y: 8, z: 1, paletteKey: 'stone' },
      { x: 2, y: 8, z: 1, paletteKey: 'stone' }
    ]
  };

  const placement = createGrabCraftPlacementArtifact({
    graphId: 'graph_demo',
    model: artifact,
    originX: 100,
    originY: 64,
    originZ: 200
  });

  t.is(placement.stats.translatedBlocks, 8);
  t.true(placement.shards.length >= 2);
  t.is(
    placement.shards.reduce((sum, shard) => sum + shard.blockCount, 0),
    8
  );
  t.true(placement.shards[0].dependencies.length === 0);
  t.true(
    placement.shards.slice(1).some((shard) => shard.dependencies.length > 0)
  );
});

test('createGrabCraftPlacementArtifact splits large structural bands across three workers when the footprint is large enough', (t) => {
  const blocks: GrabCraftModelArtifact['blocks'] = [];
  for (let x = 1; x <= 60; x += 1) {
    for (let z = 1; z <= 30; z += 1) {
      blocks.push({ x, y: 1, z, paletteKey: 'stone' });
    }
  }

  const artifact: GrabCraftModelArtifact = {
    schemaVersion: '1.0',
    kind: 'grabcraft-model',
    source: {
      pageUrl: 'https://example.com/model',
      fetchedAt: '2026-03-25T00:00:00.000Z',
      title: 'Wide Foundation'
    },
    stats: {
      importedBlocks: blocks.length,
      paletteSize: 1,
      layerCount: 1,
      bounds: {
        minX: 1,
        maxX: 60,
        minY: 1,
        maxY: 1,
        minZ: 1,
        maxZ: 30
      }
    },
    palette: [
      {
        paletteKey: 'stone',
        materialId: '4',
        name: 'Stone',
        transparent: false,
        opacity: 1,
        count: blocks.length
      }
    ],
    layers: [],
    blocks
  };

  const placement = createGrabCraftPlacementArtifact({
    graphId: 'graph_split',
    model: artifact,
    originX: 0,
    originY: 64,
    originZ: 0
  });

  t.true(placement.shards.length >= 3);
  t.true(placement.shards.some((shard) => shard.shardId.endsWith('_west')));
  t.true(placement.shards.some((shard) => shard.shardId.endsWith('_center')));
  t.true(placement.shards.some((shard) => shard.shardId.endsWith('_east')));
  t.is(
    placement.shards.reduce((sum, shard) => sum + shard.blockCount, 0),
    blocks.length
  );
  t.true(
    placement.shards.some((shard) => shard.assignedWorker === 'MinecraftAgent')
  );
  t.true(
    placement.shards.some((shard) => shard.assignedWorker === 'BuildBeaAgent')
  );
  t.true(
    placement.shards.some((shard) => shard.assignedWorker === 'MonumentMarcAgent')
  );
  const west = placement.shards.find((shard) => shard.shardId.endsWith('_west'));
  const center = placement.shards.find((shard) => shard.shardId.endsWith('_center'));
  const east = placement.shards.find((shard) => shard.shardId.endsWith('_east'));
  t.truthy(west);
  t.truthy(center);
  t.truthy(east);
  t.true((west?.bounds.maxX ?? 0) < (center?.bounds.minX ?? 0));
  t.true((center?.bounds.maxX ?? 0) < (east?.bounds.minX ?? 0));
});
