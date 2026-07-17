import test from 'ava';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  importOtsBlockModelAsCatalogModel,
  resolveOtsBlockModelReference
} from '../src/ots-blocks-import.js';
import { createCatalogPlacementArtifact } from '../src/catalog-graph.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(currentDir, '..');

test('resolveOtsBlockModelReference matches the natural Munich landmark prompt', async (t) => {
  const resolved = await resolveOtsBlockModelReference({
    modelName: 'create a famous building in Munich'
  });

  t.is(resolved.resolvedVia, 'registry');
  t.is(resolved.id, 'munich-famous-building');
  t.is(resolved.title, 'Munich Famous Building');
  t.is(
    resolved.filePath,
    path.join(serverRoot, 'local_structures', 'munich_famous_building.ots_blocks')
  );
});

test('importOtsBlockModelAsCatalogModel reads the bundled Munich OTS model', async (t) => {
  const model = await importOtsBlockModelAsCatalogModel({
    filePath: path.join(serverRoot, 'local_structures', 'munich_famous_building.ots_blocks'),
    title: 'Munich Famous Building'
  });

  t.is(model.source.title, 'Munich Famous Building');
  t.is(model.source.blockCount, 13549);
  t.deepEqual(model.source.dimensions, { x: 96, y: 69, z: 60 });
});

test('Munich OTS placement rotates shards across the full worker roster', async (t) => {
  const model = await importOtsBlockModelAsCatalogModel({
    filePath: path.join(serverRoot, 'local_structures', 'munich_famous_building.ots_blocks'),
    title: 'Munich Famous Building'
  });
  const placement = createCatalogPlacementArtifact({
    graphId: 'test_munich',
    model,
    originX: 0,
    originY: 64,
    originZ: 0
  });

  const assignedWorkers = new Set(placement.shards.map((shard) => shard.assignedWorker));
  t.deepEqual(
    Array.from(assignedWorkers).sort(),
    [
      'BuildBeaAgent',
      'DesignDoraAgent',
      'ForestFinnAgent',
      'MinecraftAgent',
      'MonumentMarcAgent',
      'SupplySidAgent'
    ]
  );
});
