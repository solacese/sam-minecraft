import test from 'ava';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildCoordinationStore } from '../src/build-coordination.js';
import {
  LandmarkAutonomyService,
  normalizeLandmarkSpec
} from '../src/landmark-autonomy.js';

interface Harness {
  baseDir: string;
  specDir: string;
  store: BuildCoordinationStore;
  service: LandmarkAutonomyService;
  setNow: (value: number) => void;
  advanceNow: (deltaMs: number) => void;
}

interface MinimalSpecOverrides {
  id?: string;
  name?: string;
  culture?: string;
  keywords?: string[];
  defaultStyle?: string;
  components?: unknown[];
}

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REAL_SPEC_DIR = path.resolve(TEST_DIR, '../landmark_specs');

function makeSpec(overrides: MinimalSpecOverrides = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    id: overrides.id ?? 'arc_test',
    name: overrides.name ?? 'Arc Test Landmark',
    culture: overrides.culture ?? 'France',
    description: 'Test spec',
    keywords: overrides.keywords ?? ['arc', 'france', 'landmark'],
    defaultStyle: overrides.defaultStyle ?? 'classic',
    styles: {
      classic: {
        primary: 'stone_bricks',
        secondary: 'smooth_stone',
        accent: 'quartz_block',
        detail: 'chiseled_stone_bricks',
        roof: 'stone_bricks',
        path: 'gravel',
        glass: 'glass_pane'
      }
    },
    components: overrides.components ?? [
      {
        id: 'foundation',
        label: 'Foundation',
        role: 'foundation',
        primaryTool: 'flatten-area',
        preferredWorker: 'WorkerA',
        offsetX: 0,
        offsetZ: 0,
        offsetY: 0,
        width: 9,
        depth: 7,
        height: 2
      },
      {
        id: 'main_arch',
        label: 'Main Arch',
        role: 'arches',
        primaryTool: 'fill-region',
        preferredWorker: 'WorkerA',
        dependencies: ['foundation'],
        offsetX: 0,
        offsetZ: 0,
        offsetY: 1,
        width: 7,
        depth: 3,
        height: 6,
        materialKey: 'primary',
        blockBudget: 180
      }
    ],
    qualityRules: ['solid-foundation', 'clean-silhouette']
  };
}

async function createHarness(
  specs: Array<Record<string, unknown>>,
  options: { taskTimeoutSeconds?: number } = {}
): Promise<Harness> {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sam-mc-landmark-test-'));
  const specDir = path.join(baseDir, 'specs');
  await fs.mkdir(specDir, { recursive: true });

  const fileNames: string[] = [];
  for (const spec of specs) {
    const id = String(spec.id);
    const fileName = `${id}.json`;
    fileNames.push(fileName);
    await fs.writeFile(path.join(specDir, fileName), JSON.stringify(spec, null, 2), 'utf8');
  }

  await fs.writeFile(
    path.join(specDir, 'index.json'),
    JSON.stringify({ specs: fileNames }, null, 2),
    'utf8'
  );

  let now = 1_760_000_000_000;
  const store = new BuildCoordinationStore(baseDir);
  const service = new LandmarkAutonomyService({
    specDir,
    baseDir,
    coordinationStore: store,
    resolveOwnerAlias: (value) => value,
    nowProvider: () => now,
    taskTimeoutSeconds: options.taskTimeoutSeconds ?? 180
  });

  return {
    baseDir,
    specDir,
    store,
    service,
    setNow: (value: number) => {
      now = value;
    },
    advanceNow: (deltaMs: number) => {
      now += deltaMs;
    }
  };
}

