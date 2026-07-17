import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CatalogModelArtifact } from './catalog-import.js';

interface OtsBlockRecord {
  x: number;
  y: number;
  z: number;
  paletteKey: string;
}

interface OtsBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface OtsBlockModelReference {
  id: string;
  title: string;
  filePath: string;
  aliases: string[];
}

export interface ImportOtsBlockModelInput {
  filePath: string;
  title?: string;
  stabilizeGravityBlocks?: boolean;
}

export interface ResolveOtsBlockModelInput {
  filePath?: string;
  modelName?: string;
  title?: string;
}

const MAGIC = 'OTS_BLOCKS';
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));

function bundledLocalStructurePath(fileName: string): string {
  return path.resolve(CURRENT_DIR, '../local_structures', fileName);
}

function projectRootPath(...segments: string[]): string {
  return path.resolve(CURRENT_DIR, '../../..', ...segments);
}

const GRAVITY_BLOCK_REPLACEMENTS = new Map<string, string>([
  ['minecraft:black_concrete_powder', 'minecraft:black_concrete'],
  ['minecraft:gray_concrete_powder', 'minecraft:gray_concrete'],
  ['minecraft:light_gray_concrete_powder', 'minecraft:light_gray_concrete'],
  ['minecraft:white_concrete_powder', 'minecraft:white_concrete'],
  ['minecraft:red_concrete_powder', 'minecraft:red_concrete'],
  ['minecraft:orange_concrete_powder', 'minecraft:orange_concrete'],
  ['minecraft:yellow_concrete_powder', 'minecraft:yellow_concrete'],
  ['minecraft:lime_concrete_powder', 'minecraft:lime_concrete'],
  ['minecraft:green_concrete_powder', 'minecraft:green_concrete'],
  ['minecraft:cyan_concrete_powder', 'minecraft:cyan_concrete'],
  ['minecraft:light_blue_concrete_powder', 'minecraft:light_blue_concrete'],
  ['minecraft:blue_concrete_powder', 'minecraft:blue_concrete'],
  ['minecraft:purple_concrete_powder', 'minecraft:purple_concrete'],
  ['minecraft:magenta_concrete_powder', 'minecraft:magenta_concrete'],
  ['minecraft:pink_concrete_powder', 'minecraft:pink_concrete'],
  ['minecraft:brown_concrete_powder', 'minecraft:brown_concrete'],
  ['minecraft:gravel', 'minecraft:andesite'],
  ['minecraft:sand', 'minecraft:sandstone'],
  ['minecraft:red_sand', 'minecraft:red_sandstone']
]);

function userDownloadsPath(fileName: string): string {
  const home = process.env.HOME || '/Users/raphaelcaillon';
  return path.join(home, 'Downloads', fileName);
}

