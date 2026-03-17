import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  BuildCoordinationStore,
  normalizeBounds,
  type BoundingBox,
  type ZoneClaim
} from './build-coordination.js';

const STYLE_PALETTE_SCHEMA = z.object({
  primary: z.string().min(1),
  secondary: z.string().min(1),
  accent: z.string().min(1),
  detail: z.string().min(1),
  roof: z.string().min(1),
  path: z.string().min(1),
  glass: z.string().min(1)
});

const SCALE_VARIANT_SCHEMA = z.object({
  footprintScale: z.number().positive(),
  heightScale: z.number().positive(),
  budgetScale: z.number().positive()
});

const LANDMARK_COMPONENT_SCHEMA = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  role: z.string().min(1),
  primaryTool: z.enum(['fill-region', 'flatten-area', 'place-block', 'plant-garden', 'build-decorated-house']),
  preferredWorker: z.string().optional(),
  dependencies: z.array(z.string().min(1)).optional().default([]),
  offsetX: z.number().int(),
  offsetZ: z.number().int(),
  offsetY: z.number().int(),
  width: z.number().int().positive(),
  depth: z.number().int().positive(),
  height: z.number().int().positive(),
  materialKey: z.enum(['primary', 'secondary', 'accent', 'detail', 'roof', 'path', 'glass']).optional(),
  blockBudget: z.number().int().positive().optional(),
  gardenSize: z.number().int().min(1).max(3).optional()
});

const DEFAULT_SCALE_VARIANTS = {
  small: { footprintScale: 0.8, heightScale: 0.8, budgetScale: 0.75 },
  medium: { footprintScale: 1.0, heightScale: 1.0, budgetScale: 1.0 },
  large: { footprintScale: 1.25, heightScale: 1.25, budgetScale: 1.35 }
};

export const LANDMARK_SPEC_SCHEMA = z.object({
  schemaVersion: z.string().default('1.0'),
  id: z.string().min(1),
  name: z.string().min(1),
  culture: z.string().min(1),
  description: z.string().optional().default(''),
  keywords: z.array(z.string().min(1)).min(1),
  defaultStyle: z.string().min(1),
  styles: z.record(STYLE_PALETTE_SCHEMA),
  scaleVariants: z.record(SCALE_VARIANT_SCHEMA).optional().default(DEFAULT_SCALE_VARIANTS),
  components: z.array(LANDMARK_COMPONENT_SCHEMA).min(1),
  qualityRules: z.array(z.string()).optional().default([])
});

export type LandmarkSpec = z.infer<typeof LANDMARK_SPEC_SCHEMA>;
export type LandmarkComponent = z.infer<typeof LANDMARK_COMPONENT_SCHEMA>;

type BuildGraphStatus = 'planning' | 'allocating' | 'building' | 'qa' | 'completed' | 'degraded';
export type BuildTaskStatus = 'ready' | 'in_progress' | 'blocked' | 'done' | 'failed' | 'repair';

type RoleName =
  | 'site'
  | 'foundation'
  | 'walls'
  | 'arches'
  | 'roof'
  | 'ornament'
  | 'landscaping'
  | 'utilities'
  | 'generic';

const GRAPH_TASK_STATUS_VALUES: BuildTaskStatus[] = [
  'ready',
  'in_progress',
  'blocked',
  'done',
  'failed',
  'repair'
];

const GRAPH_STATUS_VALUES: BuildGraphStatus[] = [
  'planning',
  'allocating',
  'building',
  'qa',
  'completed',
  'degraded'
];

const ROLE_WORKER_ROTATION: Record<RoleName, string[]> = {
  site: ['DesignDoraAgent'],
  foundation: ['MinecraftAgent', 'BuildBeaAgent'],
  walls: ['MinecraftAgent', 'BuildBeaAgent', 'SupplySidAgent'],
  arches: ['BuildBeaAgent', 'SupplySidAgent'],
  roof: ['BuildBeaAgent', 'MinecraftAgent'],
  ornament: ['SupplySidAgent', 'MinecraftAgent', 'BuildBeaAgent'],
  landscaping: ['ForestFinnAgent', 'DesignDoraAgent'],
  utilities: ['SupplySidAgent', 'ForestFinnAgent'],
  generic: ['MinecraftAgent', 'BuildBeaAgent', 'SupplySidAgent']
};

const DEFAULT_BLOCKS_PER_MINUTE = 180;

export interface BuildTaskToolPlan {
  primaryTool: 'fill-region' | 'flatten-area' | 'place-block' | 'plant-garden' | 'build-decorated-house';
  params: Record<string, unknown>;
  note: string;
}

export interface BuildGraphNode {
  taskId: string;
  zoneId: string;
  componentId: string;
  label: string;
  role: RoleName;
  dependencies: string[];
  assignedWorker: string;
  assignedOwner: string;
  stylePreset: string;
  bounds: BoundingBox;
  centerX: number;
  centerZ: number;
  expectedBlocks: number;
  blocksPlaced: number;
  status: BuildTaskStatus;
  attempts: number;
  note?: string;
  startedAt?: number;
  updatedAt?: number;
  completedAt?: number;
  toolPlan: BuildTaskToolPlan;
}