test('normalizeLandmarkSpec fills defaults for backward-compatible specs', (t) => {
  const raw = {
    id: 'legacy_spec',
    name: 'Legacy Spec',
    culture: 'Netherlands',
    keywords: ['canal', 'house'],
    defaultStyle: 'default',
    styles: {
      default: {
        primary: 'brick',
        secondary: 'stone_bricks',
        accent: 'oak_planks',
        detail: 'oak_fence',
        roof: 'oak_planks',
        path: 'gravel',
        glass: 'glass_pane'
      }
    },
    components: [
      {
        id: 'shell',
        label: 'Shell',
        role: 'walls',
        primaryTool: 'fill-region',
        offsetX: 0,
        offsetZ: 0,
        offsetY: 0,
        width: 5,
        depth: 5,
        height: 5
      }
    ]
  };

  const normalized = normalizeLandmarkSpec(raw);
  t.is(normalized.schemaVersion, '1.0');
  t.is(normalized.description, '');
  t.true(Boolean(normalized.scaleVariants.small));
  t.true(Boolean(normalized.scaleVariants.medium));
  t.true(Boolean(normalized.scaleVariants.large));
  t.deepEqual(normalized.components[0].dependencies, []);
  t.deepEqual(normalized.qualityRules, []);
});

test('selectLandmarkSpec chooses best spec from prompt and hints', async (t) => {
  const harness = await createHarness([
    makeSpec({ id: 'arc_fr', name: 'Arc de Triomphe', culture: 'France', keywords: ['arc', 'triomphe', 'france'] }),
    makeSpec({ id: 'windmill_nl', name: 'Dutch Windmill', culture: 'Netherlands', keywords: ['windmill', 'dutch', 'netherlands'] })
  ]);
  t.teardown(async () => fs.rm(harness.baseDir, { recursive: true, force: true }));

  const selected = await harness.service.selectLandmarkSpec(
    'Please build a grand dutch windmill with blades',
    'netherlands',
    'large'
  );

  t.is(selected.spec.id, 'windmill_nl');
  t.is(selected.recommendedScale, 'large');
  t.true(selected.score > 0);
});

test('discoverLandmarkCandidates ranks famous italian prompts into a usable shortlist', async (t) => {
  const harness = await createHarness([
    makeSpec({
      id: 'tower_of_pisa_it',
      name: 'Leaning Tower of Pisa',
      culture: 'it',
      keywords: ['pisa', 'tower', 'leaning', 'italy', 'italian']
    }),
    makeSpec({
      id: 'colosseum_it',
      name: 'Roman Colosseum',
      culture: 'it',
      keywords: ['colosseum', 'rome', 'roman', 'italy', 'italian']
    }),
    makeSpec({
      id: 'arc_fr',
      name: 'Arc de Triomphe',
      culture: 'fr',
      keywords: ['arc', 'triomphe', 'france', 'french']
    })
  ]);
  t.teardown(async () => fs.rm(harness.baseDir, { recursive: true, force: true }));

  const candidates = await harness.service.discoverLandmarkCandidates(
    'build a famous italian structure',
    undefined,
    'medium',
    3
  );

  t.is(candidates.length, 3);
  t.is(candidates[0].spec.id, 'tower_of_pisa_it');
  t.is(candidates[1].spec.id, 'colosseum_it');
  t.true(candidates[0].score >= candidates[1].score);
  t.true(candidates[1].score > candidates[2].score);
});

test('compileLandmarkBuildGraph emits valid dependency graph and budgets', async (t) => {
  const harness = await createHarness([makeSpec()]);
  t.teardown(async () => fs.rm(harness.baseDir, { recursive: true, force: true }));

  const graph = await harness.service.compileLandmarkBuildGraph({
    specId: 'arc_test',
    originX: 120,
    originZ: -80,
    baseY: 72,
    scale: 'medium',
    prompt: 'ornate tall monument'
  });

  t.is(graph.specId, 'arc_test');
  t.is(graph.graphStatus, 'planning');
  t.true(graph.nodes.length >= 2);
  t.true(graph.expectedBlocks > 0);
  t.true(graph.edges.some((edge) => edge.from === 'foundation' && edge.to === 'main_arch'));

  const foundation = graph.nodes.find((node) => node.taskId === 'foundation');
  const arch = graph.nodes.find((node) => node.taskId === 'main_arch');
  t.truthy(foundation);
  t.truthy(arch);
  t.is(foundation?.status, 'ready');
  t.is(arch?.status, 'blocked');
  t.is(foundation?.assignedOwner, arch?.assignedOwner);
});

