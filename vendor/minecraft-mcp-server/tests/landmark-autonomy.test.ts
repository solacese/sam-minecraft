import test from 'ava';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
        width: 9,
        depth: 9,
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
        width: 9,
        depth: 9,
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

test('dispatchNextTask reassigns stalled task after timeout', async (t) => {
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
  const reassigned = await harness.service.dispatchNextTask(graph.graphId, 'BuildBeaAgent');
  t.truthy(reassigned.task);
  t.is(reassigned.task?.assignedOwner, 'BuildBeaAgent');
  t.is(reassigned.task?.status, 'in_progress');

  const updated = await harness.service.getGraph(graph.graphId);
  const node = updated?.nodes.find((entry) => entry.taskId === 'walls');
  t.truthy(node);
  t.is(node?.attempts, 2);
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
