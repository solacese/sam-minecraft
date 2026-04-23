import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import type { GrabCraftModelArtifact } from './grabcraft-import.js';

export interface PlacementBlock {
  x: number;
  y: number;
  z: number;
  blockState: string;
  blockName: string;
  originalPaletteKey: string;
}

export interface PlacementPlan {
  translatedBlocks: PlacementBlock[];
  skippedPalette: Array<{ paletteKey: string; reason: string }>;
  sourceBlockCount: number;
}

interface VerifyResult {
  verifiedSamples: number;
  mismatches: Array<{
    x: number;
    y: number;
    z: number;
    expected: string;
    actual: string | null;
  }>;
}

const MC_DATA = minecraftData('1.21.4');

function toSnakeCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function baseBlockName(blockState: string): string {
  return blockState.replace(/^minecraft:/, '').split('[', 1)[0];
}

function modernFacing(value: string): 'north' | 'south' | 'east' | 'west' {
  const facing = value.toLowerCase();
  if (facing === 'north' || facing === 'south' || facing === 'east' || facing === 'west') {
    return facing;
  }
  throw new Error(`Unsupported facing: ${value}`);
}

const SPECIAL_BLOCK_MAP: Record<string, string> = {
  'Stone': 'minecraft:stone',
  'Cobblestone': 'minecraft:cobblestone',
  'Bedrock': 'minecraft:bedrock',
  'Diamond Ore': 'minecraft:diamond_ore',
  'Coal Ore': 'minecraft:coal_ore',
  'Grass': 'minecraft:grass_block',
  'Sandstone': 'minecraft:sandstone',
  'Oak Wood Plank': 'minecraft:oak_planks',
  'Spruce Wood Plank': 'minecraft:spruce_planks',
  'Jungle Wood Plank': 'minecraft:jungle_planks',
  'Double Stone Slab': 'minecraft:smooth_stone',
  'Stone Slab': 'minecraft:smooth_stone_slab[type=bottom,waterlogged=false]',
  'Stone Slab (Upper)': 'minecraft:smooth_stone_slab[type=top,waterlogged=false]',
  'Stone Brick Slab': 'minecraft:stone_brick_slab[type=bottom,waterlogged=false]',
  'Stone Brick Slab (Upper)': 'minecraft:stone_brick_slab[type=top,waterlogged=false]',
  'Double Cobblestone Slab': 'minecraft:cobblestone',
  'Cobblestone Slab': 'minecraft:cobblestone_slab[type=bottom,waterlogged=false]',
  'Cobblestone (Upper)': 'minecraft:cobblestone_slab[type=top,waterlogged=false]',
  'Sandstone Slab': 'minecraft:sandstone_slab[type=bottom,waterlogged=false]',
  'Sandstone Slab (Upper)': 'minecraft:sandstone_slab[type=top,waterlogged=false]',
  'Double Quartz Slab': 'minecraft:quartz_block',
  'Quartz Slab (Upper)': 'minecraft:quartz_slab[type=top,waterlogged=false]',
  'Chiseled Stone Bricks': 'minecraft:chiseled_stone_bricks',
  'End Stone': 'minecraft:end_stone',
  'White Wool': 'minecraft:white_wool',
  'Glass': 'minecraft:glass',
  'Glowstone': 'minecraft:glowstone',
  'Wall Sign, north': 'minecraft:oak_wall_sign[facing=north,waterlogged=false]',
  'Wall Sign, south': 'minecraft:oak_wall_sign[facing=south,waterlogged=false]',
  'Wall Sign, east': 'minecraft:oak_wall_sign[facing=east,waterlogged=false]',
  'Wall Sign, west': 'minecraft:oak_wall_sign[facing=west,waterlogged=false]',
  'Torch (Facing Up)': 'minecraft:torch',
  ' (Jungle Wood, Upper)': 'minecraft:jungle_slab[type=top,waterlogged=false]'
};