test('foundation fill-region plans anchor at ground level', async (t) => {
  const harness = await createHarness([
    makeSpec({
      id: 'foundation_fill_spec',
      components: [
        {
          id: 'foundation',
          label: 'Foundation',
          role: 'foundation',
          primaryTool: 'fill-region',
          offsetX: 0,
          offsetZ: 0,
          offsetY: 0,
          width: 9,
          depth: 7,
          height: 2,
          materialKey: 'secondary'
        }
      ]
    })
  ]);
  t.teardown(async () => fs.rm(harness.baseDir, { recursive: true, force: true }));

  const graph = await harness.service.compileLandmarkBuildGraph({
    specId: 'foundation_fill_spec',
    originX: 0,
    originZ: 0,
    baseY: 72
  });

  const foundation = graph.nodes[0];
  t.is((foundation.toolPlan.params as Record<string, number>).y1, 71);
  t.is((foundation.toolPlan.params as Record<string, number>).y2, 72);
});

test('compileLandmarkBuildGraph spreads independent groups across multiple workers when possible', async (t) => {
  const harness = await createHarness([
    makeSpec({
      id: 'split_spec',
      components: [
        {
          id: 'west_tower',
          label: 'West Tower',
          role: 'walls',
          primaryTool: 'fill-region',
          preferredWorker: 'WorkerA',
          offsetX: -12,
          offsetZ: 0,
          offsetY: 0,
          width: 5,
          depth: 5,
          height: 6
        },
        {
          id: 'east_tower',
          label: 'East Tower',
          role: 'walls',
          primaryTool: 'fill-region',
          preferredWorker: 'WorkerA',
          offsetX: 12,
          offsetZ: 0,
          offsetY: 0,
          width: 5,
          depth: 5,
          height: 6
        }
      ]
    })
  ]);
  t.teardown(async () => fs.rm(harness.baseDir, { recursive: true, force: true }));

  const graph = await harness.service.compileLandmarkBuildGraph({
    specId: 'split_spec',
    originX: 0,
    originZ: 0,
    baseY: 70
  });

  t.true(new Set(graph.nodes.map((node) => node.assignedOwner)).size >= 2);
});

test('compileLandmarkBuildGraph shards large fill components into parallel worker packets', async (t) => {
  const harness = await createHarness([
    makeSpec({
      id: 'sharded_tower',
      components: [
        {
          id: 'base',
          label: 'Base',
          role: 'foundation',
          primaryTool: 'fill-region',
          preferredWorker: 'MinecraftAgent',
          offsetX: 0,
          offsetZ: 0,
          offsetY: 0,
          width: 15,
          depth: 9,
          height: 3,
          materialKey: 'secondary',
          blockBudget: 405
        },
        {
          id: 'shaft',
          label: 'Shaft',
          role: 'walls',
          primaryTool: 'fill-region',
          preferredWorker: 'BuildBeaAgent',
          dependencies: ['base'],
          offsetX: 0,
          offsetZ: 0,
          offsetY: 3,
          width: 11,
          depth: 7,
          height: 8,
          materialKey: 'primary',
          blockBudget: 616
        }
      ]
    })
  ]);
  t.teardown(async () => fs.rm(harness.baseDir, { recursive: true, force: true }));

  const graph = await harness.service.compileLandmarkBuildGraph({
    specId: 'sharded_tower',
    originX: 0,
    originZ: 0,
    baseY: 70
  });

  const baseShards = graph.nodes.filter((node) => node.taskId.startsWith('base_'));
  t.is(baseShards.length, 2);
  t.true(baseShards.every((node) => node.status === 'ready'));
  t.true(new Set(baseShards.map((node) => node.assignedOwner)).size >= 2);
  t.true(baseShards.every((node) => node.toolPlan.primaryTool === 'fill-region'));

  const shaftShards = graph.nodes.filter((node) => node.taskId.startsWith('shaft_'));
  t.is(shaftShards.length, 2);
  t.true(shaftShards.every((node) => node.dependencies.length === 2));
});

