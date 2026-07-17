import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  BuildCoordinationStore,
  boxContains,
  boxesOverlap,
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
  foundation: ['MinecraftAgent', 'BuildBeaAgent', 'MonumentMarcAgent'],
  walls: ['MinecraftAgent', 'BuildBeaAgent', 'MonumentMarcAgent', 'SupplySidAgent'],
  arches: ['BuildBeaAgent', 'SupplySidAgent', 'MonumentMarcAgent'],
  roof: ['BuildBeaAgent', 'MinecraftAgent', 'MonumentMarcAgent'],
  ornament: ['SupplySidAgent', 'MonumentMarcAgent', 'MinecraftAgent', 'BuildBeaAgent'],
  landscaping: ['ForestFinnAgent', 'DesignDoraAgent'],
  utilities: ['SupplySidAgent', 'ForestFinnAgent'],
  generic: ['MinecraftAgent', 'BuildBeaAgent', 'SupplySidAgent']
};

const DEFAULT_BLOCKS_PER_MINUTE = 180;
const MIN_SHARD_DIMENSION_BLOCKS = 4;
const MIN_SHARD_EXPECTED_BLOCKS = 240;

const CULTURE_ALIAS_MAP: Record<string, string[]> = {
  fr: ['fr', 'france', 'french', 'paris'],
  france: ['fr', 'france', 'french', 'paris'],
  french: ['fr', 'france', 'french', 'paris'],
  it: ['it', 'italy', 'italian', 'pisa', 'rome', 'roman'],
  italy: ['it', 'italy', 'italian', 'pisa', 'rome', 'roman'],
  italian: ['it', 'italy', 'italian', 'pisa', 'rome', 'roman'],
  nl: ['nl', 'netherlands', 'dutch', 'holland', 'amsterdam'],
  netherlands: ['nl', 'netherlands', 'dutch', 'holland', 'amsterdam'],
  dutch: ['nl', 'netherlands', 'dutch', 'holland', 'amsterdam'],
  holland: ['nl', 'netherlands', 'dutch', 'holland', 'amsterdam'],
  us: ['us', 'usa', 'american', 'america', 'new york', 'seattle', 'san francisco', 'philadelphia'],
  usa: ['us', 'usa', 'american', 'america', 'new york', 'seattle', 'san francisco', 'philadelphia'],
  american: ['us', 'usa', 'american', 'america', 'new york', 'seattle', 'san francisco', 'philadelphia'],
  uk: ['uk', 'united kingdom', 'british', 'england', 'london'],
  british: ['uk', 'united kingdom', 'british', 'england', 'london'],
  england: ['uk', 'united kingdom', 'british', 'england', 'london'],
  au: ['au', 'australia', 'australian', 'sydney'],
  australia: ['au', 'australia', 'australian', 'sydney'],
  australian: ['au', 'australia', 'australian', 'sydney'],
  ca: ['ca', 'canada', 'canadian', 'toronto'],
  canada: ['ca', 'canada', 'canadian', 'toronto'],
  canadian: ['ca', 'canada', 'canadian', 'toronto'],
  ae: ['ae', 'uae', 'dubai', 'emirates', 'arab'],
  uae: ['ae', 'uae', 'dubai', 'emirates', 'arab'],
  dubai: ['ae', 'uae', 'dubai', 'emirates', 'arab'],
  in: ['in', 'india', 'indian', 'agra', 'delhi'],
  india: ['in', 'india', 'indian', 'agra', 'delhi'],
  indian: ['in', 'india', 'indian', 'agra', 'delhi'],
  jp: ['jp', 'japan', 'japanese', 'tokyo', 'kyoto'],
  japan: ['jp', 'japan', 'japanese', 'tokyo', 'kyoto'],
  japanese: ['jp', 'japan', 'japanese', 'tokyo', 'kyoto'],
  kh: ['kh', 'cambodia', 'cambodian', 'khmer'],
  cambodia: ['kh', 'cambodia', 'cambodian', 'khmer'],
  cambodian: ['kh', 'cambodia', 'cambodian', 'khmer'],
  gr: ['gr', 'greece', 'greek', 'athens'],
  greece: ['gr', 'greece', 'greek', 'athens'],
  greek: ['gr', 'greece', 'greek', 'athens'],
  br: ['br', 'brazil', 'brazilian', 'rio'],
  brazil: ['br', 'brazil', 'brazilian', 'rio'],
  brazilian: ['br', 'brazil', 'brazilian', 'rio'],
  de: ['de', 'germany', 'german', 'bavarian', 'berlin', 'munich'],
  germany: ['de', 'germany', 'german', 'bavarian', 'berlin', 'munich'],
  german: ['de', 'germany', 'german', 'bavarian', 'berlin', 'munich'],
  eg: ['eg', 'egypt', 'egyptian', 'cairo', 'giza'],
  egypt: ['eg', 'egypt', 'egyptian', 'cairo', 'giza'],
  egyptian: ['eg', 'egypt', 'egyptian', 'cairo', 'giza'],
  pe: ['pe', 'peru', 'peruvian', 'inca', 'incan'],
  peru: ['pe', 'peru', 'peruvian', 'inca', 'incan'],
  peruvian: ['pe', 'peru', 'peruvian', 'inca', 'incan'],
  jo: ['jo', 'jordan', 'jordanian', 'petra'],
  jordan: ['jo', 'jordan', 'jordanian', 'petra'],
  jordanian: ['jo', 'jordan', 'jordanian', 'petra'],
  cn: ['cn', 'china', 'chinese', 'beijing', 'ming'],
  china: ['cn', 'china', 'chinese', 'beijing', 'ming'],
  chinese: ['cn', 'china', 'chinese', 'beijing', 'ming'],
  ru: ['ru', 'russia', 'russian', 'moscow'],
  russia: ['ru', 'russia', 'russian', 'moscow'],
  russian: ['ru', 'russia', 'russian', 'moscow'],
  es: ['es', 'spain', 'spanish', 'barcelona', 'madrid'],
  spain: ['es', 'spain', 'spanish', 'barcelona', 'madrid'],
  spanish: ['es', 'spain', 'spanish', 'barcelona', 'madrid'],
  mx: ['mx', 'mexico', 'mexican', 'mayan', 'aztec'],
  mexico: ['mx', 'mexico', 'mexican', 'mayan', 'aztec'],
  mexican: ['mx', 'mexico', 'mexican', 'mayan', 'aztec'],
  tr: ['tr', 'turkey', 'turkish', 'istanbul', 'ottoman'],
  turkey: ['tr', 'turkey', 'turkish', 'istanbul', 'ottoman'],
  turkish: ['tr', 'turkey', 'turkish', 'istanbul', 'ottoman'],
  kr: ['kr', 'korea', 'korean', 'seoul', 'south korea'],
  korea: ['kr', 'korea', 'korean', 'seoul', 'south korea'],
  korean: ['kr', 'korea', 'korean', 'seoul', 'south korea'],
  th: ['th', 'thailand', 'thai', 'bangkok', 'siam'],
  thailand: ['th', 'thailand', 'thai', 'bangkok', 'siam'],
  thai: ['th', 'thailand', 'thai', 'bangkok', 'siam']
};

