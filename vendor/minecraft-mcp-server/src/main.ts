#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupStdioFiltering } from './stdio-filter.js';
import { log } from './logger.js';
import { parseConfig } from './config.js';
import { BotConnection } from './bot-connection.js';
import { ToolFactory } from './tool-factory.js';
import { MessageStore } from './message-store.js';
import {
  BuildCoordinationStore,
  boxesOverlapWithGap,
  normalizeBounds,
  type BoundingBox
} from './build-coordination.js';
import {
  DEFAULT_SAFETY_LIMITS,
  assessManMadeDensity,
  classifyBlockNature,
  enforceDensityGuard,
  getFootprint,
  getVolume,
  shouldEnforceOccupiedAreaGuard,
  validateSafetyLimits
} from './build-safety.js';
import { BlockPlacementQueue } from './block-placement-queue.js';
import { buildFillBatches } from './fill-batching.js';
import {
  latestZonePhase,
  planVillageLayout,
  zoneHasPhase
} from './scenario-tools.js';
import {
  parseSetblockPlacement,
  stripBlockState,
  validateGroundedPlacement
} from './placement-guard.js';
import {
  LandmarkAutonomyService,
  formatDispatchTask,
  type BuildGraph,
  type BuildGraphNode,
  type SelectLandmarkResult
} from './landmark-autonomy.js';
import { TemplateGeneratorService } from './template-generator.js';
import {
  CatalogLookupService,
  type CatalogLookupCandidate,
  type CatalogLookupResult
} from './catalog-lookup.js';
import {
  importCatalogModel,
  type CatalogModelArtifact
} from './catalog-import.js';
import {
  importLocalStructureWorldAsModel,
  resolveLocalStructureReference
} from './local-structure-import.js';
import {
  importOtsBlockModelAsCatalogModel,
  resolveOtsBlockModelReference
} from './ots-blocks-import.js';
import {
  createCatalogPlacementArtifact,
  writeCatalogModelArtifact,
  writeCatalogPlacementArtifact,
  type CatalogPlacementArtifact
} from './catalog-graph.js';
import {
  buildPlacementPlan,
  streamRconCommands,
  type PlacementBlock
} from './catalog-place.js';

setupStdioFiltering();

process.on('unhandledRejection', (reason) => {
  log('error', `Unhandled rejection: ${reason}`);
});

process.on('uncaughtException', (error) => {
  log('error', `Uncaught exception: ${error}`);
});

const coordinationStore = new BuildCoordinationStore();
const placementQueue = new BlockPlacementQueue();
const GoalNearXZ = (pathfinderPkg as any).goals?.GoalNearXZ;
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LANDMARK_SPECS_DIR = path.resolve(CURRENT_DIR, '../landmark_specs');
const META_TEMPLATES_DIR = path.resolve(CURRENT_DIR, '../meta_templates');
const PROJECT_ROOT_DIR = path.resolve(CURRENT_DIR, '../../..');

const BLOCK_QUEUE_DELAY_MS = 5;
const FILL_BATCH_TILE_SPAN = 6;
const MAX_SETBLOCK_HORIZONTAL_DISTANCE = 4;
const WALK_TO_RANGE = 1;
const HOUSE_SITE_SEARCH_RADIUS = 16;
const HOUSE_SITE_SEARCH_STEP = 2;
const HOUSE_WATER_BUFFER_BLOCKS = 2;
const GARDEN_SITE_SEARCH_RADIUS = 14;
const GARDEN_SITE_SEARCH_STEP = 2;
const GARDEN_WATER_BUFFER_BLOCKS = 1;
const MAX_STORM_DAMAGE_BLOCKS = 48;
const MAX_REPAIR_BLOCKS = 300;
const ZONE_GAP_BLOCKS = 2;
const ORCHESTRATOR_RESERVATION_CONTROLLER = 'OrchScout_o11';
const CATALOG_RUNTIME_DIR = '/tmp/sam-minecraft-coordination/catalog-runtime';
const CATALOG_RCON_BATCH_SIZE = 45;
const CATALOG_WORK_POST_OFFSET = 3;
const CATALOG_WORKER_WALK_TIMEOUT_MS = 4500;
const CATALOG_CINEMATIC_BATCH_DELAY_MS = 250;
const DIRECT_RECORDING_RCON_BATCH_DELAY_MS = 250;
const CATALOG_BATCH_SAFETY_LIMITS = {
  ...DEFAULT_SAFETY_LIMITS,
  maxFootprint: Math.min(DEFAULT_SAFETY_LIMITS.maxFootprint, 1000),
  maxVolume: Math.min(DEFAULT_SAFETY_LIMITS.maxVolume, 3000)
};
const RECORDING_CHOREOGRAPHY_DEFAULT_AGENTS = [
  'BuildBea_l33',
  'MonumentMarc_m9',
  'SupplySid_l31'
];

const OWNER_ALIAS_MAP = new Map<string, string>([
  ['minecraftagent', 'HandyHank_l33'],
  ['handyhank', 'HandyHank_l33'],
  ['handyhankl33', 'HandyHank_l33'],
  ['designdoraagent', 'DesignDora_l4s'],
  ['designdora', 'DesignDora_l4s'],
  ['designdoral4s', 'DesignDora_l4s'],
  ['buildbeaagent', 'BuildBea_l33'],
  ['buildbea', 'BuildBea_l33'],
  ['buildbeal33', 'BuildBea_l33'],
  ['supplysidagent', 'SupplySid_l31'],
  ['supplysid', 'SupplySid_l31'],
  ['supplysidl31', 'SupplySid_l31'],
  ['forestfinnagent', 'ForestFinn_q32'],
  ['forestfinn', 'ForestFinn_q32'],
  ['forestfinnq32', 'ForestFinn_q32'],
  ['monumentmarcagent', 'MonumentMarc_m9'],
  ['monumentmarc', 'MonumentMarc_m9'],
  ['monumentmarcm9', 'MonumentMarc_m9'],
  ['orchestratoragent', 'OrchScout_o11'],
  ['orchscouto11', 'OrchScout_o11']
]);

let landmarkAutonomyService: LandmarkAutonomyService | null = null;
let templateGeneratorService: TemplateGeneratorService | null = null;
let catalogLookupService: CatalogLookupService | null = null;

function getLandmarkAutonomyService(): LandmarkAutonomyService {
  if (!landmarkAutonomyService) {
    landmarkAutonomyService = new LandmarkAutonomyService({
      specDir: LANDMARK_SPECS_DIR,
      coordinationStore,
      resolveOwnerAlias: resolveReservationOwner
    });
  }
  return landmarkAutonomyService;
}

function getTemplateGeneratorService(): TemplateGeneratorService {
  if (!templateGeneratorService) {
    templateGeneratorService = new TemplateGeneratorService(
      META_TEMPLATES_DIR,
      LANDMARK_SPECS_DIR
    );
  }
  return templateGeneratorService;
}

function getCatalogLookupService(): CatalogLookupService {
  if (!catalogLookupService) {
    catalogLookupService = new CatalogLookupService();
  }
  return catalogLookupService;
}

async function autoCompleteGraphTaskForMutation(
  owner: string,
  bounds: BoundingBox,
  note: string,
  blocksPlaced: number
): Promise<void> {
  const completion = await getLandmarkAutonomyService().completeTaskForReservation(
    owner,
    bounds,
    note,
    blocksPlaced
  );

  if (!completion) {
    return;
  }

  await coordinationStore.reportProgress({
    taskId: completion.graph.graphId,
    zoneId: completion.node.zoneId,
    owner,
    phase: 'task:done',
    note
  });
}

function toInt(value: unknown): number {
  return Math.floor(Number(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBlockType(blockType: string): string {
  const normalized = blockType.trim().toLowerCase();
  return normalized.startsWith('minecraft:') ? normalized : `minecraft:${normalized}`;
}

function parseCsvList(raw: unknown): string[] | undefined {
  if (raw == null) {
    return undefined;
  }
  const value = String(raw).trim();
  if (value.length === 0) {
    return undefined;
  }
  const items = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return items.length > 0 ? items : undefined;
}

function truncateText(value: string, maxLength = 96): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function peerToolNameForWorker(workerId: string): string {
  const trimmed = workerId.trim();
  if (!trimmed) {
    return 'peer-UNKNOWN';
  }
  const withoutPeerPrefix = trimmed.replace(/^peer[-_]?/i, '');
  return `peer-${withoutPeerPrefix}`;
}

function ownerAliasKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveReservationOwner(rawOwner: string): string {
  const trimmed = rawOwner.trim();
  if (trimmed.length === 0) {
    return trimmed;
  }

  const withoutPeerPrefix = trimmed.replace(/^peer[-_]?/i, '');
  const alias = OWNER_ALIAS_MAP.get(ownerAliasKey(withoutPeerPrefix));
  return alias ?? withoutPeerPrefix;
}

function ownersMatch(left: string, right: string): boolean {
  return ownerAliasKey(resolveReservationOwner(left)) === ownerAliasKey(resolveReservationOwner(right));
}

function isOrchestratorReservationController(rawOwner: string): boolean {
  return ownersMatch(rawOwner, ORCHESTRATOR_RESERVATION_CONTROLLER) || ownersMatch(rawOwner, 'OrchestratorAgent');
}

function requireOrchestratorReservationControl(rawOwner: string, action: string): string {
  const resolvedOwner = resolveReservationOwner(rawOwner);
  if (!isOrchestratorReservationController(resolvedOwner)) {
    throw new Error(
      `${action} is orchestrator-only. Workers must use preassigned zones from get-my-build-zones.`
    );
  }
  return resolvedOwner;
}

function isAirBlockName(name: string | null | undefined): boolean {
  return !name || name === 'air' || name === 'void_air' || name === 'cave_air';
}

function isAirBlockType(blockType: string): boolean {
  const normalized = stripBlockState(blockType).replace('minecraft:', '').toLowerCase();
  return normalized === 'air' || normalized === 'void_air' || normalized === 'cave_air';
}

function formatBounds(bounds: BoundingBox): string {
  return `(${bounds.minX},${bounds.minY},${bounds.minZ})-(${bounds.maxX},${bounds.maxY},${bounds.maxZ})`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function horizontalDistanceTo(bot: any, x: number, zCoord: number): number {
  const pos = bot.entity.position;
  return Math.hypot(pos.x - x, pos.z - zCoord);
}

function isUnsafeNaturalSurfaceName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === 'water' ||
    normalized === 'lava' ||
    normalized === 'ice' ||
    normalized === 'packed_ice' ||
    normalized === 'blue_ice' ||
    normalized === 'frosted_ice' ||
    normalized === 'powder_snow' ||
    normalized === 'snow' ||
    normalized.endsWith('_leaves') ||
    normalized.endsWith('_log') ||
    normalized.endsWith('_wood') ||
    normalized.includes('seagrass') ||
    normalized.includes('kelp')
  );
}

function isLandSurfaceBlock(block: any): boolean {
  if (!block || isAirBlockName(block.name)) {
    return false;
  }

  if (block.liquid || block.boundingBox !== 'block') {
    return false;
  }

  if (classifyBlockNature(block.name) !== 'natural') {
    return false;
  }

  return !isUnsafeNaturalSurfaceName(String(block.name));
}

async function walkBotNearXZ(bot: any, x: number, zCoord: number, range: number): Promise<void> {
  if (horizontalDistanceTo(bot, x, zCoord) <= range) {
    return;
  }

  if (!GoalNearXZ || !bot.pathfinder?.goto) {
    throw new Error('Pathfinder movement is unavailable; cannot walk to target');
  }

  const goalRange = Math.max(1, Math.floor(range));
  try {
    await bot.pathfinder.goto(new GoalNearXZ(x, zCoord, goalRange));
  } catch (error) {
    throw new Error(
      `Could not walk near (${x}, ${zCoord}): ${formatError(error)}`
    );
  }
}

interface PlacementExecutionContext {
  surfaceHeightCache?: Map<string, number>;
}

function createPlacementExecutionContext(cacheSurfaceHeights = false): PlacementExecutionContext {
  return cacheSurfaceHeights
    ? { surfaceHeightCache: new Map<string, number>() }
    : {};
}

async function runServerCommand(
  bot: any,
  command: string,
  context?: PlacementExecutionContext
): Promise<void> {
  const setblockPlacement = parseSetblockPlacement(command);
  if (setblockPlacement) {
    await ensureGroundedSetblockPlacement(bot, setblockPlacement, context);
    await ensureBotNearBlock(
      bot,
      setblockPlacement.x,
      setblockPlacement.y,
      setblockPlacement.z
    );
  }
  await runServerCommandRaw(bot, command);
}

async function runServerCommandRaw(bot: any, command: string): Promise<void> {
  bot.chat(command);
  await delay(10);
}

async function ensureBotNearBlock(bot: any, x: number, y: number, zCoord: number): Promise<void> {
  const horizontalDistance = horizontalDistanceTo(bot, x, zCoord);
  const verticalDistance = Math.abs(bot.entity.position.y - (y + 1));

  if (horizontalDistance <= MAX_SETBLOCK_HORIZONTAL_DISTANCE && verticalDistance <= 8) {
    return;
  }

  await walkBotNearXZ(
    bot,
    x,
    zCoord,
    Math.max(1, MAX_SETBLOCK_HORIZONTAL_DISTANCE - 1)
  );
}

async function runFillBatches(
  bot: any,
  bounds: BoundingBox,
  batches: ReturnType<typeof buildFillBatches>
): Promise<void> {
  const centerX = Math.floor((bounds.minX + bounds.maxX) / 2);
  const centerZ = Math.floor((bounds.minZ + bounds.maxZ) / 2);
  await walkBotNearXZ(bot, centerX, centerZ, 4);

  for (const batch of batches) {
    await placementQueue.enqueue(async () => {
      await runServerCommandRaw(bot, batch.command);
      if (BLOCK_QUEUE_DELAY_MS > 0) {
        await delay(BLOCK_QUEUE_DELAY_MS);
      }
    });
  }
}

function isSolidSupportBlock(block: any): boolean {
  if (!block || isAirBlockName(block.name) || block.liquid) {
    return false;
  }
  return block.boundingBox !== 'empty';
}

function hasSolidNeighbor(bot: any, x: number, y: number, zCoord: number): boolean {
  const offsets = [
    [0, -1, 0],
    [0, 1, 0],
    [1, 0, 0],
    [-1, 0, 0],
    [0, 0, 1],
    [0, 0, -1]
  ];

  return offsets.some(([dx, dy, dz]) => {
    const block = bot.blockAt(new Vec3(x + dx, y + dy, zCoord + dz));
    return isSolidSupportBlock(block);
  });
}

function isOpenAboveBlock(block: any): boolean {
  if (!block || isAirBlockName(block.name)) {
    return true;
  }

  if (block.liquid) {
    return false;
  }

  return block.boundingBox === 'empty';
}

async function ensureGroundedSetblockPlacement(
  bot: any,
  placement: { x: number; y: number; z: number; blockType: string },
  context?: PlacementExecutionContext
): Promise<void> {
  const target = bot.blockAt(new Vec3(placement.x, placement.y, placement.z));
  const below = bot.blockAt(new Vec3(placement.x, placement.y - 1, placement.z));
  const above = bot.blockAt(new Vec3(placement.x, placement.y + 1, placement.z));
  const surfaceY = await getSurfaceHeightAt(
    bot,
    placement.x,
    placement.z,
    200,
    0,
    context?.surfaceHeightCache
  );

  const violation = validateGroundedPlacement({
    blockType: normalizeBlockType(placement.blockType),
    y: placement.y,
    targetOccupied: Boolean(target && !isAirBlockName(target.name)),
    hasSolidNeighbor: hasSolidNeighbor(bot, placement.x, placement.y, placement.z),
    surfaceY,
    belowIsSolid: isSolidSupportBlock(below),
    aboveIsAir: isOpenAboveBlock(above)
  });

  if (violation) {
    throw new Error(`${violation} at (${placement.x}, ${placement.y}, ${placement.z})`);
  }
}

interface HouseSiteEvaluation {
  ok: boolean;
  baseY: number;
  reason?: string;
}

interface LandColumnSample {
  ok: boolean;
  surfaceY: number;
  groundY: number;
  reason?: string;
}

interface Footprint2D {
  centerX: number;
  centerZ: number;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  width: number;
  depth: number;
}

interface LandFootprintEvaluation {
  ok: boolean;
  baseY: number;
  minGroundY: number;
  maxGroundY: number;
  sampleCount: number;
  manMadeColumns: number;
  reason?: string;
}

interface LandFootprintSearchResult {
  footprint: Footprint2D;
  evaluation: LandFootprintEvaluation;
  offsetDx: number;
  offsetDz: number;
}

function terrainDelta(evaluation: Pick<LandFootprintEvaluation, 'minGroundY' | 'maxGroundY'>): number {
  return evaluation.maxGroundY - evaluation.minGroundY;
}

interface HouseMaterials {
  wallMaterial: string;
  logMaterial: string;
  roofMaterial: string;
  doorMaterial: string;
}

interface HouseDefect {
  x: number;
  y: number;
  z: number;
  expected: string;
  actual: string;
}

interface HouseInspectionResult {
  centerX: number;
  centerZ: number;
  baseY: number;
  style: string;
  totalChecked: number;
  defects: HouseDefect[];
  score: number;
}

function candidateOffsets(maxRadius: number, step: number): Array<{ dx: number; dz: number }> {
  const offsets: Array<{ dx: number; dz: number }> = [{ dx: 0, dz: 0 }];
  for (let radius = step; radius <= maxRadius; radius += step) {
    for (let dx = -radius; dx <= radius; dx += step) {
      for (let dz = -radius; dz <= radius; dz += step) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) {
          continue;
        }
        offsets.push({ dx, dz });
      }
    }
  }
  return offsets;
}

function shortBlockName(blockType: string): string {
  return blockType.replace(/^minecraft:/, '');
}

function blockNameMatches(actualName: string | null | undefined, expectedBlockType: string): boolean {
  const expectedShort = shortBlockName(expectedBlockType);
  return Boolean(actualName && actualName.toLowerCase() === expectedShort.toLowerCase());
}

function houseMaterialsForStyle(inputStyle: string): HouseMaterials {
  const style = inputStyle.toLowerCase();
  if (style === 'spruce') {
    return {
      wallMaterial: 'minecraft:spruce_planks',
      logMaterial: 'minecraft:spruce_log',
      roofMaterial: 'minecraft:spruce_planks',
      doorMaterial: 'minecraft:spruce_door'
    };
  }
  if (style === 'birch') {
    return {
      wallMaterial: 'minecraft:birch_planks',
      logMaterial: 'minecraft:birch_log',
      roofMaterial: 'minecraft:birch_planks',
      doorMaterial: 'minecraft:birch_door'
    };
  }
  if (style === 'stone') {
    return {
      wallMaterial: 'minecraft:stone_bricks',
      logMaterial: 'minecraft:stone_bricks',
      roofMaterial: 'minecraft:stone_bricks',
      doorMaterial: 'minecraft:iron_door'
    };
  }
  return {
    wallMaterial: 'minecraft:oak_planks',
    logMaterial: 'minecraft:oak_log',
    roofMaterial: 'minecraft:oak_planks',
    doorMaterial: 'minecraft:oak_door'
  };
}

async function sampleLandColumn(bot: any, x: number, zCoord: number): Promise<LandColumnSample> {
  const surfaceY = await getSurfaceHeightAt(bot, x, zCoord);
  const groundY = surfaceY - 1;
  const ground = bot.blockAt(new Vec3(x, groundY, zCoord));
  const above = bot.blockAt(new Vec3(x, surfaceY, zCoord));

  if (!ground) {
    return { ok: false, surfaceY, groundY, reason: 'ground block unavailable' };
  }
  if (!isLandSurfaceBlock(ground)) {
    return {
      ok: false,
      surfaceY,
      groundY,
      reason: `surface '${ground.name}' is not buildable land`
    };
  }
  if (above?.liquid) {
    return {
      ok: false,
      surfaceY,
      groundY,
      reason: `column contains liquid '${above.name}'`
    };
  }

  return { ok: true, surfaceY, groundY };
}

function footprintSampleStep(footprint: Footprint2D): number {
  const area = footprint.width * footprint.depth;
  if (area >= 2500) {
    return 6;
  }
  if (area >= 900) {
    return 4;
  }
  if (area >= 225) {
    return 2;
  }
  return 1;
}

async function detectNearbyWater(
  bot: any,
  footprint: Footprint2D,
  waterBufferBlocks: number,
  surfaceHeightCache?: Map<string, number>
): Promise<{ hasWater: boolean; location?: string }> {
  const margin = Math.max(0, Math.floor(waterBufferBlocks));
  if (margin === 0) {
    return { hasWater: false };
  }

  const step = Math.max(1, footprintSampleStep(footprint));

  for (let x = footprint.x1 - margin; x <= footprint.x2 + margin; x += step) {
    for (let zCoord = footprint.z1 - margin; zCoord <= footprint.z2 + margin; zCoord += step) {
      const inFootprint =
        x >= footprint.x1 &&
        x <= footprint.x2 &&
        zCoord >= footprint.z1 &&
        zCoord <= footprint.z2;
      if (inFootprint) {
        continue;
      }

      const surfaceY = await getSurfaceHeightAt(bot, x, zCoord, 200, 0, surfaceHeightCache);
      const ground = bot.blockAt(new Vec3(x, surfaceY - 1, zCoord));
      const above = bot.blockAt(new Vec3(x, surfaceY, zCoord));

      if (ground?.liquid || above?.liquid || ground?.name === 'water' || above?.name === 'water') {
        return {
          hasWater: true,
          location: `${x},${surfaceY},${zCoord}`
        };
      }
    }
  }

  return { hasWater: false };
}

function footprintFromCenter(
  centerX: number,
  centerZ: number,
  width: number,
  depth: number
): Footprint2D {
  const safeWidth = Math.max(1, Math.floor(width));
  const safeDepth = Math.max(1, Math.floor(depth));
  const x1 = centerX - Math.floor(safeWidth / 2);
  const z1 = centerZ - Math.floor(safeDepth / 2);

  return {
    centerX,
    centerZ,
    x1,
    z1,
    x2: x1 + safeWidth - 1,
    z2: z1 + safeDepth - 1,
    width: safeWidth,
    depth: safeDepth
  };
}

function footprintFromBounds(
  x1: number,
  z1: number,
  x2: number,
  z2: number
): Footprint2D {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minZ = Math.min(z1, z2);
  const maxZ = Math.max(z1, z2);
  const width = maxX - minX + 1;
  const depth = maxZ - minZ + 1;
  return {
    centerX: Math.floor((minX + maxX) / 2),
    centerZ: Math.floor((minZ + maxZ) / 2),
    x1: minX,
    z1: minZ,
    x2: maxX,
    z2: maxZ,
    width,
    depth
  };
}

function formatFootprint(footprint: Footprint2D): string {
  return `x1=${footprint.x1} z1=${footprint.z1} x2=${footprint.x2} z2=${footprint.z2}`;
}

async function evaluateLandFootprint(
  bot: any,
  footprint: Footprint2D,
  maxHeightDelta: number,
  maxManMadeColumns: number,
  waterBufferBlocks = 1
): Promise<LandFootprintEvaluation> {
  const surfaceHeightCache = new Map<string, number>();
  const sampleStep = footprintSampleStep(footprint);
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let sumY = 0;
  let countY = 0;

  for (let x = footprint.x1; x <= footprint.x2; x += sampleStep) {
    for (let zCoord = footprint.z1; zCoord <= footprint.z2; zCoord += sampleStep) {
      const surfaceY = await getSurfaceHeightAt(bot, x, zCoord, 200, 0, surfaceHeightCache);
      const groundY = surfaceY - 1;
      const ground = bot.blockAt(new Vec3(x, groundY, zCoord));
      const above = bot.blockAt(new Vec3(x, surfaceY, zCoord));
      const sample = !ground
        ? { ok: false as const, surfaceY, groundY, reason: 'ground block unavailable' }
        : !isLandSurfaceBlock(ground)
          ? { ok: false as const, surfaceY, groundY, reason: `surface '${ground.name}' is not buildable land` }
          : above?.liquid
            ? { ok: false as const, surfaceY, groundY, reason: `column contains liquid '${above.name}'` }
            : { ok: true as const, surfaceY, groundY };
      if (!sample.ok) {
        return {
          ok: false,
          baseY: 64,
          minGroundY: 64,
          maxGroundY: 64,
          sampleCount: countY,
          manMadeColumns: 0,
          reason: `water/non-land terrain at (${x},${zCoord}): ${sample.reason}`
        };
      }
      minY = Math.min(minY, sample.groundY);
      maxY = Math.max(maxY, sample.groundY);
      sumY += sample.groundY;
      countY++;
    }
  }

  if (countY === 0) {
    return {
      ok: false,
      baseY: 64,
      minGroundY: 64,
      maxGroundY: 64,
      sampleCount: 0,
      manMadeColumns: 0,
      reason: 'could not sample terrain'
    };
  }

  const baseY = Math.round(sumY / countY) + 1;
  const delta = maxY - minY;
  if (delta > Math.max(0, maxHeightDelta)) {
    return {
      ok: false,
      baseY,
      minGroundY: minY,
      maxGroundY: maxY,
      sampleCount: countY,
      manMadeColumns: 0,
      reason: `terrain is not flat enough (delta=${delta}, allowed=${maxHeightDelta})`
    };
  }

  let manMadeColumns = 0;
  for (let x = footprint.x1; x <= footprint.x2; x += sampleStep) {
    for (let zCoord = footprint.z1; zCoord <= footprint.z2; zCoord += sampleStep) {
      for (let y = baseY; y <= baseY + 4; y++) {
        const name = bot.blockAt(new Vec3(x, y, zCoord))?.name ?? null;
        if (classifyBlockNature(name) === 'manmade') {
          manMadeColumns += 1;
          break;
        }
      }
    }
  }

  if (manMadeColumns > Math.max(0, maxManMadeColumns)) {
    return {
      ok: false,
      baseY,
      minGroundY: minY,
      maxGroundY: maxY,
      sampleCount: countY,
      manMadeColumns,
      reason: `existing structure detected in footprint (man-made columns=${manMadeColumns})`
    };
  }

  const nearbyWater = await detectNearbyWater(bot, footprint, waterBufferBlocks, surfaceHeightCache);
  if (nearbyWater.hasWater) {
    return {
      ok: false,
      baseY,
      minGroundY: minY,
      maxGroundY: maxY,
      sampleCount: countY,
      manMadeColumns,
      reason:
        `nearby water detected within ${Math.max(0, Math.floor(waterBufferBlocks))} block buffer` +
        (nearbyWater.location ? ` at ${nearbyWater.location}` : '')
    };
  }

  return {
    ok: true,
    baseY,
    minGroundY: minY,
    maxGroundY: maxY,
    sampleCount: countY,
    manMadeColumns
  };
}

