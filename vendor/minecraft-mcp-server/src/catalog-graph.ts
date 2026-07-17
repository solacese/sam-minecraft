import { promises as fs } from 'node:fs';
import path from 'node:path';
import { normalizeBounds, type BoundingBox } from './build-coordination.js';
import type { CatalogModelArtifact } from './catalog-import.js';
import { buildPlacementPlan, type PlacementBlock } from './catalog-place.js';

type CatalogRole = 'foundation' | 'walls' | 'roof' | 'ornament';
type PartitionBlocks = { name: string; blocks: PlacementBlock[] };

export interface CatalogPlacementShard {
  shardId: string;
  label: string;
  role: CatalogRole;
  assignedWorker: string;
  bounds: BoundingBox;
  blockCount: number;
  dependencies: string[];
  blocks: PlacementBlock[];
}

export interface CatalogPlacementArtifact {
  schemaVersion: '1.0';
  kind: 'catalog-placement-plan';
  graphId: string;
  source: {
    pageUrl: string;
    title: string;
    fetchedAt: string;
  };
  worldOrigin: {
    x: number;
    y: number;
    z: number;
  };
  stats: {
    translatedBlocks: number;
    skippedPaletteEntries: number;
    width: number;
    depth: number;
    height: number;
    bounds: BoundingBox | null;
  };
  skippedPalette: Array<{ paletteKey: string; reason: string }>;
  shards: CatalogPlacementShard[];
}

export interface CreateCatalogPlacementArtifactInput {
  graphId: string;
  model: CatalogModelArtifact;
  originX: number;
  originY: number;
  originZ: number;
}

const PARTITION_WORKERS = [
  'MinecraftAgent',
  'BuildBeaAgent',
  'MonumentMarcAgent',
  'SupplySidAgent',
  'ForestFinnAgent',
  'DesignDoraAgent'
];
const DEFAULT_BAND_HEIGHT = 6;
const MIN_SPLIT_BLOCKS = 1200;
const MAX_SHARD_FOOTPRINT = 1000;
const MAX_SHARD_BLOCKS = 2500;
const MAX_SHARD_VOLUME = 12000;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function baseBlockName(blockState: string): string {
  return blockState.replace(/^minecraft:/, '').split('[', 1)[0];
}

function isDelicateBlock(blockState: string): boolean {
  const blockName = baseBlockName(blockState);
  return (
    blockName.endsWith('_slab') ||
    blockName.endsWith('_stairs') ||
    blockName.endsWith('_torch') ||
    blockName.endsWith('_button') ||
    blockName.endsWith('_sign') ||
    blockName.endsWith('_door') ||
    blockName.endsWith('_pane')
  );
}

