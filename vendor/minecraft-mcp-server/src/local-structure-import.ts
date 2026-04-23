import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { GrabCraftModelArtifact } from './grabcraft-import.js';

const require = createRequire(import.meta.url);
const { Vec3 } = require('vec3');
const { Anvil } = require('prismarine-provider-anvil') as {
  Anvil: (version: string) => new (regionPath: string) => {
    getRegion(x: number, z: number): Promise<{ hasChunk(x: number, z: number): boolean }>;
    load(x: number, z: number): Promise<{
      getBlock(pos: { x: number; y: number; z: number }): {
        name: string;
        getProperties?: () => Record<string, string | number | boolean>;
      };
    } | null>;
    close(): Promise<void>;
  };
};

const execFileAsync = promisify(execFile);
const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_STRUCTURE_REGISTRY_PATH = path.resolve(CURRENT_DIR, '../local_structures/index.json');
const DISCOVERY_SKIP_BLOCKS = new Set([
  'air',
  'cave_air',
  'void_air',
  'bedrock',
  'dirt',
  'grass_block',
  'stone',
  'water',
  'lava',
  'sand',
  'red_sand',
  'gravel',
  'clay',
  'snow',
  'snow_block'
]);
const EXPORT_SKIP_BLOCKS = new Set(['air', 'cave_air', 'void_air', 'bedrock', 'dirt', 'grass_block']);
const DEFAULT_WORLD_VERSION = '1.13.2';
const DEFAULT_HEIGHT = 256;
const LOCAL_STRUCTURE_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'build',
  'complete',
  'from',
  'in',
  'is',
  'it',
  'local',
  'multiple',
  'parallel',
  'the',
  'this',
  'until',
  'use',
  'using',
  'with',
  'worker',
  'workers'
]);

export type LocalStructureRegistryEntry = {
  id: string;
  title: string;
  aliases?: string[];
  filePath: string;
  sourceVersion?: string;
};

export type ResolvedLocalStructureReference = {
  id?: string;
  title: string;
  filePath: string;
  sourceVersion?: string;
  resolvedVia: 'filePath' | 'registry';
  matchedAlias?: string;
};

type ChunkSummary = {
  chunkX: number;
  chunkZ: number;
  count: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
};

type StructureWorldRoot = {
  worldRoot: string;
  sourcePath: string;
  cleanupPath?: string;
  titleHint: string;
};

type LocalStructureRegistryFile = {
  schemaVersion?: string;
  structures?: LocalStructureRegistryEntry[];
};

let localStructureRegistryCache: LocalStructureRegistryEntry[] | null = null;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function normalizeStructureQuery(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function significantStructureTokens(value: string): string[] {
  return normalizeStructureQuery(value)
    .split(' ')
    .filter((token) => token.length > 0 && !LOCAL_STRUCTURE_STOP_WORDS.has(token));
}

function scoreStructureCandidate(query: string, candidate: string): number {
  const normalizedQuery = normalizeStructureQuery(query);
  const normalizedCandidate = normalizeStructureQuery(candidate);

  if (!normalizedQuery || !normalizedCandidate) {
    return 0;
  }
  if (normalizedQuery === normalizedCandidate) {
    return 1000;
  }
  if (normalizedQuery.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedQuery)) {
    return 700 + Math.min(50, normalizedCandidate.length);
  }

  const queryTokens = new Set(significantStructureTokens(query));
  const candidateTokens = significantStructureTokens(candidate);
  if (queryTokens.size === 0 || candidateTokens.length === 0) {
    return 0;
  }

  const matchedTokens = candidateTokens.filter((token) => queryTokens.has(token)).length;
  if (matchedTokens === 0) {
    return 0;
  }
  if (matchedTokens === candidateTokens.length) {
    return 400 + matchedTokens;
  }

  const requiredMatches = Math.max(2, Math.ceil(candidateTokens.length * 0.75));
  if (matchedTokens >= requiredMatches) {
    return 200 + matchedTokens;
  }

  return matchedTokens;
}