function mapStairsMaterial(material: string): string | null {
  const normalized = material.toLowerCase();
  if (normalized === 'sandstone') {
    return 'minecraft:sandstone_stairs';
  }
  if (normalized === 'stone brick') {
    return 'minecraft:stone_brick_stairs';
  }
  if (normalized === 'cobblestone') {
    return 'minecraft:cobblestone_stairs';
  }
  if (normalized === 'quartz') {
    return 'minecraft:quartz_stairs';
  }
  if (normalized === 'jungle wood') {
    return 'minecraft:jungle_stairs';
  }
  return null;
}

export function translateGrabCraftBlockName(name: string): string | null {
  if (name.startsWith('minecraft:')) {
    const blockName = baseBlockName(name);
    if (MC_DATA.blocksByName[blockName]) {
      return name;
    }
  }

  const exact = SPECIAL_BLOCK_MAP[name];
  if (exact) {
    return exact;
  }

  const stairsMatch = name.match(/^(.+)\s+Stairs \((North|South|East|West), (Normal|Upside-down)\)$/i);
  if (stairsMatch) {
    const blockId = mapStairsMaterial(stairsMatch[1]);
    if (!blockId) {
      return null;
    }
    const facing = modernFacing(stairsMatch[2]);
    const half = stairsMatch[3].toLowerCase() === 'upside-down' ? 'top' : 'bottom';
    return `${blockId}[facing=${facing},half=${half},shape=straight,waterlogged=false]`;
  }

  const torchMatch = name.match(/^Torch \(Facing (North|South|East|West)\)$/i);
  if (torchMatch) {
    const facing = modernFacing(torchMatch[1]);
    return `minecraft:wall_torch[facing=${facing}]`;
  }

  const redstoneTorchMatch = name.match(/^Redstone Torch \(on\) \(Facing (North|South|East|West)\)$/i);
  if (redstoneTorchMatch) {
    const facing = modernFacing(redstoneTorchMatch[1]);
    return `minecraft:redstone_wall_torch[facing=${facing},lit=true]`;
  }

  const buttonMatch = name.match(/^Stone Button \(Facing (North|South|East|West), Inactive\)$/i);
  if (buttonMatch) {
    const facing = modernFacing(buttonMatch[1]);
    return `minecraft:stone_button[face=wall,facing=${facing},powered=false]`;
  }

  const bedMatch = name.match(/^Bed \((East|West|North|South), Empty, (Head|Foot) of the bed\)$/i);
  if (bedMatch) {
    const facing = modernFacing(bedMatch[1]);
    const part = bedMatch[2].toLowerCase() === 'head' ? 'head' : 'foot';
    return `minecraft:red_bed[facing=${facing},part=${part},occupied=false]`;
  }

  const genericName = toSnakeCase(name);
  if (genericName && MC_DATA.blocksByName[genericName]) {
    return `minecraft:${genericName}`;
  }
  return null;
}

function placementPriority(blockState: string): number {
  const blockName = baseBlockName(blockState);
  if (blockName.endsWith('_sign') || blockName.endsWith('_button') || blockName.endsWith('_torch')) {
    return 3;
  }
  if (blockName.endsWith('_bed')) {
    return 2;
  }
  if (blockName.endsWith('_slab') || blockName.endsWith('_stairs')) {
    return 1;
  }
  return 0;
}