const LANDMARK_PROMINENCE_BY_ID: Record<string, number> = {
  eiffel_tower_fr: 7,
  great_pyramid_eg: 7,
  taj_mahal_in: 7,
  great_wall_cn: 7,
  colosseum_it: 6,
  statue_of_liberty_us: 6,
  christ_redeemer_br: 6,
  big_ben_uk: 6,
  saint_basils_cathedral_ru: 6,
  chichen_itza_mx: 6,
  machu_picchu_pe: 6,
  tower_of_pisa_it: 6,
  sydney_opera_house_au: 5,
  parthenon_gr: 5,
  hagia_sophia_tr: 5,
  angkor_wat_kh: 5,
  arc_de_triomphe_fr: 5,
  chrysler_building_us: 5,
  sagrada_familia_es: 5,
  petra_treasury_jo: 5,
  burj_khalifa_ae: 5,
  stonehenge_uk: 5,
  golden_gate_bridge_us: 5,
  japanese_pagoda_jp: 5,
  neuschwanstein_castle_de: 4,
  space_needle_us: 4,
  cn_tower_ca: 4,
  gyeongbokgung_kr: 4,
  wat_arun_th: 4,
  dutch_windmill_nl: 4,
  amsterdam_canal_house_nl: 4,
  medieval_castle_eu: 4
};

const BROAD_LANDMARK_PROMPT_TOKENS = new Set([
  'famous',
  'iconic',
  'landmark',
  'monument',
  'structure',
  'building'
]);