test('estimateLandmarkEnvelope skips optional site and landscaping work by default', async (t) => {
  const harness = await createHarness([
    makeSpec({
      id: 'optional_spec',
      components: [
        {
          id: 'site_grade',
          label: 'Site Grade',
          role: 'site',
          primaryTool: 'flatten-area',
          offsetX: 0,
          offsetZ: 0,
          offsetY: 0,
          width: 21,
          depth: 21,
          height: 2
        },
        {
          id: 'main_mass',
          label: 'Main Mass',
          role: 'walls',
          primaryTool: 'fill-region',
          offsetX: 0,
          offsetZ: 0,
          offsetY: 0,
          width: 9,
          depth: 7,
          height: 5
        },
        {
          id: 'rear_garden',
          label: 'Rear Garden',
          role: 'landscaping',
          primaryTool: 'plant-garden',
          offsetX: 0,
          offsetZ: -16,
          offsetY: 0,
          width: 7,
          depth: 7,
          height: 2,
          gardenSize: 2
        }
      ]
    })
  ]);
  t.teardown(async () => fs.rm(harness.baseDir, { recursive: true, force: true }));

  const envelope = await harness.service.estimateLandmarkEnvelope({
    specId: 'optional_spec',
    prompt: 'build the landmark'
  });

  t.deepEqual(envelope.includedComponentIds, ['main_mass']);
  t.deepEqual(envelope.skippedComponentIds, ['site_grade', 'rear_garden']);
  t.is(envelope.width, 9);
  t.is(envelope.depth, 7);
});

test('allocateBuildGraphZones is atomic and degrades graph on overlap conflict', async (t) => {
  const specA = makeSpec({
    id: 'spec_a',
    components: [
        {
          id: 'structure',
          label: 'Structure A',
          role: 'walls',
          primaryTool: 'fill-region',
          preferredWorker: 'WorkerA',
          offsetX: 0,
          offsetZ: 0,
          offsetY: 0,
          width: 7,
          depth: 7,
          height: 4
        }
      ]
  });
  const specB = makeSpec({
    id: 'spec_b',
    components: [
        {
          id: 'structure',
          label: 'Structure B',
          role: 'walls',
          primaryTool: 'fill-region',
          preferredWorker: 'WorkerB',
          offsetX: 0,
          offsetZ: 0,
          offsetY: 0,
          width: 7,
          depth: 7,
          height: 4
        }
      ]
  });

  const harness = await createHarness([specA, specB]);
  t.teardown(async () => fs.rm(harness.baseDir, { recursive: true, force: true }));

  const graphA = await harness.service.compileLandmarkBuildGraph({
    specId: 'spec_a',
    originX: 0,
    originZ: 0,
    baseY: 70
  });
  const graphB = await harness.service.compileLandmarkBuildGraph({
    specId: 'spec_b',
    originX: 0,
    originZ: 0,
    baseY: 70
  });

  const first = await harness.service.allocateBuildGraphZones(graphA.graphId, false, 600);
  t.is(first.claims.length, 1);

  const error = await t.throwsAsync(async () => {
    await harness.service.allocateBuildGraphZones(graphB.graphId, false, 600);
  });
  t.truthy(error?.message.includes('Batch allocation conflict'));

  const claims = await harness.store.listClaims();
  t.is(claims.length, 1);
  t.is(claims[0].owner, 'WorkerA');

  const degradedGraph = await harness.service.getGraph(graphB.graphId);
  t.is(degradedGraph?.graphStatus, 'degraded');
});