export const REGISTERED_OTS_BLOCK_MODELS: OtsBlockModelReference[] = [
  {
    id: 'sydney-opera-house-cadnav',
    title: 'Sydney Opera House',
    filePath: bundledLocalStructurePath('sydney_opera_house_cadnav.ots_blocks'),
    aliases: [
      'sydney opera house',
      'local sydney opera house',
      'local opera house',
      'opera house',
      'cadnav sydney opera house',
      'the one i am standing on',
      'the model i am standing on',
      'selected opera house'
    ]
  },
  {
    id: 'architecture-tower',
    title: 'Architecture Tower',
    filePath: userDownloadsPath('architecture tower 3d model.glb.ots_blocks'),
    aliases: [
      'architecture tower',
      'local architecture tower',
      'the architecture tower',
      'tower in front of me',
      'registered architecture tower'
    ]
  },
  {
    id: 'munich-famous-building',
    title: 'Munich Famous Building',
    filePath: bundledLocalStructurePath('munich_famous_building.ots_blocks'),
    aliases: [
      'munich famous building',
      'famous building in munich',
      'famous munich building',
      'munich landmark',
      'local munich landmark',
      'local munich famous building',
      'build this munich building',
      'this famous building in munich',
      'block mesh',
      'block mesh munich'
    ]
  },
  {
    id: 'santander-hq-full-campus',
    title: 'Santander HQ Full Campus',
    filePath: projectRootPath(
      'maps',
      'ciudad_grupo_santander',
      'generated',
      'ciudad_grupo_santander_2m_straight_dome_ots_spacious_treed.ots_blocks'
    ),
    aliases: [
      'santander hq',
      'santander headquarters',
      'santander campus',
      'ciudad grupo santander',
      'ciudad financiera grupo santander',
      'ciudad financiera santander',
      'santander hq campus',
      'santander full campus',
      'santander office campus',
      'grupo santander hq',
      'build santander hq',
      'build santander headquarters'
    ]
  }
];

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function displayTitleFromPath(filePath: string): string {
  return path.basename(filePath)
    .replace(/\.ots_blocks$/i, '')
    .replace(/\s*3d model\.glb$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'OTS Block Model';
}

function stabilizeBlockState(blockState: string, enabled: boolean): string {
  if (!enabled) {
    return blockState;
  }
  return GRAVITY_BLOCK_REPLACEMENTS.get(blockState) ?? blockState;
}

function isTransparentBlock(blockState: string): boolean {
  const baseName = blockState.replace(/^minecraft:/, '').split('[', 1)[0];
  return (
    baseName.includes('glass') ||
    baseName.endsWith('_pane') ||
    baseName.includes('ice') ||
    baseName.includes('water') ||
    baseName.endsWith('_leaves')
  );
}

function readString(buffer: Buffer, offset: number, length: number, filePath: string): string {
  if (offset + length > buffer.length) {
    throw new Error(`${path.basename(filePath)} has a truncated string payload.`);
  }
  return buffer.subarray(offset, offset + length).toString('utf8');
}

function updateBounds(bounds: OtsBounds | null, x: number, y: number, z: number): OtsBounds {
  if (!bounds) {
    return { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z };
  }
  return {
    minX: Math.min(bounds.minX, x),
    maxX: Math.max(bounds.maxX, x),
    minY: Math.min(bounds.minY, y),
    maxY: Math.max(bounds.maxY, y),
    minZ: Math.min(bounds.minZ, z),
    maxZ: Math.max(bounds.maxZ, z)
  };
}

export async function resolveOtsBlockModelReference(
  input: ResolveOtsBlockModelInput
): Promise<{ filePath: string; title: string; id?: string; matchedAlias?: string; resolvedVia: 'filePath' | 'registry' }> {
  if (input.filePath?.trim()) {
    const resolvedPath = path.resolve(input.filePath.trim());
    return {
      filePath: resolvedPath,
      title: input.title?.trim() || displayTitleFromPath(resolvedPath),
      resolvedVia: 'filePath'
    };
  }

  const modelName = input.modelName?.trim();
  if (!modelName) {
    throw new Error('Either filePath or modelName is required for OTS block model planning.');
  }

  const normalized = normalizeName(modelName);
  const match = REGISTERED_OTS_BLOCK_MODELS.find((candidate) => {
    const names = [candidate.id, candidate.title, ...candidate.aliases].map(normalizeName);
    return names.some((name) => name === normalized || name.includes(normalized) || normalized.includes(name));
  });

  if (!match) {
    const available = REGISTERED_OTS_BLOCK_MODELS.map((candidate) => candidate.title).join(', ');
    throw new Error(`No registered OTS block model matched '${modelName}'. Available models: ${available}`);
  }

  return {
    filePath: match.filePath,
    title: input.title?.trim() || match.title,
    id: match.id,
    matchedAlias: match.aliases.find((alias) => normalizeName(alias) === normalized) ?? match.title,
    resolvedVia: 'registry'
  };
}

export async function importOtsBlockModelAsCatalogModel(
  input: ImportOtsBlockModelInput
): Promise<CatalogModelArtifact> {
  const filePath = path.resolve(input.filePath);
  const stabilizeGravityBlocks = input.stabilizeGravityBlocks == null
    ? true
    : Boolean(input.stabilizeGravityBlocks);
  const raw = await fs.readFile(filePath);

  if (raw.length < 15 || raw.subarray(0, 10).toString('utf8') !== MAGIC) {
    throw new Error(`${path.basename(filePath)} is not a valid .ots_blocks file.`);
  }

  const version = raw.readUInt8(10);
  if (version !== 2) {
    throw new Error(`Unsupported .ots_blocks version ${version} in ${path.basename(filePath)}.`);
  }

  let offset = 11;
  if (offset + 4 > raw.length) {
    throw new Error(`${path.basename(filePath)} is missing its palette count.`);
  }
  const paletteCount = raw.readUInt32LE(offset);
  offset += 4;

  const paletteById = new Map<number, string>();
  for (let index = 0; index < paletteCount; index += 1) {
    if (offset + 8 > raw.length) {
      throw new Error(`${path.basename(filePath)} has a truncated palette payload.`);
    }
    const blockId = raw.readUInt32LE(offset);
    offset += 4;
    const stateLength = raw.readUInt32LE(offset);
    offset += 4;
    const blockState = stabilizeBlockState(
      readString(raw, offset, stateLength, filePath),
      stabilizeGravityBlocks
    );
    offset += stateLength;
    paletteById.set(blockId, blockState);
  }

  if (offset + 4 > raw.length) {
    throw new Error(`${path.basename(filePath)} is missing its block record count.`);
  }
  const recordCount = raw.readUInt32LE(offset);
  offset += 4;

  const expectedSize = offset + recordCount * 16;
  if (expectedSize !== raw.length) {
    throw new Error(`${path.basename(filePath)} has a truncated or unexpected block payload.`);
  }

  const blocks: OtsBlockRecord[] = [];
  const paletteCounts = new Map<string, number>();
  const paletteStateByKey = new Map<string, string>();
  const layerCounts = new Map<number, { count: number; paletteKeys: Set<string> }>();
  let bounds: OtsBounds | null = null;

  for (let index = 0; index < recordCount; index += 1) {
    const x = raw.readInt32LE(offset);
    const y = raw.readInt32LE(offset + 4);
    const z = raw.readInt32LE(offset + 8);
    const paletteId = raw.readUInt32LE(offset + 12);
    offset += 16;

    const blockState = paletteById.get(paletteId);
    if (!blockState) {
      throw new Error(`${path.basename(filePath)} references unknown block palette id ${paletteId}.`);
    }

    const paletteKey = `ots:${paletteId}`;
    blocks.push({ x, y, z, paletteKey });
    paletteStateByKey.set(paletteKey, blockState);
    paletteCounts.set(paletteKey, (paletteCounts.get(paletteKey) ?? 0) + 1);
    const layer = layerCounts.get(y) ?? { count: 0, paletteKeys: new Set<string>() };
    layer.count += 1;
    layer.paletteKeys.add(paletteKey);
    layerCounts.set(y, layer);
    bounds = updateBounds(bounds, x, y, z);
  }

  if (blocks.length === 0 || !bounds) {
    throw new Error(`${path.basename(filePath)} did not contain any usable blocks.`);
  }

  const palette = Array.from(paletteStateByKey.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([paletteKey, blockState]) => {
      const transparent = isTransparentBlock(blockState);
      return {
        paletteKey,
        materialId: paletteKey,
        name: blockState,
        transparent,
        opacity: transparent ? 0.35 : 1,
        count: paletteCounts.get(paletteKey) ?? 0
      };
    });

  const layers = Array.from(layerCounts.entries())
    .sort(([left], [right]) => left - right)
    .map(([y, summary]) => ({
      y,
      blockCount: summary.count,
      paletteKeys: Array.from(summary.paletteKeys).sort()
    }));

  return {
    schemaVersion: '1.0',
    kind: 'catalog-model',
    source: {
      pageUrl: `file://${filePath}`,
      fetchedAt: new Date().toISOString(),
      title: input.title?.trim() || displayTitleFromPath(filePath),
      blockCount: blocks.length,
      dimensions: {
        x: bounds.maxX - bounds.minX + 1,
        y: bounds.maxY - bounds.minY + 1,
        z: bounds.maxZ - bounds.minZ + 1
      }
    },
    stats: {
      importedBlocks: blocks.length,
      paletteSize: palette.length,
      layerCount: layers.length,
      bounds
    },
    palette,
    layers,
    blocks
  };
}