async function loadLocalStructureRegistry(): Promise<LocalStructureRegistryEntry[]> {
  if (localStructureRegistryCache) {
    return localStructureRegistryCache;
  }

  const raw = await fs.readFile(LOCAL_STRUCTURE_REGISTRY_PATH, 'utf8');
  const parsed = JSON.parse(raw) as LocalStructureRegistryFile;
  const structures = Array.isArray(parsed.structures) ? parsed.structures : [];
  localStructureRegistryCache = structures
    .filter((entry) => (
      entry &&
      typeof entry.id === 'string' &&
      typeof entry.title === 'string' &&
      typeof entry.filePath === 'string'
    ))
    .map((entry) => ({
      id: entry.id,
      title: entry.title,
      aliases: Array.isArray(entry.aliases) ? entry.aliases.filter((alias) => typeof alias === 'string' && alias.trim()) : [],
      filePath: entry.filePath,
      sourceVersion: entry.sourceVersion
    }));

  return localStructureRegistryCache;
}

export function selectLocalStructureRegistryEntry(
  structureName: string,
  entries: LocalStructureRegistryEntry[]
): { entry: LocalStructureRegistryEntry; matchedAlias: string } | null {
  let bestMatch: { entry: LocalStructureRegistryEntry; matchedAlias: string; score: number } | null = null;

  for (const entry of entries) {
    const candidates = [entry.title, ...(entry.aliases ?? [])];
    for (const candidate of candidates) {
      const score = scoreStructureCandidate(structureName, candidate);
      if (score <= 0) {
        continue;
      }
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = {
          entry,
          matchedAlias: candidate,
          score
        };
      }
    }
  }

  if (!bestMatch) {
    return null;
  }

  return {
    entry: bestMatch.entry,
    matchedAlias: bestMatch.matchedAlias
  };
}