export interface BuildGraph {
  graphId: string;
  specId: string;
  specName: string;
  culture: string;
  prompt: string;
  originX: number;
  originZ: number;
  baseY: number;
  scale: string;
  stylePreset: string;
  graphStatus: BuildGraphStatus;
  targetDurationMinutes: number;
  completionTarget: number;
  createdAt: number;
  updatedAt: number;
  allocatedAt?: number;
  qaStartedAt?: number;
  expectedBlocks: number;
  placedBlocks: number;
  nodes: BuildGraphNode[];
  edges: Array<{ from: string; to: string }>;
}

interface BuildGraphState {
  graphs: BuildGraph[];
}

interface PromptTweaks {
  footprintScale: number;
  heightScale: number;
  budgetScale: number;
}

export interface SelectLandmarkResult {
  spec: LandmarkSpec;
  score: number;
  recommendedScale: string;
  matchedKeywords: string[];
  rationale: string;
}

export interface CompileGraphInput {
  specId: string;
  originX: number;
  originZ: number;
  baseY: number;
  scale?: string;
  stylePreset?: string;
  prompt?: string;
  targetDurationMinutes?: number;
}

export interface AllocateBuildGraphResult {
  graph: BuildGraph;
  claims: ZoneClaim[];
  message: string;
}

export interface DispatchTaskResult {
  graphId: string;
  graphStatus: BuildGraphStatus;
  completionRatio: number;
  task?: BuildGraphNode;
  message: string;
}

export interface InspectBuildGraphResult {
  graphId: string;
  graphStatus: BuildGraphStatus;
  completionRatio: number;
  completionTarget: number;
  expectedBlocks: number;
  placedBlocks: number;
  criticalPathEtaMinutes: number;
  repairBacklog: number;
  roleSummary: Array<{ role: string; done: number; total: number }>;
  workerSummary: Array<{ owner: string; done: number; active: number; blocked: number }>;
  nodes: BuildGraphNode[];
}

export interface RepairBuildGraphResult {
  graph: BuildGraph;
  repairTasks: BuildGraphNode[];
  selectedBudget: number;
  message: string;
}

export interface LandmarkAutonomyOptions {
  specDir: string;
  coordinationStore: BuildCoordinationStore;
  baseDir?: string;
  resolveOwnerAlias?: (value: string) => string;
  nowProvider?: () => number;
  taskTimeoutSeconds?: number;
}

function nowMillis(nowProvider?: () => number): number {
  return nowProvider ? nowProvider() : Date.now();
}

function normalizedTokenSet(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1)
  );
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeMaterial(blockType: string): string {
  const trimmed = blockType.trim().toLowerCase();
  return trimmed.startsWith('minecraft:') ? trimmed : `minecraft:${trimmed}`;
}

function classifyRole(role: string): RoleName {
  const normalized = role.trim().toLowerCase();
  if (normalized === 'site') return 'site';
  if (normalized === 'foundation') return 'foundation';
  if (normalized === 'walls') return 'walls';
  if (normalized === 'arches') return 'arches';
  if (normalized === 'roof') return 'roof';
  if (normalized === 'ornament') return 'ornament';
  if (normalized === 'landscaping') return 'landscaping';
  if (normalized === 'utilities') return 'utilities';
  return 'generic';
}

function inferHouseStyle(stylePreset: string): string {
  const normalized = stylePreset.toLowerCase();
  if (normalized.includes('spruce')) {
    return 'spruce';
  }
  if (normalized.includes('birch') || normalized.includes('white')) {
    return 'birch';
  }
  if (normalized.includes('stone') || normalized.includes('sandstone')) {
    return 'stone';
  }
  return 'oak';
}

function keyForOwner(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseBlocksFromNote(note: string | undefined): number {
  if (!note) {
    return 0;
  }

  const match = /blocks\s*=\s*(\d+)/i.exec(note);
  if (!match) {
    return 0;
  }

  return Math.max(0, Number(match[1]));
}

function assertDAG(nodes: BuildGraphNode[]): void {
  const ids = new Set(nodes.map((node) => node.taskId));
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      if (!ids.has(dependency)) {
        throw new Error(`Component '${node.componentId}' references unknown dependency '${dependency}'.`);
      }
    }
  }

  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node.taskId, [...node.dependencies]);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (taskId: string): void => {
    if (visited.has(taskId)) {
      return;
    }
    if (visiting.has(taskId)) {
      throw new Error(`Component dependency cycle detected around '${taskId}'.`);
    }

    visiting.add(taskId);
    const dependencies = adjacency.get(taskId) ?? [];
    for (const dependency of dependencies) {
      visit(dependency);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };

  for (const taskId of adjacency.keys()) {
    visit(taskId);
  }
}

