import test from 'ava';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BuildCoordinationStore,
  boxesOverlapWithGap,
  boxesOverlap,
  normalizeBounds
} from '../src/build-coordination.js';

async function createTempStore(): Promise<{ store: BuildCoordinationStore; baseDir: string }> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sam-mc-coord-test-'));
  return { store: new BuildCoordinationStore(baseDir), baseDir };
}

test('normalizeBounds and overlap helpers work correctly', (t) => {
  const a = normalizeBounds(10, 70, 10, 20, 80, 20);
  const b = normalizeBounds(18, 72, 18, 24, 84, 24);
  const c = normalizeBounds(30, 70, 30, 40, 80, 40);
  const d = normalizeBounds(22, 70, 10, 28, 80, 20);

  t.deepEqual(a, { minX: 10, minY: 70, minZ: 10, maxX: 20, maxY: 80, maxZ: 20 });
  t.true(boxesOverlap(a, b));
  t.false(boxesOverlap(a, c));
  t.true(boxesOverlapWithGap(a, d, 2));
  t.false(boxesOverlapWithGap(a, d, 1));
});

test('claimZone rejects overlap with another owner', async (t) => {
  const { store, baseDir } = await createTempStore();
  t.teardown(async () => fs.rm(baseDir, { recursive: true, force: true }));

  const first = await store.claimZone(
    'HandyHank_l33',
    'zone_hank',
    normalizeBounds(0, 60, 0, 12, 90, 12),
    600
  );
  t.true(first.ok);

  const conflict = await store.claimZone(
    'BuildBea_l33',
    'zone_bea',
    normalizeBounds(8, 60, 8, 20, 90, 20),
    600
  );
  t.false(conflict.ok);
  t.truthy(conflict.message.includes('Zone claim conflict'));
});

test('claimZone enforces 2-block footprint buffer between owners', async (t) => {
  const { store, baseDir } = await createTempStore();
  t.teardown(async () => fs.rm(baseDir, { recursive: true, force: true }));

  const first = await store.claimZone(
    'HandyHank_l33',
    'zone_hank',
    normalizeBounds(0, 60, 0, 6, 90, 6),
    600
  );
  t.true(first.ok);

  const tooClose = await store.claimZone(
    'BuildBea_l33',
    'zone_bea_too_close',
    normalizeBounds(8, 60, 0, 14, 90, 6),
    600
  );
  t.false(tooClose.ok);
  t.true(tooClose.message.includes('2-block footprint buffer'));

  const allowed = await store.claimZone(
    'BuildBea_l33',
    'zone_bea_ok',
    normalizeBounds(9, 60, 0, 15, 90, 6),
    600
  );
  t.true(allowed.ok);
});

test('verifyReservation requires full coverage by owner claim', async (t) => {
  const { store, baseDir } = await createTempStore();
  t.teardown(async () => fs.rm(baseDir, { recursive: true, force: true }));

  await store.claimZone(
    'SupplySid_l31',
    'sid_zone',
    normalizeBounds(20, 60, 20, 30, 95, 30),
    600
  );

  const ok = await store.verifyReservation(
    'SupplySid_l31',
    normalizeBounds(22, 65, 22, 28, 80, 28)
  );
  t.true(ok.ok);

  const notCovered = await store.verifyReservation(
    'SupplySid_l31',
    normalizeBounds(18, 65, 18, 28, 80, 28)
  );
  t.false(notCovered.ok);
  t.truthy(notCovered.message.includes('not fully'));
});

test('verifyReservation is footprint-based (x/z) regardless of y span', async (t) => {
  const { store, baseDir } = await createTempStore();
  t.teardown(async () => fs.rm(baseDir, { recursive: true, force: true }));

  await store.claimZone(
    'DesignDora_l4s',
    'dora_zone',
    normalizeBounds(10, 64, 10, 18, 70, 18),
    600
  );

  const highY = await store.verifyReservation(
    'DesignDora_l4s',
    normalizeBounds(11, 80, 11, 17, 90, 17)
  );

  t.true(highY.ok);
});

test('expired claims are purged from store', async (t) => {
  const { store, baseDir } = await createTempStore();
  t.teardown(async () => fs.rm(baseDir, { recursive: true, force: true }));

  const claimsFile = path.join(baseDir, 'zone-claims.json');
  await fs.writeFile(
    claimsFile,
    JSON.stringify({
      claims: [
        {
          zoneId: 'expired_zone',
          owner: 'ForestFinn_q32',
          minX: 0,
          minY: 60,
          minZ: 0,
          maxX: 10,
          maxY: 90,
          maxZ: 10,
          createdAt: 1,
          updatedAt: 1,
          expiresAt: Date.now() - 1000
        }
      ]
    }),
    'utf8'
  );

  const claims = await store.listClaims();
  t.is(claims.length, 0);
});

