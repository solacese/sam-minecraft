import type { BoundingBox } from './build-coordination.js';

export interface FillBatch {
  command: string;
  anchorX: number;
  anchorZ: number;
  blockCount: number;
}

export function buildFillBatches(
  bounds: BoundingBox,
  normalizedBlockType: string,
  tileSpan = 6
): FillBatch[] {
  const span = Math.max(1, Math.floor(tileSpan));
  const batches: FillBatch[] = [];

  for (let y = bounds.minY; y <= bounds.maxY; y++) {
    for (let x = bounds.minX; x <= bounds.maxX; x += span) {
      const x2 = Math.min(bounds.maxX, x + span - 1);
      for (let z = bounds.minZ; z <= bounds.maxZ; z += span) {
        const z2 = Math.min(bounds.maxZ, z + span - 1);
        batches.push({
          command: `/fill ${x} ${y} ${z} ${x2} ${y} ${z2} ${normalizedBlockType}`,
          anchorX: Math.floor((x + x2) / 2),
          anchorZ: Math.floor((z + z2) / 2),
          blockCount: (x2 - x + 1) * (z2 - z + 1)
        });
      }
    }
  }

  return batches;
}