export async function resolveLocalStructureReference(input: {
  filePath?: string;
  structureName?: string;
  title?: string;
  sourceVersion?: string;
}): Promise<ResolvedLocalStructureReference> {
  const filePath = input.filePath?.trim();
  if (filePath) {
    const resolvedFilePath = path.resolve(filePath);
    await fs.access(resolvedFilePath);
    return {
      title: input.title?.trim() || path.basename(resolvedFilePath, path.extname(resolvedFilePath)),
      filePath: resolvedFilePath,
      sourceVersion: input.sourceVersion?.trim() || DEFAULT_WORLD_VERSION,
      resolvedVia: 'filePath'
    };
  }

  const structureName = input.structureName?.trim();
  if (!structureName) {
    throw new Error('Either filePath or structureName is required for local structure planning.');
  }

  const registryEntries = await loadLocalStructureRegistry();
  const match = selectLocalStructureRegistryEntry(structureName, registryEntries);
  if (!match) {
    throw new Error(`No registered local structure matched '${structureName}'.`);
  }

  const resolvedFilePath = path.resolve(match.entry.filePath);
  await fs.access(resolvedFilePath);
  return {
    id: match.entry.id,
    title: input.title?.trim() || match.entry.title,
    filePath: resolvedFilePath,
    sourceVersion: input.sourceVersion?.trim() || match.entry.sourceVersion?.trim() || DEFAULT_WORLD_VERSION,
    resolvedVia: 'registry',
    matchedAlias: match.matchedAlias
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isWorldRoot(dirPath: string): Promise<boolean> {
  return (
    await pathExists(path.join(dirPath, 'level.dat')) &&
    await pathExists(path.join(dirPath, 'region'))
  );
}

async function findWorldRoot(searchRoot: string): Promise<string | null> {
  if (await isWorldRoot(searchRoot)) {
    return searchRoot;
  }

  const queue: Array<{ dir: string; depth: number }> = [{ dir: searchRoot, depth: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }
    if (visited.has(current.dir) || current.depth > 4) {
      continue;
    }
    visited.add(current.dir);

    try {
      const dirEntries = await fs.readdir(current.dir, { withFileTypes: true });
      if (await isWorldRoot(current.dir)) {
        return current.dir;
      }
      for (const entry of dirEntries) {
        if (entry.isDirectory()) {
          queue.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
        }
      }
    } catch {
      // Ignore unreadable directories while walking extracted archives.
    }
  }

  return null;
}

async function resolveWorldRoot(inputPath: string): Promise<StructureWorldRoot> {
  const resolved = path.resolve(inputPath);
  const stat = await fs.stat(resolved);

  if (stat.isDirectory()) {
    const worldRoot = await findWorldRoot(resolved);
    if (!worldRoot) {
      throw new Error(`Could not find a Minecraft world root under ${resolved}.`);
    }
    return {
      worldRoot,
      sourcePath: resolved,
      titleHint: path.basename(worldRoot)
    };
  }

  if (!stat.isFile()) {
    throw new Error(`${resolved} is not a file or directory.`);
  }

  if (path.extname(resolved).toLowerCase() !== '.zip') {
    throw new Error(`Unsupported structure archive '${resolved}'. Expected a .zip world save or a world directory.`);
  }

  const extractRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sam-minecraft-structure-'));
  await execFileAsync('unzip', ['-q', resolved, '-d', extractRoot]);
  const worldRoot = await findWorldRoot(extractRoot);
  if (!worldRoot) {
    throw new Error(`Archive ${resolved} did not contain a readable Minecraft world save.`);
  }

  return {
    worldRoot,
    sourcePath: resolved,
    cleanupPath: extractRoot,
    titleHint: path.basename(worldRoot)
  };
}

function serializeBlockState(blockName: string, properties: Record<string, string | number | boolean> = {}): string {
  const entries = Object.entries(properties)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([left], [right]) => left.localeCompare(right));

  if (entries.length === 0) {
    return `minecraft:${blockName}`;
  }

  return `minecraft:${blockName}[${entries.map(([key, value]) => `${key}=${String(value)}`).join(',')}]`;
}

function parseRegionCoordinates(fileName: string): { regionX: number; regionZ: number } | null {
  const match = fileName.match(/^r\.(-?\d+)\.(-?\d+)\.mca$/i);
  if (!match) {
    return null;
  }
  return {
    regionX: Number.parseInt(match[1], 10),
    regionZ: Number.parseInt(match[2], 10)
  };
}

function mergeBoundingBoxes(summaries: ChunkSummary[]): ChunkSummary {
  return summaries.reduce<ChunkSummary>((acc, summary) => ({
    chunkX: 0,
    chunkZ: 0,
    count: acc.count + summary.count,
    minX: Math.min(acc.minX, summary.minX),
    maxX: Math.max(acc.maxX, summary.maxX),
    minY: Math.min(acc.minY, summary.minY),
    maxY: Math.max(acc.maxY, summary.maxY),
    minZ: Math.min(acc.minZ, summary.minZ),
    maxZ: Math.max(acc.maxZ, summary.maxZ)
  }), {
    chunkX: 0,
    chunkZ: 0,
    count: 0,
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
    minZ: Number.POSITIVE_INFINITY,
    maxZ: Number.NEGATIVE_INFINITY
  });
}

function chunkKey(chunkX: number, chunkZ: number): string {
  return `${chunkX},${chunkZ}`;
}

function selectDominantComponent(summaries: ChunkSummary[]): ChunkSummary[] {
  const byKey = new Map(summaries.map((summary) => [chunkKey(summary.chunkX, summary.chunkZ), summary]));
  const visited = new Set<string>();
  const components: ChunkSummary[][] = [];

  for (const summary of summaries) {
    const startKey = chunkKey(summary.chunkX, summary.chunkZ);
    if (visited.has(startKey)) {
      continue;
    }

    const queue = [summary];
    const component: ChunkSummary[] = [];
    visited.add(startKey);

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      component.push(current);
      const neighbors = [
        [current.chunkX - 1, current.chunkZ],
        [current.chunkX + 1, current.chunkZ],
        [current.chunkX, current.chunkZ - 1],
        [current.chunkX, current.chunkZ + 1]
      ];
      for (const [neighborX, neighborZ] of neighbors) {
        const key = chunkKey(neighborX, neighborZ);
        const neighbor = byKey.get(key);
        if (!neighbor || visited.has(key)) {
          continue;
        }
        visited.add(key);
        queue.push(neighbor);
      }
    }

    components.push(component);
  }

  components.sort((left, right) => {
    const leftCount = left.reduce((sum, summary) => sum + summary.count, 0);
    const rightCount = right.reduce((sum, summary) => sum + summary.count, 0);
    return rightCount - leftCount;
  });

  return components[0] ?? [];
}