export function buildPlacementPlan(
  artifact: GrabCraftModelArtifact,
  originX: number,
  originY: number,
  originZ: number
): PlacementPlan {
  const paletteMap = new Map(artifact.palette.map((entry) => [entry.paletteKey, entry.name]));
  const bounds = artifact.stats.bounds;
  if (!bounds) {
    throw new Error('Imported model has no bounds and cannot be placed.');
  }

  const translatedBlocks: PlacementBlock[] = [];
  const skippedPalette = new Map<string, string>();

  for (const block of artifact.blocks) {
    const paletteName = paletteMap.get(block.paletteKey);
    if (!paletteName) {
      skippedPalette.set(block.paletteKey, 'Missing palette entry');
      continue;
    }

    const blockState = translateGrabCraftBlockName(paletteName);
    if (!blockState) {
      skippedPalette.set(block.paletteKey, `Unsupported palette name: ${paletteName}`);
      continue;
    }

    translatedBlocks.push({
      x: originX + (block.x - bounds.minX),
      y: originY + (block.y - bounds.minY),
      z: originZ + (block.z - bounds.minZ),
      blockState,
      blockName: baseBlockName(blockState),
      originalPaletteKey: block.paletteKey
    });
  }

  translatedBlocks.sort((left, right) => {
    if (left.y !== right.y) {
      return left.y - right.y;
    }
    const priorityDelta = placementPriority(left.blockState) - placementPriority(right.blockState);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }
    if (left.x !== right.x) {
      return left.x - right.x;
    }
    return left.z - right.z;
  });

  return {
    translatedBlocks,
    skippedPalette: Array.from(skippedPalette.entries()).map(([paletteKey, reason]) => ({ paletteKey, reason })),
    sourceBlockCount: artifact.blocks.length
  };
}

export async function streamRconCommands(commands: string[], cwd: string): Promise<void> {
  if (commands.length === 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn('docker', ['compose', 'exec', '-T', 'mc', 'rcon-cli'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    child.stdout.on('data', () => {
      // Drain echoed RCON output so large placements do not block on stdout backpressure.
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `rcon-cli exited with code ${code}`));
    });

    child.stdin.write(commands.join('\n'));
    child.stdin.end('\n');
  });
}

async function waitForMinecraft(host: string, port: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const bot = mineflayer.createBot({
        host,
        port,
        username: `GvPing${Math.floor(Math.random() * 10000)}`,
        version: '1.21.4'
      });
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          bot.removeAllListeners();
        };
        bot.once('spawn', () => {
          cleanup();
          bot.quit();
          resolve();
        });
        bot.once('error', (error) => {
          cleanup();
          bot.quit();
          reject(error);
        });
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }

  throw new Error('Minecraft server was not ready within 60 seconds.');
}

