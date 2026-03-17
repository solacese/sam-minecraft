export interface VillageLayoutInput {
  centerX: number;
  centerZ: number;
  rows: number;
  cols: number;
  houseCount?: number;
  houseWidth?: number;
  houseDepth?: number;
  bufferBlocks?: number;
  builders?: string[];
  styles?: string[];
}

export interface VillageLayoutSlot {
  houseId: string;
  index: number;
  centerX: number;
  centerZ: number;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  style: string;
  builder: string;
}

export interface VillageLayoutPlan {
  slots: VillageLayoutSlot[];
  bounds: {
    minX: number;
    minZ: number;
    maxX: number;
    maxZ: number;
  };
  meta: {
    rows: number;
    cols: number;
    requestedHouses: number;
    generatedHouses: number;
    houseWidth: number;
    houseDepth: number;
    bufferBlocks: number;
  };
}

export interface RelayProgressEvent {
  zoneId: string;
  phase: string;
  timestamp: number;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function formatHouseId(index: number): string {
  return `house_${String(index).padStart(2, '0')}`;
}

function normalizedList(input: string[] | undefined, fallback: string[]): string[] {
  if (!input || input.length === 0) {
    return fallback;
  }

  const cleaned = input
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return cleaned.length > 0 ? cleaned : fallback;
}

export function planVillageLayout(input: VillageLayoutInput): VillageLayoutPlan {
  const rows = clampInt(input.rows, 1, 12);
  const cols = clampInt(input.cols, 1, 12);
  const houseWidth = clampInt(input.houseWidth ?? 7, 3, 21);
  const houseDepth = clampInt(input.houseDepth ?? 7, 3, 21);
  const bufferBlocks = clampInt(input.bufferBlocks ?? 2, 0, 12);
  const gridCapacity = rows * cols;
  const requestedHouses = clampInt(input.houseCount ?? gridCapacity, 1, gridCapacity);

  const builders = normalizedList(input.builders, [
    'MinecraftAgent',
    'BuildBeaAgent',
    'SupplySidAgent'
  ]);
  const styles = normalizedList(input.styles, ['oak', 'spruce', 'birch']);

  const stepX = houseWidth + bufferBlocks;
  const stepZ = houseDepth + bufferBlocks;
  const startX = Math.floor(input.centerX) - Math.floor(((cols - 1) * stepX) / 2);
  const startZ = Math.floor(input.centerZ) - Math.floor(((rows - 1) * stepZ) / 2);

  const slots: VillageLayoutSlot[] = [];
  let counter = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (counter >= requestedHouses) {
        break;
      }
      counter += 1;

      const centerX = startX + col * stepX;
      const centerZ = startZ + row * stepZ;
      const x1 = centerX - Math.floor(houseWidth / 2);
      const z1 = centerZ - Math.floor(houseDepth / 2);
      const x2 = x1 + houseWidth - 1;
      const z2 = z1 + houseDepth - 1;

      slots.push({
        houseId: formatHouseId(counter),
        index: counter,
        centerX,
        centerZ,
        x1,
        z1,
        x2,
        z2,
        style: styles[(counter - 1) % styles.length],
        builder: builders[(counter - 1) % builders.length]
      });
    }
    if (counter >= requestedHouses) {
      break;
    }
  }

  const minX = Math.min(...slots.map((slot) => slot.x1));
  const minZ = Math.min(...slots.map((slot) => slot.z1));
  const maxX = Math.max(...slots.map((slot) => slot.x2));
  const maxZ = Math.max(...slots.map((slot) => slot.z2));

  return {
    slots,
    bounds: {
      minX,
      minZ,
      maxX,
      maxZ
    },
    meta: {
      rows,
      cols,
      requestedHouses,
      generatedHouses: slots.length,
      houseWidth,
      houseDepth,
      bufferBlocks
    }
  };
}

export function latestZonePhase(
  events: RelayProgressEvent[],
  zoneId: string
): RelayProgressEvent | null {
  let latest: RelayProgressEvent | null = null;

  for (const event of events) {
    if (event.zoneId !== zoneId) {
      continue;
    }
    if (!latest || event.timestamp > latest.timestamp) {
      latest = event;
    }
  }

  return latest;
}

export function zoneHasPhase(
  events: RelayProgressEvent[],
  zoneId: string,
  requiredPhase: string
): boolean {
  const target = requiredPhase.trim().toLowerCase();
  return events.some((event) =>
    event.zoneId === zoneId &&
    event.phase.trim().toLowerCase() === target
  );
}
