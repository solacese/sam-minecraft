export interface SetblockPlacement {
  x: number;
  y: number;
  z: number;
  blockType: string;
}

export interface GroundedPlacementInput {
  blockType: string;
  y: number;
  targetOccupied: boolean;
  hasSolidNeighbor: boolean;
  surfaceY: number;
  belowIsSolid: boolean;
  aboveIsAir: boolean;
}

const FLOWER_BLOCKS = new Set([
  'poppy',
  'dandelion',
  'blue_orchid',
  'allium',
  'azure_bluet',
  'red_tulip',
  'orange_tulip',
  'white_tulip',
  'pink_tulip',
  'oxeye_daisy',
  'cornflower',
  'lily_of_the_valley',
  'sunflower',
  'lilac',
  'rose_bush',
  'peony'
]);

const PATH_BLOCKS = new Set([
  'dirt_path',
  'gravel'
]);

const AIR_BLOCKS = new Set([
  'air',
  'cave_air',
  'void_air'
]);

export function stripBlockState(blockType: string): string {
  const raw = String(blockType).trim().toLowerCase();
  const stateIndex = raw.indexOf('[');
  return stateIndex >= 0 ? raw.slice(0, stateIndex) : raw;
}

function shortBlockName(blockType: string): string {
  return stripBlockState(blockType).replace(/^minecraft:/, '');
}

export function normalizeBlockTypeId(blockType: string): string {
  const normalized = stripBlockState(blockType);
  return normalized.startsWith('minecraft:') ? normalized : `minecraft:${normalized}`;
}

export function isAirLikeBlockType(blockType: string): boolean {
  return AIR_BLOCKS.has(shortBlockName(blockType));
}

export function isFlowerBlockType(blockType: string): boolean {
  return FLOWER_BLOCKS.has(shortBlockName(blockType));
}

export function isTorchBlockType(blockType: string): boolean {
  const name = shortBlockName(blockType);
  return name === 'torch' || name === 'soul_torch' || name === 'redstone_torch';
}

export function isPathBlockType(blockType: string): boolean {
  return PATH_BLOCKS.has(shortBlockName(blockType));
}

export function parseSetblockPlacement(command: string): SetblockPlacement | null {
  const match = /^\/setblock\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+([^\s]+)(?:\s+.*)?$/i.exec(command.trim());
  if (!match) {
    return null;
  }

  return {
    x: Number(match[1]),
    y: Number(match[2]),
    z: Number(match[3]),
    blockType: match[4]
  };
}

export function validateGroundedPlacement(input: GroundedPlacementInput): string | null {
  const normalizedBlock = normalizeBlockTypeId(input.blockType);
  const blockName = shortBlockName(normalizedBlock);

  if (isAirLikeBlockType(normalizedBlock)) {
    return null;
  }

  if (!input.targetOccupied && !input.hasSolidNeighbor) {
    return `Refusing floating placement of ${blockName}; no solid neighboring block`;
  }

  if (isFlowerBlockType(normalizedBlock) || isTorchBlockType(normalizedBlock)) {
    if (!input.belowIsSolid) {
      return `Ground decoration ${blockName} requires a solid block directly below`;
    }

    if (input.y !== input.surfaceY) {
      return `Ground decoration ${blockName} must be placed at surface level Y=${input.surfaceY}`;
    }
  }

  if (isPathBlockType(normalizedBlock)) {
    const requiredY = input.surfaceY - 1;

    if (!input.belowIsSolid) {
      return `Path block ${blockName} requires solid terrain below`;
    }

    if (input.y !== requiredY) {
      return `Path block ${blockName} must be placed on ground layer Y=${requiredY}`;
    }

    if (!input.aboveIsAir) {
      return `Path block ${blockName} needs open air above`;
    }
  }

  return null;
}