export async function verifyPlacedBlocks(
  host: string,
  port: number,
  expected: PlacementBlock[],
  sampleCount: number,
  rconCwd?: string
): Promise<VerifyResult> {
  if (expected.length === 0 || sampleCount <= 0) {
    return {
      verifiedSamples: 0,
      mismatches: []
    };
  }

  const bot = mineflayer.createBot({
    host,
    port,
    username: `GvChk${Math.floor(Math.random() * 10000)}`,
    version: '1.21.4'
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Verifier bot timed out while joining the server.'));
    }, 20_000);

    bot.once('spawn', () => {
      clearTimeout(timer);
      resolve();
    });
    bot.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  try {
    if (rconCwd) {
      const xs = expected.map((block) => block.x);
      const ys = expected.map((block) => block.y);
      const zs = expected.map((block) => block.z);
      const tpX = Math.floor((Math.min(...xs) + Math.max(...xs)) / 2);
      const tpY = Math.max(...ys) + 6;
      const tpZ = Math.floor((Math.min(...zs) + Math.max(...zs)) / 2);
      await streamRconCommands([`/tp ${bot.username} ${tpX} ${tpY} ${tpZ}`], rconCwd);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    if (typeof (bot as any).waitForChunksToLoad === 'function') {
      await (bot as any).waitForChunksToLoad();
    } else {
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    const sampleIndices = new Set<number>();
    if (sampleCount >= expected.length) {
      for (let index = 0; index < expected.length; index += 1) {
        sampleIndices.add(index);
      }
    } else {
      for (let sample = 0; sample < sampleCount; sample += 1) {
        const index = Math.floor((sample * (expected.length - 1)) / Math.max(1, sampleCount - 1));
        sampleIndices.add(index);
      }
    }

    const mismatches: VerifyResult['mismatches'] = [];
    for (const index of Array.from(sampleIndices).sort((left, right) => left - right)) {
      const block = expected[index];
      const actual = bot.blockAt(new Vec3(block.x, block.y, block.z));
      const actualName = actual?.name ?? null;
      if (actualName !== block.blockName) {
        mismatches.push({
          x: block.x,
          y: block.y,
          z: block.z,
          expected: block.blockName,
          actual: actualName
        });
      }
    }

    return {
      verifiedSamples: sampleIndices.size,
      mismatches
    };
  } finally {
    bot.quit();
  }
}

async function runCli(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('grabcraft-place')
    .usage('$0 --input model.json --x 20 --y 65 --z 20 [options]')
    .option('input', {
      type: 'string',
      demandOption: true,
      describe: 'Path to a GrabCraft model artifact JSON file'
    })
    .option('x', {
      type: 'number',
      demandOption: true,
      describe: 'Target origin X for the imported model'
    })
    .option('y', {
      type: 'number',
      demandOption: true,
      describe: 'Target origin Y for the imported model'
    })
    .option('z', {
      type: 'number',
      demandOption: true,
      describe: 'Target origin Z for the imported model'
    })
    .option('host', {
      type: 'string',
      default: '127.0.0.1',
      describe: 'Minecraft host for verification'
    })
    .option('port', {
      type: 'number',
      default: 25565,
      describe: 'Minecraft port for verification'
    })
    .option('verify-samples', {
      type: 'number',
      default: 20,
      describe: 'How many evenly spread translated blocks to verify with a bot after placement'
    })
    .option('max-blocks', {
      type: 'number',
      describe: 'Optional cap on number of translated blocks to place'
    })
    .option('clear', {
      type: 'boolean',
      default: false,
      describe: 'Clear the placement bounding box to air before placing'
    })
    .strict()
    .help()
    .parse();

  const inputPath = path.resolve(argv.input);
  const artifact = JSON.parse(await fs.readFile(inputPath, 'utf8')) as GrabCraftModelArtifact;

  if (artifact.kind !== 'grabcraft-model') {
    throw new Error(`Expected a grabcraft-model artifact, got ${artifact.kind}.`);
  }

  const plan = buildPlacementPlan(artifact, Math.floor(argv.x), Math.floor(argv.y), Math.floor(argv.z));
  const translatedBlocks =
    argv['max-blocks'] && argv['max-blocks'] > 0
      ? plan.translatedBlocks.slice(0, argv['max-blocks'])
      : plan.translatedBlocks;

  if (translatedBlocks.length === 0) {
    throw new Error('No translated blocks were produced for placement.');
  }

  const commands: string[] = [];
  const xs = translatedBlocks.map((block) => block.x);
  const ys = translatedBlocks.map((block) => block.y);
  const zs = translatedBlocks.map((block) => block.z);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);

  commands.push(`/forceload add ${minX} ${minZ} ${maxX} ${maxZ}`);
  if (argv.clear) {
    commands.push(
      `/fill ${minX} ${minY} ${minZ} ${maxX} ${maxY} ${maxZ} minecraft:air`
    );
  }
  for (const block of translatedBlocks) {
    commands.push(`/setblock ${block.x} ${block.y} ${block.z} ${block.blockState}`);
  }

  await streamRconCommands(commands, path.resolve(process.cwd(), '..', '..'));
  await waitForMinecraft(argv.host, argv.port);
  const verification = await verifyPlacedBlocks(
    argv.host,
    argv.port,
    translatedBlocks,
    argv['verify-samples'],
    path.resolve(process.cwd(), '..', '..')
  );

  const skippedSummary = plan.skippedPalette.length
    ? `${plan.skippedPalette.length} palette entries skipped`
    : 'no skipped palette entries';

  process.stdout.write(
    `Placed ${translatedBlocks.length}/${plan.sourceBlockCount} translated blocks from ${artifact.source.title}; ${skippedSummary}. Verified ${verification.verifiedSamples} samples with ${verification.mismatches.length} mismatches.\n`
  );

  if (verification.mismatches.length > 0) {
    process.stdout.write(`${JSON.stringify(verification.mismatches.slice(0, 10), null, 2)}\n`);
    process.exitCode = 2;
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).toString()) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