async function findNearestLandFootprint(
  bot: any,
  requestedCenterX: number,
  requestedCenterZ: number,
  width: number,
  depth: number,
  searchRadius: number,
  searchStep: number,
  maxHeightDelta: number,
  maxManMadeColumns: number,
  waterBufferBlocks: number
): Promise<{ ok: boolean; result?: LandFootprintSearchResult; reason: string }> {
  let lastReason = 'no candidates evaluated';

  for (const offset of candidateOffsets(searchRadius, searchStep)) {
    const centerX = requestedCenterX + offset.dx;
    const centerZ = requestedCenterZ + offset.dz;
    const footprint = footprintFromCenter(centerX, centerZ, width, depth);
    const evaluation = await evaluateLandFootprint(
      bot,
      footprint,
      maxHeightDelta,
      maxManMadeColumns,
      waterBufferBlocks
    );

    if (evaluation.ok) {
      return {
        ok: true,
        result: {
          footprint,
          evaluation,
          offsetDx: offset.dx,
          offsetDz: offset.dz
        },
        reason: 'ok'
      };
    }

    lastReason = evaluation.reason ?? 'site rejected';
  }

  return {
    ok: false,
    reason: lastReason
  };
}

async function findNearestLandmarkOrigin(
  bot: any,
  requestedOriginX: number,
  requestedOriginZ: number,
  envelope: {
    minOffsetX: number;
    maxOffsetX: number;
    minOffsetZ: number;
    maxOffsetZ: number;
  },
  searchRadius: number,
  searchStep: number,
  maxHeightDelta: number,
  maxManMadeColumns: number,
  waterBufferBlocks: number
): Promise<{
  ok: boolean;
  result?: {
    originX: number;
    originZ: number;
    footprint: Footprint2D;
    evaluation: LandFootprintEvaluation;
    offsetDx: number;
    offsetDz: number;
  };
  reason: string;
}> {
  let lastReason = 'no candidates evaluated';
  let bestResult: {
    originX: number;
    originZ: number;
    footprint: Footprint2D;
    evaluation: LandFootprintEvaluation;
    offsetDx: number;
    offsetDz: number;
  } | undefined;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const offset of candidateOffsets(searchRadius, searchStep)) {
    const originX = requestedOriginX + offset.dx;
    const originZ = requestedOriginZ + offset.dz;
    const footprint = footprintFromBounds(
      originX + envelope.minOffsetX,
      originZ + envelope.minOffsetZ,
      originX + envelope.maxOffsetX,
      originZ + envelope.maxOffsetZ
    );
    const evaluation = await evaluateLandFootprint(
      bot,
      footprint,
      maxHeightDelta,
      maxManMadeColumns,
      waterBufferBlocks
    );

    if (evaluation.ok) {
      const score =
        evaluation.manMadeColumns * 10000 +
        terrainDelta(evaluation) * 100 +
        Math.abs(offset.dx) +
        Math.abs(offset.dz);
      if (score < bestScore) {
        bestScore = score;
        bestResult = {
          originX,
          originZ,
          footprint,
          evaluation,
          offsetDx: offset.dx,
          offsetDz: offset.dz
        };
      }
      if (score === 0) {
        break;
      }
    }

    lastReason = evaluation.reason ?? 'site rejected';
  }

  if (bestResult) {
    return {
      ok: true,
      result: bestResult,
      reason: 'ok'
    };
  }

  return {
    ok: false,
    reason: lastReason
  };
}

interface CompileLandmarkGraphWithPlacementInput {
  specId: string;
  originX: number;
  originZ: number;
  scale?: string;
  stylePreset?: string;
  prompt?: string;
  targetDurationMinutes?: number;
  baseY?: number;
  autoPlace?: boolean;
  searchRadius?: number;
  searchStep?: number;
  maxHeightDelta?: number;
  maxManMadeColumns?: number;
  waterBufferBlocks?: number;
}

async function compileLandmarkGraphWithPlacement(
  bot: any,
  autonomy: LandmarkAutonomyService,
  input: CompileLandmarkGraphWithPlacementInput
): Promise<{ graph: BuildGraph; placementSummary: string }> {
  const requestedOriginX = toInt(input.originX);
  const requestedOriginZ = toInt(input.originZ);
  const prompt = input.prompt;
  const autoPlace = input.autoPlace == null ? true : Boolean(input.autoPlace);

  let originX = requestedOriginX;
  let originZ = requestedOriginZ;
  let baseY = input.baseY == null ? await getSurfaceHeightAt(bot, originX, originZ) : toInt(input.baseY);
  let placementSummary = `requestedOrigin=(${requestedOriginX},${requestedOriginZ}) actualOrigin=(${originX},${baseY},${originZ}) autoPlace=no`;

  if (autoPlace) {
    const searchRadius = Math.max(0, Math.min(160, toInt(input.searchRadius ?? 96)));
    const searchStep = Math.max(1, Math.min(8, toInt(input.searchStep ?? 4)));
    const maxHeightDelta = Math.max(0, Math.min(4, toInt(input.maxHeightDelta ?? 3)));
    const maxManMadeColumns = Math.max(0, Math.min(20, toInt(input.maxManMadeColumns ?? 0)));
    const waterBufferBlocks = Math.max(0, Math.min(4, toInt(input.waterBufferBlocks ?? 1)));
    const envelope = await autonomy.estimateLandmarkEnvelope({
      specId: input.specId,
      scale: input.scale,
      stylePreset: input.stylePreset,
      prompt
    });

    const site = await findNearestLandmarkOrigin(
      bot,
      requestedOriginX,
      requestedOriginZ,
      envelope,
      searchRadius,
      searchStep,
      maxHeightDelta,
      maxManMadeColumns,
      waterBufferBlocks
    );

    if (!site.ok || !site.result) {
      throw new Error(
        `Could not auto-place landmark '${input.specId}' near (${requestedOriginX},${requestedOriginZ}). ` +
        `Structural footprint=${envelope.width}x${envelope.depth}. Last reason: ${site.reason}`
      );
    }

    originX = site.result.originX;
    originZ = site.result.originZ;
    if (input.baseY == null) {
      baseY = site.result.evaluation.baseY;
    }
    placementSummary =
      `requestedOrigin=(${requestedOriginX},${requestedOriginZ}) actualOrigin=(${originX},${baseY},${originZ}) ` +
      `autoPlace=yes offset=(${site.result.offsetDx},${site.result.offsetDz}) footprint=${formatFootprint(site.result.footprint)} ` +
      `terrainDelta=${terrainDelta(site.result.evaluation)} skippedOptional=${envelope.skippedComponentIds.join(',') || 'none'}`;
  }

  const graph = await autonomy.compileLandmarkBuildGraph({
    specId: input.specId,
    originX,
    originZ,
    baseY,
    scale: input.scale,
    stylePreset: input.stylePreset,
    prompt,
    targetDurationMinutes: input.targetDurationMinutes != null
      ? toInt(input.targetDurationMinutes)
      : undefined
  });

  return {
    graph,
    placementSummary
  };
}

function taskWaveIndex(taskId: string, taskMap: Map<string, BuildGraphNode>, cache: Map<string, number>): number {
  const existing = cache.get(taskId);
  if (existing != null) {
    return existing;
  }

  const node = taskMap.get(taskId);
  if (!node || node.dependencies.length === 0) {
    cache.set(taskId, 0);
    return 0;
  }

  const wave = Math.max(...node.dependencies.map((dependency) => taskWaveIndex(dependency, taskMap, cache))) + 1;
  cache.set(taskId, wave);
  return wave;
}

function buildLandmarkTaskWaves(graph: BuildGraph): BuildGraphNode[][] {
  const taskMap = new Map(graph.nodes.map((node) => [node.taskId, node]));
  const cache = new Map<string, number>();
  const waves = new Map<number, BuildGraphNode[]>();

  for (const node of graph.nodes) {
    const wave = taskWaveIndex(node.taskId, taskMap, cache);
    const bucket = waves.get(wave) ?? [];
    bucket.push(node);
    waves.set(wave, bucket);
  }

  return [...waves.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, nodes]) =>
      [...nodes].sort((left, right) => {
        if (left.assignedOwner !== right.assignedOwner) {
          return left.assignedOwner.localeCompare(right.assignedOwner);
        }
        return left.taskId.localeCompare(right.taskId);
      })
    );
}

function formatWorkerTaskPacket(task: BuildGraphNode): string {
  const paramsJson = JSON.stringify(task.toolPlan.params);
  const delegateTool = peerToolNameForWorker(task.assignedWorker);
  return (
    `worker=${task.assignedWorker} delegate_tool=${delegateTool} owner=${task.assignedOwner} ${formatDispatchTask(task)} ` +
    `execute_tool=${task.toolPlan.primaryTool} execute_params=${paramsJson} note=${truncateText(task.toolPlan.note, 140)}`
  );
}

function recommendScaleForCatalogCandidate(candidate: CatalogLookupCandidate, sizeHint?: string): string {
  if (sizeHint && sizeHint.trim()) {
    return sizeHint.trim().toLowerCase();
  }

  const blockCount = candidate.blockCount ?? 0;
  if (blockCount >= 35000) {
    return 'small';
  }
  if (blockCount >= 12000) {
    return 'medium';
  }
  return 'medium';
}

function formatCatalogLookupCandidate(candidate: CatalogLookupCandidate): string {
  return (
    `${candidate.title} score=${candidate.score} query="${candidate.query}" ` +
    `blocks=${candidate.blockCount ?? 'unknown'} mappedSpec=${candidate.mappedSpecId ?? 'none'} ` +
    `matchedTokens=${candidate.matchedTokens.join(',') || 'none'} url=${candidate.url}`
  );
}

