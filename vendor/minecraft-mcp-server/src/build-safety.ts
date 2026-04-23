import type { BoundingBox } from './build-coordination.js';

export interface SafetyLimits {
  maxFootprint: number;
  maxVolume: number;
  maxAirOperations: number;
  maxManMadeRatio: number;
  minSamplesForDensityGuard: number;
}

export interface SafetyValidationInput {
  bounds: BoundingBox;
  plannedOperations: number;
  plannedAirOperations: number;
}

export interface DensityAssessment {
  manMadeBlocks: number;
  naturalBlocks: number;
  sampledBlocks: number;
  ratio: number;
}

const NATURAL_BLOCKS_EXACT = new Set([
  'stone',
  'dirt',
  'grass_block',
  'coarse_dirt',
  'sand',
  'red_sand',
  'gravel',
  'water',
  'lava',
  'mud',
  'snow',
  'ice',
  'clay',
  'deepslate',
  'andesite',
  'diorite',
  'granite',
  'basalt',
  'netherrack',
  'blackstone',
  'moss_block',
  'podzol'
]);

const NATURAL_BLOCK_SUFFIXES = [
  '_log',
  '_leaves',
  '_mushroom',
  '_sapling',
  '_flower',
  '_tulip'
];

const NATURAL_BLOCK_SUBSTRINGS = [
  'grass',
  'fern',
  'vine',
  'flower',
  'lily',
  'cornflower',
  'orchid'
];

export const DEFAULT_SAFETY_LIMITS: SafetyLimits = {
  maxFootprint: 1200,
  maxVolume: 4200,
  maxAirOperations: 900,
  maxManMadeRatio: 0.18,
  minSamplesForDensityGuard: 18
};

export function getFootprint(bounds: BoundingBox): number {
  return (bounds.maxX - bounds.minX + 1) * (bounds.maxZ - bounds.minZ + 1);
}

export function getVolume(bounds: BoundingBox): number {
  return (
    (bounds.maxX - bounds.minX + 1) *
    (bounds.maxY - bounds.minY + 1) *
    (bounds.maxZ - bounds.minZ + 1)
  );
}

export function validateSafetyLimits(
  input: SafetyValidationInput,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS
): void {
  const footprint = getFootprint(input.bounds);
  if (footprint > limits.maxFootprint) {
    throw new Error(
      `Operation footprint ${footprint} exceeds limit ${limits.maxFootprint}. ` +
      `Split the task into smaller zones.`
    );
  }

  const volume = getVolume(input.bounds);
  if (volume > limits.maxVolume) {
    throw new Error(
      `Operation volume ${volume} exceeds limit ${limits.maxVolume}. ` +
      `Split the task into smaller phases.`
    );
  }

  if (input.plannedOperations > limits.maxVolume) {
    throw new Error(
      `Planned edits ${input.plannedOperations} exceed limit ${limits.maxVolume}. ` +
      `Use more, smaller calls.`
    );
  }

  if (input.plannedAirOperations > limits.maxAirOperations) {
    throw new Error(
      `Planned air edits ${input.plannedAirOperations} exceed strict limit ${limits.maxAirOperations}. ` +
      `Large destructive clears are blocked.`
    );
  }
}

export function shouldEnforceOccupiedAreaGuard(
  input: SafetyValidationInput
): boolean {
  return input.plannedAirOperations > 0;
}

export function classifyBlockNature(blockName: string | null | undefined): 'natural' | 'manmade' | 'empty' {
  if (!blockName || blockName === 'air' || blockName === 'cave_air' || blockName === 'void_air') {
    return 'empty';
  }

  const normalized = blockName.toLowerCase();
  if (NATURAL_BLOCKS_EXACT.has(normalized)) {
    return 'natural';
  }

  if (NATURAL_BLOCK_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return 'natural';
  }

  if (NATURAL_BLOCK_SUBSTRINGS.some((part) => normalized.includes(part))) {
    return 'natural';
  }

  return 'manmade';
}

export function assessManMadeDensity(
  bounds: BoundingBox,
  sampleBlockName: (x: number, y: number, z: number) => string | null | undefined
): DensityAssessment {
  const width = bounds.maxX - bounds.minX + 1;
  const depth = bounds.maxZ - bounds.minZ + 1;
  const stepX = Math.max(1, Math.floor(width / 10));
  const stepZ = Math.max(1, Math.floor(depth / 10));

  let manMadeBlocks = 0;
  let naturalBlocks = 0;
  let sampledBlocks = 0;

  for (let x = bounds.minX; x <= bounds.maxX; x += stepX) {
    for (let z = bounds.minZ; z <= bounds.maxZ; z += stepZ) {
      for (let y = bounds.maxY; y >= bounds.minY; y--) {
        const type = classifyBlockNature(sampleBlockName(x, y, z));
        if (type === 'empty') {
          continue;
        }
        sampledBlocks += 1;
        if (type === 'manmade') {
          manMadeBlocks += 1;
        } else {
          naturalBlocks += 1;
        }
        break;
      }
    }
  }

  const ratio = sampledBlocks === 0 ? 0 : manMadeBlocks / sampledBlocks;
  return {
    manMadeBlocks,
    naturalBlocks,
    sampledBlocks,
    ratio
  };
}

export function enforceDensityGuard(
  assessment: DensityAssessment,
  limits: SafetyLimits = DEFAULT_SAFETY_LIMITS
): void {
  if (assessment.sampledBlocks < limits.minSamplesForDensityGuard) {
    return;
  }

  if (assessment.ratio > limits.maxManMadeRatio) {
    throw new Error(
      `Area appears occupied by existing builds (man-made ratio ${(assessment.ratio * 100).toFixed(1)}%). ` +
      `Choose another reserved zone to avoid destructive overlap.`
    );
  }
}