function progressStatusForNode(node: BuildGraphNode): string {
  return `${node.componentId}:${node.status} owner=${node.assignedOwner}`;
}

export function normalizeLandmarkSpec(rawSpec: unknown): LandmarkSpec {
  return LANDMARK_SPEC_SCHEMA.parse(rawSpec);
}

export class LandmarkAutonomyService {
  private readonly specDir: string;
  private readonly graphFile: string;
  private readonly coordinationStore: BuildCoordinationStore;
  private readonly resolveOwnerAlias: (value: string) => string;
  private readonly nowProvider?: () => number;
  private readonly taskTimeoutMs: number;

  constructor(options: LandmarkAutonomyOptions) {
    this.specDir = options.specDir;
    this.coordinationStore = options.coordinationStore;
    const baseDir = options.baseDir ?? '/tmp/sam-minecraft-coordination';
    this.graphFile = path.join(baseDir, 'build-graphs.json');
    this.resolveOwnerAlias = options.resolveOwnerAlias ?? ((value) => value);
    this.nowProvider = options.nowProvider;
    this.taskTimeoutMs = Math.max(20, Math.floor(options.taskTimeoutSeconds ?? 180)) * 1000;
  }

  async listLandmarkSpecs(): Promise<LandmarkSpec[]> {
    await fs.mkdir(this.specDir, { recursive: true });
    const indexPath = path.join(this.specDir, 'index.json');

    let fileNames: string[] = [];
    try {
      const rawIndex = await fs.readFile(indexPath, 'utf8');
      const indexPayload = JSON.parse(rawIndex) as { specs?: unknown };
      if (Array.isArray(indexPayload.specs)) {
        fileNames = indexPayload.specs
          .map((entry) => String(entry).trim())
          .filter((entry) => entry.endsWith('.json'));
      }
    } catch {
      fileNames = [];
    }

    if (fileNames.length === 0) {
      const allEntries = await fs.readdir(this.specDir);
      fileNames = allEntries
        .filter((entry) => entry.endsWith('.json'))
        .filter((entry) => entry !== 'index.json' && !entry.startsWith('schema.'))
        .sort();
    }

    const specs: LandmarkSpec[] = [];
    for (const fileName of fileNames) {
      const filePath = path.join(this.specDir, fileName);
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      specs.push(normalizeLandmarkSpec(parsed));
    }

    if (specs.length === 0) {
      throw new Error(`No landmark specs found in ${this.specDir}`);
    }

    return specs;
  }

  async selectLandmarkSpec(prompt: string, cultureHint?: string, sizeHint?: string): Promise<SelectLandmarkResult> {
    const normalizedPrompt = prompt.trim().toLowerCase();
    const promptTokens = normalizedTokenSet(normalizedPrompt);
    const culture = (cultureHint ?? '').trim().toLowerCase();
    const specs = await this.listLandmarkSpecs();

    let best: SelectLandmarkResult | null = null;

    for (const spec of specs) {
      const matchedKeywords = spec.keywords.filter((keyword) => normalizedPrompt.includes(keyword.toLowerCase()));
      const keywordScore = matchedKeywords.length * 6;
      const cultureScore = culture.length > 0 && spec.culture.toLowerCase().includes(culture) ? 8 : 0;

      let tokenScore = 0;
      const nameTokens = normalizedTokenSet(spec.name);
      for (const token of nameTokens) {
        if (promptTokens.has(token)) {
          tokenScore += 4;
        }
      }

      const idTokens = normalizedTokenSet(spec.id.replace(/_/g, ' '));
      for (const token of idTokens) {
        if (promptTokens.has(token)) {
          tokenScore += 3;
        }
      }

      const score = keywordScore + cultureScore + tokenScore;
      const recommendedScale = this.resolveScaleHint(spec, sizeHint);
      const rationale =
        `keywordScore=${keywordScore}, tokenScore=${tokenScore}, cultureScore=${cultureScore}` +
        (matchedKeywords.length > 0 ? `, keywords=${matchedKeywords.join(',')}` : '');

      const candidate: SelectLandmarkResult = {
        spec,
        score,
        recommendedScale,
        matchedKeywords,
        rationale
      };

      if (!best || candidate.score > best.score) {
        best = candidate;
      }
    }

    if (!best) {
      throw new Error('Could not select a landmark spec from the spec bank.');
    }

    if (best.score === 0) {
      const sorted = [...specs].sort((a, b) => a.id.localeCompare(b.id));
      const fallback = sorted[0];
      return {
        spec: fallback,
        score: 0,
        recommendedScale: this.resolveScaleHint(fallback, sizeHint),
        matchedKeywords: [],
        rationale: 'No direct keyword match; selected deterministic fallback template.'
      };
    }

    return best;
  }