function slugifyIdentifier(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

async function compileCatalogGraphWithPlacement(
  bot: any,
  autonomy: LandmarkAutonomyService,
  input: {
    prompt: string;
    candidate: CatalogLookupCandidate;
    cultureHint?: string;
    sizeHint?: string;
    targetDurationMinutes?: number;
    originX: number;
    originZ: number;
    baseY?: number;
    autoPlace?: boolean;
    searchRadius?: number;
    searchStep?: number;
    maxHeightDelta?: number;
    maxManMadeColumns?: number;
    waterBufferBlocks?: number;
  }
): Promise<{
  graph: BuildGraph;
  placementSummary: string;
  modelArtifactPath: string;
  placementArtifactPath: string;
  model: CatalogModelArtifact;
}> {
  const model = await importCatalogModel(input.candidate.url);
  const modelBounds = model.stats.bounds;
  if (!modelBounds) {
    throw new Error(`Imported model '${input.candidate.url}' has no bounds.`);
  }

  const width = modelBounds.maxX - modelBounds.minX + 1;
  const depth = modelBounds.maxZ - modelBounds.minZ + 1;
  const autoPlace = input.autoPlace == null ? true : Boolean(input.autoPlace);
  const requestedCenterX = toInt(input.originX);
  const requestedCenterZ = toInt(input.originZ);

  let centerX = requestedCenterX;
  let centerZ = requestedCenterZ;
  let minX = requestedCenterX - Math.floor(width / 2);
  let minZ = requestedCenterZ - Math.floor(depth / 2);
  let baseY = input.baseY == null
    ? await getSurfaceHeightAt(bot, requestedCenterX, requestedCenterZ)
    : toInt(input.baseY);
  let placementSummary =
    `source=catalog url=${input.candidate.url} title="${model.source.title}" ` +
    `requestedCenter=(${requestedCenterX},${requestedCenterZ}) actualOrigin=(${minX},${baseY},${minZ}) autoPlace=no`;

  if (autoPlace) {
    const dynamicSearchStep = Math.max(4, Math.min(12, Math.ceil(Math.max(width, depth) / 8)));
    const searchRadius = Math.max(0, Math.min(128, toInt(input.searchRadius ?? 80)));
    const searchStep = Math.max(1, Math.min(12, toInt(input.searchStep ?? dynamicSearchStep)));
    const maxHeightDelta = Math.max(0, Math.min(6, toInt(input.maxHeightDelta ?? 4)));
    const maxManMadeColumns = Math.max(0, Math.min(12, toInt(input.maxManMadeColumns ?? 0)));
    const waterBufferBlocks = Math.max(0, Math.min(4, toInt(input.waterBufferBlocks ?? 1)));
    const existingClaims = await coordinationStore.listClaims();
    const activeGraphBounds = await autonomy.listActiveGraphBounds();
    const blockedBounds: BoundingBox[] = [
      ...existingClaims.map((claim) => normalizeBounds(claim.minX, claim.minY, claim.minZ, claim.maxX, claim.maxY, claim.maxZ)),
      ...activeGraphBounds
    ];
    const site = blockedBounds.length > 0
      ? await findNearestLandFootprintAvoiding(
          bot,
          requestedCenterX,
          requestedCenterZ,
          width,
          depth,
          searchRadius,
          searchStep,
          maxHeightDelta,
          maxManMadeColumns,
          waterBufferBlocks,
          blockedBounds
        )
      : await findNearestLandFootprint(
          bot,
          requestedCenterX,
          requestedCenterZ,
          width,
          depth,
          searchRadius,
          searchStep,
          maxHeightDelta,
          maxManMadeColumns,
          waterBufferBlocks
        );

    if (!site.ok || !site.result) {
      throw new Error(
        `Could not auto-place imported model '${model.source.title}' near (${requestedCenterX},${requestedCenterZ}). ` +
        `Footprint=${width}x${depth}. Last reason: ${site.reason}`
      );
    }

    centerX = site.result.footprint.centerX;
    centerZ = site.result.footprint.centerZ;
    minX = site.result.footprint.x1;
    minZ = site.result.footprint.z1;
    if (input.baseY == null) {
      baseY = site.result.evaluation.baseY;
    }
    placementSummary =
      `source=catalog url=${input.candidate.url} title="${model.source.title}" ` +
      `requestedCenter=(${requestedCenterX},${requestedCenterZ}) actualCenter=(${centerX},${baseY},${centerZ}) ` +
      `actualOrigin=(${minX},${baseY},${minZ}) autoPlace=yes footprint=${formatFootprint(site.result.footprint)} ` +
      `terrainDelta=${terrainDelta(site.result.evaluation)}`;
  }

  const graphId = `landmark_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const placementArtifact = createCatalogPlacementArtifact({
    graphId,
    model,
    originX: minX,
    originY: baseY,
    originZ: minZ
  });
  const runtimeDir = path.join(CATALOG_RUNTIME_DIR, graphId);
  const modelArtifactPath = await writeCatalogModelArtifact(runtimeDir, graphId, model);
  const placementArtifactPath = await writeCatalogPlacementArtifact(runtimeDir, placementArtifact);
  const now = Date.now();

  const nodes: BuildGraphNode[] = placementArtifact.shards.map((shard) => ({
    taskId: shard.shardId,
    zoneId: `${graphId.slice(0, 10)}_${shard.shardId}`,
    componentId: shard.shardId,
    label: shard.label,
    role: shard.role,
    dependencies: [...shard.dependencies],
    assignedWorker: shard.assignedWorker,
    assignedOwner: resolveReservationOwner(shard.assignedWorker),
    stylePreset: 'catalog_exact',
    bounds: shard.bounds,
    centerX: Math.floor((shard.bounds.minX + shard.bounds.maxX) / 2),
    centerZ: Math.floor((shard.bounds.minZ + shard.bounds.maxZ) / 2),
    expectedBlocks: shard.blockCount,
    blocksPlaced: 0,
    status: shard.dependencies.length === 0 ? 'ready' : 'blocked',
    attempts: 0,
    updatedAt: now,
    toolPlan: {
      primaryTool: 'place-catalog-shard',
      params: {
        placementFile: placementArtifactPath,
        shardId: shard.shardId
      },
      note:
        `Place exact imported model shard for ${model.source.title}. source=${input.candidate.url} ` +
        `blocks=${shard.blockCount}`
    }
  }));

  const graph: BuildGraph = {
    graphId,
    specId: input.candidate.mappedSpecId ?? `catalog_${slugifyIdentifier(model.source.title)}`,
    specName: model.source.title,
    culture: input.cultureHint ? String(input.cultureHint) : (input.candidate.mappedSpecId?.split('_').at(-1) ?? 'catalog'),
    prompt: input.prompt,
    originX: centerX,
    originZ: centerZ,
    baseY,
    scale: input.sizeHint?.trim().toLowerCase() || 'catalog',
    stylePreset: 'catalog_exact',
    graphStatus: 'planning',
    targetDurationMinutes: Math.max(10, Math.min(60, toInt(input.targetDurationMinutes ?? 30))),
    completionTarget: 1,
    createdAt: now,
    updatedAt: now,
    expectedBlocks: nodes.reduce((sum, node) => sum + node.expectedBlocks, 0),
    placedBlocks: 0,
    nodes,
    edges: nodes.flatMap((node) => node.dependencies.map((dependency) => ({ from: dependency, to: node.taskId })))
  };

  await autonomy.registerBuildGraph(graph);

  if (placementArtifact.skippedPalette.length > 0) {
    placementSummary += ` skippedPalette=${placementArtifact.skippedPalette.length}`;
  }
  placementSummary += ` modelArtifact=${modelArtifactPath} placementArtifact=${placementArtifactPath}`;

  return {
    graph,
    placementSummary,
    modelArtifactPath,
    placementArtifactPath,
    model
  };
}

async function compileLocalStructureGraphWithPlacement(
  bot: any,
  autonomy: LandmarkAutonomyService,
  input: {
    prompt: string;
    filePath: string;
    title?: string;
    sourceVersion?: string;
    sourceRef?: string;
    targetDurationMinutes?: number;
    originX: number;
    originZ: number;
    baseY?: number;
    autoPlace?: boolean;
    searchRadius?: number;
    searchStep?: number;
    maxHeightDelta?: number;
    maxManMadeColumns?: number;
    waterBufferBlocks?: number;
  }
): Promise<{
  graph: BuildGraph;
  placementSummary: string;
  modelArtifactPath: string;
  placementArtifactPath: string;
  model: CatalogModelArtifact;
}> {
  const model = await importLocalStructureWorldAsModel({
    filePath: input.filePath,
    title: input.title,
    sourceVersion: input.sourceVersion
  });
  const modelBounds = model.stats.bounds;
  if (!modelBounds) {
    throw new Error(`Imported local structure '${input.filePath}' has no bounds.`);
  }

  const width = modelBounds.maxX - modelBounds.minX + 1;
  const depth = modelBounds.maxZ - modelBounds.minZ + 1;
  const autoPlace = input.autoPlace == null ? true : Boolean(input.autoPlace);
  const requestedCenterX = toInt(input.originX);
  const requestedCenterZ = toInt(input.originZ);
  const resolvedFilePath = path.resolve(input.filePath);
  const sourceRef = input.sourceRef?.trim() || resolvedFilePath;

  let centerX = requestedCenterX;
  let centerZ = requestedCenterZ;
  let minX = requestedCenterX - Math.floor(width / 2);
  let minZ = requestedCenterZ - Math.floor(depth / 2);
  let baseY = input.baseY == null
    ? await getSurfaceHeightAt(bot, requestedCenterX, requestedCenterZ)
    : toInt(input.baseY);
  let placementSummary =
    `source=local-archive ref="${sourceRef}" title="${model.source.title}" ` +
    `requestedCenter=(${requestedCenterX},${requestedCenterZ}) actualOrigin=(${minX},${baseY},${minZ}) autoPlace=no`;

  if (autoPlace) {
    const dynamicSearchStep = Math.max(4, Math.min(12, Math.ceil(Math.max(width, depth) / 8)));
    const searchRadius = Math.max(0, Math.min(128, toInt(input.searchRadius ?? 80)));
    const searchStep = Math.max(1, Math.min(12, toInt(input.searchStep ?? dynamicSearchStep)));
    const maxHeightDelta = Math.max(0, Math.min(6, toInt(input.maxHeightDelta ?? 4)));
    const maxManMadeColumns = Math.max(0, Math.min(12, toInt(input.maxManMadeColumns ?? 0)));
    const waterBufferBlocks = Math.max(0, Math.min(4, toInt(input.waterBufferBlocks ?? 1)));
    const existingClaims = await coordinationStore.listClaims();
    const activeGraphBounds = await autonomy.listActiveGraphBounds();
    const blockedBounds: BoundingBox[] = [
      ...existingClaims.map((claim) => normalizeBounds(claim.minX, claim.minY, claim.minZ, claim.maxX, claim.maxY, claim.maxZ)),
      ...activeGraphBounds
    ];
    const site = blockedBounds.length > 0
      ? await findNearestLandFootprintAvoiding(
          bot,
          requestedCenterX,
          requestedCenterZ,
          width,
          depth,
          searchRadius,
          searchStep,
          maxHeightDelta,
          maxManMadeColumns,
          waterBufferBlocks,
          blockedBounds
        )
      : await findNearestLandFootprint(
          bot,
          requestedCenterX,
          requestedCenterZ,
          width,
          depth,
          searchRadius,
          searchStep,
          maxHeightDelta,
          maxManMadeColumns,
          waterBufferBlocks
        );

    if (!site.ok || !site.result) {
      throw new Error(
        `Could not auto-place imported structure '${model.source.title}' near (${requestedCenterX},${requestedCenterZ}). ` +
        `Footprint=${width}x${depth}. Last reason: ${site.reason}`
      );
    }

    centerX = site.result.footprint.centerX;
    centerZ = site.result.footprint.centerZ;
    minX = site.result.footprint.x1;
    minZ = site.result.footprint.z1;
    if (input.baseY == null) {
      baseY = site.result.evaluation.baseY;
    }
    placementSummary =
      `source=local-archive file=${resolvedFilePath} title="${model.source.title}" ` +
      `requestedCenter=(${requestedCenterX},${requestedCenterZ}) actualCenter=(${centerX},${baseY},${centerZ}) ` +
      `actualOrigin=(${minX},${baseY},${minZ}) autoPlace=yes footprint=${formatFootprint(site.result.footprint)} ` +
      `terrainDelta=${terrainDelta(site.result.evaluation)}`;
  }

  const graphId = `landmark_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const placementArtifact = createCatalogPlacementArtifact({
    graphId,
    model,
    originX: minX,
    originY: baseY,
    originZ: minZ
  });
  const runtimeDir = path.join(CATALOG_RUNTIME_DIR, graphId);
  const modelArtifactPath = await writeCatalogModelArtifact(runtimeDir, graphId, model);
  const placementArtifactPath = await writeCatalogPlacementArtifact(runtimeDir, placementArtifact);
  const now = Date.now();

  const nodes: BuildGraphNode[] = placementArtifact.shards.map((shard) => ({
    taskId: shard.shardId,
    zoneId: `${graphId.slice(0, 10)}_${shard.shardId}`,
    componentId: shard.shardId,
    label: shard.label,
    role: shard.role,
    dependencies: [...shard.dependencies],
    assignedWorker: shard.assignedWorker,
    assignedOwner: resolveReservationOwner(shard.assignedWorker),
    stylePreset: 'local_archive_exact',
    bounds: shard.bounds,
    centerX: Math.floor((shard.bounds.minX + shard.bounds.maxX) / 2),
    centerZ: Math.floor((shard.bounds.minZ + shard.bounds.maxZ) / 2),
    expectedBlocks: shard.blockCount,
    blocksPlaced: 0,
    status: shard.dependencies.length === 0 ? 'ready' : 'blocked',
    attempts: 0,
    updatedAt: now,
    toolPlan: {
      primaryTool: 'place-catalog-shard',
      params: {
        placementFile: placementArtifactPath,
        shardId: shard.shardId
      },
      note:
        `Place exact imported structure shard for ${model.source.title}. source=${resolvedFilePath} ` +
        `blocks=${shard.blockCount}`
    }
  }));

  const graph: BuildGraph = {
    graphId,
    specId: `local_${slugifyIdentifier(model.source.title)}`,
    specName: model.source.title,
    culture: 'custom',
    prompt: input.prompt,
    originX: centerX,
    originZ: centerZ,
    baseY,
    scale: 'imported',
    stylePreset: 'local_archive_exact',
    graphStatus: 'planning',
    targetDurationMinutes: Math.max(10, Math.min(60, toInt(input.targetDurationMinutes ?? 30))),
    completionTarget: 1,
    createdAt: now,
    updatedAt: now,
    expectedBlocks: nodes.reduce((sum, node) => sum + node.expectedBlocks, 0),
    placedBlocks: 0,
    nodes,
    edges: nodes.flatMap((node) => node.dependencies.map((dependency) => ({ from: dependency, to: node.taskId })))
  };

  await autonomy.registerBuildGraph(graph);

  if (placementArtifact.skippedPalette.length > 0) {
    placementSummary += ` skippedPalette=${placementArtifact.skippedPalette.length}`;
  }
  placementSummary += ` modelArtifact=${modelArtifactPath} placementArtifact=${placementArtifactPath}`;

  return {
    graph,
    placementSummary,
    modelArtifactPath,
    placementArtifactPath,
    model
  };
}

async function compileOtsBlockModelGraphWithPlacement(
  bot: any,
  autonomy: LandmarkAutonomyService,
  input: {
    prompt: string;
    filePath: string;
    title?: string;
    sourceRef?: string;
    sourceId?: string;
    targetDurationMinutes?: number;
    originX: number;
    originZ: number;
    baseY?: number;
    autoPlace?: boolean;
    searchRadius?: number;
    searchStep?: number;
    maxHeightDelta?: number;
    maxManMadeColumns?: number;
    waterBufferBlocks?: number;
    stabilizeGravityBlocks?: boolean;
  }
): Promise<{
  graph: BuildGraph;
  placementSummary: string;
  modelArtifactPath: string;
  placementArtifactPath: string;
  model: CatalogModelArtifact;
}> {
  const model = await importOtsBlockModelAsCatalogModel({
    filePath: input.filePath,
    title: input.title,
    stabilizeGravityBlocks: input.stabilizeGravityBlocks
  });
  const modelBounds = model.stats.bounds;
  if (!modelBounds) {
    throw new Error(`Imported OTS block model '${input.filePath}' has no bounds.`);
  }

  const width = modelBounds.maxX - modelBounds.minX + 1;
  const depth = modelBounds.maxZ - modelBounds.minZ + 1;
  const autoPlace = input.autoPlace == null ? true : Boolean(input.autoPlace);
  const requestedCenterX = toInt(input.originX);
  const requestedCenterZ = toInt(input.originZ);
  const resolvedFilePath = path.resolve(input.filePath);
  const sourceRef = input.sourceRef?.trim() || resolvedFilePath;

  let centerX = requestedCenterX;
  let centerZ = requestedCenterZ;
  let minX = requestedCenterX - Math.floor(width / 2);
  let minZ = requestedCenterZ - Math.floor(depth / 2);
  let baseY = input.baseY == null
    ? await getSurfaceHeightAt(bot, requestedCenterX, requestedCenterZ)
    : toInt(input.baseY);
  let placementSummary =
    `source=ots-blocks ref="${sourceRef}" title="${model.source.title}" ` +
    `requestedCenter=(${requestedCenterX},${requestedCenterZ}) actualOrigin=(${minX},${baseY},${minZ}) autoPlace=no`;

  if (autoPlace) {
    const dynamicSearchStep = Math.max(4, Math.min(12, Math.ceil(Math.max(width, depth) / 8)));
    const searchRadius = Math.max(0, Math.min(128, toInt(input.searchRadius ?? 80)));
    const searchStep = Math.max(1, Math.min(12, toInt(input.searchStep ?? dynamicSearchStep)));
    const maxHeightDelta = Math.max(0, Math.min(8, toInt(input.maxHeightDelta ?? 4)));
    const maxManMadeColumns = Math.max(0, Math.min(12, toInt(input.maxManMadeColumns ?? 0)));
    const waterBufferBlocks = Math.max(0, Math.min(4, toInt(input.waterBufferBlocks ?? 1)));
    const existingClaims = await coordinationStore.listClaims();
    const activeGraphBounds = await autonomy.listActiveGraphBounds();
    const blockedBounds: BoundingBox[] = [
      ...existingClaims.map((claim) => normalizeBounds(claim.minX, claim.minY, claim.minZ, claim.maxX, claim.maxY, claim.maxZ)),
      ...activeGraphBounds
    ];
    const site = blockedBounds.length > 0
      ? await findNearestLandFootprintAvoiding(
          bot,
          requestedCenterX,
          requestedCenterZ,
          width,
          depth,
          searchRadius,
          searchStep,
          maxHeightDelta,
          maxManMadeColumns,
          waterBufferBlocks,
          blockedBounds
        )
      : await findNearestLandFootprint(
          bot,
          requestedCenterX,
          requestedCenterZ,
          width,
          depth,
          searchRadius,
          searchStep,
          maxHeightDelta,
          maxManMadeColumns,
          waterBufferBlocks
        );

    if (!site.ok || !site.result) {
      throw new Error(
        `Could not auto-place OTS block model '${model.source.title}' near (${requestedCenterX},${requestedCenterZ}). ` +
        `Footprint=${width}x${depth}. Last reason: ${site.reason}`
      );
    }

    centerX = site.result.footprint.centerX;
    centerZ = site.result.footprint.centerZ;
    minX = site.result.footprint.x1;
    minZ = site.result.footprint.z1;
    if (input.baseY == null) {
      baseY = site.result.evaluation.baseY;
    }
    placementSummary =
      `source=ots-blocks file=${resolvedFilePath} title="${model.source.title}" ` +
      `requestedCenter=(${requestedCenterX},${requestedCenterZ}) actualCenter=(${centerX},${baseY},${centerZ}) ` +
      `actualOrigin=(${minX},${baseY},${minZ}) autoPlace=yes footprint=${formatFootprint(site.result.footprint)} ` +
      `terrainDelta=${terrainDelta(site.result.evaluation)}`;
  }

  const graphId = `landmark_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const placementArtifact = createCatalogPlacementArtifact({
    graphId,
    model,
    originX: minX,
    originY: baseY,
    originZ: minZ
  });
  const runtimeDir = path.join(CATALOG_RUNTIME_DIR, graphId);
  const modelArtifactPath = await writeCatalogModelArtifact(runtimeDir, graphId, model);
  const placementArtifactPath = await writeCatalogPlacementArtifact(runtimeDir, placementArtifact);
  const now = Date.now();

  const nodes: BuildGraphNode[] = placementArtifact.shards.map((shard) => ({
    taskId: shard.shardId,
    zoneId: `${graphId.slice(0, 10)}_${shard.shardId}`,
    componentId: shard.shardId,
    label: shard.label,
    role: shard.role,
    dependencies: [...shard.dependencies],
    assignedWorker: shard.assignedWorker,
    assignedOwner: resolveReservationOwner(shard.assignedWorker),
    stylePreset: 'ots_blocks_exact',
    bounds: shard.bounds,
    centerX: Math.floor((shard.bounds.minX + shard.bounds.maxX) / 2),
    centerZ: Math.floor((shard.bounds.minZ + shard.bounds.maxZ) / 2),
    expectedBlocks: shard.blockCount,
    blocksPlaced: 0,
    status: shard.dependencies.length === 0 ? 'ready' : 'blocked',
    attempts: 0,
    updatedAt: now,
    toolPlan: {
      primaryTool: 'place-catalog-shard',
      params: {
        placementFile: placementArtifactPath,
        shardId: shard.shardId
      },
      note:
        `Place exact OTS block-model shard for ${model.source.title}. source=${resolvedFilePath} ` +
        `blocks=${shard.blockCount}`
    }
  }));

  const graph: BuildGraph = {
    graphId,
    specId: input.sourceId
      ? `ots_${slugifyIdentifier(input.sourceId)}`
      : `ots_${slugifyIdentifier(model.source.title)}`,
    specName: model.source.title,
    culture: 'custom',
    prompt: input.prompt,
    originX: centerX,
    originZ: centerZ,
    baseY,
    scale: 'block-model',
    stylePreset: 'ots_blocks_exact',
    graphStatus: 'planning',
    targetDurationMinutes: Math.max(10, Math.min(60, toInt(input.targetDurationMinutes ?? 30))),
    completionTarget: 1,
    createdAt: now,
    updatedAt: now,
    expectedBlocks: nodes.reduce((sum, node) => sum + node.expectedBlocks, 0),
    placedBlocks: 0,
    nodes,
    edges: nodes.flatMap((node) => node.dependencies.map((dependency) => ({ from: dependency, to: node.taskId })))
  };

  await autonomy.registerBuildGraph(graph);

  if (placementArtifact.skippedPalette.length > 0) {
    placementSummary += ` skippedPalette=${placementArtifact.skippedPalette.length}`;
  }
  placementSummary += ` modelArtifact=${modelArtifactPath} placementArtifact=${placementArtifactPath}`;

  return {
    graph,
    placementSummary,
    modelArtifactPath,
    placementArtifactPath,
    model
  };
}

function chunkCommands(commands: string[], batchSize: number): string[][] {
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  const batches: string[][] = [];
  for (let index = 0; index < commands.length; index += safeBatchSize) {
    batches.push(commands.slice(index, index + safeBatchSize));
  }
  return batches;
}

function appendProcessLines(lines: string[], chunk: string, limit = 80): void {
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    lines.push(trimmed);
  }
  if (lines.length > limit) {
    lines.splice(0, lines.length - limit);
  }
}

async function runProjectPythonScript(
  scriptRelativePath: string,
  args: string[]
): Promise<{ stdoutTail: string; stderrTail: string }> {
  const scriptPath = path.join(PROJECT_ROOT_DIR, scriptRelativePath);
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  return await new Promise((resolve, reject) => {
    const child = spawn('python3', [scriptPath, ...args], {
      cwd: PROJECT_ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    child.stdout.on('data', (chunk) => {
      appendProcessLines(stdoutLines, chunk.toString());
    });
    child.stderr.on('data', (chunk) => {
      appendProcessLines(stderrLines, chunk.toString());
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const stdoutTail = stdoutLines.slice(-30).join('\n');
      const stderrTail = stderrLines.slice(-20).join('\n');
      if (code === 0) {
        resolve({ stdoutTail, stderrTail });
        return;
      }
      reject(
        new Error(
          `${scriptRelativePath} failed with code=${code ?? 'none'} signal=${signal ?? 'none'} ` +
          `stderr=${stderrTail || 'none'} stdout=${stdoutTail || 'none'}`
        )
      );
    });
  });
}

function commandForPlacementRun(
  x1: number,
  x2: number,
  y: number,
  zCoord: number,
  blockState: string
): string {
  if (x1 === x2) {
    return `/setblock ${x1} ${y} ${zCoord} ${blockState}`;
  }
  return `/fill ${x1} ${y} ${zCoord} ${x2} ${y} ${zCoord} ${blockState}`;
}

function placementRunCommands(blocks: PlacementBlock[]): string[] {
  const sorted = [...blocks].sort((left, right) => {
    if (left.y !== right.y) {
      return left.y - right.y;
    }
    if (left.z !== right.z) {
      return left.z - right.z;
    }
    if (left.x !== right.x) {
      return left.x - right.x;
    }
    return left.blockState.localeCompare(right.blockState);
  });

  const commands: string[] = [];
  let runStart: number | null = null;
  let runEnd: number | null = null;
  let runY: number | null = null;
  let runZ: number | null = null;
  let runState: string | null = null;

  const flushRun = () => {
    if (runStart == null || runEnd == null || runY == null || runZ == null || runState == null) {
      return;
    }
    commands.push(commandForPlacementRun(runStart, runEnd, runY, runZ, runState));
  };

  for (const block of sorted) {
    if (
      runState != null &&
      block.y === runY &&
      block.z === runZ &&
      block.blockState === runState &&
      block.x === (runEnd ?? block.x) + 1
    ) {
      runEnd = block.x;
      continue;
    }

    flushRun();
    runStart = block.x;
    runEnd = block.x;
    runY = block.y;
    runZ = block.z;
    runState = block.blockState;
  }

  flushRun();
  return commands;
}

function placementBounds(blocks: PlacementBlock[]): BoundingBox {
  const xs = blocks.map((block) => block.x);
  const ys = blocks.map((block) => block.y);
  const zs = blocks.map((block) => block.z);
  return normalizeBounds(
    Math.min(...xs),
    Math.min(...ys),
    Math.min(...zs),
    Math.max(...xs),
    Math.max(...ys),
    Math.max(...zs)
  );
}

function groupPlacementBlocksByLayer(blocks: PlacementBlock[]): Array<{ y: number; blocks: PlacementBlock[] }> {
  const byLayer = new Map<number, PlacementBlock[]>();
  for (const block of blocks) {
    const layer = byLayer.get(block.y) ?? [];
    layer.push(block);
    byLayer.set(block.y, layer);
  }

  return Array.from(byLayer.entries())
    .sort(([leftY], [rightY]) => leftY - rightY)
    .map(([y, layerBlocks]) => ({ y, blocks: layerBlocks }));
}

function preparedRecordingPlotCommands(baseY: number, clearTopY: number, radius: number): string[] {
  const minX = -radius;
  const maxX = radius;
  const minZ = -radius;
  const maxZ = radius;
  const commands: string[] = [];

  commands.push(`/forceload add ${minX} ${minZ} ${maxX} ${maxZ}`);
  for (let y = baseY; y <= clearTopY; y += 1) {
    commands.push(`/fill ${minX} ${y} ${minZ} ${maxX} ${y} ${maxZ} air`);
  }
  commands.push(`/fill ${minX} ${baseY - 3} ${minZ} ${maxX} ${baseY - 3} ${maxZ} stone`);
  commands.push(`/fill ${minX} ${baseY - 2} ${minZ} ${maxX} ${baseY - 2} ${maxZ} dirt`);
  commands.push(`/fill ${minX} ${baseY - 1} ${minZ} ${maxX} ${baseY - 1} ${maxZ} grass_block`);
  commands.push('/gamerule doMobSpawning false');
  commands.push('/gamerule doDaylightCycle false');
  commands.push('/gamerule doWeatherCycle false');
  commands.push('/difficulty peaceful');
  commands.push('/time set day');
  commands.push('/weather clear 1000000');
  commands.push('/kill @e[type=!player]');
  commands.push('/spawnpoint @a 0 69 -95');
  commands.push('/setworldspawn 0 69 -95');
  commands.push('/tp Noptus 0 96 -115 0 25');
  return commands;
}

function parseRecordingAgentList(raw: unknown): string[] {
  const parsed = parseCsvList(raw);
  return parsed && parsed.length > 0
    ? parsed
    : [...RECORDING_CHOREOGRAPHY_DEFAULT_AGENTS];
}

function recordingPhaseForLayer(layerIndex: number, totalLayers: number): string {
  const ratio = layerIndex / Math.max(1, totalLayers);
  if (ratio < 0.18) {
    return 'foundation and podium';
  }
  if (ratio < 0.48) {
    return 'lower shells and glazing';
  }
  if (ratio < 0.78) {
    return 'sail ribs and roof arcs';
  }
  if (ratio < 0.98) {
    return 'upper shell finish';
  }
  return 'final capstones';
}

function tellrawCommand(text: string, color = 'aqua'): string {
  return `/tellraw @a ${JSON.stringify({ text, color })}`;
}

function recordingChoreographyCommands(input: {
  bounds: BoundingBox;
  layerIndex: number;
  totalLayers: number;
  layerY: number;
  baseY: number;
  agents: string[];
  moveAgents: boolean;
  emitChat: boolean;
  chatIntervalLayers: number;
  moveIntervalLayers: number;
}): string[] {
  const commands: string[] = [];
  const isFirst = input.layerIndex === 1;
  const isLast = input.layerIndex === input.totalLayers;
  const chatInterval = Math.max(1, input.chatIntervalLayers);
  const moveInterval = Math.max(1, input.moveIntervalLayers);

  if (
    input.emitChat &&
    (isFirst || isLast || input.layerIndex % chatInterval === 0)
  ) {
    const phase = recordingPhaseForLayer(input.layerIndex, input.totalLayers);
    commands.push(
      tellrawCommand(
        `[SAM] Coordination: ${phase}, layer ${input.layerIndex}/${input.totalLayers}. ` +
        `${input.agents.slice(0, 3).join(', ')} are tracking the active build front.`
      )
    );
  }

  if (
    !input.moveAgents ||
    input.agents.length === 0 ||
    !(isFirst || isLast || input.layerIndex % moveInterval === 0)
  ) {
    return commands;
  }

  const width = input.bounds.maxX - input.bounds.minX + 1;
  const depth = input.bounds.maxZ - input.bounds.minZ + 1;
  const orbitY = Math.max(input.baseY + 1, Math.min(input.layerY + 2, input.baseY + 12));
  const positions = [
    {
      x: input.bounds.minX + Math.floor(((input.layerIndex * 7) % Math.max(1, width))),
      z: input.bounds.minZ - 5,
      yaw: 0
    },
    {
      x: input.bounds.maxX + 5,
      z: input.bounds.minZ + Math.floor(((input.layerIndex * 9) % Math.max(1, depth))),
      yaw: -90
    },
    {
      x: input.bounds.minX + Math.floor(((input.layerIndex * 11) % Math.max(1, width))),
      z: input.bounds.maxZ + 5,
      yaw: 180
    },
    {
      x: input.bounds.minX - 5,
      z: input.bounds.minZ + Math.floor(((input.layerIndex * 5) % Math.max(1, depth))),
      yaw: 90
    }
  ];

  input.agents.slice(0, positions.length).forEach((agent, index) => {
    const position = positions[index];
    commands.push(`/tp ${agent} ${position.x} ${orbitY} ${position.z} ${position.yaw} 18`);
  });

  return commands;
}

type CinematicPlacementBlock = {
  x: number;
  y: number;
  z: number;
  blockState: string;
};

function boundsForPlacementBlocks(blocks: CinematicPlacementBlock[]): BoundingBox {
  const xs = blocks.map((block) => block.x);
  const ys = blocks.map((block) => block.y);
  const zs = blocks.map((block) => block.z);
  return normalizeBounds(
    Math.min(...xs),
    Math.min(...ys),
    Math.min(...zs),
    Math.max(...xs),
    Math.max(...ys),
    Math.max(...zs)
  );
}

function isCatalogBatchWithinSafetyLimits(blocks: CinematicPlacementBlock[]): boolean {
  if (blocks.length === 0 || blocks.length > CATALOG_RCON_BATCH_SIZE) {
    return false;
  }

  const bounds = boundsForPlacementBlocks(blocks);
  return (
    getFootprint(bounds) <= CATALOG_BATCH_SAFETY_LIMITS.maxFootprint &&
    getVolume(bounds) <= CATALOG_BATCH_SAFETY_LIMITS.maxVolume
  );
}

function chunkPlacementBlocksByLayer(
  blocks: CinematicPlacementBlock[],
  batchSize: number
): CinematicPlacementBlock[][] {
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  const sortedBlocks = [...blocks].sort((left, right) => {
    if (left.y !== right.y) {
      return left.y - right.y;
    }
    if (left.z !== right.z) {
      return left.z - right.z;
    }
    return left.x - right.x;
  });

  const batches: CinematicPlacementBlock[][] = [];
  let currentBatch: CinematicPlacementBlock[] = [];
  let currentLayer: number | null = null;

  for (const block of sortedBlocks) {
    if (
      currentBatch.length >= safeBatchSize ||
      (currentLayer != null && block.y !== currentLayer && currentBatch.length >= Math.floor(safeBatchSize * 0.45))
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentLayer = null;
    }

    currentBatch.push(block);
    currentLayer = block.y;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function sortPlacementBlocksBottomUp(
  blocks: CinematicPlacementBlock[]
): CinematicPlacementBlock[] {
  return [...blocks].sort((left, right) => {
    if (left.y !== right.y) {
      return left.y - right.y;
    }
    if (left.z !== right.z) {
      return left.z - right.z;
    }
    return left.x - right.x;
  });
}

function splitPlacementBatchForSafety(
  blocks: CinematicPlacementBlock[],
  output: CinematicPlacementBlock[][]
): void {
  if (blocks.length === 0) {
    return;
  }

  if (blocks.length === 1 || isCatalogBatchWithinSafetyLimits(blocks)) {
    output.push(sortPlacementBlocksBottomUp(blocks));
    return;
  }

  const bounds = boundsForPlacementBlocks(blocks);
  const spans = [
    { axis: 'x' as const, size: bounds.maxX - bounds.minX },
    { axis: 'z' as const, size: bounds.maxZ - bounds.minZ },
    { axis: 'y' as const, size: bounds.maxY - bounds.minY }
  ].sort((left, right) => right.size - left.size);
  const axis = spans[0].axis;
  const sorted = [...blocks].sort((left, right) => {
    const axisDelta = left[axis] - right[axis];
    if (axisDelta !== 0) {
      return axisDelta;
    }
    if (left.y !== right.y) {
      return left.y - right.y;
    }
    if (left.z !== right.z) {
      return left.z - right.z;
    }
    return left.x - right.x;
  });
  const midpoint = Math.floor(sorted.length / 2);

  if (midpoint <= 0 || midpoint >= sorted.length) {
    output.push(sortPlacementBlocksBottomUp(blocks));
    return;
  }

  splitPlacementBatchForSafety(sorted.slice(0, midpoint), output);
  splitPlacementBatchForSafety(sorted.slice(midpoint), output);
}

function splitPlacementBlocksForSafeCinematicBatches(
  blocks: CinematicPlacementBlock[],
  batchSize: number
): CinematicPlacementBlock[][] {
  const layerBatches = chunkPlacementBlocksByLayer(blocks, batchSize);
  const safeBatches: CinematicPlacementBlock[][] = [];

  for (const layerBatch of layerBatches) {
    splitPlacementBatchForSafety(layerBatch, safeBatches);
  }

  return safeBatches;
}

function chooseCinematicWorkPost(
  shardBounds: BoundingBox,
  batchBounds: BoundingBox,
  batchIndex: number
): { x: number; z: number } {
  const batchCenterX = Math.floor((batchBounds.minX + batchBounds.maxX) / 2);
  const batchCenterZ = Math.floor((batchBounds.minZ + batchBounds.maxZ) / 2);
  const shardCenterZ = Math.floor((shardBounds.minZ + shardBounds.maxZ) / 2);
  const side = batchIndex % 4;

  if (side === 0) {
    return {
      x: Math.max(shardBounds.minX - CATALOG_WORK_POST_OFFSET, Math.min(shardBounds.maxX + CATALOG_WORK_POST_OFFSET, batchCenterX)),
      z: shardBounds.minZ - CATALOG_WORK_POST_OFFSET
    };
  }
  if (side === 1) {
    return {
      x: shardBounds.maxX + CATALOG_WORK_POST_OFFSET,
      z: Math.max(shardBounds.minZ - CATALOG_WORK_POST_OFFSET, Math.min(shardBounds.maxZ + CATALOG_WORK_POST_OFFSET, batchCenterZ))
    };
  }
  if (side === 2) {
    return {
      x: Math.max(shardBounds.minX - CATALOG_WORK_POST_OFFSET, Math.min(shardBounds.maxX + CATALOG_WORK_POST_OFFSET, batchCenterX)),
      z: shardBounds.maxZ + CATALOG_WORK_POST_OFFSET
    };
  }

  return {
    x: shardBounds.minX - CATALOG_WORK_POST_OFFSET,
    z: Math.max(shardBounds.minZ - CATALOG_WORK_POST_OFFSET, Math.min(shardBounds.maxZ + CATALOG_WORK_POST_OFFSET, Number.isFinite(batchCenterZ) ? batchCenterZ : shardCenterZ))
  };
}

async function walkBotNearXZBestEffort(
  bot: any,
  x: number,
  zCoord: number,
  range: number,
  timeoutMs: number
): Promise<boolean> {
  if (horizontalDistanceTo(bot, x, zCoord) <= range) {
    return true;
  }

  let timedOut = false;
  const movement = walkBotNearXZ(bot, x, zCoord, range)
    .then(() => true)
    .catch((error) => {
      log('warn', `Cinematic worker walk failed for ${bot.username}: ${formatError(error)}`);
      return false;
    });
  const timeout = delay(timeoutMs).then(() => {
    timedOut = true;
    return false;
  });
  const moved = await Promise.race([movement, timeout]);

  if (timedOut && bot.pathfinder?.stop) {
    try {
      bot.pathfinder.stop();
    } catch {
      // Best-effort only. Placement must continue even if movement choreography fails.
    }
  }

  return moved;
}

async function animateBotForPlacementBatch(
  bot: any,
  shardBounds: BoundingBox,
  batchBounds: BoundingBox,
  batchIndex: number
): Promise<boolean> {
  const workPost = chooseCinematicWorkPost(shardBounds, batchBounds, batchIndex);
  const moved = await walkBotNearXZBestEffort(
    bot,
    workPost.x,
    workPost.z,
    2,
    CATALOG_WORKER_WALK_TIMEOUT_MS
  );

  const targetX = Math.floor((batchBounds.minX + batchBounds.maxX) / 2);
  const targetY = Math.floor((batchBounds.minY + batchBounds.maxY) / 2);
  const targetZ = Math.floor((batchBounds.minZ + batchBounds.maxZ) / 2);
  try {
    await bot.lookAt(new Vec3(targetX + 0.5, targetY + 0.5, targetZ + 0.5), false);
  } catch (error) {
    log('warn', `Cinematic worker lookAt failed for ${bot.username}: ${formatError(error)}`);
  }

  return moved;
}

async function resolveLandmarkCandidatesWithCatalog(
  autonomy: LandmarkAutonomyService,
  prompt: string,
  cultureHint: string | undefined,
  sizeHint: string | undefined,
  candidateLimit: number
): Promise<{
  candidates: SelectLandmarkResult[];
  lookup?: CatalogLookupResult;
  mappedLookup?: CatalogLookupCandidate;
}> {
  const localCandidates = await autonomy.discoverLandmarkCandidates(prompt, cultureHint, sizeHint, candidateLimit);
  const specs = await autonomy.listLandmarkSpecs();
  const lookup = await getCatalogLookupService().lookupLandmarks({
    prompt,
    cultureHint,
    specs,
    limit: candidateLimit
  });

  const merged: SelectLandmarkResult[] = [];
  const mappedLookup = lookup.selected?.mappedSpecId ? lookup.selected : undefined;
  if (mappedLookup?.mappedSpecId) {
    const mappedSpec = specs.find((spec) => spec.id === mappedLookup.mappedSpecId);
    if (mappedSpec) {
      merged.push({
        spec: mappedSpec,
        score: Math.max(localCandidates[0]?.score ?? 0, mappedLookup.score + 5),
        recommendedScale: recommendScaleForCatalogCandidate(mappedLookup, sizeHint),
        matchedKeywords: mappedLookup.matchedTokens,
        rationale:
          `Model lookup matched "${mappedLookup.title}" via query "${mappedLookup.query}" ` +
          `(${mappedLookup.url})`
      });
    }
  }

  for (const candidate of localCandidates) {
    if (merged.some((entry) => entry.spec.id === candidate.spec.id)) {
      continue;
    }
    merged.push(candidate);
  }

  return {
    candidates: merged.slice(0, Math.max(1, candidateLimit)),
    lookup,
    mappedLookup
  };
}

async function findNearestLandFootprintAvoiding(
  bot: any,
  requestedCenterX: number,
  requestedCenterZ: number,
  width: number,
  depth: number,
  searchRadius: number,
  searchStep: number,
  maxHeightDelta: number,
  maxManMadeColumns: number,
  waterBufferBlocks: number,
  blockedBounds: BoundingBox[],
  zoneHeight = 8
): Promise<{ ok: boolean; result?: { footprint: Footprint2D; baseY: number; claimBounds: BoundingBox; offsetDx: number; offsetDz: number; evaluation: LandFootprintEvaluation }; reason: string }> {
  let lastReason = 'no candidates evaluated';

  for (const offset of candidateOffsets(searchRadius, searchStep)) {
    const centerX = requestedCenterX + offset.dx;
    const centerZ = requestedCenterZ + offset.dz;
    const footprint = footprintFromCenter(centerX, centerZ, width, depth);
    const evaluation = await evaluateLandFootprint(
      bot,
      footprint,
      maxHeightDelta,
      maxManMadeColumns,
      waterBufferBlocks
    );

    if (!evaluation.ok) {
      lastReason = evaluation.reason ?? 'site rejected';
      continue;
    }

    const claimBounds = normalizeBounds(
      footprint.x1,
      evaluation.baseY - 1,
      footprint.z1,
      footprint.x2,
      evaluation.baseY + zoneHeight,
      footprint.z2
    );

    const overlap = blockedBounds.find((bounds) =>
      boxesOverlapWithGap(bounds, claimBounds, ZONE_GAP_BLOCKS)
    );

    if (overlap) {
      lastReason =
        `candidate overlaps reserved footprint with ${ZONE_GAP_BLOCKS}-block spacing at ` +
        `${formatBounds(overlap)}`;
      continue;
    }

    return {
      ok: true,
      result: {
        footprint,
        baseY: evaluation.baseY,
        claimBounds,
        offsetDx: offset.dx,
        offsetDz: offset.dz,
        evaluation
      },
      reason: 'ok'
    };
  }

  return {
    ok: false,
    reason: lastReason
  };
}

async function evaluateHouseSite(
  bot: any,
  centerX: number,
  centerZ: number,
  halfWidth: number,
  halfDepth: number
): Promise<HouseSiteEvaluation> {
  const width = halfWidth * 2 + 1;
  const depth = halfDepth * 2 + 1;
  const footprint = footprintFromCenter(centerX, centerZ, width, depth);
  const evaluation = await evaluateLandFootprint(bot, footprint, 1, 8, HOUSE_WATER_BUFFER_BLOCKS);
  if (!evaluation.ok) {
    return {
      ok: false,
      baseY: evaluation.baseY,
      reason: evaluation.reason
    };
  }
  return { ok: true, baseY: evaluation.baseY };
}
async function getSurfaceHeightAt(
  bot: any,
  x: number,
  zCoord: number,
  maxY = 200,
  minY = 0,
  surfaceHeightCache?: Map<string, number>
): Promise<number> {
  const cacheKey = `${x}:${zCoord}`;
  const cached = surfaceHeightCache?.get(cacheKey);
  if (cached != null) {
    return cached;
  }

  for (let y = maxY; y >= minY; y--) {
    const block = bot.blockAt(new Vec3(x, y, zCoord));
    if (
      block &&
      !isAirBlockName(block.name) &&
      block.boundingBox === 'block'
    ) {
      const surfaceY = y + 1;
      surfaceHeightCache?.set(cacheKey, surfaceY);
      return surfaceY;
    }
  }
  surfaceHeightCache?.set(cacheKey, 64);
  return 64;
}

interface ExpectedBlock {
  x: number;
  y: number;
  z: number;
  blockType: string;
}

async function estimateHouseBaseY(
  bot: any,
  centerX: number,
  centerZ: number,
  width = 7,
  depth = 7
): Promise<number> {
  const footprint = footprintFromCenter(centerX, centerZ, width, depth);
  const topY = await getSurfaceHeightAt(bot, centerX, centerZ);
  const minSearchY = Math.max(1, topY - 32);
  const area = width * depth;
  const cobbleThreshold = Math.max(6, Math.floor(area * 0.7));

  for (let y = topY; y >= minSearchY; y--) {
    let cobbleCount = 0;
    for (let x = footprint.x1; x <= footprint.x2; x++) {
      for (let zCoord = footprint.z1; zCoord <= footprint.z2; zCoord++) {
        const name = bot.blockAt(new Vec3(x, y, zCoord))?.name ?? '';
        if (name === 'cobblestone') {
          cobbleCount += 1;
        }
      }
    }
    if (cobbleCount >= cobbleThreshold) {
      return y + 1;
    }
  }

  let totalGroundY = 0;
  let sampleCount = 0;
  for (let x = footprint.x1; x <= footprint.x2; x++) {
    for (let zCoord = footprint.z1; zCoord <= footprint.z2; zCoord++) {
      const sample = await sampleLandColumn(bot, x, zCoord);
      if (!sample.ok) {
        continue;
      }
      totalGroundY += sample.groundY;
      sampleCount += 1;
    }
  }

  if (sampleCount === 0) {
    return 64;
  }
  return Math.round(totalGroundY / sampleCount) + 1;
}

function expectedFlatHouseBlocks(
  centerX: number,
  centerZ: number,
  baseY: number,
  style: string,
  width = 7,
  depth = 7
): ExpectedBlock[] {
  const materials = houseMaterialsForStyle(style);
  const halfWidth = Math.floor(width / 2);
  const halfDepth = Math.floor(depth / 2);
  const x1 = centerX - halfWidth;
  const z1 = centerZ - halfDepth;
  const x2 = x1 + width - 1;
  const z2 = z1 + depth - 1;
  const wallHeight = 4;
  const roofY = baseY + wallHeight + 1;

  const expectedMap = new Map<string, ExpectedBlock>();
  const setExpected = (x: number, y: number, z: number, blockType: string): void => {
    expectedMap.set(`${x}:${y}:${z}`, { x, y, z, blockType });
  };

  for (let x = x1; x <= x2; x++) {
    for (let zCoord = z1; zCoord <= z2; zCoord++) {
      setExpected(x, baseY - 1, zCoord, 'minecraft:cobblestone');
    }
  }

  for (let y = baseY + 1; y <= baseY + wallHeight; y++) {
    for (let x = x1; x <= x2; x++) {
      setExpected(x, y, z1, materials.wallMaterial);
      setExpected(x, y, z2, materials.wallMaterial);
    }
    for (let zCoord = z1; zCoord <= z2; zCoord++) {
      setExpected(x1, y, zCoord, materials.wallMaterial);
      setExpected(x2, y, zCoord, materials.wallMaterial);
    }
    setExpected(x1, y, z1, materials.logMaterial);
    setExpected(x1, y, z2, materials.logMaterial);
    setExpected(x2, y, z1, materials.logMaterial);
    setExpected(x2, y, z2, materials.logMaterial);
  }

  for (let x = x1; x <= x2; x++) {
    for (let zCoord = z1; zCoord <= z2; zCoord++) {
      setExpected(x, roofY, zCoord, materials.roofMaterial);
    }
  }

  for (let x = x1; x <= x2; x++) {
    setExpected(x, roofY + 1, z1, materials.wallMaterial);
    setExpected(x, roofY + 1, z2, materials.wallMaterial);
  }
  for (let zCoord = z1; zCoord <= z2; zCoord++) {
    setExpected(x1, roofY + 1, zCoord, materials.wallMaterial);
    setExpected(x2, roofY + 1, zCoord, materials.wallMaterial);
  }

  return Array.from(expectedMap.values());
}

async function inspectFlatHouse(
  bot: any,
  centerX: number,
  centerZ: number,
  style: string,
  width = 7,
  depth = 7,
  maxDefects = 200
): Promise<HouseInspectionResult> {
  const normalizedStyle = style.toLowerCase();
  const baseY = await estimateHouseBaseY(bot, centerX, centerZ, width, depth);
  const expected = expectedFlatHouseBlocks(centerX, centerZ, baseY, normalizedStyle, width, depth);

  const defects: HouseDefect[] = [];
  for (const block of expected) {
    const actualName = bot.blockAt(new Vec3(block.x, block.y, block.z))?.name ?? 'air';
    if (!blockNameMatches(actualName, block.blockType)) {
      defects.push({
        x: block.x,
        y: block.y,
        z: block.z,
        expected: block.blockType,
        actual: actualName
      });
      if (defects.length >= maxDefects) {
        break;
      }
    }
  }

  const score = Math.max(0, Math.round(100 - (defects.length / Math.max(1, expected.length)) * 100));

  return {
    centerX,
    centerZ,
    baseY,
    style: normalizedStyle,
    totalChecked: expected.length,
    defects,
    score
  };
}

async function enforceMutatingOperationGuard(
  bot: any,
  owner: string,
  bounds: BoundingBox,
  plannedOperations: number,
  plannedAirOperations: number
): Promise<void> {
  validateSafetyLimits({
    bounds,
    plannedOperations,
    plannedAirOperations
  }, DEFAULT_SAFETY_LIMITS);

  const reservation = await coordinationStore.verifyReservation(owner, bounds);
  if (!reservation.ok) {
    throw new Error(reservation.message);
  }

  if (
    shouldEnforceOccupiedAreaGuard({
      bounds,
      plannedOperations,
      plannedAirOperations
    })
  ) {
    const density = assessManMadeDensity(
      bounds,
      (x, y, zCoord) => bot.blockAt(new Vec3(x, y, zCoord))?.name ?? null
    );
    enforceDensityGuard(density, DEFAULT_SAFETY_LIMITS);
  }
}

async function enforceReservationOnly(owner: string, bounds: BoundingBox): Promise<void> {
  const reservation = await coordinationStore.verifyReservation(owner, bounds);
  if (!reservation.ok) {
    throw new Error(reservation.message);
  }
}

function cuboidSetBlockCommands(bounds: BoundingBox, blockType: string): string[] {
  const blockId = normalizeBlockType(blockType);
  const commands: string[] = [];
  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x++) {
      for (let zCoord = bounds.minZ; zCoord <= bounds.maxZ; zCoord++) {
        commands.push(`/setblock ${x} ${y} ${zCoord} ${blockId}`);
      }
    }
  }
  return commands;
}

function countAirCommands(commands: string[]): number {
  return commands.reduce((count, command) => (
    command.includes(' minecraft:air') ? count + 1 : count
  ), 0);
}

function nowIsoTimestamp(value: number): string {
  return new Date(value).toISOString().replace('T', ' ').replace('Z', '');
}

// Register MCP tools with safe, cinematic building behavior.
function registerEssentialTools(factory: ToolFactory, getBot: () => any, getOwner: () => string): void {

  // 1. get-position
  factory.registerTool(
    "get-position",
    "Get the bot's current position and facing direction",
    {},
    async () => {
      const bot = getBot();
      const pos = bot.entity.position;
      return factory.createResponse(`Position: x=${Math.floor(pos.x)}, y=${Math.floor(pos.y)}, z=${Math.floor(pos.z)}`);
    }
  );

  // 2. walk-to
  factory.registerTool(
    "walk-to",
    "Walk to specific coordinates using pathfinding (no teleport).",
    {
      x: z.coerce.number().describe("Target X coordinate"),
      z: z.coerce.number().describe("Target Z coordinate"),
    },
    async (params: any) => {
      const bot = getBot();
      const targetX = toInt(params.x);
      const targetZ = toInt(params.z);

      await walkBotNearXZ(bot, targetX, targetZ, WALK_TO_RANGE);
      const newPos = bot.entity.position;
      return factory.createResponse(`Walked to (${Math.floor(newPos.x)}, ${Math.floor(newPos.y)}, ${Math.floor(newPos.z)})`);
    }
  );

  // 3. look-around
  factory.registerTool(
    "look-around",
    "Survey the surroundings and report nearby entities and sampled ground blocks.",
    {
      radius: z.coerce.number().optional().describe("Search radius (default: 16)"),
    },
    async (params: any) => {
      const bot = getBot();
      const radius = params.radius ? toInt(params.radius) : 16;
      const pos = bot.entity.position;

      const entities = Object.values(bot.entities as Record<string, any>)
        .filter((entity: any) => entity !== bot.entity && entity.position.distanceTo(pos) <= radius)
        .map((entity: any) => `${entity.name || entity.username || 'unknown'} at (${Math.floor(entity.position.x)}, ${Math.floor(entity.position.y)}, ${Math.floor(entity.position.z)})`);

      const sampledBlocks: string[] = [];
      for (let dx = -4; dx <= 4; dx += 4) {
        for (let dz = -4; dz <= 4; dz += 4) {
          const block = bot.blockAt(new Vec3(Math.floor(pos.x) + dx, Math.floor(pos.y) - 1, Math.floor(pos.z) + dz));
          if (block && block.name !== 'air') {
            sampledBlocks.push(block.name);
          }
        }
      }

      return factory.createResponse(
        `Position: (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)}). ` +
        `Nearby entities: ${entities.length > 0 ? entities.join(', ') : 'none'}. ` +
        `Ground blocks: ${[...new Set(sampledBlocks)].join(', ') || 'none'}`
      );
    }
  );

  // 4. get-surface-height
  factory.registerTool(
    "get-surface-height",
    "Find the surface Y level at specific X,Z coordinates.",
    {
      x: z.coerce.number().describe("X coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async (params: any) => {
      const bot = getBot();
      const x = toInt(params.x);
      const zCoord = toInt(params.z);
      const surfaceY = await getSurfaceHeightAt(bot, x, zCoord);
      const groundBlock = bot.blockAt(new Vec3(x, surfaceY - 1, zCoord));
      return factory.createResponse(
        `Surface height at (${x}, ${zCoord}) is Y=${surfaceY}. Ground block: ${groundBlock?.name ?? 'unknown'}`
      );
    }
  );

  // 5. validate-build-site
  factory.registerTool(
    "validate-build-site",
    "Validate whether a rectangular footprint is buildable dry land that is already flat or can be gently flattened.",
    {
      x1: z.coerce.number().describe("Footprint min/max X corner"),
      z1: z.coerce.number().describe("Footprint min/max Z corner"),
      x2: z.coerce.number().describe("Footprint min/max X corner"),
      z2: z.coerce.number().describe("Footprint min/max Z corner"),
      maxHeightDelta: z.coerce.number().optional().describe("Maximum allowed terrain delta across footprint before rejection (default: 2)"),
      maxManMadeColumns: z.coerce.number().optional().describe("Maximum allowed man-made columns in footprint (default: 8)"),
      waterBufferBlocks: z.coerce.number().optional().describe("Reject sites if water is nearby within this many blocks (default: 2)")
    },
    async (params: any) => {
      const bot = getBot();
      const footprint = footprintFromBounds(
        toInt(params.x1),
        toInt(params.z1),
        toInt(params.x2),
        toInt(params.z2)
      );
      const maxHeightDelta = Math.max(0, Math.min(6, toInt(params.maxHeightDelta ?? 2)));
      const maxManMadeColumns = Math.max(0, toInt(params.maxManMadeColumns ?? 8));
      const waterBufferBlocks = Math.max(0, Math.min(4, toInt(params.waterBufferBlocks ?? HOUSE_WATER_BUFFER_BLOCKS)));
      const evaluation = await evaluateLandFootprint(
        bot,
        footprint,
        maxHeightDelta,
        maxManMadeColumns,
        waterBufferBlocks
      );

      const base = `footprint ${formatFootprint(footprint)}, center=(${footprint.centerX},${footprint.centerZ})`;
      if (!evaluation.ok) {
        return factory.createResponse(
          `INVALID build site: ${base}. Reason: ${evaluation.reason}. ` +
          `samples=${evaluation.sampleCount}, minY=${evaluation.minGroundY}, maxY=${evaluation.maxGroundY}`
        );
      }

      return factory.createResponse(
        `VALID build site: ${base}. baseY=${evaluation.baseY}, delta=${terrainDelta(evaluation)}, ` +
        `flattenRecommended=${terrainDelta(evaluation) > 0 ? 'yes' : 'no'}, ` +
        `suggestedFlattenMaxAdjustment=${Math.min(2, terrainDelta(evaluation))}, ` +
        `manMadeColumns=${evaluation.manMadeColumns}, waterBuffer=${waterBufferBlocks}. ` +
        `Suggested claim: x1=${footprint.x1} y1=${evaluation.baseY - 1} z1=${footprint.z1} x2=${footprint.x2} y2=${evaluation.baseY + 7} z2=${footprint.z2}`
      );
    }
  );

  // 6. find-build-site
  factory.registerTool(
    "find-build-site",
    "Find the nearest valid dry-land footprint around a target center, including land that can be gently flattened.",
    {
      centerX: z.coerce.number().describe("Requested center X"),
      centerZ: z.coerce.number().describe("Requested center Z"),
      width: z.coerce.number().describe("Footprint width in blocks"),
      depth: z.coerce.number().describe("Footprint depth in blocks"),
      searchRadius: z.coerce.number().optional().describe("Search radius around requested center (default: 16)"),
      searchStep: z.coerce.number().optional().describe("Search step between candidates (default: 2)"),
      maxHeightDelta: z.coerce.number().optional().describe("Maximum allowed terrain delta across footprint before rejection (default: 2)"),
      maxManMadeColumns: z.coerce.number().optional().describe("Maximum allowed man-made columns in footprint (default: 8)"),
      waterBufferBlocks: z.coerce.number().optional().describe("Reject sites if water is nearby within this many blocks (default: 2)")
    },
    async (params: any) => {
      const bot = getBot();
      const centerX = toInt(params.centerX);
      const centerZ = toInt(params.centerZ);
      const width = Math.max(1, Math.min(33, toInt(params.width)));
      const depth = Math.max(1, Math.min(33, toInt(params.depth)));
      const searchRadius = Math.max(0, Math.min(64, toInt(params.searchRadius ?? 16)));
      const searchStep = Math.max(1, Math.min(8, toInt(params.searchStep ?? 2)));
      const maxHeightDelta = Math.max(0, Math.min(6, toInt(params.maxHeightDelta ?? 2)));
      const maxManMadeColumns = Math.max(0, toInt(params.maxManMadeColumns ?? 8));
      const waterBufferBlocks = Math.max(0, Math.min(4, toInt(params.waterBufferBlocks ?? HOUSE_WATER_BUFFER_BLOCKS)));

      const search = await findNearestLandFootprint(
        bot,
        centerX,
        centerZ,
        width,
        depth,
        searchRadius,
        searchStep,
        maxHeightDelta,
        maxManMadeColumns,
        waterBufferBlocks
      );

      if (!search.ok || !search.result) {
        return factory.createResponse(
          `No valid site found near (${centerX},${centerZ}) for width=${width},depth=${depth}. ` +
          `Last reason: ${search.reason}`
        );
      }

      const { footprint, evaluation, offsetDx, offsetDz } = search.result;
      return factory.createResponse(
        `Found build site: center=(${footprint.centerX},${footprint.centerZ}) ` +
        `offset=(${offsetDx},${offsetDz}), ${formatFootprint(footprint)}, baseY=${evaluation.baseY}, ` +
        `delta=${terrainDelta(evaluation)}, flattenRecommended=${terrainDelta(evaluation) > 0 ? 'yes' : 'no'}, ` +
        `suggestedFlattenMaxAdjustment=${Math.min(2, terrainDelta(evaluation))}, manMadeColumns=${evaluation.manMadeColumns}, ` +
        `waterBuffer=${waterBufferBlocks}. ` +
        `Suggested claim: x1=${footprint.x1} y1=${evaluation.baseY - 1} z1=${footprint.z1} x2=${footprint.x2} y2=${evaluation.baseY + 7} z2=${footprint.z2}`
      );
    }
  );

  // 7. claim-build-zone
  factory.registerTool(
    "claim-build-zone",
    "Orchestrator-only: assign an exclusive build zone (bbox + TTL) to a worker before mutating build tools.",
    {
      zoneId: z.string().min(1).describe("Unique zone identifier"),
      assignedTo: z.string().optional().describe("Worker alias/user to receive this zone assignment"),
      x1: z.coerce.number().describe("Start X"),
      y1: z.coerce.number().describe("Start Y"),
      z1: z.coerce.number().describe("Start Z"),
      x2: z.coerce.number().describe("End X"),
      y2: z.coerce.number().describe("End Y"),
      z2: z.coerce.number().describe("End Z"),
      ttlSeconds: z.coerce.number().optional().describe("Reservation TTL in seconds (default: 900)"),
      spacingBlocks: z.coerce.number().optional().describe("Required footprint spacing to other owners (default: 2, use 0 for touching subzones)"),
    },
    async (params: any) => {
      const requester = requireOrchestratorReservationControl(getOwner(), 'claim-build-zone');
      const assignedTo = resolveReservationOwner(String(params.assignedTo ?? requester));
      const bounds = normalizeBounds(
        toInt(params.x1),
        toInt(params.y1),
        toInt(params.z1),
        toInt(params.x2),
        toInt(params.y2),
        toInt(params.z2)
      );
      const result = await coordinationStore.claimZone(
        assignedTo,
        String(params.zoneId),
        bounds,
        params.ttlSeconds ? toInt(params.ttlSeconds) : 900,
        params.spacingBlocks == null ? undefined : toInt(params.spacingBlocks)
      );

      if (!result.ok) {
        throw new Error(result.message);
      }

      return factory.createResponse(
        `Zone '${String(params.zoneId)}' assigned by ${requester} to ${assignedTo}. ${result.message}`
      );
    }
  );

  // 8. release-build-zone
  factory.registerTool(
    "release-build-zone",
    "Orchestrator-only: release a previously assigned build zone.",
    {
      zoneId: z.string().min(1).describe("Zone identifier to release"),
      assignedTo: z.string().optional().describe("Optional worker alias/user that currently owns the assignment"),
    },
    async (params: any) => {
      const requester = requireOrchestratorReservationControl(getOwner(), 'release-build-zone');
      const zoneId = String(params.zoneId).trim();
      let assignedTo = params.assignedTo ? resolveReservationOwner(String(params.assignedTo)) : '';

      if (!assignedTo) {
        const matches = (await coordinationStore.listClaims()).filter((claim) => claim.zoneId === zoneId);
        if (matches.length === 0) {
          return factory.createResponse(`No assigned zone '${zoneId}' found to release.`);
        }
        if (matches.length > 1) {
          throw new Error(
            `Multiple assignments share zoneId '${zoneId}'. Re-run with assignedTo to release the correct one.`
          );
        }
        assignedTo = matches[0].owner;
      }

      const result = await coordinationStore.releaseZone(assignedTo, zoneId);
      return factory.createResponse(
        `Zone '${zoneId}' release requested by ${requester} for ${assignedTo}. ${result.message}`
      );
    }
  );

  // 9. report-progress
  factory.registerTool(
    "report-progress",
    "Report structured progress for coordination board and chat visibility.",
    {
      taskId: z.string().min(1).describe("Task identifier"),
      zoneId: z.string().min(1).describe("Zone identifier"),
      phase: z.string().min(1).describe("Phase label (e.g., claimed, building, completed, blocked)"),
      note: z.string().optional().describe("Optional detail note"),
    },
    async (params: any) => {
      const bot = getBot();
      const owner = getOwner();
      const entry = await coordinationStore.reportProgress({
        taskId: String(params.taskId),
        zoneId: String(params.zoneId),
        owner,
        phase: String(params.phase),
        note: params.note ? String(params.note) : undefined
      });

      const chatMessage =
        `[progress][${entry.taskId}] ${owner} ${entry.zoneId} -> ${entry.phase}` +
        (entry.note ? ` (${entry.note})` : '');
      bot.chat(chatMessage);

      return factory.createResponse(
        `Progress recorded at ${nowIsoTimestamp(entry.timestamp)}: ${owner} ${entry.zoneId} -> ${entry.phase}` +
        (entry.note ? ` (${entry.note})` : '')
      );
    }
  );

  // 10. get-my-build-zones
  factory.registerTool(
    "get-my-build-zones",
    "Show the current worker's active preassigned build zones. Workers should use this instead of claiming zones.",
    {
      maxEntries: z.coerce.number().optional().describe("Max assigned zones to include (default: all, max: 100)"),
      zoneId: z.string().optional().describe("Optional exact zone id to verify/pin in the response"),
    },
    async (params: any) => {
      const owner = resolveReservationOwner(getOwner());
      const requestedZoneId = params.zoneId ? String(params.zoneId).trim() : '';
      const claims = (await coordinationStore.listClaims())
        .filter((claim) => ownersMatch(claim.owner, owner))
        .sort((a, b) => a.zoneId.localeCompare(b.zoneId));

      if (claims.length === 0) {
        return factory.createResponse(
          `No active preassigned build zones for ${owner}. Ask OrchestratorAgent for an assignment.`
        );
      }

      const filteredClaims = requestedZoneId
        ? claims.filter((claim) => claim.zoneId === requestedZoneId)
        : claims;

      if (requestedZoneId && filteredClaims.length === 0) {
        return factory.createResponse(
          `Requested zone '${requestedZoneId}' is not currently assigned to ${owner}. ` +
          `Active zones for ${owner}: ${claims.map((claim) => claim.zoneId).join(', ')}`
        );
      }

      const maxEntries = Math.max(
        1,
        Math.min(100, toInt(params.maxEntries ?? filteredClaims.length))
      );

      const lines = filteredClaims.slice(0, maxEntries).map((claim) => {
        const ttlSeconds = Math.max(0, Math.floor((claim.expiresAt - Date.now()) / 1000));
        return `${claim.zoneId} assignedTo=${claim.owner} bounds=${formatBounds(claim)} ttl=${ttlSeconds}s spacing=${claim.spacingBlocks}`;
      });

      const scope = requestedZoneId
        ? `Requested zone '${requestedZoneId}' for ${owner}`
        : `Preassigned build zones for ${owner} (${claims.length} total)`;
      const truncated = filteredClaims.length > maxEntries
        ? `\nNote: showing ${maxEntries}/${filteredClaims.length} matching zones.`
        : '';

      return factory.createResponse(
        `${scope}:\n${lines.join('\n')}${truncated}`
      );
    }
  );

  // 11. get-progress-board
  factory.registerTool(
    "get-progress-board",
    "Show active zone claims and recent progress updates.",
    {
      taskId: z.string().optional().describe("Filter by task id"),
      maxEntries: z.coerce.number().optional().describe("Max progress entries to include (default: 10, max: 20)"),
      includeClaims: z.coerce.boolean().optional().describe("Whether to include active claim lines (default: true)"),
    },
    async (params: any) => {
      const taskId = params.taskId ? String(params.taskId) : undefined;
      const maxEntries = Math.max(1, Math.min(20, toInt(params.maxEntries ?? 10)));
      const includeClaims = params.includeClaims == null ? true : Boolean(params.includeClaims);
      const claims = await coordinationStore.listClaims();
      const updates = await coordinationStore.getProgressBoard(taskId);

      const claimLines = includeClaims
        ? (claims.length > 0
            ? claims.slice(0, 8).map((claim) => {
                const ttlSeconds = Math.max(0, Math.floor((claim.expiresAt - Date.now()) / 1000));
                return `- ${claim.zoneId} assignedTo=${claim.owner} ttl=${ttlSeconds}s`;
              }).join('\n')
            : '- none')
        : '- skipped';

      const updateLines = updates.length > 0
        ? updates.slice(0, maxEntries).map((entry) => (
            `- ${nowIsoTimestamp(entry.timestamp)} ${entry.owner} ${entry.zoneId} ${entry.phase}` +
            (entry.note ? ` note="${truncateText(entry.note, 84)}"` : '')
          )).join('\n')
        : '- none';

      return factory.createResponse([
        `Progress board summary${taskId ? ` task=${taskId}` : ''}: claims=${claims.length} updates=${updates.length}`,
        `Claims (showing up to 8):`,
        claimLines,
        `Recent Progress (showing up to ${maxEntries}):`,
        updateLines
      ].join('\n'));
    }
  );

  // 12. plan-village-layout
  factory.registerTool(
    "plan-village-layout",
    "Plan a compact multi-house village grid with explicit non-overlapping footprint slots.",
    {
      centerX: z.coerce.number().describe("Village center X"),
      centerZ: z.coerce.number().describe("Village center Z"),
      rows: z.coerce.number().describe("Grid rows"),
      cols: z.coerce.number().describe("Grid columns"),
      houseCount: z.coerce.number().optional().describe("Number of houses to generate (default: rows*cols)"),
      houseWidth: z.coerce.number().optional().describe("House footprint width (default: 7)"),
      houseDepth: z.coerce.number().optional().describe("House footprint depth (default: 7)"),
      bufferBlocks: z.coerce.number().optional().describe("Gap between house footprints (default: 2)"),
      stylesCsv: z.string().optional().describe("Comma-separated style rotation (e.g., oak,spruce,birch)"),
      buildersCsv: z.string().optional().describe("Comma-separated builder rotation (e.g., MinecraftAgent,BuildBeaAgent,SupplySidAgent)")
    },
    async (params: any) => {
      const styles = parseCsvList(params.stylesCsv);
      const builders = parseCsvList(params.buildersCsv);

      const plan = planVillageLayout({
        centerX: toInt(params.centerX),
        centerZ: toInt(params.centerZ),
        rows: toInt(params.rows),
        cols: toInt(params.cols),
        houseCount: params.houseCount != null ? toInt(params.houseCount) : undefined,
        houseWidth: params.houseWidth != null ? toInt(params.houseWidth) : undefined,
        houseDepth: params.houseDepth != null ? toInt(params.houseDepth) : undefined,
        bufferBlocks: params.bufferBlocks != null ? toInt(params.bufferBlocks) : undefined,
        styles,
        builders
      });

      const lines = plan.slots.map((slot) =>
        `${slot.houseId} builder=${slot.builder} style=${slot.style} center=(${slot.centerX},${slot.centerZ}) ` +
        `footprint=(${slot.x1},${slot.z1})-(${slot.x2},${slot.z2})`
      );

      return factory.createResponse(
        `Village layout generated: ${plan.meta.generatedHouses}/${plan.meta.requestedHouses} houses, ` +
        `grid=${plan.meta.rows}x${plan.meta.cols}, house=${plan.meta.houseWidth}x${plan.meta.houseDepth}, ` +
        `buffer=${plan.meta.bufferBlocks}, bounds=(${plan.bounds.minX},${plan.bounds.minZ})-(${plan.bounds.maxX},${plan.bounds.maxZ}).\n` +
        lines.join('\n')
      );
    }
  );

  // 13. allocate-village-zones
  factory.registerTool(
    "allocate-village-zones",
    "Plan and reserve all worker house zones upfront in one atomic pass for conflict-free parallel building.",
    {
      taskId: z.string().optional().describe("Optional task id for progress board entries"),
      centerX: z.coerce.number().describe("Village center X"),
      centerZ: z.coerce.number().describe("Village center Z"),
      rows: z.coerce.number().describe("Grid rows"),
      cols: z.coerce.number().describe("Grid columns"),
      houseCount: z.coerce.number().optional().describe("Number of houses to allocate (default: rows*cols)"),
      houseWidth: z.coerce.number().optional().describe("House footprint width (default: 7)"),
      houseDepth: z.coerce.number().optional().describe("House footprint depth (default: 7)"),
      bufferBlocks: z.coerce.number().optional().describe("Gap between planned footprints (default: 2)"),
      buildersCsv: z.string().optional().describe("Builder rotation by agent/user aliases (default: MinecraftAgent,BuildBeaAgent,SupplySidAgent)"),
      stylesCsv: z.string().optional().describe("House style rotation (default: oak,spruce,birch)"),
      ttlSeconds: z.coerce.number().optional().describe("Claim TTL in seconds (default: 1800)"),
      clearExistingForOwners: z.coerce.boolean().optional().describe("Clear prior claims for target owners before allocation (default: true)"),
      searchRadius: z.coerce.number().optional().describe("Per-slot local search radius (default: 14)"),
      searchStep: z.coerce.number().optional().describe("Search step size (default: 2)"),
      maxHeightDelta: z.coerce.number().optional().describe("Allowed terrain delta inside each footprint before rejection (default: 2)"),
      maxManMadeColumns: z.coerce.number().optional().describe("Allowed man-made columns inside each footprint (default: 4)"),
      waterBufferBlocks: z.coerce.number().optional().describe("Reject sites too close to water (default: 2)")
    },
    async (params: any) => {
      const orchestratorOwner = requireOrchestratorReservationControl(getOwner(), 'allocate-village-zones');
      const bot = getBot();
      const builders = parseCsvList(params.buildersCsv) ?? [
        'MinecraftAgent',
        'BuildBeaAgent',
        'SupplySidAgent'
      ];
      const styles = parseCsvList(params.stylesCsv) ?? ['oak', 'spruce', 'birch'];
      const ttlSeconds = Math.max(60, Math.min(7200, toInt(params.ttlSeconds ?? 1800)));
      const clearExistingForOwners = params.clearExistingForOwners == null
        ? true
        : Boolean(params.clearExistingForOwners);
      const searchRadius = Math.max(0, Math.min(48, toInt(params.searchRadius ?? 14)));
      const searchStep = Math.max(1, Math.min(8, toInt(params.searchStep ?? 2)));
      const maxHeightDelta = Math.max(0, Math.min(4, toInt(params.maxHeightDelta ?? 2)));
      const maxManMadeColumns = Math.max(0, Math.min(20, toInt(params.maxManMadeColumns ?? 4)));
      const waterBufferBlocks = Math.max(0, Math.min(4, toInt(params.waterBufferBlocks ?? HOUSE_WATER_BUFFER_BLOCKS)));
      const taskId = params.taskId ? String(params.taskId) : `zone-allocation-${Date.now()}`;

      const plan = planVillageLayout({
        centerX: toInt(params.centerX),
        centerZ: toInt(params.centerZ),
        rows: toInt(params.rows),
        cols: toInt(params.cols),
        houseCount: params.houseCount != null ? toInt(params.houseCount) : undefined,
        houseWidth: params.houseWidth != null ? toInt(params.houseWidth) : undefined,
        houseDepth: params.houseDepth != null ? toInt(params.houseDepth) : undefined,
        bufferBlocks: params.bufferBlocks != null ? toInt(params.bufferBlocks) : undefined,
        builders,
        styles
      });

      const requestedOwners = new Set(
        plan.slots.map((slot) => resolveReservationOwner(slot.builder))
      );
      const existingClaims = await coordinationStore.listClaims();
      const blockedBounds: BoundingBox[] = existingClaims
        .filter((claim) => !(clearExistingForOwners && requestedOwners.has(claim.owner)))
        .map((claim) => normalizeBounds(claim.minX, claim.minY, claim.minZ, claim.maxX, claim.maxY, claim.maxZ));

      const allocations: Array<{
        zoneId: string;
        owner: string;
        builder: string;
        style: string;
        centerX: number;
        centerZ: number;
        x1: number;
        z1: number;
        x2: number;
        z2: number;
        y1: number;
        y2: number;
        terrainDelta: number;
        suggestedFlattenMaxAdjustment: number;
      }> = [];

      for (const slot of plan.slots) {
        const owner = resolveReservationOwner(slot.builder);
        const site = await findNearestLandFootprintAvoiding(
          bot,
          slot.centerX,
          slot.centerZ,
          plan.meta.houseWidth,
          plan.meta.houseDepth,
          searchRadius,
          searchStep,
          maxHeightDelta,
          maxManMadeColumns,
          waterBufferBlocks,
          blockedBounds
        );

        if (!site.ok || !site.result) {
          throw new Error(
            `Failed to allocate ${slot.houseId} for ${owner} near (${slot.centerX},${slot.centerZ}). ` +
            `Reason: ${site.reason}`
          );
        }

        blockedBounds.push(site.result.claimBounds);
        allocations.push({
          zoneId: slot.houseId,
          owner,
          builder: slot.builder,
          style: slot.style,
          centerX: site.result.footprint.centerX,
          centerZ: site.result.footprint.centerZ,
          x1: site.result.footprint.x1,
          z1: site.result.footprint.z1,
          x2: site.result.footprint.x2,
          z2: site.result.footprint.z2,
          y1: site.result.baseY - 1,
          y2: site.result.baseY + 7,
          terrainDelta: terrainDelta(site.result.evaluation),
          suggestedFlattenMaxAdjustment: Math.min(2, terrainDelta(site.result.evaluation))
        });
      }

      const batchResult = await coordinationStore.claimZonesBatch(
        allocations.map((allocation) => ({
          owner: allocation.owner,
          zoneId: allocation.zoneId,
          bounds: normalizeBounds(
            allocation.x1,
            allocation.y1,
            allocation.z1,
            allocation.x2,
            allocation.y2,
            allocation.z2
          ),
          ttlSeconds
        })),
        { clearExistingForOwners }
      );

      if (!batchResult.ok) {
        throw new Error(batchResult.message);
      }

      for (const allocation of allocations) {
        await coordinationStore.reportProgress({
          taskId,
          zoneId: allocation.zoneId,
          owner: orchestratorOwner,
          phase: 'allocated',
          note: `assignedTo=${allocation.owner} center=(${allocation.centerX},${allocation.centerZ})`
        });
      }

      const lines = allocations.map((allocation) =>
        `${allocation.zoneId} assignedTo=${allocation.owner} builder=${allocation.builder} style=${allocation.style} ` +
        `center=(${allocation.centerX},${allocation.centerZ}) claim=` +
        `x1=${allocation.x1} y1=${allocation.y1} z1=${allocation.z1} x2=${allocation.x2} y2=${allocation.y2} z2=${allocation.z2} ` +
        `terrainDelta=${allocation.terrainDelta} flattenRecommended=${allocation.terrainDelta > 0 ? 'yes' : 'no'} ` +
        `suggestedFlattenMaxAdjustment=${allocation.suggestedFlattenMaxAdjustment}`
      );

      return factory.createResponse(
        `${batchResult.message} taskId=${taskId}. ` +
        `Use these assignments directly; workers can start in parallel without additional claim races.\n` +
        lines.join('\n')
      );
    }
  );

  // 14. lookup-catalog-landmarks
  factory.registerTool(
    "lookup-catalog-landmarks",
    "Search the approved model library for landmark/building candidates related to a user prompt and map matching results onto supported local templates when possible.",
    {
      prompt: z.string().min(1).describe("User mission prompt describing the requested landmark or cultural structure"),
      cultureHint: z.string().optional().describe("Optional culture hint, e.g. USA or France"),
      limit: z.coerce.number().optional().describe("Maximum number of ranked results to return (default: 5)")
    },
    async (params: any) => {
      const autonomy = getLandmarkAutonomyService();
      const specs = await autonomy.listLandmarkSpecs();
      const prompt = String(params.prompt);
      const cultureHint = params.cultureHint ? String(params.cultureHint) : undefined;
      const limit = Math.max(1, Math.min(8, toInt(params.limit ?? 5)));

      const lookup = await getCatalogLookupService().lookupLandmarks({
        prompt,
        cultureHint,
        specs,
        limit
      });

      if (lookup.candidates.length === 0) {
        return factory.createResponse(
          `Model lookup found no candidates for prompt="${prompt}" queries=${lookup.queries.join(',') || 'none'}`
        );
      }

      return factory.createResponse(
        `Model library queries=${lookup.queries.join(' | ')}\n` +
        lookup.candidates.map((candidate, index) => `${index + 1}. ${formatCatalogLookupCandidate(candidate)}`).join('\n')
      );
    }
  );

  // 15. discover-landmark-candidates
  factory.registerTool(
    "discover-landmark-candidates",
    "Discover and rank landmark candidates from the active local landmark bank for a broad cultural or landmark prompt.",
    {
      prompt: z.string().min(1).describe("User mission prompt describing the landmark/building intent"),
      cultureHint: z.string().optional().describe("Optional culture hint, e.g. Italy or France"),
      sizeHint: z.string().optional().describe("Optional size hint, e.g. small/medium/large"),
      limit: z.coerce.number().optional().describe("Maximum number of ranked candidates to return (default: 5)")
    },
    async (params: any) => {
      const autonomy = getLandmarkAutonomyService();
      const prompt = String(params.prompt);
      const cultureHint = params.cultureHint ? String(params.cultureHint) : undefined;
      const sizeHint = params.sizeHint ? String(params.sizeHint) : undefined;
      const limit = Math.max(1, Math.min(8, toInt(params.limit ?? 5)));

      const candidates = await autonomy.discoverLandmarkCandidates(prompt, cultureHint, sizeHint, limit);
      const lines = candidates.map((candidate, index) => (
        `${index + 1}. ${candidate.spec.id} (${candidate.spec.name}) culture=${candidate.spec.culture} ` +
        `score=${candidate.score} recommendedScale=${candidate.recommendedScale} ` +
        `matchedKeywords=${candidate.matchedKeywords.join(',') || 'none'} rationale=${candidate.rationale}`
      ));

      return factory.createResponse(lines.join('\n'));
    }
  );

  // 16. select-landmark-spec
  factory.registerTool(
    "select-landmark-spec",
    "Select the best landmark template for a user prompt. Uses the active local landmark bank and can prefer an imported-model match when site lookup finds a stronger match.",
    {
      prompt: z.string().min(1).describe("User mission prompt describing the landmark/building intent"),
      cultureHint: z.string().optional().describe("Optional culture hint, e.g. France or Netherlands"),
      sizeHint: z.string().optional().describe("Optional size hint, e.g. small/medium/large"),
    },
    async (params: any) => {
      const autonomy = getLandmarkAutonomyService();
      const prompt = String(params.prompt);
      const cultureHint = params.cultureHint ? String(params.cultureHint) : undefined;
      const sizeHint = params.sizeHint ? String(params.sizeHint) : undefined;

      const resolution = await resolveLandmarkCandidatesWithCatalog(
        autonomy,
        prompt,
        cultureHint,
        sizeHint,
        3
      );
      const selected = resolution.candidates[0];
      const styles = Object.keys(selected.spec.styles).join(',');
      const scales = Object.keys(selected.spec.scaleVariants).join(',');
      const sourceNote = resolution.mappedLookup
        ? ` lookupSource=the approved model library matchedTitle="${resolution.mappedLookup.title}" matchedUrl=${resolution.mappedLookup.url}.`
        : '';

      return factory.createResponse(
        `Selected landmark spec '${selected.spec.id}' (${selected.spec.name}) ` +
        `culture=${selected.spec.culture} score=${selected.score} recommendedScale=${selected.recommendedScale}. ` +
        `Matched keywords=${selected.matchedKeywords.join(',') || 'none'}. Styles=${styles}. Scales=${scales}. ` +
        `Rationale: ${selected.rationale}.${sourceNote}`
      );
    }
  );

  // 17. plan-landmark-mission
  factory.registerTool(
    "plan-landmark-mission",
    "High-level landmark planner: discover candidates, consult the approved model library when needed, pick the best buildable landmark, auto-place it, compile the graph, and emit dispatch waves for the orchestrator.",
    {
      prompt: z.string().min(1).describe("User mission prompt describing the requested landmark or cultural structure"),
      originX: z.coerce.number().describe("Requested build origin X"),
      originZ: z.coerce.number().describe("Requested build origin Z"),
      cultureHint: z.string().optional().describe("Optional culture hint, e.g. Italy or France"),
      sizeHint: z.string().optional().describe("Optional size hint, e.g. small/medium/large"),
      stylePreset: z.string().optional().describe("Optional style preset key for the selected spec"),
      targetDurationMinutes: z.coerce.number().optional().describe("Target autonomy runtime in minutes (default: 30)"),
      baseY: z.coerce.number().optional().describe("Optional explicit base Y. If omitted, sampled from terrain."),
      autoPlace: z.coerce.boolean().optional().describe("Auto-pick the nearest usable dry site for the landmark footprint (default: true)"),
      searchRadius: z.coerce.number().optional().describe("Auto-placement search radius around requested origin (default: 96)"),
      searchStep: z.coerce.number().optional().describe("Auto-placement search step size (default: 4)"),
      maxHeightDelta: z.coerce.number().optional().describe("Allowed terrain delta across the structural footprint during auto-placement (default: 3)"),
      maxManMadeColumns: z.coerce.number().optional().describe("Allowed man-made columns across the structural footprint during auto-placement (default: 0)"),
      waterBufferBlocks: z.coerce.number().optional().describe("Reject auto-placement sites too close to water (default: 1)"),
      candidateLimit: z.coerce.number().optional().describe("Number of ranked candidates to try before failing (default: 3)"),
      allowLocalSpecFallback: z.coerce.boolean().optional().describe("Allow fallback to simplified local landmark specs if live model import fails (default: false)")
    },
    async (params: any) => {
      const autonomy = getLandmarkAutonomyService();
      const bot = getBot();
      const prompt = String(params.prompt);
      const cultureHint = params.cultureHint ? String(params.cultureHint) : undefined;
      const sizeHint = params.sizeHint ? String(params.sizeHint) : undefined;
      const candidateLimit = Math.max(1, Math.min(6, toInt(params.candidateLimit ?? 3)));
      const allowLocalSpecFallback = params.allowLocalSpecFallback == null
        ? false
        : Boolean(params.allowLocalSpecFallback);

      const resolution = await resolveLandmarkCandidatesWithCatalog(
        autonomy,
        prompt,
        cultureHint,
        sizeHint,
        candidateLimit
      );
      const candidates = resolution.candidates;
      const failedCandidates: string[] = [];
      let compiled: {
        graph: BuildGraph;
        placementSummary: string;
        source: 'catalog' | 'local-spec';
        selectedName: string;
        selectedSpecId: string;
        selectedCulture: string;
        selectedScale: string;
      } | null = null;

      const lookupCandidates = resolution.lookup?.selected
        ? [
            resolution.lookup.selected,
            ...(resolution.lookup.candidates ?? []).filter((candidate) => candidate.url !== resolution.lookup?.selected?.url)
          ]
        : (resolution.lookup?.candidates ?? []);

      for (const candidate of lookupCandidates.slice(0, candidateLimit)) {
        try {
          const imported = await compileCatalogGraphWithPlacement(bot, autonomy, {
            prompt,
            candidate,
            cultureHint,
            sizeHint: recommendScaleForCatalogCandidate(candidate, sizeHint),
            targetDurationMinutes: params.targetDurationMinutes != null
              ? toInt(params.targetDurationMinutes)
              : undefined,
            originX: toInt(params.originX),
            originZ: toInt(params.originZ),
            baseY: params.baseY == null ? undefined : toInt(params.baseY),
            autoPlace: params.autoPlace == null ? undefined : Boolean(params.autoPlace),
            searchRadius: params.searchRadius == null ? undefined : toInt(params.searchRadius),
            searchStep: params.searchStep == null ? undefined : toInt(params.searchStep),
            maxHeightDelta: params.maxHeightDelta == null ? undefined : toInt(params.maxHeightDelta),
            maxManMadeColumns: params.maxManMadeColumns == null ? undefined : toInt(params.maxManMadeColumns),
            waterBufferBlocks: params.waterBufferBlocks == null ? undefined : toInt(params.waterBufferBlocks)
          });
          compiled = {
            graph: imported.graph,
            placementSummary: imported.placementSummary,
            source: 'catalog',
            selectedName: imported.model.source.title,
            selectedSpecId: imported.graph.specId,
            selectedCulture: imported.graph.culture,
            selectedScale: imported.graph.scale
          };
          break;
        } catch (error) {
          failedCandidates.push(`catalog:${candidate.title}: ${formatError(error)}`);
        }
      }

      if (!compiled && allowLocalSpecFallback) {
        for (const candidate of candidates) {
          try {
            const localCompiled = await compileLandmarkGraphWithPlacement(bot, autonomy, {
              specId: candidate.spec.id,
              originX: toInt(params.originX),
              originZ: toInt(params.originZ),
              scale: candidate.recommendedScale,
              stylePreset: params.stylePreset ? String(params.stylePreset) : undefined,
              prompt,
              targetDurationMinutes: params.targetDurationMinutes != null
                ? toInt(params.targetDurationMinutes)
                : undefined,
              baseY: params.baseY == null ? undefined : toInt(params.baseY),
              autoPlace: params.autoPlace == null ? undefined : Boolean(params.autoPlace),
              searchRadius: params.searchRadius == null ? undefined : toInt(params.searchRadius),
              searchStep: params.searchStep == null ? undefined : toInt(params.searchStep),
              maxHeightDelta: params.maxHeightDelta == null ? undefined : toInt(params.maxHeightDelta),
              maxManMadeColumns: params.maxManMadeColumns == null ? undefined : toInt(params.maxManMadeColumns),
              waterBufferBlocks: params.waterBufferBlocks == null ? undefined : toInt(params.waterBufferBlocks)
            });
            compiled = {
              graph: localCompiled.graph,
              placementSummary: localCompiled.placementSummary,
              source: 'local-spec',
              selectedName: candidate.spec.name,
              selectedSpecId: candidate.spec.id,
              selectedCulture: candidate.spec.culture,
              selectedScale: candidate.recommendedScale
            };
            break;
          } catch (error) {
            failedCandidates.push(`${candidate.spec.id}: ${formatError(error)}`);
          }
        }
      }

      if (!compiled) {
        const lookupFailureSummary = resolution.lookup?.candidates?.length
          ? ` Model library top results: ${resolution.lookup.candidates
              .slice(0, 3)
              .map((candidate) => formatCatalogLookupCandidate(candidate))
              .join(' | ')}`
          : '';
        throw new Error(
          `Could not plan a landmark mission for '${prompt}' from the approved model library. ` +
          `Live model import is required for this tool. ` +
          `Tried candidates: ${failedCandidates.join(' | ') || 'none'}.${lookupFailureSummary}`
        );
      }

      const graph = compiled.graph;
      const readyPackets = graph.nodes
        .filter((node) => node.status === 'ready')
        .slice(0, 5)
        .map((node) => (
          `${node.assignedWorker}:${node.taskId}:${node.toolPlan.primaryTool}:${node.zoneId}`
        ));
      const readyWorkers = Array.from(new Set(
        graph.nodes
          .filter((node) => node.status === 'ready')
          .map((node) => node.assignedWorker)
      ));
      const candidateSummary = candidates
        .slice(0, 3)
        .map((candidate) => `${candidate.spec.id}:${candidate.score}`)
        .join(', ');
      const lookupSummary = resolution.lookup?.candidates?.length
        ? resolution.lookup.candidates
            .slice(0, Math.min(2, resolution.lookup.candidates.length))
            .map((candidate) => formatCatalogLookupCandidate(candidate))
            .join(' | ')
        : 'none';

      return factory.createResponse(
        `Mission plan ready. selectedSource=${compiled.source} selectedSpec=${compiled.selectedSpecId} selectedName="${compiled.selectedName}" ` +
        `culture=${compiled.selectedCulture} selectedScale=${compiled.selectedScale} ` +
        `graphId=${graph.graphId} tasks=${graph.nodes.length} blockBudget=${graph.expectedBlocks}. ${compiled.placementSummary}\n` +
        `readyWorkers=${readyWorkers.join(',') || 'none'} ` +
        `readyPackets=${readyPackets.join(' | ') || 'none'}\n` +
        `candidateSummary=${candidateSummary || 'none'}\n` +
        `catalogSummary=${lookupSummary}` +
        (failedCandidates.length > 0 ? `\nskipped=${failedCandidates.slice(0, 2).join(' | ')}` : '')
      );
    }
  );

  factory.registerTool(
    "build-santander-hq-staged",
    "Build the registered Santander HQ full-campus .ots_blocks model one named area at a time using the safe tiled placer.",
    {
      filePath: z.string().min(1).optional().describe("Optional absolute path to a Santander .ots_blocks file"),
      modelName: z.string().min(1).optional().describe("Optional registered model name. Defaults to 'Santander HQ Full Campus'."),
      title: z.string().optional().describe("Optional display title for the imported model"),
      centerX: z.coerce.number().optional().describe("Build center X for the full campus (default: 0)"),
      centerZ: z.coerce.number().optional().describe("Build center Z for the full campus (default: 0)"),
      baseY: z.coerce.number().optional().describe("Minimum build Y (default: 64)"),
      clearBeforeBuild: z.coerce.boolean().optional().describe("Clear the whole campus footprint before staged placement (default: true)"),
      clearYMax: z.coerce.number().optional().describe("Top Y to clear before placement (default: baseY + 51)"),
      batchSize: z.coerce.number().optional().describe("RCON commands per batch for the Python tiled placer (default: 5000)"),
      tileSize: z.coerce.number().optional().describe("Forceload/placement tile width and depth (default: 128)"),
      stageDelaySeconds: z.coerce.number().optional().describe("Delay between named areas (default: 1.5)"),
      batchDelaySeconds: z.coerce.number().optional().describe("Delay between placement batches (default: 0.05)"),
      dryRun: z.coerce.boolean().optional().describe("Print the staged build plan without changing Minecraft (default: false)")
    },
    async (params: any) => {
      requireOrchestratorReservationControl(getOwner(), 'build-santander-hq-staged');

      const resolved = await resolveOtsBlockModelReference({
        filePath: params.filePath ? String(params.filePath) : undefined,
        modelName: params.modelName ? String(params.modelName) : 'Santander HQ Full Campus',
        title: params.title ? String(params.title) : undefined
      });
      const centerX = params.centerX == null ? 0 : toInt(params.centerX);
      const centerZ = params.centerZ == null ? 0 : toInt(params.centerZ);
      const baseY = params.baseY == null ? 64 : toInt(params.baseY);
      const clearBeforeBuild = params.clearBeforeBuild == null ? true : Boolean(params.clearBeforeBuild);
      const clearYMax = params.clearYMax == null ? baseY + 51 : toInt(params.clearYMax);
      const batchSize = Math.max(100, Math.min(10000, params.batchSize == null ? 5000 : toInt(params.batchSize)));
      const tileSize = Math.max(32, Math.min(256, params.tileSize == null ? 128 : toInt(params.tileSize)));
      const stageDelaySeconds = Math.max(0, Math.min(30, params.stageDelaySeconds == null ? 1.5 : Number(params.stageDelaySeconds)));
      const batchDelaySeconds = Math.max(0, Math.min(2, params.batchDelaySeconds == null ? 0.05 : Number(params.batchDelaySeconds)));
      const dryRun = params.dryRun == null ? false : Boolean(params.dryRun);

      const scriptArgs = [
        '--input', resolved.filePath,
        '--center-x', String(centerX),
        '--center-z', String(centerZ),
        '--base-y', String(baseY),
        '--axis-order', 'xyz',
        '--batch-size', String(batchSize),
        '--tile-size', String(tileSize),
        '--clear-y-min', String(baseY),
        '--clear-y-max', String(clearYMax),
        '--stage-delay', String(stageDelaySeconds),
        '--batch-delay', String(batchDelaySeconds)
      ];
      if (!clearBeforeBuild) {
        scriptArgs.push('--no-clear-before-build');
      }
      if (dryRun) {
        scriptArgs.push('--dry-run');
      }

      const result = await runProjectPythonScript('tools/place_santander_hq_staged.py', scriptArgs);
      return factory.createResponse(
        `Santander HQ staged build ${dryRun ? 'plan ready' : 'complete'}. selectedSource=ots-blocks ` +
        `selectedName="${resolved.title}" modelId=${resolved.id ?? 'ad-hoc'} center=(${centerX},${centerZ}) ` +
        `baseY=${baseY} clearBeforeBuild=${clearBeforeBuild} batchSize=${batchSize} tileSize=${tileSize} ` +
        `stageDelaySeconds=${stageDelaySeconds} batchDelaySeconds=${batchDelaySeconds}\n` +
        `${result.stdoutTail || 'No staged build output captured.'}` +
        (result.stderrTail ? `\nstderrTail=${result.stderrTail}` : '')
      );
    }
  );

  factory.registerTool(
    "build-ots-model-direct-recording",
    "Fast recording mode: clear the prepared plot and place a registered/file-based .ots_blocks model directly from bottom to top without zones, workers, or retries.",
    {
      filePath: z.string().min(1).optional().describe("Optional absolute path to a local .ots_blocks file"),
      modelName: z.string().min(1).optional().describe("Optional registered OTS model name. Defaults to 'local Sydney Opera House'."),
      title: z.string().optional().describe("Optional display title for the imported model"),
      centerX: z.coerce.number().optional().describe("Build center X (default: 0)"),
      centerZ: z.coerce.number().optional().describe("Build center Z (default: 0)"),
      baseY: z.coerce.number().optional().describe("Minimum build Y (default: 68)"),
      clearPlot: z.coerce.boolean().optional().describe("Clear and prepare the recording plot first (default: true)"),
      clearRadius: z.coerce.number().optional().describe("Prepared plot radius around world origin when clearPlot=true (default: 70)"),
      clearTopY: z.coerce.number().optional().describe("Top Y to clear when clearPlot=true (default: max(160, model top + 8))"),
      batchSize: z.coerce.number().optional().describe("RCON commands per layer batch (default: 5000)"),
      layerDelayMs: z.coerce.number().optional().describe("Optional delay between layers in milliseconds (default: 0)"),
      targetDurationSeconds: z.coerce.number().optional().describe("Target total recording duration in seconds; overrides layerDelayMs when > 0"),
      showAgentChoreography: z.coerce.boolean().optional().describe("Move a few visible bots around the active layer perimeter (default: false)"),
      emitCoordinationChat: z.coerce.boolean().optional().describe("Emit lightweight Minecraft chat coordination messages during the direct build (default: same as showAgentChoreography)"),
      choreographyAgents: z.string().optional().describe("Comma-separated bot usernames to move during choreography"),
      agentMoveIntervalLayers: z.coerce.number().optional().describe("Move choreography bots every N layers (default: 1)"),
      chatIntervalLayers: z.coerce.number().optional().describe("Emit coordination chat every N layers (default: 5)"),
      stabilizeGravityBlocks: z.coerce.boolean().optional().describe("Replace falling concrete-powder/sand/gravel with stable equivalents before building (default: true)")
    },
    async (params: any) => {
      requireOrchestratorReservationControl(getOwner(), 'build-ots-model-direct-recording');

      const resolved = await resolveOtsBlockModelReference({
        filePath: params.filePath ? String(params.filePath) : undefined,
        modelName: params.modelName ? String(params.modelName) : 'local Sydney Opera House',
        title: params.title ? String(params.title) : undefined
      });
      const model = await importOtsBlockModelAsCatalogModel({
        filePath: resolved.filePath,
        title: resolved.title,
        stabilizeGravityBlocks: params.stabilizeGravityBlocks == null
          ? true
          : Boolean(params.stabilizeGravityBlocks)
      });

      const sourceBounds = model.stats.bounds;
      if (!sourceBounds) {
        throw new Error(`Imported OTS model '${resolved.title}' has no bounds.`);
      }

      const width = sourceBounds.maxX - sourceBounds.minX + 1;
      const depth = sourceBounds.maxZ - sourceBounds.minZ + 1;
      const centerX = params.centerX == null ? 0 : toInt(params.centerX);
      const centerZ = params.centerZ == null ? 0 : toInt(params.centerZ);
      const baseY = params.baseY == null ? 68 : toInt(params.baseY);
      const originX = centerX - Math.floor(width / 2);
      const originZ = centerZ - Math.floor(depth / 2);
      const plan = buildPlacementPlan(model, originX, baseY, originZ);

      if (plan.translatedBlocks.length === 0) {
        throw new Error(`OTS model '${resolved.title}' produced no placeable blocks.`);
      }

      const bounds = placementBounds(plan.translatedBlocks);
      const batchSize = Math.max(1, Math.min(500, params.batchSize == null ? 300 : toInt(params.batchSize)));
      const clearPlot = params.clearPlot == null ? true : Boolean(params.clearPlot);
      const clearRadius = Math.max(16, Math.min(256, params.clearRadius == null ? 70 : toInt(params.clearRadius)));
      const clearTopY = Math.max(
        bounds.maxY + 2,
        params.clearTopY == null ? Math.max(160, bounds.maxY + 8) : toInt(params.clearTopY)
      );
      const layers = groupPlacementBlocksByLayer(plan.translatedBlocks);
      const targetDurationSeconds = params.targetDurationSeconds == null
        ? 0
        : Math.max(0, Math.min(300, Number(params.targetDurationSeconds)));
      const layerDelayMs = targetDurationSeconds > 0
        ? Math.max(0, Math.min(5000, Math.floor((targetDurationSeconds * 1000) / Math.max(1, layers.length))))
        : Math.max(0, Math.min(5000, params.layerDelayMs == null ? 0 : toInt(params.layerDelayMs)));
      const showAgentChoreography = params.showAgentChoreography == null
        ? false
        : Boolean(params.showAgentChoreography);
      const emitCoordinationChat = params.emitCoordinationChat == null
        ? showAgentChoreography
        : Boolean(params.emitCoordinationChat);
      const choreographyAgents = parseRecordingAgentList(params.choreographyAgents);
      const agentMoveIntervalLayers = Math.max(1, Math.min(12, params.agentMoveIntervalLayers == null ? 1 : toInt(params.agentMoveIntervalLayers)));
      const chatIntervalLayers = Math.max(1, Math.min(12, params.chatIntervalLayers == null ? 5 : toInt(params.chatIntervalLayers)));
      let commandCount = 0;
      let batchCount = 0;

      if (clearPlot) {
        await streamRconCommands(
          preparedRecordingPlotCommands(baseY, clearTopY, clearRadius),
          PROJECT_ROOT_DIR
        );
      }

      const forceloadAdd = `/forceload add ${bounds.minX} ${bounds.minZ} ${bounds.maxX} ${bounds.maxZ}`;
      const forceloadRemove = `/forceload remove ${bounds.minX} ${bounds.minZ} ${bounds.maxX} ${bounds.maxZ}`;
      await streamRconCommands([forceloadAdd], PROJECT_ROOT_DIR);
      try {
        if (emitCoordinationChat) {
          await streamRconCommands([
            tellrawCommand(
              `[SAM] Coordination: direct recording build started for ${resolved.title}. ` +
              `Reliable layer placement stays centralized; visible agents mirror the active layer.`
            )
          ], PROJECT_ROOT_DIR);
        }

        for (let layerIndex = 0; layerIndex < layers.length; layerIndex += 1) {
          const layer = layers[layerIndex];
          const layerNumber = layerIndex + 1;
          const choreographyCommands = recordingChoreographyCommands({
            bounds,
            layerIndex: layerNumber,
            totalLayers: layers.length,
            layerY: layer.y,
            baseY,
            agents: choreographyAgents,
            moveAgents: showAgentChoreography,
            emitChat: emitCoordinationChat,
            chatIntervalLayers,
            moveIntervalLayers: agentMoveIntervalLayers
          });
          if (choreographyCommands.length > 0) {
            await streamRconCommands(choreographyCommands, PROJECT_ROOT_DIR);
          }

          const layerCommands = placementRunCommands(layer.blocks);
          for (const batch of chunkCommands(layerCommands, batchSize)) {
            await streamRconCommands(batch, PROJECT_ROOT_DIR);
            commandCount += batch.length;
            batchCount += 1;
            if (DIRECT_RECORDING_RCON_BATCH_DELAY_MS > 0) {
              await delay(DIRECT_RECORDING_RCON_BATCH_DELAY_MS);
            }
          }
          if (layerDelayMs > 0) {
            await delay(layerDelayMs);
          }
        }
      } finally {
        try {
          await streamRconCommands([forceloadRemove], PROJECT_ROOT_DIR);
        } catch (error) {
          log('warn', `Failed to remove direct recording forceload for ${resolved.title}: ${formatError(error)}`);
        }
      }

      return factory.createResponse(
        `Direct recording build complete. selectedSource=ots-blocks selectedName="${resolved.title}" ` +
        `modelId=${resolved.id ?? 'ad-hoc'} blocks=${plan.translatedBlocks.length} layers=${layers.length} ` +
        `commands=${commandCount} batches=${batchCount} bounds=${formatBounds(bounds)} ` +
        `clearPlot=${clearPlot} layerDelayMs=${layerDelayMs} targetDurationSeconds=${targetDurationSeconds} ` +
        `choreography=${showAgentChoreography} agents=${showAgentChoreography ? choreographyAgents.join(',') : 'none'} ` +
        `skippedPalette=${plan.skippedPalette.length}`
      );
    }
  );

  factory.registerTool(
    "plan-ots-block-model-mission",
    "Import a registered or file-based .ots_blocks model, auto-place it on valid land, compile exact shard packets, and emit a worker-ready graph for the orchestrator.",
    {
      filePath: z.string().min(1).optional().describe("Optional absolute path to a local .ots_blocks file"),
      modelName: z.string().min(1).optional().describe("Optional registered OTS model name or alias, e.g. 'local Architecture Tower'"),
      title: z.string().optional().describe("Optional display title for the imported model"),
      originX: z.coerce.number().describe("Requested build center X"),
      originZ: z.coerce.number().describe("Requested build center Z"),
      targetDurationMinutes: z.coerce.number().optional().describe("Target autonomy runtime in minutes (default: 30)"),
      baseY: z.coerce.number().optional().describe("Optional explicit base Y. If omitted, sampled from terrain."),
      autoPlace: z.coerce.boolean().optional().describe("Auto-pick the nearest usable dry site for the model footprint (default: true)"),
      searchRadius: z.coerce.number().optional().describe("Auto-placement search radius around requested center (default: 80)"),
      searchStep: z.coerce.number().optional().describe("Auto-placement search step size"),
      maxHeightDelta: z.coerce.number().optional().describe("Allowed terrain delta across the structural footprint during auto-placement (default: 4)"),
      maxManMadeColumns: z.coerce.number().optional().describe("Allowed man-made columns across the structural footprint during auto-placement (default: 0)"),
      waterBufferBlocks: z.coerce.number().optional().describe("Reject auto-placement sites too close to water (default: 1)"),
      stabilizeGravityBlocks: z.coerce.boolean().optional().describe("Replace falling concrete-powder/sand/gravel with stable equivalents before building (default: true)")
    },
    async (params: any) => {
      const autonomy = getLandmarkAutonomyService();
      const bot = getBot();
      const resolved = await resolveOtsBlockModelReference({
        filePath: params.filePath ? String(params.filePath) : undefined,
        modelName: params.modelName ? String(params.modelName) : undefined,
        title: params.title ? String(params.title) : undefined
      });
      const compiled = await compileOtsBlockModelGraphWithPlacement(bot, autonomy, {
        prompt: `Build local OTS block model ${resolved.title}`,
        filePath: resolved.filePath,
        title: resolved.title,
        sourceRef: resolved.resolvedVia === 'registry'
          ? `registry:${resolved.id ?? resolved.title}`
          : resolved.filePath,
        sourceId: resolved.id,
        targetDurationMinutes: params.targetDurationMinutes != null
          ? toInt(params.targetDurationMinutes)
          : undefined,
        originX: toInt(params.originX),
        originZ: toInt(params.originZ),
        baseY: params.baseY == null ? undefined : toInt(params.baseY),
        autoPlace: params.autoPlace == null ? undefined : Boolean(params.autoPlace),
        searchRadius: params.searchRadius == null ? undefined : toInt(params.searchRadius),
        searchStep: params.searchStep == null ? undefined : toInt(params.searchStep),
        maxHeightDelta: params.maxHeightDelta == null ? undefined : toInt(params.maxHeightDelta),
        maxManMadeColumns: params.maxManMadeColumns == null ? undefined : toInt(params.maxManMadeColumns),
        waterBufferBlocks: params.waterBufferBlocks == null ? undefined : toInt(params.waterBufferBlocks),
        stabilizeGravityBlocks: params.stabilizeGravityBlocks == null ? undefined : Boolean(params.stabilizeGravityBlocks)
      });
      const graph = compiled.graph;
      const readyPackets = graph.nodes
        .filter((node) => node.status === 'ready')
        .slice(0, 6)
        .map((node) => (
          `${node.assignedWorker}:${node.taskId}:${node.toolPlan.primaryTool}:${node.zoneId}`
        ));
      const readyWorkers = Array.from(new Set(
        graph.nodes
          .filter((node) => node.status === 'ready')
          .map((node) => node.assignedWorker)
      ));

      return factory.createResponse(
        `Mission plan ready. selectedSource=ots-blocks selectedSpec=${graph.specId} selectedName="${graph.specName}" ` +
        `resolution=${resolved.resolvedVia} selectedModelId=${resolved.id ?? 'ad-hoc'} matchedAlias="${resolved.matchedAlias ?? resolved.title}" ` +
        `graphId=${graph.graphId} tasks=${graph.nodes.length} blockBudget=${graph.expectedBlocks}. ${compiled.placementSummary}\n` +
        `readyWorkers=${readyWorkers.join(',') || 'none'} readyPackets=${readyPackets.join(' | ') || 'none'}`
      );
    }
  );

  // 18. compile-landmark-build-graph
  factory.registerTool(
    "plan-local-structure-mission",
    "Import a local world-save zip or world directory, isolate the dominant structure, auto-place it on valid land, compile exact shard packets, and emit a worker-ready graph for the orchestrator.",
    {
      filePath: z.string().min(1).optional().describe("Optional absolute path to a local .zip world save or extracted Minecraft world directory"),
      structureName: z.string().min(1).optional().describe("Optional registered local structure name or alias, e.g. 'local Leaning Tower of Pisa'"),
      title: z.string().optional().describe("Optional display title for the imported structure"),
      sourceVersion: z.string().optional().describe("Minecraft version used to read the source world (default: 1.13.2)"),
      originX: z.coerce.number().describe("Requested build origin X"),
      originZ: z.coerce.number().describe("Requested build origin Z"),
      targetDurationMinutes: z.coerce.number().optional().describe("Target autonomy runtime in minutes (default: 30)"),
      baseY: z.coerce.number().optional().describe("Optional explicit base Y. If omitted, sampled from terrain."),
      autoPlace: z.coerce.boolean().optional().describe("Auto-pick the nearest usable dry site for the imported structure footprint (default: true)"),
      searchRadius: z.coerce.number().optional().describe("Auto-placement search radius around requested origin (default: 80)"),
      searchStep: z.coerce.number().optional().describe("Auto-placement search step size"),
      maxHeightDelta: z.coerce.number().optional().describe("Allowed terrain delta across the structural footprint during auto-placement (default: 4)"),
      maxManMadeColumns: z.coerce.number().optional().describe("Allowed man-made columns across the structural footprint during auto-placement (default: 0)"),
      waterBufferBlocks: z.coerce.number().optional().describe("Reject auto-placement sites too close to water (default: 1)")
    },
    async (params: any) => {
      const autonomy = getLandmarkAutonomyService();
      const bot = getBot();
      const resolved = await resolveLocalStructureReference({
        filePath: params.filePath ? String(params.filePath) : undefined,
        structureName: params.structureName ? String(params.structureName) : undefined,
        title: params.title ? String(params.title) : undefined,
        sourceVersion: params.sourceVersion ? String(params.sourceVersion) : undefined
      });
      const compiled = await compileLocalStructureGraphWithPlacement(bot, autonomy, {
        prompt: `Build local structure ${resolved.title}`,
        filePath: resolved.filePath,
        title: resolved.title,
        sourceVersion: resolved.sourceVersion,
        sourceRef: resolved.resolvedVia === 'registry'
          ? `registry:${resolved.id ?? resolved.title}`
          : resolved.filePath,
        targetDurationMinutes: params.targetDurationMinutes != null
          ? toInt(params.targetDurationMinutes)
          : undefined,
        originX: toInt(params.originX),
        originZ: toInt(params.originZ),
        baseY: params.baseY == null ? undefined : toInt(params.baseY),
        autoPlace: params.autoPlace == null ? undefined : Boolean(params.autoPlace),
        searchRadius: params.searchRadius == null ? undefined : toInt(params.searchRadius),
        searchStep: params.searchStep == null ? undefined : toInt(params.searchStep),
        maxHeightDelta: params.maxHeightDelta == null ? undefined : toInt(params.maxHeightDelta),
        maxManMadeColumns: params.maxManMadeColumns == null ? undefined : toInt(params.maxManMadeColumns),
        waterBufferBlocks: params.waterBufferBlocks == null ? undefined : toInt(params.waterBufferBlocks)
      });
      const graph = compiled.graph;
      const readyPackets = graph.nodes
        .filter((node) => node.status === 'ready')
        .slice(0, 6)
        .map((node) => (
          `${node.assignedWorker}:${node.taskId}:${node.toolPlan.primaryTool}:${node.zoneId}`
        ));
      const readyWorkers = Array.from(new Set(
        graph.nodes
          .filter((node) => node.status === 'ready')
          .map((node) => node.assignedWorker)
      ));

      return factory.createResponse(
        `Mission plan ready. selectedSource=local-archive selectedSpec=${graph.specId} selectedName="${graph.specName}" ` +
        `resolution=${resolved.resolvedVia} selectedStructureId=${resolved.id ?? 'ad-hoc'} matchedAlias="${resolved.matchedAlias ?? resolved.title}" ` +
        `graphId=${graph.graphId} tasks=${graph.nodes.length} blockBudget=${graph.expectedBlocks}. ${compiled.placementSummary}\n` +
        `readyWorkers=${readyWorkers.join(',') || 'none'} readyPackets=${readyPackets.join(' | ') || 'none'}`
      );
    }
  );

  // 18. compile-landmark-build-graph
  factory.registerTool(
    "compile-landmark-build-graph",
    "Compile a landmark build graph from a selected spec. By default this auto-picks the nearest usable dry site for the whole landmark footprint before building.",
    {
      specId: z.string().min(1).describe("Landmark spec id from select-landmark-spec"),
      originX: z.coerce.number().describe("Build origin X"),
      originZ: z.coerce.number().describe("Build origin Z"),
      scale: z.string().optional().describe("Scale variant (small/medium/large or custom key)"),
      stylePreset: z.string().optional().describe("Optional style preset key from selected spec"),
      prompt: z.string().optional().describe("Optional original mission prompt for parametric adaptation"),
      targetDurationMinutes: z.coerce.number().optional().describe("Target autonomy runtime in minutes (default: 30)"),
      baseY: z.coerce.number().optional().describe("Optional explicit base Y. If omitted, sampled from terrain."),
      autoPlace: z.coerce.boolean().optional().describe("Auto-pick the nearest usable dry site for the landmark footprint (default: true)"),
      searchRadius: z.coerce.number().optional().describe("Auto-placement search radius around requested origin (default: 96)"),
      searchStep: z.coerce.number().optional().describe("Auto-placement search step size (default: 4)"),
      maxHeightDelta: z.coerce.number().optional().describe("Allowed terrain delta across the structural footprint during auto-placement (default: 3)"),
      maxManMadeColumns: z.coerce.number().optional().describe("Allowed man-made columns across the structural footprint during auto-placement (default: 0)"),
      waterBufferBlocks: z.coerce.number().optional().describe("Reject auto-placement sites too close to water (default: 1)")
    },
    async (params: any) => {
      const autonomy = getLandmarkAutonomyService();
      const bot = getBot();
      const prompt = params.prompt ? String(params.prompt) : undefined;
      const compiled = await compileLandmarkGraphWithPlacement(bot, autonomy, {
        specId: String(params.specId),
        originX: toInt(params.originX),
        originZ: toInt(params.originZ),
        scale: params.scale ? String(params.scale) : undefined,
        stylePreset: params.stylePreset ? String(params.stylePreset) : undefined,
        prompt,
        targetDurationMinutes: params.targetDurationMinutes != null
          ? toInt(params.targetDurationMinutes)
          : undefined,
        baseY: params.baseY == null ? undefined : toInt(params.baseY),
        autoPlace: params.autoPlace == null ? undefined : Boolean(params.autoPlace),
        searchRadius: params.searchRadius == null ? undefined : toInt(params.searchRadius),
        searchStep: params.searchStep == null ? undefined : toInt(params.searchStep),
        maxHeightDelta: params.maxHeightDelta == null ? undefined : toInt(params.maxHeightDelta),
        maxManMadeColumns: params.maxManMadeColumns == null ? undefined : toInt(params.maxManMadeColumns),
        waterBufferBlocks: params.waterBufferBlocks == null ? undefined : toInt(params.waterBufferBlocks)
      });
      const graph = compiled.graph;

      const lines = graph.nodes.map((node) => (
        `${node.taskId} owner=${node.assignedOwner} role=${node.role} tool=${node.toolPlan.primaryTool} ` +
        `deps=${node.dependencies.join(',') || 'none'} zone=${node.zoneId} budget=${node.expectedBlocks}`
      ));

      return factory.createResponse(
        `Compiled graph ${graph.graphId} from spec=${graph.specId} style=${graph.stylePreset} scale=${graph.scale} ` +
        `origin=(${graph.originX},${graph.baseY},${graph.originZ}) tasks=${graph.nodes.length} ` +
        `blockBudget=${graph.expectedBlocks} targetMinutes=${graph.targetDurationMinutes}. ${compiled.placementSummary}\n` +
        lines.join('\n')
      );
    }
  );

  // 16. allocate-build-graph-zones
  factory.registerTool(
    "allocate-build-graph-zones",
    "Atomically pre-allocate all zones for a compiled landmark graph before workers execute in parallel.",
    {
      graphId: z.string().min(1).describe("Build graph id"),
      clearExistingForOwners: z.coerce.boolean().optional().describe("Clear prior claims for graph owners (default: true)"),
      ttlSeconds: z.coerce.number().optional().describe("Reservation TTL in seconds (default: 1800)")
    },
    async (params: any) => {
      const autonomy = getLandmarkAutonomyService();
      const owner = requireOrchestratorReservationControl(getOwner(), 'allocate-build-graph-zones');
      const graphId = String(params.graphId);
      const clearExistingForOwners = params.clearExistingForOwners == null
        ? true
        : Boolean(params.clearExistingForOwners);
      const ttlSeconds = params.ttlSeconds == null ? 1800 : toInt(params.ttlSeconds);

      const allocated = await autonomy.allocateBuildGraphZones(
        graphId,
        clearExistingForOwners,
        ttlSeconds
      );

      for (const node of allocated.graph.nodes) {
        await coordinationStore.reportProgress({
          taskId: allocated.graph.graphId,
          zoneId: node.zoneId,
          owner,
          phase: 'allocated',
          note: `component=${node.componentId} assigned=${node.assignedOwner}`
        });
      }

      const claimLines = allocated.claims.map((claim) => (
        `${claim.zoneId} assignedTo=${claim.owner} bounds=${formatBounds(claim)}`
      ));

      return factory.createResponse(
        `${allocated.message} graph=${allocated.graph.graphId} status=${allocated.graph.graphStatus}. ` +
        `Claims=${allocated.claims.length}.\n${claimLines.join('\n')}`
      );
    }
  );

  // 16. dispatch-next-task
  factory.registerTool(
    "dispatch-next-task",
    "Scheduler dispatch: assign the next ready task packet to a worker from a pre-allocated build graph.",
    {
      graphId: z.string().min(1).describe("Build graph id"),
      workerId: z.string().min(1).describe("Worker/agent id"),
    },
    async (params: any) => {
      const autonomy = getLandmarkAutonomyService();
      const graphId = String(params.graphId);
      const workerId = String(params.workerId);
      const dispatch = await autonomy.dispatchNextTask(graphId, workerId);

      if (!dispatch.task) {
        return factory.createResponse(
          `Dispatch idle for worker=${workerId}. graph=${dispatch.graphId} status=${dispatch.graphStatus} ` +
          `completion=${Math.round(dispatch.completionRatio * 100)}%. ${dispatch.message}`
        );
      }

      const task = dispatch.task;
      const paramsJson = JSON.stringify(task.toolPlan.params);
      const delegateTool = peerToolNameForWorker(task.assignedWorker);
      return factory.createResponse(
        `Dispatch ready for worker=${workerId}: ${formatDispatchTask(task)}\n` +
        `delegate_tool=${delegateTool}\n` +
        `execute_tool=${task.toolPlan.primaryTool} execute_params=${paramsJson}\n` +
        `note=${task.toolPlan.note}\n` +
        `graphStatus=${dispatch.graphStatus} completion=${Math.round(dispatch.completionRatio * 100)}%`
      );
    }
  );

  // 17. update-task-status
  factory.registerTool(
    "update-task-status",
    "Scheduler update: update task execution status for a build graph task.",
    {
      graphId: z.string().min(1).describe("Build graph id"),
      taskId: z.string().min(1).describe("Task id in the graph"),
      status: z.enum(['ready', 'in_progress', 'blocked', 'done', 'failed', 'repair', 'completed']).describe("New task status"),
      note: z.string().optional().describe("Optional status note"),
      blocksPlaced: z.coerce.number().optional().describe("Optional blocks placed count for this task")
    },
    async (params: any) => {
      const autonomy = getLandmarkAutonomyService();
      const owner = getOwner();
      const graphId = String(params.graphId);
      const taskId = String(params.taskId);
      const status = String(params.status) as
        | 'ready'
        | 'in_progress'
        | 'blocked'
        | 'done'
        | 'failed'
        | 'repair'
        | 'completed';
      const note = params.note ? String(params.note) : undefined;
      const blocksPlaced = params.blocksPlaced == null ? undefined : Math.max(0, toInt(params.blocksPlaced));

      const graph = await autonomy.updateTaskStatus(
        graphId,
        taskId,
        status,
        note,
        blocksPlaced
      );

      const node = graph.nodes.find((entry) => entry.taskId === taskId);
      if (node) {
        await coordinationStore.reportProgress({
          taskId: graph.graphId,
          zoneId: node.zoneId,
          owner,
          phase: `task:${node.status}`,
          note
        });
      }

      const doneCount = graph.nodes.filter((entry) => entry.status === 'done').length;
      return factory.createResponse(
        `Task status updated: graph=${graph.graphId} task=${taskId} status=${status} graphStatus=${graph.graphStatus} ` +
        `done=${doneCount}/${graph.nodes.length} blocks=${graph.placedBlocks}/${graph.expectedBlocks}`
      );
    }
  );

  // 18. inspect-build-graph
  factory.registerTool(
    "inspect-build-graph",
    "Inspector view for landmark autonomy graphs with KPIs by component role and worker.",
    {
      graphId: z.string().min(1).describe("Build graph id"),
    },
    async (params: any) => {
      const autonomy = getLandmarkAutonomyService();
      const inspection = await autonomy.inspectBuildGraph(String(params.graphId));
      const componentPct = Math.round(inspection.completionRatio * 1000) / 10;
      const blockPct = inspection.expectedBlocks > 0
        ? Math.round((inspection.placedBlocks / inspection.expectedBlocks) * 1000) / 10
        : 0;

      const roleLines = inspection.roleSummary
        .map((entry) => `- role=${entry.role} done=${entry.done}/${entry.total}`)
        .join('\n');
      const workerLines = inspection.workerSummary
        .map((entry) => `- worker=${entry.owner} done=${entry.done} active=${entry.active} blocked=${entry.blocked}`)
        .join('\n');

      return factory.createResponse(
        `Graph ${inspection.graphId} status=${inspection.graphStatus}. ` +
        `componentsDone=${componentPct}% (target=${Math.round(inspection.completionTarget * 100)}%), ` +
        `blocksPlaced=${inspection.placedBlocks}/${inspection.expectedBlocks} (${blockPct}%), ` +
        `criticalPathEta=${inspection.criticalPathEtaMinutes}m, repairBacklog=${inspection.repairBacklog}.\n` +
        `By component:\n${roleLines || '- none'}\nBy worker:\n${workerLines || '- none'}`
      );
    }
  );

  // 19. repair-build-graph
  factory.registerTool(
    "repair-build-graph",
    "Schedule targeted repair tasks on failed/blocked graph nodes with a block budget.",
    {
      graphId: z.string().min(1).describe("Build graph id"),
      budgetBlocks: z.coerce.number().optional().describe("Repair budget in blocks (default: 600)")
    },
    async (params: any) => {
      const autonomy = getLandmarkAutonomyService();
      const owner = getOwner();
      const graphId = String(params.graphId);
      const budgetBlocks = params.budgetBlocks == null ? 600 : toInt(params.budgetBlocks);
      const repair = await autonomy.repairBuildGraph(graphId, budgetBlocks);

      for (const node of repair.repairTasks) {
        await coordinationStore.reportProgress({
          taskId: repair.graph.graphId,
          zoneId: node.zoneId,
          owner,
          phase: 'repair',
          note: node.note
        });
      }

      if (repair.repairTasks.length === 0) {
        return factory.createResponse(
          `Repair queue unchanged for graph=${repair.graph.graphId}. ${repair.message}`
        );
      }

      const lines = repair.repairTasks.map((node) => (
        `${node.taskId} owner=${node.assignedOwner} zone=${node.zoneId} budgetTarget=${node.expectedBlocks - node.blocksPlaced}`
      ));
      return factory.createResponse(
        `${repair.message} graph=${repair.graph.graphId} status=${repair.graph.graphStatus}.\n` +
        lines.join('\n')
      );
    }
  );

  // 20. check-phase-gate
  factory.registerTool(
    "check-phase-gate",
    "Relay-build helper: verify that a required phase exists for a zone before next handoff.",
    {
      taskId: z.string().min(1).describe("Task identifier"),
      zoneId: z.string().min(1).describe("Zone/house identifier"),
      requiredPhase: z.string().min(1).describe("Required prior phase"),
    },
    async (params: any) => {
      const taskId = String(params.taskId);
      const zoneId = String(params.zoneId);
      const requiredPhase = String(params.requiredPhase);
      const events = (await coordinationStore.getProgressBoard(taskId)).map((entry) => ({
        zoneId: entry.zoneId,
        phase: entry.phase,
        timestamp: entry.timestamp
      }));

      const allowed = zoneHasPhase(events, zoneId, requiredPhase);
      const latest = latestZonePhase(events, zoneId);

      if (!allowed) {
        return factory.createResponse(
          `PHASE-GATE BLOCKED for ${zoneId}: missing required phase '${requiredPhase}'. ` +
          `Latest phase=${latest?.phase ?? 'none'}`
        );
      }

      return factory.createResponse(
        `PHASE-GATE OPEN for ${zoneId}: required phase '${requiredPhase}' found. ` +
        `Latest phase=${latest?.phase ?? 'none'}`
      );
    }
  );

  // 21. relay-handoff
  factory.registerTool(
    "relay-handoff",
    "Relay-build helper: record an explicit handoff between agents with structured note.",
    {
      taskId: z.string().min(1).describe("Task identifier"),
      zoneId: z.string().min(1).describe("Zone/house identifier"),
      toAgent: z.string().min(1).describe("Receiving agent name"),
      note: z.string().optional().describe("Optional handoff artifact/note"),
    },
    async (params: any) => {
      const bot = getBot();
      const owner = getOwner();
      const taskId = String(params.taskId);
      const zoneId = String(params.zoneId);
      const toAgent = String(params.toAgent).trim();
      const note = params.note ? String(params.note) : undefined;
      const phase = `handoff:${toAgent}`;
      const entry = await coordinationStore.reportProgress({
        taskId,
        zoneId,
        owner,
        phase,
        note
      });

      bot.chat(
        `[handoff][${taskId}] ${zoneId}: ${owner} -> ${toAgent}` +
        (note ? ` (${note})` : '')
      );

      return factory.createResponse(
        `Handoff recorded at ${nowIsoTimestamp(entry.timestamp)}: ${zoneId} ${owner} -> ${toAgent}` +
        (note ? ` (${note})` : '')
      );
    }
  );

  // 14. place-block
  factory.registerTool(
    "place-block",
    "Place a single block at specific coordinates. Requires an active claimed zone.",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      blockType: z.string().describe("Block type (e.g., 'stone', 'oak_planks', 'lantern')"),
    },
    async (params: any) => {
      const bot = getBot();
      const owner = getOwner();
      const x = toInt(params.x);
      const y = toInt(params.y);
      const zCoord = toInt(params.z);
      const blockType = normalizeBlockType(String(params.blockType));
      const bounds = normalizeBounds(x, y, zCoord, x, y, zCoord);

      await enforceMutatingOperationGuard(
        bot,
        owner,
        bounds,
        1,
        isAirBlockType(blockType) ? 1 : 0
      );

      await placementQueue.enqueueCommands(
        [`/setblock ${x} ${y} ${zCoord} ${blockType}`],
        (command) => runServerCommand(bot, command),
        BLOCK_QUEUE_DELAY_MS
      );
      await autoCompleteGraphTaskForMutation(
        owner,
        bounds,
        `Placed ${blockType} at (${x}, ${y}, ${zCoord})`,
        1
      );

      return factory.createResponse(`Placed ${blockType} at (${x}, ${y}, ${zCoord})`);
    }
  );

  factory.registerTool(
    "place-catalog-shard",
    "Place one exact imported model shard from a freshly imported placement artifact. Requires an active claimed zone.",
    {
      placementFile: z.string().min(1).describe("Absolute path to a catalog-placement-plan artifact"),
      shardId: z.string().min(1).describe("Shard id inside the placement artifact")
    },
    async (params: any) => {
      const bot = getBot();
      const owner = getOwner();
      const placementFile = path.resolve(String(params.placementFile));
      const shardId = String(params.shardId);
      const raw = await fs.readFile(placementFile, 'utf8');
      const artifact = JSON.parse(raw) as CatalogPlacementArtifact;

      if (artifact.kind !== 'catalog-placement-plan') {
        throw new Error(
          `Expected a catalog-placement-plan artifact, got '${String((artifact as { kind?: string }).kind ?? 'unknown')}'.`
        );
      }

      const shard = artifact.shards.find((entry) => entry.shardId === shardId);
      if (!shard) {
        throw new Error(`Shard '${shardId}' was not found in ${placementFile}.`);
      }
      if (shard.blocks.length === 0) {
        throw new Error(`Shard '${shardId}' contains no translated blocks.`);
      }

      const bounds = normalizeBounds(
        shard.bounds.minX,
        shard.bounds.minY,
        shard.bounds.minZ,
        shard.bounds.maxX,
        shard.bounds.maxY,
        shard.bounds.maxZ
      );
      await enforceReservationOnly(owner, bounds);

      const cinematicBatches = splitPlacementBlocksForSafeCinematicBatches(
        shard.blocks,
        CATALOG_RCON_BATCH_SIZE
      );
      const forceloadAdd = `/forceload add ${bounds.minX} ${bounds.minZ} ${bounds.maxX} ${bounds.maxZ}`;
      const forceloadRemove = `/forceload remove ${bounds.minX} ${bounds.minZ} ${bounds.maxX} ${bounds.maxZ}`;
      const clearBlockingEntities =
        `/kill @e[type=!player,x=${bounds.minX},y=${Math.max(0, bounds.minY - 2)},z=${bounds.minZ},` +
        `dx=${bounds.maxX - bounds.minX},dy=${bounds.maxY - bounds.minY + 4},dz=${bounds.maxZ - bounds.minZ}]`;
      let movementSteps = 0;

      await streamRconCommands([forceloadAdd], PROJECT_ROOT_DIR);
      try {
        await streamRconCommands([clearBlockingEntities], PROJECT_ROOT_DIR);
        for (let batchIndex = 0; batchIndex < cinematicBatches.length; batchIndex += 1) {
          const batchBlocks = cinematicBatches[batchIndex];
          const batchBounds = boundsForPlacementBlocks(batchBlocks);
          validateSafetyLimits({
            bounds: batchBounds,
            plannedOperations: batchBlocks.length,
            plannedAirOperations: 0
          }, CATALOG_BATCH_SAFETY_LIMITS);
          await enforceReservationOnly(owner, batchBounds);

          const moved = await animateBotForPlacementBatch(bot, bounds, batchBounds, batchIndex);
          if (moved) {
            movementSteps += 1;
          }

          await streamRconCommands(
            batchBlocks.map((block) => `/setblock ${block.x} ${block.y} ${block.z} ${block.blockState}`),
            PROJECT_ROOT_DIR
          );

          if (CATALOG_CINEMATIC_BATCH_DELAY_MS > 0) {
            await delay(CATALOG_CINEMATIC_BATCH_DELAY_MS);
          }
        }
      } finally {
        try {
          await streamRconCommands([forceloadRemove], PROJECT_ROOT_DIR);
        } catch (error) {
          log('warn', `Failed to remove model forceload for ${shardId}: ${formatError(error)}`);
        }
      }

      await autoCompleteGraphTaskForMutation(
        owner,
        bounds,
        `Placed exact imported model shard ${shardId} from ${artifact.source.title}`,
        shard.blockCount
      );

      return factory.createResponse(
        `Placed exact imported model shard ${shardId} from "${artifact.source.title}" ` +
        `blocks=${shard.blockCount} safeBatches=${cinematicBatches.length} movementSteps=${movementSteps} bounds=${formatBounds(bounds)} ` +
        `source=${artifact.source.pageUrl}`
      );
    }
  );

  // 12. build-decorated-house
  factory.registerTool(
    "build-decorated-house",
    "Build a decorated flat-roof house with a solid block roof, block-by-block on nearby flat land (never water). Requires an active claimed zone.",
    {
      x: z.coerce.number().describe("House center X coordinate"),
      z: z.coerce.number().describe("House center Z coordinate"),
      style: z.string().optional().describe("Style: 'oak', 'spruce', 'birch', 'stone' (default: oak)"),
    },
    async (params: any) => {
      const bot = getBot();
      const owner = getOwner();
      const requestedCenterX = toInt(params.x);
      const requestedCenterZ = toInt(params.z);
      const style = String(params.style || 'oak').toLowerCase();
      const {
        wallMaterial,
        logMaterial,
        roofMaterial,
        doorMaterial
      } = houseMaterialsForStyle(style);

      const width = 7;
      const depth = 7;
      const wallHeight = 4;
      const halfWidth = Math.floor(width / 2);
      const halfDepth = Math.floor(depth / 2);

      let centerX = requestedCenterX;
      let centerZ = requestedCenterZ;
      let baseY = 64;
      let selectedBounds: BoundingBox | null = null;
      let selectedReason = '';

      for (const offset of candidateOffsets(HOUSE_SITE_SEARCH_RADIUS, HOUSE_SITE_SEARCH_STEP)) {
        const candidateCenterX = requestedCenterX + offset.dx;
        const candidateCenterZ = requestedCenterZ + offset.dz;
        const candidateX1 = candidateCenterX - halfWidth;
        const candidateX2 = candidateX1 + width - 1;
        const candidateZ1 = candidateCenterZ - halfDepth;
        const candidateZ2 = candidateZ1 + depth - 1;

        const site = await evaluateHouseSite(
          bot,
          candidateCenterX,
          candidateCenterZ,
          halfWidth,
          halfDepth
        );
        if (!site.ok) {
          selectedReason = site.reason ?? 'site rejected';
          continue;
        }

        const candidateBounds = normalizeBounds(
          candidateX1,
          site.baseY - 1,
          candidateZ1,
          candidateX2,
          site.baseY + wallHeight + 2,
          candidateZ2
        );

        const reservationCheck = await coordinationStore.verifyReservation(owner, candidateBounds);
        if (!reservationCheck.ok) {
          selectedReason = reservationCheck.message;
          continue;
        }

        centerX = candidateCenterX;
        centerZ = candidateCenterZ;
        baseY = site.baseY;
        selectedBounds = candidateBounds;
        break;
      }

      if (!selectedBounds) {
        throw new Error(
          `Could not find a valid flat house site near (${requestedCenterX},${requestedCenterZ}). ` +
          `Last reason: ${selectedReason || 'unknown'}`
        );
      }

      const x1 = centerX - halfWidth;
      const x2 = x1 + width - 1;
      const z1 = centerZ - halfDepth;
      const z2 = z1 + depth - 1;
      const roofY = baseY + wallHeight + 1;
      const doorX = x1 + Math.floor(width / 2);

      const bounds = selectedBounds;
      const commands: string[] = [];

      // Foundation + floor
      for (let x = x1; x <= x2; x++) {
        for (let zCoord = z1; zCoord <= z2; zCoord++) {
          commands.push(`/setblock ${x} ${baseY - 1} ${zCoord} minecraft:cobblestone`);
          commands.push(`/setblock ${x} ${baseY} ${zCoord} ${wallMaterial}`);
          if (x > x1 && x < x2 && zCoord > z1 && zCoord < z2) {
            commands.push(`/setblock ${x} ${baseY + 1} ${zCoord} minecraft:red_carpet`);
          }
        }
      }

      // Walls and corners
      for (let y = baseY + 1; y <= baseY + wallHeight; y++) {
        for (let x = x1; x <= x2; x++) {
          commands.push(`/setblock ${x} ${y} ${z1} ${wallMaterial}`);
          commands.push(`/setblock ${x} ${y} ${z2} ${wallMaterial}`);
        }
        for (let zCoord = z1; zCoord <= z2; zCoord++) {
          commands.push(`/setblock ${x1} ${y} ${zCoord} ${wallMaterial}`);
          commands.push(`/setblock ${x2} ${y} ${zCoord} ${wallMaterial}`);
        }
        commands.push(`/setblock ${x1} ${y} ${z1} ${logMaterial}`);
        commands.push(`/setblock ${x1} ${y} ${z2} ${logMaterial}`);
        commands.push(`/setblock ${x2} ${y} ${z1} ${logMaterial}`);
        commands.push(`/setblock ${x2} ${y} ${z2} ${logMaterial}`);
      }

      // Solid flat roof
      for (let x = x1; x <= x2; x++) {
        for (let zCoord = z1; zCoord <= z2; zCoord++) {
          commands.push(`/setblock ${x} ${roofY} ${zCoord} ${roofMaterial}`);
        }
      }
      // Low parapet for a cleaner flat-roof silhouette.
      for (let x = x1; x <= x2; x++) {
        commands.push(`/setblock ${x} ${roofY + 1} ${z1} ${wallMaterial}`);
        commands.push(`/setblock ${x} ${roofY + 1} ${z2} ${wallMaterial}`);
      }
      for (let zCoord = z1; zCoord <= z2; zCoord++) {
        commands.push(`/setblock ${x1} ${roofY + 1} ${zCoord} ${wallMaterial}`);
        commands.push(`/setblock ${x2} ${roofY + 1} ${zCoord} ${wallMaterial}`);
      }

      // Door + windows + decorations
      commands.push(`/setblock ${doorX} ${baseY + 1} ${z1} minecraft:air`);
      commands.push(`/setblock ${doorX} ${baseY + 2} ${z1} minecraft:air`);
      commands.push(`/setblock ${doorX} ${baseY + 1} ${z1} ${doorMaterial}[half=lower,facing=south]`);
      commands.push(`/setblock ${doorX} ${baseY + 2} ${z1} ${doorMaterial}[half=upper,facing=south]`);
      commands.push(`/setblock ${doorX - 2} ${baseY + 2} ${z1} minecraft:glass_pane`);
      commands.push(`/setblock ${doorX + 2} ${baseY + 2} ${z1} minecraft:glass_pane`);
      commands.push(`/setblock ${x1} ${baseY + 2} ${z1 + 3} minecraft:glass_pane`);
      commands.push(`/setblock ${x2} ${baseY + 2} ${z1 + 3} minecraft:glass_pane`);
      commands.push(`/setblock ${doorX - 1} ${baseY + 3} ${z1 + 1} minecraft:lantern`);
      commands.push(`/setblock ${doorX + 1} ${baseY + 3} ${z1 + 1} minecraft:lantern`);
      commands.push(`/setblock ${centerX} ${baseY + wallHeight} ${centerZ} minecraft:lantern[hanging=true]`);

      const plannedAirOperations = countAirCommands(commands);
      await enforceMutatingOperationGuard(bot, owner, bounds, commands.length, plannedAirOperations);
      const placementContext = createPlacementExecutionContext(true);

      await placementQueue.enqueueCommands(
        commands,
        (command) => runServerCommand(bot, command, placementContext),
        BLOCK_QUEUE_DELAY_MS
      );
      await autoCompleteGraphTaskForMutation(
        owner,
        bounds,
        `Built ${style} solid-roof flat house at (${centerX}, ${baseY}, ${centerZ})`,
        commands.length
      );

      return factory.createResponse(
        `Built ${style} solid-roof flat house at (${centerX}, ${baseY}, ${centerZ}) with ${commands.length} block-by-block edits` +
        (centerX !== requestedCenterX || centerZ !== requestedCenterZ
          ? ` (adjusted from requested center ${requestedCenterX},${requestedCenterZ} to find flat safe ground)`
          : '')
      );
    }
  );

  // 13. fill-region
  factory.registerTool(
    "fill-region",
    "Fill a rectangular region in small visible patch fills. Requires an active claimed zone.",
    {
      x1: z.coerce.number().describe("Start X"),
      y1: z.coerce.number().describe("Start Y"),
      z1: z.coerce.number().describe("Start Z"),
      x2: z.coerce.number().describe("End X"),
      y2: z.coerce.number().describe("End Y"),
      z2: z.coerce.number().describe("End Z"),
      blockType: z.string().describe("Block type (use 'air' for controlled deletion)"),
    },
    async (params: any) => {
      const bot = getBot();
      const owner = getOwner();
      const normalizedBlockType = normalizeBlockType(String(params.blockType));
      const bounds = normalizeBounds(
        toInt(params.x1),
        toInt(params.y1),
        toInt(params.z1),
        toInt(params.x2),
        toInt(params.y2),
        toInt(params.z2)
      );
      const plannedOperations = getVolume(bounds);
      const airOps = normalizedBlockType === 'minecraft:air' ? plannedOperations : 0;
      const batches = buildFillBatches(bounds, normalizedBlockType, FILL_BATCH_TILE_SPAN);

      await enforceMutatingOperationGuard(bot, owner, bounds, plannedOperations, airOps);
      await runFillBatches(bot, bounds, batches);
      await autoCompleteGraphTaskForMutation(
        owner,
        bounds,
        `Filled region ${formatBounds(bounds)} with ${normalizedBlockType}`,
        plannedOperations
      );

      return factory.createResponse(
        `Filled region ${formatBounds(bounds)} with ${normalizedBlockType} using ${plannedOperations} block edits across ${batches.length} patch fills`
      );
    }
  );

  // 14. flatten-area
  factory.registerTool(
    "flatten-area",
    "Gently flatten terrain block-by-block with strict safety limits (small grading only). Requires an active claimed zone.",
    {
      x1: z.coerce.number().describe("Start X"),
      z1: z.coerce.number().describe("Start Z"),
      x2: z.coerce.number().describe("End X"),
      z2: z.coerce.number().describe("End Z"),
      material: z.string().optional().describe("Surface material (default: grass_block)"),
      maxAdjustment: z.coerce.number().optional().describe("Maximum vertical blocks to raise/lower per column (default: 1, max: 2)"),
    },
    async (params: any) => {
      const bot = getBot();
      const owner = getOwner();
      const minX = Math.min(toInt(params.x1), toInt(params.x2));
      const maxX = Math.max(toInt(params.x1), toInt(params.x2));
      const minZ = Math.min(toInt(params.z1), toInt(params.z2));
      const maxZ = Math.max(toInt(params.z1), toInt(params.z2));
      const material = normalizeBlockType(String(params.material || 'grass_block'));
      const maxAdjustment = Math.max(0, Math.min(2, toInt(params.maxAdjustment ?? 1)));

      const samples: Array<{ x: number; z: number; groundY: number }> = [];
      let totalGroundY = 0;
      let minGroundY = Number.POSITIVE_INFINITY;
      let maxGroundY = Number.NEGATIVE_INFINITY;
      for (let x = minX; x <= maxX; x++) {
        for (let zCoord = minZ; zCoord <= maxZ; zCoord++) {
          const sample = await sampleLandColumn(bot, x, zCoord);
          if (!sample.ok) {
            throw new Error(
              `Cannot gently flatten non-land column at (${x},${zCoord}): ${sample.reason}`
            );
          }
          samples.push({ x, z: zCoord, groundY: sample.groundY });
          totalGroundY += sample.groundY;
          minGroundY = Math.min(minGroundY, sample.groundY);
          maxGroundY = Math.max(maxGroundY, sample.groundY);
        }
      }

      if (samples.length === 0) {
        throw new Error('No terrain samples found for flatten-area.');
      }

      const targetY = Math.round(totalGroundY / samples.length);
      const requiredAdjustment = samples.reduce(
        (maxDiff, sample) => Math.max(maxDiff, Math.abs(sample.groundY - targetY)),
        0
      );
      if (requiredAdjustment > maxAdjustment) {
        throw new Error(
          `Terrain too uneven for gentle flatten (needs ±${requiredAdjustment}, cap is ±${maxAdjustment}). ` +
          `Use a flatter area or increase maxAdjustment (max 2).`
        );
      }

      const bounds = normalizeBounds(
        minX,
        targetY - maxAdjustment,
        minZ,
        maxX,
        targetY + maxAdjustment + 1,
        maxZ
      );

      const commands: string[] = [];
      for (const sample of samples) {
        if (sample.groundY > targetY) {
          for (let y = sample.groundY; y > targetY; y--) {
            commands.push(`/setblock ${sample.x} ${y} ${sample.z} minecraft:air`);
          }
        } else if (sample.groundY < targetY) {
          for (let y = sample.groundY + 1; y < targetY; y++) {
            commands.push(`/setblock ${sample.x} ${y} ${sample.z} minecraft:dirt`);
          }
        }

        commands.push(`/setblock ${sample.x} ${targetY} ${sample.z} ${material}`);
      }

      const airOps = countAirCommands(commands);
      await enforceMutatingOperationGuard(bot, owner, bounds, commands.length, airOps);

      await placementQueue.enqueueCommands(
        commands,
        (command) => runServerCommand(bot, command),
        BLOCK_QUEUE_DELAY_MS
      );
      await autoCompleteGraphTaskForMutation(
        owner,
        bounds,
        `Flattened area (${minX},${minZ})-(${maxX},${maxZ}) to Y=${targetY}`,
        commands.length
      );

      return factory.createResponse(
        `Gently flattened area (${minX},${minZ})-(${maxX},${maxZ}) to Y=${targetY} with ${commands.length} block edits ` +
        `(terrain min=${minGroundY}, max=${maxGroundY}, requiredAdjustment=±${requiredAdjustment}, cap=±${maxAdjustment})`
      );
    }
  );

  // 17. simulate-storm-damage
  factory.registerTool(
    "simulate-storm-damage",
    "Storm-recovery demo tool: remove a limited number of upper structure blocks from a house footprint.",
    {
      x: z.coerce.number().describe("House center X coordinate"),
      z: z.coerce.number().describe("House center Z coordinate"),
      style: z.string().optional().describe("House style hint: oak/spruce/birch/stone (default: oak)"),
      width: z.coerce.number().optional().describe("Footprint width (default: 7)"),
      depth: z.coerce.number().optional().describe("Footprint depth (default: 7)"),
      damageBlocks: z.coerce.number().optional().describe("Number of blocks to remove (default: 18, max: 48)")
    },
    async (params: any) => {
      const bot = getBot();
      const owner = getOwner();
      const centerX = toInt(params.x);
      const centerZ = toInt(params.z);
      const style = String(params.style || 'oak').toLowerCase();
      const width = Math.max(3, Math.min(15, toInt(params.width ?? 7)));
      const depth = Math.max(3, Math.min(15, toInt(params.depth ?? 7)));
      const damageBlocks = Math.max(1, Math.min(MAX_STORM_DAMAGE_BLOCKS, toInt(params.damageBlocks ?? 18)));
      const baseY = await estimateHouseBaseY(bot, centerX, centerZ, width, depth);
      const expected = expectedFlatHouseBlocks(centerX, centerZ, baseY, style, width, depth);

      const uniqueByCoord = new Map<string, ExpectedBlock>();
      for (const block of expected) {
        if (block.y <= baseY + 1) {
          continue;
        }
        const key = `${block.x}:${block.y}:${block.z}`;
        if (!uniqueByCoord.has(key)) {
          uniqueByCoord.set(key, block);
        }
      }

      const candidates = Array.from(uniqueByCoord.values()).filter((block) => {
        const actual = bot.blockAt(new Vec3(block.x, block.y, block.z));
        return Boolean(actual && !isAirBlockName(actual.name) && classifyBlockNature(actual.name) === 'manmade');
      });

      if (candidates.length === 0) {
        throw new Error('No storm-damage candidates found in the target footprint.');
      }

      const shuffled = candidates
        .map((block) => ({
          block,
          weight: Math.abs((block.x * 1103515245 + block.y * 12345 + block.z * 2654435761) % 2147483647)
        }))
        .sort((a, b) => a.weight - b.weight)
        .map((entry) => entry.block);

      const selected = shuffled.slice(0, Math.min(damageBlocks, shuffled.length));
      const commands = selected.map((block) => `/setblock ${block.x} ${block.y} ${block.z} minecraft:air`);

      const minX = Math.min(...selected.map((block) => block.x));
      const maxX = Math.max(...selected.map((block) => block.x));
      const minY = Math.min(...selected.map((block) => block.y));
      const maxY = Math.max(...selected.map((block) => block.y));
      const minZ = Math.min(...selected.map((block) => block.z));
      const maxZ = Math.max(...selected.map((block) => block.z));
      const bounds = normalizeBounds(minX, minY, minZ, maxX, maxY, maxZ);

      await enforceMutatingOperationGuard(bot, owner, bounds, commands.length, commands.length);
      await placementQueue.enqueueCommands(
        commands,
        (command) => runServerCommand(bot, command),
        BLOCK_QUEUE_DELAY_MS
      );

      return factory.createResponse(
        `Storm damage simulated at (${centerX},${centerZ}) style=${style}: removed ${commands.length} blocks (baseY=${baseY}).`
      );
    }
  );

  // 18. inspect-house
  factory.registerTool(
    "inspect-house",
    "Inspector tool: evaluate a flat house with a solid roof and report defects + quality score.",
    {
      x: z.coerce.number().describe("House center X coordinate"),
      z: z.coerce.number().describe("House center Z coordinate"),
      style: z.string().optional().describe("Expected style: oak/spruce/birch/stone (default: oak)"),
      width: z.coerce.number().optional().describe("Footprint width (default: 7)"),
      depth: z.coerce.number().optional().describe("Footprint depth (default: 7)"),
      maxDefects: z.coerce.number().optional().describe("Maximum listed defects (default: 50)")
    },
    async (params: any) => {
      const bot = getBot();
      const centerX = toInt(params.x);
      const centerZ = toInt(params.z);
      const style = String(params.style || 'oak').toLowerCase();
      const width = Math.max(3, Math.min(15, toInt(params.width ?? 7)));
      const depth = Math.max(3, Math.min(15, toInt(params.depth ?? 7)));
      const maxDefects = Math.max(1, Math.min(200, toInt(params.maxDefects ?? 50)));

      const inspection = await inspectFlatHouse(
        bot,
        centerX,
        centerZ,
        style,
        width,
        depth,
        maxDefects
      );

      const sampleLines = inspection.defects
        .slice(0, 20)
        .map((defect) => (
          `- (${defect.x},${defect.y},${defect.z}) expected=${shortBlockName(defect.expected)} actual=${defect.actual}`
        ))
        .join('\n');

      return factory.createResponse(
        `House inspection at (${centerX},${centerZ}) style=${inspection.style}: score=${inspection.score}/100, ` +
        `defects=${inspection.defects.length}/${inspection.totalChecked}, baseY=${inspection.baseY}.\n` +
        (sampleLines.length > 0 ? `Defect samples:\n${sampleLines}` : 'No defects detected.')
      );
    }
  );

  // 19. repair-house
  factory.registerTool(
    "repair-house",
    "Repair tool: patch detected defects in a flat house with a solid roof, block-by-block inside reserved zone.",
    {
      x: z.coerce.number().describe("House center X coordinate"),
      z: z.coerce.number().describe("House center Z coordinate"),
      style: z.string().optional().describe("Expected style: oak/spruce/birch/stone (default: oak)"),
      width: z.coerce.number().optional().describe("Footprint width (default: 7)"),
      depth: z.coerce.number().optional().describe("Footprint depth (default: 7)"),
      maxRepairs: z.coerce.number().optional().describe("Maximum blocks to repair in this call (default: 120, max: 300)")
    },
    async (params: any) => {
      const bot = getBot();
      const owner = getOwner();
      const centerX = toInt(params.x);
      const centerZ = toInt(params.z);
      const style = String(params.style || 'oak').toLowerCase();
      const width = Math.max(3, Math.min(15, toInt(params.width ?? 7)));
      const depth = Math.max(3, Math.min(15, toInt(params.depth ?? 7)));
      const maxRepairs = Math.max(1, Math.min(MAX_REPAIR_BLOCKS, toInt(params.maxRepairs ?? 120)));

      const inspection = await inspectFlatHouse(
        bot,
        centerX,
        centerZ,
        style,
        width,
        depth,
        MAX_REPAIR_BLOCKS * 2
      );

      if (inspection.defects.length === 0) {
        return factory.createResponse(
          `No repairs needed at (${centerX},${centerZ}) style=${style}. Score=${inspection.score}/100`
        );
      }

      const selected = inspection.defects.slice(0, maxRepairs);
      const commands = selected.map((defect) => (
        `/setblock ${defect.x} ${defect.y} ${defect.z} ${normalizeBlockType(defect.expected)}`
      ));

      const minX = Math.min(...selected.map((defect) => defect.x));
      const maxX = Math.max(...selected.map((defect) => defect.x));
      const minY = Math.min(...selected.map((defect) => defect.y));
      const maxY = Math.max(...selected.map((defect) => defect.y));
      const minZ = Math.min(...selected.map((defect) => defect.z));
      const maxZ = Math.max(...selected.map((defect) => defect.z));
      const bounds = normalizeBounds(minX, minY, minZ, maxX, maxY, maxZ);

      await enforceMutatingOperationGuard(bot, owner, bounds, commands.length, 0);
      const placementContext = createPlacementExecutionContext(true);
      await placementQueue.enqueueCommands(
        commands,
        (command) => runServerCommand(bot, command, placementContext),
        BLOCK_QUEUE_DELAY_MS
      );

      const remaining = Math.max(0, inspection.defects.length - selected.length);
      return factory.createResponse(
        `Repaired ${selected.length} blocks at (${centerX},${centerZ}) style=${style}. ` +
        `Remaining defects (if any): ${remaining}`
      );
    }
  );

  // 20. generate-spec-from-template
  factory.registerTool(
    "generate-spec-from-template",
    "Generate a new landmark spec from a parametric template (tower, temple, bridge, castle, pyramid, statue, arena).",
    {
      templateType: z.enum(['tower', 'temple', 'bridge', 'castle', 'pyramid', 'statue', 'arena']).describe("Template type to use"),
      name: z.string().min(1).describe("Name for the generated landmark"),
      culture: z.string().min(1).describe("Culture/region (e.g., france, egypt, japan, greece)"),
      parameters: z.record(z.any()).optional().describe("Template-specific parameters as JSON object (optional)"),
      scale: z.enum(['small', 'medium', 'large']).optional().describe("Size scale (default: medium)"),
      stylePreset: z.string().optional().describe("Style preset name (default: 'default')")
    },
    async (params: any) => {
      const generator = getTemplateGeneratorService();
      const spec = await generator.generateSpecFromTemplate({
        templateType: String(params.templateType),
        name: String(params.name),
        culture: String(params.culture),
        parameters: params.parameters ? (params.parameters as Record<string, any>) : {},
        scale: params.scale ? String(params.scale) : undefined,
        stylePreset: params.stylePreset ? String(params.stylePreset) : undefined
      });

      const filePath = await generator.saveSpec(spec);
      return factory.createResponse(
        `Generated landmark spec '${spec.id}' from ${params.templateType} template. ` +
        `Name: ${spec.name}, Culture: ${spec.culture}, Components: ${spec.components.length}, ` +
        `Saved to: ${path.basename(filePath)}. ` +
        `Use select-landmark-spec with keywords: ${spec.keywords.join(', ')}`
      );
    }
  );

  // 21. send-chat
  factory.registerTool(
    "send-chat",
    "Send a chat message to all players.",
    {
      message: z.string().describe("Message to send"),
    },
    async (params: any) => {
      const bot = getBot();
      bot.chat(String(params.message));
      return factory.createResponse(`Sent: ${String(params.message)}`);
    }
  );

  // 22. plant-garden
  factory.registerTool(
    "plant-garden",
    "Plant a decorative garden block-by-block on flat land (never water). Requires an active claimed zone.",
    {
      x: z.coerce.number().describe("Garden center X coordinate"),
      z: z.coerce.number().describe("Garden center Z coordinate"),
      size: z.coerce.number().optional().describe("Garden size: 1=small, 2=medium, 3=large (default: 2)"),
    },
    async (params: any) => {
      const bot = getBot();
      const owner = getOwner();
      const requestedCenterX = toInt(params.x);
      const requestedCenterZ = toInt(params.z);
      const size = Math.max(1, Math.min(3, toInt(params.size ?? 2)));
      const radius = size === 3 ? 6 : 4;
      let centerX = requestedCenterX;
      let centerZ = requestedCenterZ;
      let baseY = 64;
      let bounds: BoundingBox | null = null;
      let selectedReason = '';

      for (const offset of candidateOffsets(GARDEN_SITE_SEARCH_RADIUS, GARDEN_SITE_SEARCH_STEP)) {
        const candidateCenterX = requestedCenterX + offset.dx;
        const candidateCenterZ = requestedCenterZ + offset.dz;
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let sumY = 0;
        let sampleCount = 0;
        let siteRejected = false;

        for (let x = candidateCenterX - radius; x <= candidateCenterX + radius; x += 2) {
          for (let zCoord = candidateCenterZ - radius; zCoord <= candidateCenterZ + radius; zCoord += 2) {
            const sample = await sampleLandColumn(bot, x, zCoord);
            if (!sample.ok) {
              selectedReason = `water/non-land terrain at (${x},${zCoord}): ${sample.reason}`;
              siteRejected = true;
              break;
            }
            minY = Math.min(minY, sample.groundY);
            maxY = Math.max(maxY, sample.groundY);
            sumY += sample.groundY;
            sampleCount++;
          }
          if (siteRejected) {
            break;
          }
        }

        if (siteRejected || sampleCount === 0) {
          continue;
        }

        if (maxY - minY > 1) {
          selectedReason = `terrain is not flat enough (delta=${maxY - minY})`;
          continue;
        }

        const candidateBaseY = Math.round(sumY / sampleCount) + 1;
        const candidateFootprint = footprintFromCenter(
          candidateCenterX,
          candidateCenterZ,
          radius * 2 + 1,
          radius * 2 + 1
        );
        const nearbyWater = await detectNearbyWater(bot, candidateFootprint, GARDEN_WATER_BUFFER_BLOCKS);
        if (nearbyWater.hasWater) {
          selectedReason =
            `nearby water within buffer (${GARDEN_WATER_BUFFER_BLOCKS})` +
            (nearbyWater.location ? ` at ${nearbyWater.location}` : '');
          continue;
        }

        const candidateBounds = normalizeBounds(
          candidateCenterX - radius,
          candidateBaseY - 1,
          candidateCenterZ - radius,
          candidateCenterX + radius,
          candidateBaseY + 2,
          candidateCenterZ + radius
        );

        const reservationCheck = await coordinationStore.verifyReservation(owner, candidateBounds);
        if (!reservationCheck.ok) {
          selectedReason = reservationCheck.message;
          continue;
        }

        centerX = candidateCenterX;
        centerZ = candidateCenterZ;
        baseY = candidateBaseY;
        bounds = candidateBounds;
        break;
      }

      if (!bounds) {
        throw new Error(
          `Could not find a valid land garden site near (${requestedCenterX},${requestedCenterZ}). ` +
          `Last reason: ${selectedReason || 'unknown'}`
        );
      }

      const flowers = [
        'minecraft:poppy',
        'minecraft:dandelion',
        'minecraft:blue_orchid',
        'minecraft:allium',
        'minecraft:azure_bluet',
        'minecraft:red_tulip',
        'minecraft:orange_tulip',
        'minecraft:white_tulip',
        'minecraft:pink_tulip',
        'minecraft:oxeye_daisy',
        'minecraft:cornflower',
        'minecraft:lily_of_the_valley'
      ];

      const commands: string[] = [];
      for (let x = centerX - radius; x <= centerX + radius; x++) {
        for (let zCoord = centerZ - radius; zCoord <= centerZ + radius; zCoord++) {
          const onPath = zCoord === centerZ;
          commands.push(`/setblock ${x} ${baseY - 1} ${zCoord} ${onPath ? 'minecraft:gravel' : 'minecraft:grass_block'}`);

          if (!onPath) {
            const noise = Math.abs((x * 734287 + zCoord * 912931 + centerX * 31 + centerZ * 17) % 100);
            if (noise < 36) {
              const flower = flowers[noise % flowers.length];
              commands.push(`/setblock ${x} ${baseY} ${zCoord} ${flower}`);
            }
          }
        }
      }

      for (let index = 0; index < size; index++) {
        const offset = index * 2 + 1;
        commands.push(`/setblock ${centerX - offset} ${baseY} ${centerZ + offset} minecraft:oak_leaves[persistent=true]`);
      }

      if (size >= 2) {
        const corners = [
          [centerX - radius, centerZ - radius],
          [centerX + radius, centerZ - radius],
          [centerX - radius, centerZ + radius],
          [centerX + radius, centerZ + radius]
        ];
        for (const [x, zCoord] of corners) {
          commands.push(`/setblock ${x} ${baseY} ${zCoord} minecraft:cobblestone_wall`);
          commands.push(`/setblock ${x} ${baseY + 1} ${zCoord} minecraft:lantern`);
        }
      }

      const airOps = countAirCommands(commands);
      await enforceMutatingOperationGuard(bot, owner, bounds, commands.length, airOps);

      await placementQueue.enqueueCommands(
        commands,
        (command) => runServerCommand(bot, command),
        BLOCK_QUEUE_DELAY_MS
      );

      return factory.createResponse(
        `Planted garden size=${size} at (${centerX}, ${baseY}, ${centerZ}) with ${commands.length} block-by-block edits` +
        (centerX !== requestedCenterX || centerZ !== requestedCenterZ
          ? ` (adjusted from requested center ${requestedCenterX},${requestedCenterZ} to stay on flat land)`
          : '')
      );
    }
  );
}

async function main() {
  const config = parseConfig();
  const messageStore = new MessageStore();

  const connection = new BotConnection(
    config,
    {
      onLog: log,
      onChatMessage: (username, message) => messageStore.addMessage(username, message)
    }
  );

  connection.connect();

  const server = new McpServer({
    name: "minecraft-mcp-server",
    version: "2.2.0-cinematic-safe"
  });

  const factory = new ToolFactory(server, connection);
  const getBot = () => connection.getBot()!;
  const getOwner = () => connection.getConfig().username;

  registerEssentialTools(factory, getBot, getOwner);

  process.stdin.on('end', () => {
    connection.cleanup();
    log('info', 'MCP Client has disconnected. Shutting down...');
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  log('error', `Fatal error in main(): ${error}`);
  process.exit(1);
});