export async function importLocalStructureWorldAsModel(input: {
  filePath: string;
  title?: string;
  sourceVersion?: string;
}): Promise<GrabCraftModelArtifact> {
  const world = await resolveWorldRoot(input.filePath);
  const regionDir = path.join(world.worldRoot, 'region');
  const mcVersion = input.sourceVersion?.trim() || DEFAULT_WORLD_VERSION;
  const Provider = Anvil(mcVersion);
  const provider = new Provider(regionDir);

  try {
    const regionEntries = await fs.readdir(regionDir, { withFileTypes: true });
    const chunkSummaries: ChunkSummary[] = [];

    for (const entry of regionEntries) {
      if (!entry.isFile()) {
        continue;
      }
      const coords = parseRegionCoordinates(entry.name);
      if (!coords) {
        continue;
      }

      const region = await provider.getRegion(coords.regionX * 32, coords.regionZ * 32);
      for (let localX = 0; localX < 32; localX += 1) {
        for (let localZ = 0; localZ < 32; localZ += 1) {
          if (!region.hasChunk(localX, localZ)) {
            continue;
          }
          const chunkX = coords.regionX * 32 + localX;
          const chunkZ = coords.regionZ * 32 + localZ;
          const chunk = await provider.load(chunkX, chunkZ);
          if (!chunk) {
            continue;
          }

          let summary: ChunkSummary | null = null;
          for (let y = 0; y < DEFAULT_HEIGHT; y += 1) {
            for (let x = 0; x < 16; x += 1) {
              for (let z = 0; z < 16; z += 1) {
                const block = chunk.getBlock(new Vec3(x, y, z));
                if (DISCOVERY_SKIP_BLOCKS.has(block.name)) {
                  continue;
                }
                const globalX = chunkX * 16 + x;
                const globalZ = chunkZ * 16 + z;
                if (!summary) {
                  summary = {
                    chunkX,
                    chunkZ,
                    count: 0,
                    minX: globalX,
                    maxX: globalX,
                    minY: y,
                    maxY: y,
                    minZ: globalZ,
                    maxZ: globalZ
                  };
                }
                summary.count += 1;
                summary.minX = Math.min(summary.minX, globalX);
                summary.maxX = Math.max(summary.maxX, globalX);
                summary.minY = Math.min(summary.minY, y);
                summary.maxY = Math.max(summary.maxY, y);
                summary.minZ = Math.min(summary.minZ, globalZ);
                summary.maxZ = Math.max(summary.maxZ, globalZ);
              }
            }
          }

          if (summary && summary.count > 0) {
            chunkSummaries.push(summary);
          }
        }
      }
    }

    if (chunkSummaries.length === 0) {
      throw new Error(`No man-made structure blocks were found in ${input.filePath}.`);
    }

    const selectedComponent = selectDominantComponent(chunkSummaries);
    if (selectedComponent.length === 0) {
      throw new Error(`Could not isolate a dominant structure from ${input.filePath}.`);
    }
    const bbox = mergeBoundingBoxes(selectedComponent);
    const minChunkX = Math.floor(bbox.minX / 16);
    const maxChunkX = Math.floor(bbox.maxX / 16);
    const minChunkZ = Math.floor(bbox.minZ / 16);
    const maxChunkZ = Math.floor(bbox.maxZ / 16);

    const paletteCounts = new Map<string, number>();
    const layerCounts = new Map<number, number>();
    const layerPalettes = new Map<number, Set<string>>();
    const blocks: GrabCraftModelArtifact['blocks'] = [];

    for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX += 1) {
      for (let chunkZ = minChunkZ; chunkZ <= maxChunkZ; chunkZ += 1) {
        const chunk = await provider.load(chunkX, chunkZ);
        if (!chunk) {
          continue;
        }

        const localMinX = chunkX === minChunkX ? Math.max(0, bbox.minX - chunkX * 16) : 0;
        const localMaxX = chunkX === maxChunkX ? Math.min(15, bbox.maxX - chunkX * 16) : 15;
        const localMinZ = chunkZ === minChunkZ ? Math.max(0, bbox.minZ - chunkZ * 16) : 0;
        const localMaxZ = chunkZ === maxChunkZ ? Math.min(15, bbox.maxZ - chunkZ * 16) : 15;

        for (let y = bbox.minY; y <= bbox.maxY; y += 1) {
          for (let x = localMinX; x <= localMaxX; x += 1) {
            for (let z = localMinZ; z <= localMaxZ; z += 1) {
              const block = chunk.getBlock(new Vec3(x, y, z));
              if (EXPORT_SKIP_BLOCKS.has(block.name)) {
                continue;
              }
              const globalX = chunkX * 16 + x;
              const globalZ = chunkZ * 16 + z;
              const blockState = serializeBlockState(
                block.name,
                typeof block.getProperties === 'function' ? block.getProperties() : {}
              );
              blocks.push({
                x: globalX,
                y,
                z: globalZ,
                paletteKey: blockState
              });
              paletteCounts.set(blockState, (paletteCounts.get(blockState) ?? 0) + 1);
              layerCounts.set(y, (layerCounts.get(y) ?? 0) + 1);
              const paletteSet = layerPalettes.get(y) ?? new Set<string>();
              paletteSet.add(blockState);
              layerPalettes.set(y, paletteSet);
            }
          }
        }
      }
    }

    if (blocks.length === 0) {
      throw new Error(`No non-terrain structure blocks were exported from ${input.filePath}.`);
    }

    const palette: GrabCraftModelArtifact['palette'] = Array.from(paletteCounts.entries())
      .sort((left, right) => right[1] - left[1])
      .map(([blockState, count]) => ({
        paletteKey: blockState,
        materialId: blockState,
        name: blockState,
        transparent: blockState.includes('glass') || blockState.includes('air') || blockState.includes('torch') || blockState.includes('bars') || blockState.includes('fence'),
        opacity: 1,
        count
      }));

    const layers: GrabCraftModelArtifact['layers'] = Array.from(layerCounts.entries())
      .sort((left, right) => left[0] - right[0])
      .map(([y, blockCount]) => ({
        y,
        blockCount,
        paletteKeys: Array.from(layerPalettes.get(y) ?? []).sort()
      }));

    const title = input.title?.trim() || world.titleHint.replace(/\s+/g, ' ').trim() || slugify(path.basename(input.filePath));
    const sourcePath = path.resolve(input.filePath);

    return {
      schemaVersion: '1.0',
      kind: 'grabcraft-model',
      source: {
        pageUrl: `file://${sourcePath}`,
        fetchedAt: new Date().toISOString(),
        title,
        dimensions: {
          x: bbox.maxX - bbox.minX + 1,
          y: bbox.maxY - bbox.minY + 1,
          z: bbox.maxZ - bbox.minZ + 1
        },
        blueprintBaseUrl: sourcePath,
        blueprintLayerCount: layers.length
      },
      stats: {
        importedBlocks: blocks.length,
        paletteSize: palette.length,
        layerCount: layers.length,
        bounds: {
          minX: bbox.minX,
          maxX: bbox.maxX,
          minY: bbox.minY,
          maxY: bbox.maxY,
          minZ: bbox.minZ,
          maxZ: bbox.maxZ
        }
      },
      palette,
      layers,
      blocks
    };
  } finally {
    await provider.close().catch(() => undefined);
    if (world.cleanupPath) {
      await fs.rm(world.cleanupPath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
