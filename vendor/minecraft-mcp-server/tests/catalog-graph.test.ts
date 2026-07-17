import test from 'ava';
import type { CatalogModelArtifact } from '../src/catalog-import.js';
import { createCatalogPlacementArtifact } from '../src/catalog-graph.js';

test('createCatalogPlacementArtifact builds sequential bands with exact block counts', (t) => {
  const artifact: CatalogModelArtifact = {
    schemaVersion: '1.0',
    kind: 'catalog-model',
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

  const placement = createCatalogPlacementArtifact({
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

test('createCatalogPlacementArtifact splits large structural bands across three workers when the footprint is large enough', (t) => {
  const blocks: CatalogModelArtifact['blocks'] = [];
  for (let x = 1; x <= 60; x += 1) {
    for (let z = 1; z <= 30; z += 1) {
      blocks.push({ x, y: 1, z, paletteKey: 'stone' });
    }
  }

  const artifact: CatalogModelArtifact = {
    schemaVersion: '1.0',
    kind: 'catalog-model',
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

  const placement = createCatalogPlacementArtifact({
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

test('createCatalogPlacementArtifact caps dense one-layer shards below safety footprint limits', (t) => {
  const blocks: CatalogModelArtifact['blocks'] = [];
  for (let x = 1; x <= 100; x += 1) {
    for (let z = 1; z <= 60; z += 1) {
      blocks.push({ x, y: 1, z, paletteKey: 'stone' });
    }
  }

  const artifact: CatalogModelArtifact = {
    schemaVersion: '1.0',
    kind: 'catalog-model',
    source: {
      pageUrl: 'https://example.com/model',
      fetchedAt: '2026-03-25T00:00:00.000Z',
      title: 'Dense Foundation'
    },
    stats: {
      importedBlocks: blocks.length,
      paletteSize: 1,
      layerCount: 1,
      bounds: {
        minX: 1,
        maxX: 100,
        minY: 1,
        maxY: 1,
        minZ: 1,
        maxZ: 60
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

  const placement = createCatalogPlacementArtifact({
    graphId: 'graph_dense',
    model: artifact,
    originX: 0,
    originY: 64,
    originZ: 0
  });

  t.is(
    placement.shards.reduce((sum, shard) => sum + shard.blockCount, 0),
    blocks.length
  );
  t.true(placement.shards.length > 6);
  for (const shard of placement.shards) {
    const footprint = (shard.bounds.maxX - shard.bounds.minX + 1) *
      (shard.bounds.maxZ - shard.bounds.minZ + 1);
    t.true(footprint <= 1000);
    t.true(shard.blockCount <= 1000);
  }
});

test('createCatalogPlacementArtifact keeps sub-shard owners stable within each vertical footprint lane', (t) => {
  const blocks: CatalogModelArtifact['blocks'] = [];
  for (let y = 1; y <= 2; y += 1) {
    for (let x = 1; x <= 100; x += 1) {
      for (let z = 1; z <= 60; z += 1) {
        blocks.push({ x, y, z, paletteKey: 'stone' });
      }
    }
  }

  const artifact: CatalogModelArtifact = {
    schemaVersion: '1.0',
    kind: 'catalog-model',
    source: {
      pageUrl: 'https://example.com/model',
      fetchedAt: '2026-03-25T00:00:00.000Z',
      title: 'Two Layer Dense Foundation'
    },
    stats: {
      importedBlocks: blocks.length,
      paletteSize: 1,
      layerCount: 2,
      bounds: {
        minX: 1,
        maxX: 100,
        minY: 1,
        maxY: 2,
        minZ: 1,
        maxZ: 60
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

  const placement = createCatalogPlacementArtifact({
    graphId: 'graph_stable_lanes',
    model: artifact,
    originX: 0,
    originY: 64,
    originZ: 0
  });

  const westShards = placement.shards.filter((shard) => shard.shardId.includes('_west'));
  const centerShards = placement.shards.filter((shard) => shard.shardId.includes('_center'));
  const eastShards = placement.shards.filter((shard) => shard.shardId.includes('_east'));

  t.true(westShards.length > 2);
  t.true(centerShards.length > 2);
  t.true(eastShards.length > 2);
  t.true(westShards.every((shard) => shard.assignedWorker === 'MinecraftAgent'));
  t.true(centerShards.every((shard) => shard.assignedWorker === 'BuildBeaAgent'));
  t.true(eastShards.every((shard) => shard.assignedWorker === 'MonumentMarcAgent'));
});