export interface BuildTaskToolPlan {
  primaryTool: 'fill-region' | 'flatten-area' | 'place-block' | 'plant-garden' | 'build-decorated-house' | 'place-catalog-shard';
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

export interface LandmarkEnvelopeEstimate {
  specId: string;
  scale: string;
  stylePreset: string;
  width: number;
  depth: number;
  minOffsetX: number;
  maxOffsetX: number;
  minOffsetZ: number;
  maxOffsetZ: number;
  includedComponentIds: string[];
  skippedComponentIds: string[];
}

export interface SelectLandmarkResult {
  spec: LandmarkSpec;
  score: number;
  recommendedScale: string;
  matchedKeywords: string[];
  rationale: string;
}

export interface LandmarkDiscoveryResult {
  candidates: SelectLandmarkResult[];
  selected: SelectLandmarkResult;
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

export interface ReservationCompletionResult {
  graph: BuildGraph;
  node: BuildGraphNode;
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

function cultureAliases(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  const aliases = new Set<string>();
  if (normalized.length > 0) {
    aliases.add(normalized);
  }

  for (const token of normalizedTokenSet(normalized)) {
    aliases.add(token);
    for (const alias of CULTURE_ALIAS_MAP[token] ?? []) {
      aliases.add(alias);
    }
  }

  for (const alias of CULTURE_ALIAS_MAP[normalized] ?? []) {
    aliases.add(alias);
  }

  return [...aliases];
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
    const candidates = await this.discoverLandmarkCandidates(prompt, cultureHint, sizeHint, 1);
    return candidates[0];
  }

  async discoverLandmarkCandidates(
    prompt: string,
    cultureHint?: string,
    sizeHint?: string,
    limit = 5
  ): Promise<SelectLandmarkResult[]> {
    const normalizedPrompt = prompt.trim().toLowerCase();
    const promptTokens = normalizedTokenSet(normalizedPrompt);
    const requestedCultureAliases = cultureAliases(cultureHint ?? '');
    const broadPrompt = [...BROAD_LANDMARK_PROMPT_TOKENS].some((token) => promptTokens.has(token));
    const specs = await this.listLandmarkSpecs();

    const ranked = specs
      .map((spec) =>
        this.scoreLandmarkSpec(spec, {
          normalizedPrompt,
          promptTokens,
          requestedCultureAliases,
          sizeHint,
          broadPrompt
        })
      )
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return left.spec.name.localeCompare(right.spec.name);
      });

    if (ranked.length === 0) {
      throw new Error('Could not select a landmark spec from the spec bank.');
    }

    if (ranked[0].score === 0) {
      return ranked
        .sort((left, right) => left.spec.id.localeCompare(right.spec.id))
        .slice(0, Math.max(1, limit))
        .map((candidate, index) => ({
          ...candidate,
          rationale:
            index === 0
              ? 'No direct keyword match; selected deterministic fallback template.'
              : 'No direct keyword match; deterministic fallback candidate.'
        }));
    }

    return ranked.slice(0, Math.max(1, limit));
  }

  async estimateLandmarkEnvelope(input: {
    specId: string;
    scale?: string;
    stylePreset?: string;
    prompt?: string;
    includeOptionalSiteWork?: boolean;
  }): Promise<LandmarkEnvelopeEstimate> {
    const context = await this.resolveCompileContext(input);

    let minOffsetX = Number.POSITIVE_INFINITY;
    let maxOffsetX = Number.NEGATIVE_INFINITY;
    let minOffsetZ = Number.POSITIVE_INFINITY;
    let maxOffsetZ = Number.NEGATIVE_INFINITY;

    for (const component of context.components) {
      const width = Math.max(1, Math.round(component.width * context.footprintScale));
      const depth = Math.max(1, Math.round(component.depth * context.footprintScale));
      const centerX = Math.round(component.offsetX * context.footprintScale);
      const centerZ = Math.round(component.offsetZ * context.footprintScale);
      const x1 = centerX - Math.floor(width / 2);
      const x2 = x1 + width - 1;
      const z1 = centerZ - Math.floor(depth / 2);
      const z2 = z1 + depth - 1;

      minOffsetX = Math.min(minOffsetX, x1);
      maxOffsetX = Math.max(maxOffsetX, x2);
      minOffsetZ = Math.min(minOffsetZ, z1);
      maxOffsetZ = Math.max(maxOffsetZ, z2);
    }

    if (!Number.isFinite(minOffsetX) || !Number.isFinite(minOffsetZ)) {
      minOffsetX = 0;
      maxOffsetX = 0;
      minOffsetZ = 0;
      maxOffsetZ = 0;
    }

    return {
      specId: context.spec.id,
      scale: context.scale,
      stylePreset: context.stylePreset,
      width: maxOffsetX - minOffsetX + 1,
      depth: maxOffsetZ - minOffsetZ + 1,
      minOffsetX,
      maxOffsetX,
      minOffsetZ,
      maxOffsetZ,
      includedComponentIds: context.components.map((component) => component.id),
      skippedComponentIds: context.skippedComponents.map((component) => component.id)
    };
  }