test('dispatchNextTask marks stalled task failed after timeout without reassignment', async (t) => {
  const harness = await createHarness([
    makeSpec({
      id: 'timeout_spec',
      components: [
        {
          id: 'walls',
          label: 'Walls',
          role: 'walls',
          primaryTool: 'fill-region',
          offsetX: 0,
          offsetZ: 0,
          offsetY: 0,
          width: 7,
          depth: 7,
          height: 4
        }
      ]
    })
  ], { taskTimeoutSeconds: 1 });
  t.teardown(async () => fs.rm(harness.baseDir, { recursive: true, force: true }));

  const graph = await harness.service.compileLandmarkBuildGraph({
    specId: 'timeout_spec',
    originX: 10,
    originZ: 10,
    baseY: 70
  });

  const firstDispatch = await harness.service.dispatchNextTask(graph.graphId, 'MinecraftAgent');
  t.truthy(firstDispatch.task);
  t.is(firstDispatch.task?.assignedOwner, 'MinecraftAgent');

  harness.advanceNow(25_000);
  const idle = await harness.service.dispatchNextTask(graph.graphId, 'BuildBeaAgent');
  t.falsy(idle.task);

  const updated = await harness.service.getGraph(graph.graphId);
  const node = updated?.nodes.find((entry) => entry.taskId === 'walls');
  t.truthy(node);
  t.is(node?.attempts, 1);
  t.is(node?.assignedOwner, 'MinecraftAgent');
  t.is(node?.status, 'failed');
});

test('dispatchNextTask repairs a missing reservation before handing out work', async (t) => {
  const harness = await createHarness([
    makeSpec({
      id: 'repair_claim_spec',
      components: [
        {
          id: 'podium_base_west',
          label: 'Podium Base West',
          role: 'foundation',
          primaryTool: 'fill-region',
          preferredWorker: 'MinecraftAgent',
          offsetX: 0,
          offsetZ: 0,
          offsetY: 0,
          width: 7,
          depth: 7,
          height: 3,
          materialKey: 'primary'
        }
      ]
    })
  ]);
  t.teardown(async () => fs.rm(harness.baseDir, { recursive: true, force: true }));

  const graph = await harness.service.compileLandmarkBuildGraph({
    specId: 'repair_claim_spec',
    originX: 30,
    originZ: 30,
    baseY: 64
  });

  const claimsBefore = await harness.store.listClaims();
  t.is(claimsBefore.length, 0);

  const dispatch = await harness.service.dispatchNextTask(graph.graphId, 'MinecraftAgent');
  t.truthy(dispatch.task);

  const claimsAfter = await harness.store.listClaims();
  t.is(claimsAfter.length, 1);
  t.is(claimsAfter[0].zoneId, 'landmark_m_podium_base_west');
  t.is(claimsAfter[0].owner, 'MinecraftAgent');
});

test('inspectBuildGraph and repairBuildGraph expose QA backlog and scheduling', async (t) => {
  const harness = await createHarness([makeSpec()]);
  t.teardown(async () => fs.rm(harness.baseDir, { recursive: true, force: true }));

  const graph = await harness.service.compileLandmarkBuildGraph({
    specId: 'arc_test',
    originX: 40,
    originZ: -20,
    baseY: 70
  });
  await harness.service.allocateBuildGraphZones(graph.graphId, true, 600);

  await harness.service.updateTaskStatus(graph.graphId, 'foundation', 'done', 'blocks=80', 80);
  await harness.service.updateTaskStatus(graph.graphId, 'main_arch', 'failed', 'blocked by mismatch');

  const inspection = await harness.service.inspectBuildGraph(graph.graphId);
  t.is(inspection.repairBacklog, 1);
  t.true(inspection.completionRatio > 0);
  t.is(inspection.graphStatus, 'building');

  const repair = await harness.service.repairBuildGraph(graph.graphId, 240);
  t.is(repair.repairTasks.length, 1);
  t.is(repair.repairTasks[0].taskId, 'main_arch');
  t.is(repair.repairTasks[0].status, 'repair');
  t.true(repair.selectedBudget > 0);

  const after = await harness.service.inspectBuildGraph(graph.graphId);
  t.true(['qa', 'building', 'completed', 'degraded'].includes(after.graphStatus));
  t.true(after.repairBacklog >= 1);
});