  async compileLandmarkBuildGraph(input: CompileGraphInput): Promise<BuildGraph> {
    const specs = await this.listLandmarkSpecs();
    const spec = specs.find((entry) => entry.id === input.specId);
    if (!spec) {
      throw new Error(`Unknown landmark spec '${input.specId}'.`);
    }

    const scale = this.resolveScaleHint(spec, input.scale);
    const scaleVariant = spec.scaleVariants[scale] ?? DEFAULT_SCALE_VARIANTS.medium;
    const stylePreset = input.stylePreset && spec.styles[input.stylePreset]
      ? input.stylePreset
      : spec.defaultStyle;
    const palette = spec.styles[stylePreset];

    if (!palette) {
      throw new Error(`Spec '${spec.id}' is missing style palette '${stylePreset}'.`);
    }

    const promptTweaks = this.derivePromptTweaks(input.prompt ?? '');
    const footprintScale = scaleVariant.footprintScale * promptTweaks.footprintScale;
    const heightScale = scaleVariant.heightScale * promptTweaks.heightScale;
    const budgetScale = scaleVariant.budgetScale * promptTweaks.budgetScale;

    const now = nowMillis(this.nowProvider);
    const graphId = `landmark_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const nodes: BuildGraphNode[] = [];
    const edges: Array<{ from: string; to: string }> = [];

    for (let index = 0; index < spec.components.length; index++) {
      const component = spec.components[index];
      const role = classifyRole(component.role);
      const width = Math.max(1, Math.round(component.width * footprintScale));
      const depth = Math.max(1, Math.round(component.depth * footprintScale));
      const height = Math.max(1, Math.round(component.height * heightScale));
      const centerX = input.originX + Math.round(component.offsetX * footprintScale);
      const centerZ = input.originZ + Math.round(component.offsetZ * footprintScale);
      const compBaseY = input.baseY + Math.round(component.offsetY * heightScale);

      const x1 = centerX - Math.floor(width / 2);
      const z1 = centerZ - Math.floor(depth / 2);
      const x2 = x1 + width - 1;
      const z2 = z1 + depth - 1;

      const y1 = compBaseY - 1;
      const y2 = compBaseY + Math.max(3, height + 2);

      const preferredWorker = component.preferredWorker ?? this.workerForRole(role, index);
      const assignedOwner = this.resolveOwnerAlias(preferredWorker);
      const expectedBlocks = Math.max(
        12,
        Math.round((component.blockBudget ?? width * depth * Math.max(1, height)) * budgetScale)
      );

      const taskId = component.id;
      const zoneId = `${graphId.slice(0, 10)}_${component.id}`;
      const dependencies = [...component.dependencies];

      const node: BuildGraphNode = {
        taskId,
        zoneId,
        componentId: component.id,
        label: component.label,
        role,
        dependencies,
        assignedWorker: preferredWorker,
        assignedOwner,
        stylePreset,
        bounds: normalizeBounds(x1, y1, z1, x2, y2, z2),
        centerX,
        centerZ,
        expectedBlocks,
        blocksPlaced: 0,
        status: dependencies.length === 0 ? 'ready' : 'blocked',
        attempts: 0,
        updatedAt: now,
        toolPlan: this.buildToolPlan(component, {
          stylePreset,
          palette,
          width,
          depth,
          height,
          centerX,
          centerZ,
          baseY: compBaseY,
          bounds: normalizeBounds(x1, y1, z1, x2, y2, z2)
        })
      };

      nodes.push(node);

      for (const dependency of dependencies) {
        edges.push({ from: dependency, to: taskId });
      }
    }

    assertDAG(nodes);

    const expectedBlocks = nodes.reduce((sum, node) => sum + node.expectedBlocks, 0);

    const graph: BuildGraph = {
      graphId,
      specId: spec.id,
      specName: spec.name,
      culture: spec.culture,
      prompt: input.prompt ?? '',
      originX: input.originX,
      originZ: input.originZ,
      baseY: input.baseY,
      scale,
      stylePreset,
      graphStatus: 'planning',
      targetDurationMinutes: clampInt(input.targetDurationMinutes ?? 30, 10, 60),
      completionTarget: 0.85,
      createdAt: now,
      updatedAt: now,
      expectedBlocks,
      placedBlocks: 0,
      nodes,
      edges
    };

    await this.upsertGraph(graph);
    return graph;
  }

  async getGraph(graphId: string): Promise<BuildGraph | null> {
    const state = await this.readGraphState();
    const graph = state.graphs.find((entry) => entry.graphId === graphId);
    return graph ? JSON.parse(JSON.stringify(graph)) as BuildGraph : null;
  }

  async allocateBuildGraphZones(
    graphId: string,
    clearExistingForOwners = true,
    ttlSeconds = 1800
  ): Promise<AllocateBuildGraphResult> {
    const graph = await this.requireGraph(graphId);
    const now = nowMillis(this.nowProvider);

    graph.graphStatus = 'allocating';
    graph.updatedAt = now;

    const claimResult = await this.coordinationStore.claimZonesBatch(
      graph.nodes.map((node) => ({
        zoneId: node.zoneId,
        owner: node.assignedOwner,
        bounds: node.bounds,
        ttlSeconds
      })),
      { clearExistingForOwners }
    );

    if (!claimResult.ok) {
      graph.graphStatus = 'degraded';
      graph.updatedAt = now;
      await this.upsertGraph(graph);
      throw new Error(claimResult.message);
    }

    graph.allocatedAt = now;
    graph.graphStatus = 'building';
    graph.updatedAt = now;
    await this.upsertGraph(graph);

    return {
      graph,
      claims: claimResult.claims,
      message: claimResult.message
    };
  }

  async dispatchNextTask(graphId: string, workerId: string): Promise<DispatchTaskResult> {
    const graph = await this.requireGraph(graphId);
    const now = nowMillis(this.nowProvider);
    const owner = this.resolveOwnerAlias(workerId);

    this.refreshTaskStates(graph, now);

    const candidates = graph.nodes
      .filter((node) => (node.status === 'ready' || node.status === 'repair') && keyForOwner(node.assignedOwner) === keyForOwner(owner))
      .sort((a, b) => this.nodePriorityScore(b) - this.nodePriorityScore(a));

    const completionRatio = this.computeCompletion(graph);

    if (candidates.length === 0) {
      this.refreshGraphStatus(graph, now);
      graph.updatedAt = now;
      await this.upsertGraph(graph);

      const pending = graph.nodes.filter((node) => node.status !== 'done');
      if (pending.length === 0) {
        return {
          graphId,
          graphStatus: graph.graphStatus,
          completionRatio,
          message: `No remaining tasks. Graph is ${graph.graphStatus}.`
        };
      }

      const readyForOthers = graph.nodes
        .filter((node) => node.status === 'ready' || node.status === 'repair')
        .slice(0, 5)
        .map((node) => `${node.taskId}->${node.assignedOwner}`)
        .join(', ');

      return {
        graphId,
        graphStatus: graph.graphStatus,
        completionRatio,
        message:
          `No task currently ready for ${owner}. ` +
          (readyForOthers ? `Ready for others: ${readyForOthers}` : 'Waiting on dependency completion.')
      };
    }

    const selected = candidates[0];
    selected.status = 'in_progress';
    selected.attempts += 1;
    selected.startedAt = now;
    selected.updatedAt = now;

    this.refreshGraphStatus(graph, now);
    graph.updatedAt = now;
    await this.upsertGraph(graph);

    return {
      graphId,
      graphStatus: graph.graphStatus,
      completionRatio: this.computeCompletion(graph),
      task: selected,
      message:
        `Dispatched ${selected.taskId} to ${owner} using ${selected.toolPlan.primaryTool}. ` +
        `Zone=${selected.zoneId} bounds=(${selected.bounds.minX},${selected.bounds.minY},${selected.bounds.minZ})` +
        `-(${selected.bounds.maxX},${selected.bounds.maxY},${selected.bounds.maxZ})`
    };
  }

  async updateTaskStatus(
    graphId: string,
    taskId: string,
    status: BuildTaskStatus | 'completed',
    note?: string,
    blocksPlaced?: number
  ): Promise<BuildGraph> {
    const graph = await this.requireGraph(graphId);
    const node = graph.nodes.find((entry) => entry.taskId === taskId);
    if (!node) {
      throw new Error(`Task '${taskId}' does not exist in graph '${graphId}'.`);
    }

    const normalizedStatus = status === 'completed' ? 'done' : status;
    if (!GRAPH_TASK_STATUS_VALUES.includes(normalizedStatus)) {
      throw new Error(`Invalid status '${status}'. Valid statuses: ${GRAPH_TASK_STATUS_VALUES.join(', ')}`);
    }

    const now = nowMillis(this.nowProvider);
    node.status = normalizedStatus;
    node.updatedAt = now;
    if (note) {
      node.note = note.trim();
    }

    if (normalizedStatus === 'in_progress' && !node.startedAt) {
      node.startedAt = now;
    }

    if (normalizedStatus === 'done') {
      node.completedAt = now;
      const noteBlocks = parseBlocksFromNote(note);
      const explicitBlocks = blocksPlaced ?? 0;
      const mergedBlocks = Math.max(0, explicitBlocks, noteBlocks);
      if (mergedBlocks > 0) {
        node.blocksPlaced = Math.max(node.blocksPlaced, mergedBlocks);
      } else if (node.blocksPlaced === 0) {
        node.blocksPlaced = node.expectedBlocks;
      }
    }

    this.refreshTaskStates(graph, now);
    this.refreshGraphStatus(graph, now);
    graph.updatedAt = now;
    await this.upsertGraph(graph);

    return graph;
  }

  async inspectBuildGraph(graphId: string): Promise<InspectBuildGraphResult> {
    const graph = await this.requireGraph(graphId);
    const now = nowMillis(this.nowProvider);

    this.refreshTaskStates(graph, now);
    this.refreshGraphStatus(graph, now);

    graph.updatedAt = now;
    await this.upsertGraph(graph);

    const completionRatio = this.computeCompletion(graph);
    const remainingBlocks = Math.max(0, graph.expectedBlocks - graph.placedBlocks);
    const elapsedMinutes = Math.max(0.1, (now - graph.createdAt) / 60000);
    const throughput = graph.placedBlocks > 0
      ? graph.placedBlocks / elapsedMinutes
      : DEFAULT_BLOCKS_PER_MINUTE;
    const criticalPathEtaMinutes = Math.max(0, Math.round((remainingBlocks / Math.max(1, throughput)) * 10) / 10);

    const roleBuckets = new Map<string, { done: number; total: number }>();
    const workerBuckets = new Map<string, { done: number; active: number; blocked: number }>();

    for (const node of graph.nodes) {
      const roleStats = roleBuckets.get(node.role) ?? { done: 0, total: 0 };
      roleStats.total += 1;
      if (node.status === 'done') {
        roleStats.done += 1;
      }
      roleBuckets.set(node.role, roleStats);

      const workerStats = workerBuckets.get(node.assignedOwner) ?? { done: 0, active: 0, blocked: 0 };
      if (node.status === 'done') {
        workerStats.done += 1;
      } else if (node.status === 'in_progress') {
        workerStats.active += 1;
      } else if (node.status === 'blocked' || node.status === 'failed' || node.status === 'repair') {
        workerStats.blocked += 1;
      }
      workerBuckets.set(node.assignedOwner, workerStats);
    }

    const repairBacklog = graph.nodes.filter((node) => node.status === 'failed' || node.status === 'repair').length;

    return {
      graphId,
      graphStatus: graph.graphStatus,
      completionRatio,
      completionTarget: graph.completionTarget,
      expectedBlocks: graph.expectedBlocks,
      placedBlocks: graph.placedBlocks,
      criticalPathEtaMinutes,
      repairBacklog,
      roleSummary: Array.from(roleBuckets.entries()).map(([role, stats]) => ({
        role,
        done: stats.done,
        total: stats.total
      })),
      workerSummary: Array.from(workerBuckets.entries()).map(([owner, stats]) => ({
        owner,
        done: stats.done,
        active: stats.active,
        blocked: stats.blocked
      })),
      nodes: graph.nodes
    };
  }

  async repairBuildGraph(graphId: string, budgetBlocks = 600): Promise<RepairBuildGraphResult> {
    const graph = await this.requireGraph(graphId);
    const now = nowMillis(this.nowProvider);

    this.refreshTaskStates(graph, now);

    let remainingBudget = Math.max(50, budgetBlocks);
    const repairTasks: BuildGraphNode[] = [];

    const candidates = graph.nodes
      .filter((node) => node.status === 'failed' || node.status === 'blocked')
      .sort((a, b) => a.expectedBlocks - b.expectedBlocks);

    for (const node of candidates) {
      if (remainingBudget <= 0) {
        break;
      }

      const needed = Math.max(20, node.expectedBlocks - node.blocksPlaced);
      if (needed > remainingBudget && repairTasks.length > 0) {
        continue;
      }

      node.status = 'repair';
      node.updatedAt = now;
      node.note = `repair scheduled by inspect loop; budget=${Math.min(needed, remainingBudget)}`;
      repairTasks.push(node);
      remainingBudget -= needed;
    }

    if (repairTasks.length === 0) {
      graph.graphStatus = this.computeCompletion(graph) >= graph.completionTarget
        ? 'completed'
        : graph.graphStatus;
      graph.updatedAt = now;
      await this.upsertGraph(graph);
      return {
        graph,
        repairTasks: [],
        selectedBudget: 0,
        message: 'No failed/blocked tasks required repair scheduling.'
      };
    }

    graph.qaStartedAt = graph.qaStartedAt ?? now;
    graph.graphStatus = 'qa';
    graph.updatedAt = now;

    await this.upsertGraph(graph);

    const selectedBudget = budgetBlocks - Math.max(0, remainingBudget);
    return {
      graph,
      repairTasks,
      selectedBudget,
      message: `Scheduled ${repairTasks.length} repair tasks with budget ${selectedBudget} blocks.`
    };
  }

  private resolveScaleHint(spec: LandmarkSpec, sizeHint?: string): string {
    const requested = (sizeHint ?? 'medium').trim().toLowerCase();
    if (requested.length > 0 && spec.scaleVariants[requested]) {
      return requested;
    }
    if (spec.scaleVariants.medium) {
      return 'medium';
    }
    const keys = Object.keys(spec.scaleVariants);
    return keys.length > 0 ? keys[0] : 'medium';
  }

  private derivePromptTweaks(prompt: string): PromptTweaks {
    const normalized = prompt.toLowerCase();

    let footprintScale = 1;
    let heightScale = 1;
    let budgetScale = 1;

    if (/(grand|monumental|huge|massive|epic)/.test(normalized)) {
      footprintScale *= 1.18;
      heightScale *= 1.24;
      budgetScale *= 1.28;
    }

    if (/(compact|small|mini)/.test(normalized)) {
      footprintScale *= 0.82;
      heightScale *= 0.82;
      budgetScale *= 0.8;
    }

    if (/(ornate|detailed|decorative|baroque)/.test(normalized)) {
      budgetScale *= 1.18;
    }

    if (/(minimal|simple|clean)/.test(normalized)) {
      budgetScale *= 0.88;
    }

    if (/(tall|vertical|towering)/.test(normalized)) {
      heightScale *= 1.15;
    }

    if (/(wide|broad|spacious)/.test(normalized)) {
      footprintScale *= 1.12;
    }

    return {
      footprintScale,
      heightScale,
      budgetScale
    };
  }

  private workerForRole(role: RoleName, index: number): string {
    const pool = ROLE_WORKER_ROTATION[role] ?? ROLE_WORKER_ROTATION.generic;
    return pool[index % pool.length];
  }

  private buildToolPlan(
    component: LandmarkComponent,
    context: {
      stylePreset: string;
      palette: z.infer<typeof STYLE_PALETTE_SCHEMA>;
      width: number;
      depth: number;
      height: number;
      centerX: number;
      centerZ: number;
      baseY: number;
      bounds: BoundingBox;
    }
  ): BuildTaskToolPlan {
    const materialKey = component.materialKey ?? 'primary';
    const material = normalizeMaterial(context.palette[materialKey]);

    if (component.primaryTool === 'flatten-area') {
      return {
        primaryTool: 'flatten-area',
        params: {
          x1: context.bounds.minX,
          z1: context.bounds.minZ,
          x2: context.bounds.maxX,
          z2: context.bounds.maxZ,
          material: normalizeMaterial(context.palette.path),
          maxAdjustment: 1
        },
        note: `Grade footprint for ${component.label} before structure work.`
      };
    }

    if (component.primaryTool === 'plant-garden') {
      return {
        primaryTool: 'plant-garden',
        params: {
          x: context.centerX,
          z: context.centerZ,
          size: component.gardenSize ?? 2
        },
        note: `Landscape around ${component.label}.`
      };
    }

    if (component.primaryTool === 'place-block') {
      return {
        primaryTool: 'place-block',
        params: {
          x: context.centerX,
          y: context.baseY,
          z: context.centerZ,
          blockType: material
        },
        note: `Place key marker/detail for ${component.label}; repeat with local pattern as needed.`
      };
    }

    if (component.primaryTool === 'build-decorated-house') {
      return {
        primaryTool: 'build-decorated-house',
        params: {
          x: context.centerX,
          z: context.centerZ,
          style: inferHouseStyle(context.stylePreset)
        },
        note: `Build a stylized massing block for ${component.label}.`
      };
    }

    return {
      primaryTool: 'fill-region',
      params: {
        x1: context.bounds.minX,
        y1: context.baseY,
        z1: context.bounds.minZ,
        x2: context.bounds.maxX,
        y2: context.baseY + Math.max(0, context.height - 1),
        z2: context.bounds.maxZ,
        blockType: material
      },
      note: `Fill structural mass for ${component.label} using ${material}.`
    };
  }

  private refreshTaskStates(graph: BuildGraph, now: number): void {
    const taskMap = new Map(graph.nodes.map((node) => [node.taskId, node]));

    const dependencyDone = (node: BuildGraphNode): boolean =>
      node.dependencies.every((dependencyId) => taskMap.get(dependencyId)?.status === 'done');

    for (const node of graph.nodes) {
      if (node.status === 'in_progress' && node.startedAt && now - node.startedAt > this.taskTimeoutMs) {
        node.status = 'blocked';
        node.note = `timed out after ${Math.floor(this.taskTimeoutMs / 1000)}s, awaiting reassignment`;
        node.updatedAt = now;

        const roleWorkers = ROLE_WORKER_ROTATION[node.role] ?? ROLE_WORKER_ROTATION.generic;
        const currentKey = keyForOwner(node.assignedOwner);
        const alternative = roleWorkers
          .map((worker) => ({ worker, owner: this.resolveOwnerAlias(worker) }))
          .find((entry) => keyForOwner(entry.owner) !== currentKey);

        if (alternative) {
          node.assignedWorker = alternative.worker;
          node.assignedOwner = alternative.owner;
          node.status = 'ready';
          node.note = `reassigned after timeout to ${alternative.owner}`;
        }
      }
    }

    for (const node of graph.nodes) {
      if (node.status === 'done' || node.status === 'failed' || node.status === 'repair' || node.status === 'in_progress') {
        continue;
      }

      const depsSatisfied = dependencyDone(node);
      if (depsSatisfied && node.status === 'blocked') {
        node.status = 'ready';
      } else if (!depsSatisfied && node.status === 'ready') {
        node.status = 'blocked';
      }

      node.updatedAt = now;
    }

    graph.placedBlocks = graph.nodes.reduce((sum, node) => sum + node.blocksPlaced, 0);
  }

  private refreshGraphStatus(graph: BuildGraph, now: number): void {
    const completion = this.computeCompletion(graph);
    const hasFailed = graph.nodes.some((node) => node.status === 'failed');
    const allDone = graph.nodes.every((node) => node.status === 'done');
    const elapsedMinutes = (now - graph.createdAt) / 60000;

    if (allDone) {
      graph.graphStatus = 'completed';
      graph.updatedAt = now;
      return;
    }

    if (hasFailed && elapsedMinutes >= graph.targetDurationMinutes) {
      graph.graphStatus = 'degraded';
      graph.updatedAt = now;
      return;
    }

    if (elapsedMinutes >= Math.max(1, graph.targetDurationMinutes - 5) || completion >= graph.completionTarget) {
      graph.graphStatus = 'qa';
      graph.qaStartedAt = graph.qaStartedAt ?? now;
      graph.updatedAt = now;
      return;
    }

    if (graph.allocatedAt) {
      graph.graphStatus = 'building';
      graph.updatedAt = now;
      return;
    }

    if (GRAPH_STATUS_VALUES.includes(graph.graphStatus) && graph.graphStatus === 'allocating') {
      graph.updatedAt = now;
      return;
    }

    graph.graphStatus = 'planning';
    graph.updatedAt = now;
  }

  private computeCompletion(graph: BuildGraph): number {
    if (graph.nodes.length === 0) {
      return 0;
    }
    const done = graph.nodes.filter((node) => node.status === 'done').length;
    return done / graph.nodes.length;
  }

  private nodePriorityScore(node: BuildGraphNode): number {
    const statusBoost = node.status === 'repair' ? 100000 : 0;
    const dependencyScore = Math.max(0, 500 - node.dependencies.length * 100);
    const blockScore = node.expectedBlocks;
    return statusBoost + dependencyScore + blockScore;
  }

  private async requireGraph(graphId: string): Promise<BuildGraph> {
    const graph = await this.getGraph(graphId);
    if (!graph) {
      throw new Error(`Build graph '${graphId}' was not found.`);
    }
    return graph;
  }

  private async readGraphState(): Promise<BuildGraphState> {
    return this.withGraphLock(async () => {
      try {
        const raw = await fs.readFile(this.graphFile, 'utf8');
        const parsed = JSON.parse(raw) as BuildGraphState;
        if (!Array.isArray(parsed.graphs)) {
          return { graphs: [] };
        }
        return parsed;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          return { graphs: [] };
        }
        throw err;
      }
    });
  }

  private async upsertGraph(graph: BuildGraph): Promise<void> {
    await this.withGraphLock(async () => {
      const state = await this.readGraphStateUnlocked();
      const nextGraphs = state.graphs.filter((entry) => entry.graphId !== graph.graphId);
      nextGraphs.push(graph);
      await this.writeGraphStateUnlocked({ graphs: nextGraphs });
    });
  }

  private async readGraphStateUnlocked(): Promise<BuildGraphState> {
    try {
      const raw = await fs.readFile(this.graphFile, 'utf8');
      const parsed = JSON.parse(raw) as BuildGraphState;
      if (!Array.isArray(parsed.graphs)) {
        return { graphs: [] };
      }
      return parsed;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return { graphs: [] };
      }
      throw err;
    }
  }

  private async writeGraphStateUnlocked(state: BuildGraphState): Promise<void> {
    await fs.mkdir(path.dirname(this.graphFile), { recursive: true });
    const tmp = `${this.graphFile}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, this.graphFile);
  }

  private async withGraphLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockFile = `${this.graphFile}.lock`;
    await fs.mkdir(path.dirname(this.graphFile), { recursive: true });

    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        const handle = await fs.open(lockFile, 'wx');
        try {
          return await operation();
        } finally {
          await handle.close();
          await fs.unlink(lockFile).catch(() => undefined);
        }
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'EEXIST') {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }

    throw new Error(`Timed out acquiring build graph lock for ${this.graphFile}`);
  }
}

export function formatDispatchTask(task: BuildGraphNode): string {
  return [
    `taskId=${task.taskId}`,
    `zoneId=${task.zoneId}`,
    `status=${task.status}`,
    `owner=${task.assignedOwner}`,
    `tool=${task.toolPlan.primaryTool}`,
    `bounds=(${task.bounds.minX},${task.bounds.minY},${task.bounds.minZ})-(${task.bounds.maxX},${task.bounds.maxY},${task.bounds.maxZ})`,
    `plan=${progressStatusForNode(task)}`
  ].join(' ');
}