  async compileLandmarkBuildGraph(input: CompileGraphInput): Promise<BuildGraph> {
    const {
      spec,
      scale,
      stylePreset,
      palette,
      footprintScale,
      heightScale,
      budgetScale,
      components
    } = await this.resolveCompileContext(input);

    const now = nowMillis(this.nowProvider);
    const graphId = `landmark_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const nodes: BuildGraphNode[] = [];
    const includedComponentIds = new Set(components.map((component) => component.id));

    for (let index = 0; index < components.length; index++) {
      const component = components[index];
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
      const dependencies = component.dependencies.filter((dependency) => includedComponentIds.has(dependency));

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
    }

    const compiledNodes = this.expandCollaborativeShards(nodes);
    this.normalizeReservationOwners(compiledNodes);
    this.ensureCollaborativeCoverage(compiledNodes);
    assertDAG(compiledNodes);

    const expectedBlocks = compiledNodes.reduce((sum, node) => sum + node.expectedBlocks, 0);
    const edges = compiledNodes.flatMap((node) => (
      node.dependencies.map((dependency) => ({ from: dependency, to: node.taskId }))
    ));

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
      nodes: compiledNodes,
      edges
    };

    await this.upsertGraph(graph);
    return graph;
  }

  async registerBuildGraph(graph: BuildGraph): Promise<BuildGraph> {
    assertDAG(graph.nodes);
    const now = nowMillis(this.nowProvider);
    graph.updatedAt = now;
    graph.expectedBlocks = graph.nodes.reduce((sum, node) => sum + node.expectedBlocks, 0);
    graph.placedBlocks = graph.nodes.reduce((sum, node) => sum + node.blocksPlaced, 0);
    this.refreshTaskStates(graph, now);
    this.refreshGraphStatus(graph, now);
    await this.upsertGraph(graph);
    return graph;
  }

  async getGraph(graphId: string): Promise<BuildGraph | null> {
    const state = await this.readGraphState();
    const graph = state.graphs.find((entry) => entry.graphId === graphId);
    return graph ? JSON.parse(JSON.stringify(graph)) as BuildGraph : null;
  }

  async listActiveGraphBounds(excludeGraphIds: string[] = []): Promise<BoundingBox[]> {
    const state = await this.readGraphState();
    const excluded = new Set(excludeGraphIds);
    const activeStatuses = new Set<BuildGraphStatus>(['planning', 'allocating', 'building', 'qa']);
    const bounds: BoundingBox[] = [];

    for (const graph of state.graphs) {
      if (excluded.has(graph.graphId) || !activeStatuses.has(graph.graphStatus)) {
        continue;
      }
      for (const node of graph.nodes) {
        bounds.push(JSON.parse(JSON.stringify(node.bounds)) as BoundingBox);
      }
    }

    return bounds;
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
        ttlSeconds,
        spacingBlocks: 0
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
    await this.ensureNodeReservation(selected);
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

  private async ensureNodeReservation(node: BuildGraphNode): Promise<void> {
    const existingClaims = await this.coordinationStore.listClaims();
    const coveringClaim = existingClaims.find((claim) => (
      keyForOwner(claim.owner) === keyForOwner(node.assignedOwner) &&
      claim.zoneId === node.zoneId &&
      boxContains(claim, node.bounds)
    ));

    if (coveringClaim) {
      return;
    }

    const repaired = await this.coordinationStore.claimZone(
      node.assignedOwner,
      node.zoneId,
      node.bounds,
      1800,
      0
    );

    if (!repaired.ok) {
      throw new Error(
        `Zone '${node.zoneId}' is not available for ${node.assignedOwner}: ${repaired.message}`
      );
    }
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

  async completeTaskForReservation(
    owner: string,
    bounds: BoundingBox,
    note?: string,
    blocksPlaced?: number
  ): Promise<ReservationCompletionResult | null> {
    return this.withGraphLock(async () => {
      const state = await this.readGraphStateUnlocked();
      const ownerKey = keyForOwner(owner);
      const candidates: Array<{ graph: BuildGraph; node: BuildGraphNode }> = [];

      for (const graph of state.graphs) {
        for (const node of graph.nodes) {
          if (node.status !== 'in_progress') {
            continue;
          }
          if (keyForOwner(node.assignedOwner) !== ownerKey) {
            continue;
          }
          if (!boxContains(node.bounds, bounds)) {
            continue;
          }
          candidates.push({ graph, node });
        }
      }

      if (candidates.length === 0) {
        return null;
      }

      candidates.sort((a, b) => {
        const aVolume =
          (a.node.bounds.maxX - a.node.bounds.minX + 1) *
          (a.node.bounds.maxY - a.node.bounds.minY + 1) *
          (a.node.bounds.maxZ - a.node.bounds.minZ + 1);
        const bVolume =
          (b.node.bounds.maxX - b.node.bounds.minX + 1) *
          (b.node.bounds.maxY - b.node.bounds.minY + 1) *
          (b.node.bounds.maxZ - b.node.bounds.minZ + 1);
        return aVolume - bVolume || b.node.updatedAt - a.node.updatedAt;
      });

      const selected = candidates[0];
      const now = nowMillis(this.nowProvider);
      selected.node.status = 'done';
      selected.node.updatedAt = now;
      selected.node.completedAt = now;
      if (note) {
        selected.node.note = note.trim();
      }

      const noteBlocks = parseBlocksFromNote(note);
      const mergedBlocks = Math.max(0, blocksPlaced ?? 0, noteBlocks);
      if (mergedBlocks > 0) {
        selected.node.blocksPlaced = Math.max(selected.node.blocksPlaced, mergedBlocks);
      } else if (selected.node.blocksPlaced === 0) {
        selected.node.blocksPlaced = selected.node.expectedBlocks;
      }

      this.refreshTaskStates(selected.graph, now);
      this.refreshGraphStatus(selected.graph, now);
      selected.graph.updatedAt = now;

      await this.writeGraphStateUnlocked({ graphs: state.graphs });
      return selected;
    });
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

  private scoreLandmarkSpec(
    spec: LandmarkSpec,
    context: {
      normalizedPrompt: string;
      promptTokens: Set<string>;
      requestedCultureAliases: string[];
      sizeHint?: string;
      broadPrompt: boolean;
    }
  ): SelectLandmarkResult {
    const matchedKeywords = spec.keywords.filter((keyword) =>
      context.normalizedPrompt.includes(keyword.toLowerCase())
    );
    const keywordScore = matchedKeywords.length * 6;

    let tokenScore = 0;
    const nameTokens = normalizedTokenSet(spec.name);
    for (const token of nameTokens) {
      if (context.promptTokens.has(token)) {
        tokenScore += 4;
      }
    }

    const idTokens = normalizedTokenSet(spec.id.replace(/_/g, ' '));
    for (const token of idTokens) {
      if (context.promptTokens.has(token)) {
        tokenScore += 3;
      }
    }

    const specCultureAliases = cultureAliases(spec.culture);
    const hintedCultureMatch =
      context.requestedCultureAliases.length > 0 &&
      context.requestedCultureAliases.some((alias) => specCultureAliases.includes(alias));
    const promptCultureMatch = specCultureAliases.some((alias) => context.promptTokens.has(alias));
    const cultureScore = (hintedCultureMatch ? 8 : 0) + (promptCultureMatch ? 6 : 0);

    const prominenceScore =
      context.broadPrompt && (keywordScore > 0 || tokenScore > 0 || cultureScore > 0)
        ? (LANDMARK_PROMINENCE_BY_ID[spec.id] ?? 0)
        : 0;

    const score = keywordScore + tokenScore + cultureScore + prominenceScore;
    const recommendedScale = this.resolveScaleHint(spec, context.sizeHint);
    const rationale =
      `keywordScore=${keywordScore}, tokenScore=${tokenScore}, cultureScore=${cultureScore}, prominenceScore=${prominenceScore}` +
      (matchedKeywords.length > 0 ? `, keywords=${matchedKeywords.join(',')}` : '');

    return {
      spec,
      score,
      recommendedScale,
      matchedKeywords,
      rationale
    };
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

  private shouldIncludeOptionalSiteWork(prompt: string): boolean {
    return /(garden|path|plaza|landscap|courtyard|grounds|forecourt|walkway|walk|piazza)/i.test(prompt);
  }

  private selectComponentsForExecution(
    spec: LandmarkSpec,
    prompt: string,
    includeOptionalSiteWork = false
  ): { components: LandmarkComponent[]; skippedComponents: LandmarkComponent[] } {
    const keepOptionalSiteWork = includeOptionalSiteWork || this.shouldIncludeOptionalSiteWork(prompt);
    const components = spec.components.filter((component) => {
      const role = classifyRole(component.role);
      if (role === 'site' || role === 'landscaping') {
        return keepOptionalSiteWork;
      }
      return true;
    });

    const finalComponents = components.length > 0 ? components : spec.components;
    const included = new Set(finalComponents.map((component) => component.id));
    const skippedComponents = spec.components.filter((component) => !included.has(component.id));

    return {
      components: finalComponents,
      skippedComponents
    };
  }

  private async resolveCompileContext(input: {
    specId: string;
    scale?: string;
    stylePreset?: string;
    prompt?: string;
    includeOptionalSiteWork?: boolean;
  }): Promise<{
    spec: LandmarkSpec;
    scale: string;
    stylePreset: string;
    palette: z.infer<typeof STYLE_PALETTE_SCHEMA>;
    footprintScale: number;
    heightScale: number;
    budgetScale: number;
    components: LandmarkComponent[];
    skippedComponents: LandmarkComponent[];
  }> {
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

    const prompt = input.prompt ?? '';
    const promptTweaks = this.derivePromptTweaks(prompt);
    const footprintScale = scaleVariant.footprintScale * promptTweaks.footprintScale;
    const heightScale = scaleVariant.heightScale * promptTweaks.heightScale;
    const budgetScale = scaleVariant.budgetScale * promptTweaks.budgetScale;
    const selection = this.selectComponentsForExecution(
      spec,
      prompt,
      input.includeOptionalSiteWork ?? false
    );

    return {
      spec,
      scale,
      stylePreset,
      palette,
      footprintScale,
      heightScale,
      budgetScale,
      components: selection.components,
      skippedComponents: selection.skippedComponents
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
    const role = classifyRole(component.role);

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

    const startY = role === 'foundation' || materialKey === 'path'
      ? context.baseY - 1
      : context.baseY;

    return {
      primaryTool: 'fill-region',
      params: {
        x1: context.bounds.minX,
        y1: startY,
        z1: context.bounds.minZ,
        x2: context.bounds.maxX,
        y2: startY + Math.max(0, context.height - 1),
        z2: context.bounds.maxZ,
        blockType: material
      },
      note: `Fill structural mass for ${component.label} using ${material}.`
    };
  }

  private normalizeReservationOwners(nodes: BuildGraphNode[]): void {
    const groups = this.buildConflictGroups(nodes);
    for (const group of groups) {
      if (group.length < 2) {
        continue;
      }

      const selected = this.pickGroupAssignment(group);
      for (const node of group) {
        node.assignedWorker = selected.worker;
        node.assignedOwner = selected.owner;
      }
    }
  }

  private ensureCollaborativeCoverage(nodes: BuildGraphNode[]): void {
    const groups = this.buildConflictGroups(nodes);
    if (groups.length < 2) {
      return;
    }

    const distinctOwners = new Set(groups.map((group) => keyForOwner(group[0].assignedOwner)));
    if (distinctOwners.size >= 2) {
      return;
    }

    const candidates = [...groups].sort((a, b) => {
      const aBlocks = a.reduce((sum, node) => sum + node.expectedBlocks, 0);
      const bBlocks = b.reduce((sum, node) => sum + node.expectedBlocks, 0);
      return bBlocks - aBlocks;
    });

    for (const group of candidates) {
      for (const node of [...group].sort((a, b) => b.expectedBlocks - a.expectedBlocks)) {
        const pool = ROLE_WORKER_ROTATION[node.role] ?? ROLE_WORKER_ROTATION.generic;
        for (const worker of pool) {
          const owner = this.resolveOwnerAlias(worker);
          if (keyForOwner(owner) === keyForOwner(group[0].assignedOwner)) {
            continue;
          }

          for (const member of group) {
            member.assignedWorker = worker;
            member.assignedOwner = owner;
          }
          return;
        }
      }
    }
  }

  private buildConflictGroups(nodes: BuildGraphNode[]): BuildGraphNode[][] {
    const groups: BuildGraphNode[][] = [];
    const seen = new Set<string>();

    for (const node of nodes) {
      if (seen.has(node.taskId)) {
        continue;
      }

      const group: BuildGraphNode[] = [];
      const queue: BuildGraphNode[] = [node];
      seen.add(node.taskId);

      while (queue.length > 0) {
        const current = queue.shift();
        if (!current) {
          continue;
        }

        group.push(current);

        for (const candidate of nodes) {
          if (seen.has(candidate.taskId)) {
            continue;
          }
          if (!boxesOverlap(current.bounds, candidate.bounds)) {
            continue;
          }

          seen.add(candidate.taskId);
          queue.push(candidate);
        }
      }

      groups.push(group);
    }

    return groups;
  }

  private expandCollaborativeShards(nodes: BuildGraphNode[]): BuildGraphNode[] {
    const expansion = new Map<string, BuildGraphNode[]>();

    for (const node of nodes) {
      expansion.set(node.taskId, this.shardNodeIfNeeded(node));
    }

    const expanded: BuildGraphNode[] = [];
    for (const node of nodes) {
      const shards = expansion.get(node.taskId) ?? [node];
      for (const shard of shards) {
        const dependencies = node.dependencies.flatMap((dependency) => (
          expansion.get(dependency)?.map((entry) => entry.taskId) ?? [dependency]
        ));
        shard.dependencies = Array.from(new Set(dependencies));
        shard.status = shard.dependencies.length === 0 ? 'ready' : 'blocked';
        expanded.push(shard);
      }
    }

    return expanded;
  }

  private shardNodeIfNeeded(node: BuildGraphNode): BuildGraphNode[] {
    if (!this.shouldShardNode(node)) {
      return [node];
    }

    const params = node.toolPlan.params as Record<string, number>;
    const x1 = Math.min(Number(params.x1), Number(params.x2));
    const x2 = Math.max(Number(params.x1), Number(params.x2));
    const y1 = Math.min(Number(params.y1), Number(params.y2));
    const y2 = Math.max(Number(params.y1), Number(params.y2));
    const z1 = Math.min(Number(params.z1), Number(params.z2));
    const z2 = Math.max(Number(params.z1), Number(params.z2));
    const width = x2 - x1 + 1;
    const depth = z2 - z1 + 1;
    const splitAlongX = width >= depth;
    const splitSize = splitAlongX ? width : depth;
    const firstSize = Math.ceil(splitSize / 2);
    const secondSize = splitSize - firstSize;

    if (firstSize < MIN_SHARD_DIMENSION_BLOCKS || secondSize < MIN_SHARD_DIMENSION_BLOCKS) {
      return [node];
    }

    const pool = this.workerRotationForRole(node.role);
    const workerA = node.assignedWorker;
    const workerB = pool.find((worker) => worker !== workerA) ?? pool[0] ?? workerA;
    if (workerA === workerB) {
      return [node];
    }

    const firstBounds = splitAlongX
      ? normalizeBounds(x1, y1, z1, x1 + firstSize - 1, y2, z2)
      : normalizeBounds(x1, y1, z1, x2, y2, z1 + firstSize - 1);
    const secondBounds = splitAlongX
      ? normalizeBounds(x1 + firstSize, y1, z1, x2, y2, z2)
      : normalizeBounds(x1, y1, z1 + firstSize, x2, y2, z2);

    const firstVolume = this.boundsVolume(firstBounds);
    const secondVolume = this.boundsVolume(secondBounds);
    const totalVolume = Math.max(1, firstVolume + secondVolume);
    const firstExpectedBlocks = Math.max(12, Math.round(node.expectedBlocks * (firstVolume / totalVolume)));

    return [
      this.cloneShardNode(node, {
        suffix: splitAlongX ? 'west' : 'north',
        bounds: firstBounds,
        expectedBlocks: firstExpectedBlocks,
        worker: workerA
      }),
      this.cloneShardNode(node, {
        suffix: splitAlongX ? 'east' : 'south',
        bounds: secondBounds,
        expectedBlocks: Math.max(12, node.expectedBlocks - firstExpectedBlocks),
        worker: workerB
      })
    ];
  }

  private cloneShardNode(
    node: BuildGraphNode,
    input: {
      suffix: string;
      bounds: BoundingBox;
      expectedBlocks: number;
      worker: string;
    }
  ): BuildGraphNode {
    const params = node.toolPlan.params as Record<string, unknown>;

    return {
      ...node,
      taskId: `${node.taskId}_${input.suffix}`,
      zoneId: `${node.zoneId}_${input.suffix}`,
      label: `${node.label} (${input.suffix})`,
      assignedWorker: input.worker,
      assignedOwner: this.resolveOwnerAlias(input.worker),
      bounds: input.bounds,
      centerX: Math.floor((input.bounds.minX + input.bounds.maxX) / 2),
      centerZ: Math.floor((input.bounds.minZ + input.bounds.maxZ) / 2),
      expectedBlocks: input.expectedBlocks,
      blocksPlaced: 0,
      status: 'blocked',
      attempts: 0,
      note: undefined,
      startedAt: undefined,
      completedAt: undefined,
      toolPlan: {
        ...node.toolPlan,
        params: {
          ...params,
          x1: input.bounds.minX,
          y1: input.bounds.minY,
          z1: input.bounds.minZ,
          x2: input.bounds.maxX,
          y2: input.bounds.maxY,
          z2: input.bounds.maxZ
        },
        note: `${node.toolPlan.note} shard=${input.suffix}`
      }
    };
  }

  private shouldShardNode(node: BuildGraphNode): boolean {
    if (node.toolPlan.primaryTool !== 'fill-region') {
      return false;
    }
    if (node.expectedBlocks < MIN_SHARD_EXPECTED_BLOCKS) {
      return false;
    }
    if (!['foundation', 'walls', 'roof'].includes(node.role)) {
      return false;
    }

    const params = node.toolPlan.params as Record<string, number>;
    const width = Math.abs(Number(params.x2) - Number(params.x1)) + 1;
    const depth = Math.abs(Number(params.z2) - Number(params.z1)) + 1;
    return Math.max(width, depth) >= MIN_SHARD_DIMENSION_BLOCKS * 2;
  }

  private boundsVolume(bounds: BoundingBox): number {
    return (
      Math.max(1, bounds.maxX - bounds.minX + 1) *
      Math.max(1, bounds.maxY - bounds.minY + 1) *
      Math.max(1, bounds.maxZ - bounds.minZ + 1)
    );
  }

  private workerRotationForRole(role: RoleName): string[] {
    return ROLE_WORKER_ROTATION[role] ?? ROLE_WORKER_ROTATION.generic;
  }

  private pickGroupAssignment(group: BuildGraphNode[]): { worker: string; owner: string } {
    const ranked = [...group].sort((a, b) => {
      if (a.dependencies.length !== b.dependencies.length) {
        return a.dependencies.length - b.dependencies.length;
      }

      const roleDelta = this.roleReservationPriority(a.role) - this.roleReservationPriority(b.role);
      if (roleDelta !== 0) {
        return roleDelta;
      }

      return b.expectedBlocks - a.expectedBlocks;
    });

    const selected = ranked[0] ?? group[0];
    return {
      worker: selected.assignedWorker,
      owner: selected.assignedOwner
    };
  }

  private roleReservationPriority(role: RoleName): number {
    switch (role) {
      case 'foundation':
        return 0;
      case 'walls':
        return 1;
      case 'roof':
        return 2;
      case 'arches':
        return 3;
      case 'ornament':
        return 4;
      case 'utilities':
        return 5;
      case 'landscaping':
        return 6;
      case 'site':
        return 7;
      default:
        return 8;
    }
  }

  private refreshTaskStates(graph: BuildGraph, now: number): void {
    const taskMap = new Map(graph.nodes.map((node) => [node.taskId, node]));

    const dependencyDone = (node: BuildGraphNode): boolean =>
      node.dependencies.every((dependencyId) => taskMap.get(dependencyId)?.status === 'done');

    for (const node of graph.nodes) {
      if (node.status === 'in_progress' && node.startedAt && now - node.startedAt > this.taskTimeoutMs) {
        node.status = 'failed';
        node.note = `timed out after ${Math.floor(this.taskTimeoutMs / 1000)}s`;
        node.updatedAt = now;
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