test('progress board supports filtered reads', async (t) => {
  const { store, baseDir } = await createTempStore();
  t.teardown(async () => fs.rm(baseDir, { recursive: true, force: true }));

  await store.reportProgress({
    taskId: 'task-a',
    zoneId: 'zone-1',
    owner: 'DesignDora_l4s',
    phase: 'claimed'
  });
  await store.reportProgress({
    taskId: 'task-b',
    zoneId: 'zone-2',
    owner: 'MinecraftAgent',
    phase: 'building'
  });

  const taskAEntries = await store.getProgressBoard('task-a');
  const allEntries = await store.getProgressBoard();

  t.is(taskAEntries.length, 1);
  t.is(taskAEntries[0].taskId, 'task-a');
  t.true(allEntries.length >= 2);
});

test('claimZonesBatch allocates all zones atomically for parallel workers', async (t) => {
  const { store, baseDir } = await createTempStore();
  t.teardown(async () => fs.rm(baseDir, { recursive: true, force: true }));

  const result = await store.claimZonesBatch(
    [
      {
        owner: 'HandyHank_l33',
        zoneId: 'house_01',
        bounds: normalizeBounds(0, 60, 0, 6, 90, 6),
        ttlSeconds: 600
      },
      {
        owner: 'BuildBea_l33',
        zoneId: 'house_02',
        bounds: normalizeBounds(9, 60, 0, 15, 90, 6),
        ttlSeconds: 600
      }
    ],
    { clearExistingForOwners: true }
  );

  t.true(result.ok);
  t.is(result.claims.length, 2);

  const verifyHank = await store.verifyReservation(
    'HandyHank_l33',
    normalizeBounds(1, 65, 1, 5, 80, 5)
  );
  const verifyBea = await store.verifyReservation(
    'BuildBea_l33',
    normalizeBounds(10, 65, 1, 14, 80, 5)
  );

  t.true(verifyHank.ok);
  t.true(verifyBea.ok);
});

test('claimZonesBatch allows touching landmark subzones when spacing is zero', async (t) => {
  const { store, baseDir } = await createTempStore();
  t.teardown(async () => fs.rm(baseDir, { recursive: true, force: true }));

  const result = await store.claimZonesBatch(
    [
      {
        owner: 'HandyHank_l33',
        zoneId: 'tower_base_west',
        bounds: normalizeBounds(0, 60, 0, 6, 90, 6),
        ttlSeconds: 600,
        spacingBlocks: 0
      },
      {
        owner: 'BuildBea_l33',
        zoneId: 'tower_base_east',
        bounds: normalizeBounds(7, 60, 0, 13, 90, 6),
        ttlSeconds: 600,
        spacingBlocks: 0
      }
    ],
    { clearExistingForOwners: true }
  );

  t.true(result.ok);
  t.is(result.claims.length, 2);

  const verifyWest = await store.verifyReservation(
    'HandyHank_l33',
    normalizeBounds(1, 65, 1, 5, 80, 5)
  );
  const verifyEast = await store.verifyReservation(
    'BuildBea_l33',
    normalizeBounds(8, 65, 1, 12, 80, 5)
  );

  t.true(verifyWest.ok);
  t.true(verifyEast.ok);
});

test('claimZonesBatch fails without partial writes when one zone conflicts', async (t) => {
  const { store, baseDir } = await createTempStore();
  t.teardown(async () => fs.rm(baseDir, { recursive: true, force: true }));

  await store.claimZone(
    'DesignDora_l4s',
    'design_zone',
    normalizeBounds(0, 60, 0, 8, 90, 8),
    600
  );

  const failed = await store.claimZonesBatch(
    [
      {
        owner: 'HandyHank_l33',
        zoneId: 'house_01',
        bounds: normalizeBounds(10, 60, 0, 16, 90, 6),
        ttlSeconds: 600
      },
      {
        owner: 'BuildBea_l33',
        zoneId: 'house_02',
        bounds: normalizeBounds(7, 60, 0, 13, 90, 6),
        ttlSeconds: 600
      }
    ],
    { clearExistingForOwners: true }
  );

  t.false(failed.ok);
  t.truthy(failed.message.includes('Batch allocation conflict'));

  const claims = await store.listClaims();
  t.is(claims.length, 1);
  t.is(claims[0].zoneId, 'design_zone');
});

test('claimZonesBatch can replace stale zones for the same owners', async (t) => {
  const { store, baseDir } = await createTempStore();
  t.teardown(async () => fs.rm(baseDir, { recursive: true, force: true }));

  await store.claimZone(
    'SupplySid_l31',
    'old_sid_zone',
    normalizeBounds(30, 60, 0, 36, 90, 6),
    600
  );
  await store.claimZone(
    'ForestFinn_q32',
    'finn_keep_zone',
    normalizeBounds(50, 60, 0, 56, 90, 6),
    600
  );

  const replaced = await store.claimZonesBatch(
    [
      {
        owner: 'SupplySid_l31',
        zoneId: 'sid_new_zone',
        bounds: normalizeBounds(0, 60, 20, 6, 90, 26),
        ttlSeconds: 600
      }
    ],
    { clearExistingForOwners: true }
  );

  t.true(replaced.ok);
  const claims = await store.listClaims();
  t.truthy(claims.some((claim) => claim.zoneId === 'sid_new_zone'));
  t.false(claims.some((claim) => claim.zoneId === 'old_sid_zone'));
  t.true(claims.some((claim) => claim.zoneId === 'finn_keep_zone'));
});