test('real arc_de_triomphe spec preserves the lower central vault under simplified compile', async (t) => {
  const rawSpec = JSON.parse(
    await fs.readFile(path.join(REAL_SPEC_DIR, 'arc_de_triomphe_fr.json'), 'utf8')
  ) as Record<string, unknown>;

  const harness = await createHarness([rawSpec]);
  t.teardown(async () => fs.rm(harness.baseDir, { recursive: true, force: true }));

  const graph = await harness.service.compileLandmarkBuildGraph({
    specId: 'arc_de_triomphe_fr',
    originX: 0,
    originZ: 0,
    baseY: 70
  });

  const centralVoid = {
    minX: -7,
    maxX: 7,
    minZ: -3,
    maxZ: 3,
    minY: 73,
    maxY: 97
  };

  const intrudingTasks = graph.nodes
    .filter((node) => node.toolPlan.primaryTool === 'fill-region')
    .filter((node) => {
      const params = node.toolPlan.params as Record<string, number>;
      const x1 = Math.min(Number(params.x1), Number(params.x2));
      const x2 = Math.max(Number(params.x1), Number(params.x2));
      const y1 = Math.min(Number(params.y1), Number(params.y2));
      const y2 = Math.max(Number(params.y1), Number(params.y2));
      const z1 = Math.min(Number(params.z1), Number(params.z2));
      const z2 = Math.max(Number(params.z1), Number(params.z2));

      return (
        x1 <= centralVoid.maxX &&
        x2 >= centralVoid.minX &&
        z1 <= centralVoid.maxZ &&
        z2 >= centralVoid.minZ &&
        y1 <= centralVoid.maxY &&
        y2 >= centralVoid.minY
      );
    })
    .map((node) => node.taskId);

  t.deepEqual(intrudingTasks, []);
  t.true(graph.nodes.some((node) => node.taskId === 'attic_core' || node.taskId.startsWith('attic_core_')));
  t.true(graph.nodes.length > 0);
});

test('real tower_of_pisa spec selects correctly and compiles a monotonic lean without heavy site prep', async (t) => {
  const rawSpec = JSON.parse(
    await fs.readFile(path.join(REAL_SPEC_DIR, 'tower_of_pisa_it.json'), 'utf8')
  ) as Record<string, unknown>;

  const harness = await createHarness([rawSpec]);
  t.teardown(async () => fs.rm(harness.baseDir, { recursive: true, force: true }));

  const selected = await harness.service.selectLandmarkSpec(
    'Build the leaning tower of pisa',
    'italy',
    'medium'
  );
  t.is(selected.spec.id, 'tower_of_pisa_it');

  const graph = await harness.service.compileLandmarkBuildGraph({
    specId: 'tower_of_pisa_it',
    originX: 0,
    originZ: 0,
    baseY: 70,
    prompt: 'Build the leaning tower of pisa'
  });

  const envelope = await harness.service.estimateLandmarkEnvelope({
    specId: 'tower_of_pisa_it',
    prompt: 'Build the leaning tower of pisa'
  });
  t.false(envelope.includedComponentIds.includes('site_plaza'));

  const lower = graph.nodes.find((node) => node.taskId === 'lower_stage' || node.taskId.startsWith('lower_stage_'));
  const middle = graph.nodes.find((node) => node.taskId === 'middle_stage' || node.taskId.startsWith('middle_stage_'));
  const upper = graph.nodes.find((node) => node.taskId === 'upper_stage' || node.taskId.startsWith('upper_stage_'));
  const bell = graph.nodes.find((node) => node.taskId === 'bell_chamber' || node.taskId.startsWith('bell_chamber_'));
  t.truthy(lower);
  t.truthy(middle);
  t.truthy(upper);
  t.truthy(bell);
  t.true((lower?.centerX ?? 0) < (middle?.centerX ?? 0));
  t.true((middle?.centerX ?? 0) < (upper?.centerX ?? 0));
  t.true((upper?.centerX ?? 0) < (bell?.centerX ?? 0));

  t.false(graph.nodes.some((node) => node.toolPlan.primaryTool === 'flatten-area'));
  const owners = new Set(graph.nodes.map((node) => node.assignedOwner));
  t.true(owners.size >= 2);
  t.true(graph.nodes.some((node) => node.taskId === 'approach_walk' && node.assignedOwner === 'ForestFinnAgent'));
});