function shardBounds(blocks: PlacementBlock[]): BoundingBox {
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

function boundsVolume(bounds: BoundingBox): number {
  return (
    (bounds.maxX - bounds.minX + 1) *
    (bounds.maxY - bounds.minY + 1) *
    (bounds.maxZ - bounds.minZ + 1)
  );
}

function boundsFootprint(bounds: BoundingBox): number {
  return (bounds.maxX - bounds.minX + 1) * (bounds.maxZ - bounds.minZ + 1);
}

function roleForBand(
  bandIndex: number,
  totalBands: number,
  delicateRatio: number
): CatalogRole {
  if (delicateRatio >= 0.18) {
    return 'ornament';
  }
  if (bandIndex <= 1 || totalBands <= 3) {
    return 'foundation';
  }
  if (bandIndex >= totalBands - 2) {
    return 'roof';
  }
  return 'walls';
}

function workerForPartition(partitionIndex: number): string {
  return PARTITION_WORKERS[partitionIndex % PARTITION_WORKERS.length];
}

function splitFootprintBlocks(blocks: PlacementBlock[]): PartitionBlocks[] {
  if (blocks.length < MIN_SPLIT_BLOCKS) {
    return [{ name: 'core', blocks }];
  }

  const minX = Math.min(...blocks.map((block) => block.x));
  const maxX = Math.max(...blocks.map((block) => block.x));
  const minZ = Math.min(...blocks.map((block) => block.z));
  const maxZ = Math.max(...blocks.map((block) => block.z));
  const splitAlongX = (maxX - minX) >= (maxZ - minZ);
  const midpoint = splitAlongX
    ? Math.floor((minX + maxX) / 2)
    : Math.floor((minZ + maxZ) / 2);

  if (blocks.length >= MIN_SPLIT_BLOCKS * 2) {
    const spanStart = splitAlongX ? minX : minZ;
    const spanEnd = splitAlongX ? maxX : maxZ;
    const range = Math.max(1, spanEnd - spanStart + 1);
    const firstCut = spanStart + Math.floor(range / 3);
    const secondCut = spanStart + Math.floor((range * 2) / 3);
    const first = blocks.filter((block) => (splitAlongX ? block.x : block.z) <= firstCut);
    const second = blocks.filter((block) => {
      const axis = splitAlongX ? block.x : block.z;
      return axis > firstCut && axis <= secondCut;
    });
    const third = blocks.filter((block) => (splitAlongX ? block.x : block.z) > secondCut);

    if (first.length > 0 && second.length > 0 && third.length > 0) {
      return [
        { name: splitAlongX ? 'west' : 'north', blocks: first },
        { name: 'center', blocks: second },
        { name: splitAlongX ? 'east' : 'south', blocks: third }
      ];
    }
  }

  const first = blocks.filter((block) => splitAlongX ? block.x <= midpoint : block.z <= midpoint);
  const second = blocks.filter((block) => splitAlongX ? block.x > midpoint : block.z > midpoint);

  if (first.length === 0 || second.length === 0) {
    return [{ name: 'core', blocks }];
  }

  return [
    { name: splitAlongX ? 'west' : 'north', blocks: first },
    { name: splitAlongX ? 'east' : 'south', blocks: second }
  ];
}

function splitBlocksToVolume(
  blocks: PlacementBlock[],
  baseName: string
): PartitionBlocks[] {
  const bounds = shardBounds(blocks);
  if (
    boundsVolume(bounds) <= MAX_SHARD_VOLUME &&
    boundsFootprint(bounds) <= MAX_SHARD_FOOTPRINT &&
    blocks.length <= MAX_SHARD_BLOCKS
  ) {
    return [{ name: baseName, blocks }];
  }

  const spanX = bounds.maxX - bounds.minX + 1;
  const spanZ = bounds.maxZ - bounds.minZ + 1;
  const splitAlongX = spanX >= spanZ;
  const minAxis = splitAlongX ? bounds.minX : bounds.minZ;
  const maxAxis = splitAlongX ? bounds.maxX : bounds.maxZ;
  if (minAxis === maxAxis) {
    return [{ name: baseName, blocks }];
  }

  const midpoint = Math.floor((minAxis + maxAxis) / 2);
  const left = blocks.filter((block) => (splitAlongX ? block.x : block.z) <= midpoint);
  const right = blocks.filter((block) => (splitAlongX ? block.x : block.z) > midpoint);

  if (left.length === 0 || right.length === 0) {
    return [{ name: baseName, blocks }];
  }

  return [
    ...splitBlocksToVolume(left, `${baseName}_a`),
    ...splitBlocksToVolume(right, `${baseName}_b`)
  ];
}

export function createCatalogPlacementArtifact(
  input: CreateCatalogPlacementArtifactInput
): CatalogPlacementArtifact {
  const plan = buildPlacementPlan(
    input.model,
    input.originX,
    input.originY,
    input.originZ
  );

  if (plan.translatedBlocks.length === 0) {
    throw new Error('Model import produced no translated blocks.');
  }

  const minY = Math.min(...plan.translatedBlocks.map((block) => block.y));
  const maxY = Math.max(...plan.translatedBlocks.map((block) => block.y));
  const totalBands = Math.max(1, Math.ceil((maxY - minY + 1) / DEFAULT_BAND_HEIGHT));
  const footprintPartitions = splitFootprintBlocks(plan.translatedBlocks);
  const shards: CatalogPlacementShard[] = [];
  let previousWaveShardIds: string[] = [];
  let shardSequence = 0;

  for (let bandIndex = 0; bandIndex < totalBands; bandIndex += 1) {
    const bandMinY = minY + bandIndex * DEFAULT_BAND_HEIGHT;
    const bandMaxY = Math.min(maxY, bandMinY + DEFAULT_BAND_HEIGHT - 1);
    const currentWaveShardIds: string[] = [];

    footprintPartitions.forEach((partition) => {
      const bandBlocks = partition.blocks.filter((block) => block.y >= bandMinY && block.y <= bandMaxY);
      if (bandBlocks.length === 0) {
        return;
      }

      const subPartitions = splitBlocksToVolume(bandBlocks, partition.name);
      subPartitions.forEach((subPartition) => {
        const subBounds = shardBounds(subPartition.blocks);
        const delicateRatio =
          subPartition.blocks.filter((block) => isDelicateBlock(block.blockState)).length /
          Math.max(1, subPartition.blocks.length);
        const role = roleForBand(bandIndex, totalBands, delicateRatio);
        const shardId = `band_${String(bandIndex + 1).padStart(2, '0')}_${subPartition.name}`;
        currentWaveShardIds.push(shardId);
        shards.push({
          shardId,
          label: `${input.model.source.title} band ${bandIndex + 1} ${subPartition.name}`,
          role,
          assignedWorker: workerForPartition(shardSequence),
          bounds: subBounds,
          blockCount: subPartition.blocks.length,
          dependencies: [...previousWaveShardIds],
          blocks: subPartition.blocks
        });
        shardSequence += 1;
      });
    });

    if (currentWaveShardIds.length > 0) {
      previousWaveShardIds = currentWaveShardIds;
    }
  }

  const bounds = shardBounds(plan.translatedBlocks);
  return {
    schemaVersion: '1.0',
    kind: 'catalog-placement-plan',
    graphId: input.graphId,
    source: {
      pageUrl: input.model.source.pageUrl,
      title: input.model.source.title,
      fetchedAt: input.model.source.fetchedAt
    },
    worldOrigin: {
      x: input.originX,
      y: input.originY,
      z: input.originZ
    },
    stats: {
      translatedBlocks: plan.translatedBlocks.length,
      skippedPaletteEntries: plan.skippedPalette.length,
      width: bounds.maxX - bounds.minX + 1,
      depth: bounds.maxZ - bounds.minZ + 1,
      height: bounds.maxY - bounds.minY + 1,
      bounds
    },
    skippedPalette: plan.skippedPalette,
    shards
  };
}

export async function writeCatalogPlacementArtifact(
  outputDir: string,
  artifact: CatalogPlacementArtifact
): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(
    outputDir,
    `${slugify(artifact.source.title)}-${artifact.graphId}.placement.json`
  );
  await fs.writeFile(filePath, JSON.stringify(artifact, null, 2), 'utf8');
  return filePath;
}

export async function writeCatalogModelArtifact(
  outputDir: string,
  graphId: string,
  model: CatalogModelArtifact
): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(
    outputDir,
    `${slugify(model.source.title)}-${graphId}.model.json`
  );
  await fs.writeFile(filePath, JSON.stringify(model, null, 2), 'utf8');
  return filePath;
}
