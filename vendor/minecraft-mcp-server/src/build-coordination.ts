import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface BoundingBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

export interface ZoneClaim extends BoundingBox {
  zoneId: string;
  owner: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

export interface ProgressUpdate {
  taskId: string;
  zoneId: string;
  owner: string;
  phase: string;
  note?: string;
  timestamp: number;
}

interface ClaimState {
  claims: ZoneClaim[];
}

interface ProgressState {
  updates: ProgressUpdate[];
}

export interface ClaimResult {
  ok: boolean;
  claim?: ZoneClaim;
  conflict?: ZoneClaim;
  message: string;
}

export interface ReservationCheckResult {
  ok: boolean;
  coveringClaim?: ZoneClaim;
  conflict?: ZoneClaim;
  message: string;
}

export interface ZoneAllocationInput {
  zoneId: string;
  owner: string;
  bounds: BoundingBox;
  ttlSeconds?: number;
}

export interface BatchClaimOptions {
  clearExistingForOwners?: boolean;
}

export interface BatchClaimResult {
  ok: boolean;
  claims: ZoneClaim[];
  conflict?: ZoneClaim;
  message: string;
}

const DEFAULT_LOCK_RETRIES = 120;
const LOCK_RETRY_MS = 25;
const MIN_ZONE_FOOTPRINT_GAP_BLOCKS = 2;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeBounds(
  x1: number,
  y1: number,
  z1: number,
  x2: number,
  y2: number,
  z2: number
): BoundingBox {
  return {
    minX: Math.min(x1, x2),
    minY: Math.min(y1, y2),
    minZ: Math.min(z1, z2),
    maxX: Math.max(x1, x2),
    maxY: Math.max(y1, y2),
    maxZ: Math.max(z1, z2)
  };
}

export function boxesOverlap(a: BoundingBox, b: BoundingBox): boolean {
  // Reservation conflicts are enforced in X/Z footprint space so workers cannot stack
  // structures vertically in the same ground area.
  return (
    a.minX <= b.maxX &&
    a.maxX >= b.minX &&
    a.minZ <= b.maxZ &&
    a.maxZ >= b.minZ
  );
}

export function boxesOverlapWithGap(
  a: BoundingBox,
  b: BoundingBox,
  gapBlocks: number
): boolean {
  const gap = Math.max(0, Math.floor(gapBlocks));
  return (
    a.minX <= b.maxX + gap &&
    a.maxX >= b.minX - gap &&
    a.minZ <= b.maxZ + gap &&
    a.maxZ >= b.minZ - gap
  );
}

export function boxContains(outer: BoundingBox, inner: BoundingBox): boolean {
  // Coverage checks are footprint-based for mutating operations; Y is intentionally
  // not part of claim ownership enforcement.
  return (
    outer.minX <= inner.minX &&
    outer.maxX >= inner.maxX &&
    outer.minZ <= inner.minZ &&
    outer.maxZ >= inner.maxZ
  );
}

export class BuildCoordinationStore {
  private claimsFile: string;
  private progressFile: string;
  private maxProgressEntries: number;

  constructor(
    baseDir = '/tmp/sam-minecraft-coordination',
    maxProgressEntries = 600
  ) {
    this.claimsFile = path.join(baseDir, 'zone-claims.json');
    this.progressFile = path.join(baseDir, 'progress-board.json');
    this.maxProgressEntries = maxProgressEntries;
  }

  async claimZone(
    owner: string,
    zoneId: string,
    bounds: BoundingBox,
    ttlSeconds = 900
  ): Promise<ClaimResult> {
    return this.withFileLock(this.claimsFile, async () => {
      const state = await this.readJsonFile<ClaimState>(this.claimsFile, { claims: [] });
      const now = Date.now();
      const cleanedClaims = this.removeExpiredClaims(state.claims, now);
      const normalizedZoneId = zoneId.trim();

      const conflict = cleanedClaims.find(
        (existing) =>
          existing.owner !== owner &&
          boxesOverlapWithGap(existing, bounds, MIN_ZONE_FOOTPRINT_GAP_BLOCKS)
      );

      if (conflict) {
        return {
          ok: false,
          conflict,
          message:
            `Zone claim conflict with zone '${conflict.zoneId}' owned by '${conflict.owner}' ` +
            `(${conflict.minX},${conflict.minY},${conflict.minZ})-(${conflict.maxX},${conflict.maxY},${conflict.maxZ}). ` +
            `A ${MIN_ZONE_FOOTPRINT_GAP_BLOCKS}-block footprint buffer is required between zones.`
        };
      }

      const existingIndex = cleanedClaims.findIndex(
        (claim) => claim.owner === owner && claim.zoneId === normalizedZoneId
      );

      const claim: ZoneClaim = {
        ...bounds,
        zoneId: normalizedZoneId,
        owner,
        createdAt: existingIndex >= 0 ? cleanedClaims[existingIndex].createdAt : now,
        updatedAt: now,
        expiresAt: now + Math.max(30, Math.floor(ttlSeconds)) * 1000
      };

      if (existingIndex >= 0) {
        cleanedClaims[existingIndex] = claim;
      } else {
        cleanedClaims.push(claim);
      }

      await this.writeJsonFile(this.claimsFile, { claims: cleanedClaims });

      return {
        ok: true,
        claim,
        message:
          `Zone '${claim.zoneId}' claimed for ${owner}: ` +
          `(${claim.minX},${claim.minY},${claim.minZ})-(${claim.maxX},${claim.maxY},${claim.maxZ}) ` +
          `TTL=${Math.floor((claim.expiresAt - now) / 1000)}s`
      };
    });
  }

  async releaseZone(owner: string, zoneId: string): Promise<{ released: boolean; message: string }> {
    return this.withFileLock(this.claimsFile, async () => {
      const state = await this.readJsonFile<ClaimState>(this.claimsFile, { claims: [] });
      const now = Date.now();
      const cleanedClaims = this.removeExpiredClaims(state.claims, now);
      const before = cleanedClaims.length;
      const normalizedZoneId = zoneId.trim();
      const remaining = cleanedClaims.filter(
        (claim) => !(claim.owner === owner && claim.zoneId === normalizedZoneId)
      );

      await this.writeJsonFile(this.claimsFile, { claims: remaining });

      const released = remaining.length < before;
      return {
        released,
        message: released
          ? `Released zone '${normalizedZoneId}' for ${owner}`
          : `No owned zone '${normalizedZoneId}' found for ${owner}`
      };
    });
  }

  async verifyReservation(owner: string, bounds: BoundingBox): Promise<ReservationCheckResult> {
    return this.withFileLock(this.claimsFile, async () => {
      const state = await this.readJsonFile<ClaimState>(this.claimsFile, { claims: [] });
      const now = Date.now();
      const claims = this.removeExpiredClaims(state.claims, now);
      await this.writeJsonFile(this.claimsFile, { claims });

      const conflict = claims.find(
        (claim) => claim.owner !== owner && boxesOverlapWithGap(claim, bounds, MIN_ZONE_FOOTPRINT_GAP_BLOCKS)
      );
      if (conflict) {
        return {
          ok: false,
          conflict,
          message:
            `Operation overlaps zone '${conflict.zoneId}' owned by '${conflict.owner}'. ` +
            `Request a new non-overlapping assignment with at least ${MIN_ZONE_FOOTPRINT_GAP_BLOCKS} blocks of spacing.`
        };
      }

      const coveringClaim = claims.find(
        (claim) => claim.owner === owner && boxContains(claim, bounds)
      );
      if (!coveringClaim) {
        return {
          ok: false,
          message:
            `Operation area is not fully reserved by ${owner}. Use claim-build-zone first.`
        };
      }

      return {
        ok: true,
        coveringClaim,
        message: `Reservation verified under zone '${coveringClaim.zoneId}'.`
      };
    });
  }

  async claimZonesBatch(
    allocations: ZoneAllocationInput[],
    options: BatchClaimOptions = {}
  ): Promise<BatchClaimResult> {
    return this.withFileLock(this.claimsFile, async () => {
      if (allocations.length === 0) {
        return {
          ok: false,
          claims: [],
          message: 'No zone allocations were provided.'
        };
      }

      const state = await this.readJsonFile<ClaimState>(this.claimsFile, { claims: [] });
      const now = Date.now();
      let nextClaims = this.removeExpiredClaims(state.claims, now);
      const clearExisting = options.clearExistingForOwners ?? false;

      const normalizedAllocations = allocations.map((allocation) => ({
        zoneId: allocation.zoneId.trim(),
        owner: allocation.owner.trim(),
        bounds: allocation.bounds,
        ttlSeconds: Math.max(30, Math.floor(allocation.ttlSeconds ?? 900))
      }));

      const invalid = normalizedAllocations.find(
        (allocation) => allocation.owner.length === 0 || allocation.zoneId.length === 0
      );
      if (invalid) {
        return {
          ok: false,
          claims: [],
          message: 'Every allocation must include a non-empty owner and zoneId.'
        };
      }

      if (clearExisting) {
        const targetOwners = new Set(normalizedAllocations.map((allocation) => allocation.owner));
        nextClaims = nextClaims.filter((claim) => !targetOwners.has(claim.owner));
      }

      const createdClaims: ZoneClaim[] = [];
      for (const allocation of normalizedAllocations) {
        const conflict = nextClaims.find(
          (existing) =>
            existing.owner !== allocation.owner &&
            boxesOverlapWithGap(existing, allocation.bounds, MIN_ZONE_FOOTPRINT_GAP_BLOCKS)
        );

        if (conflict) {
          return {
            ok: false,
            claims: [],
            conflict,
            message:
              `Batch allocation conflict for '${allocation.zoneId}' owner='${allocation.owner}' ` +
              `against existing zone '${conflict.zoneId}' owner='${conflict.owner}'.`
          };
        }

        const existingIndex = nextClaims.findIndex(
          (claim) => claim.owner === allocation.owner && claim.zoneId === allocation.zoneId
        );

        const claim: ZoneClaim = {
          ...allocation.bounds,
          zoneId: allocation.zoneId,
          owner: allocation.owner,
          createdAt: existingIndex >= 0 ? nextClaims[existingIndex].createdAt : now,
          updatedAt: now,
          expiresAt: now + allocation.ttlSeconds * 1000
        };

        if (existingIndex >= 0) {
          nextClaims[existingIndex] = claim;
        } else {
          nextClaims.push(claim);
        }
        createdClaims.push(claim);
      }

      await this.writeJsonFile(this.claimsFile, { claims: nextClaims });

      const owners = Array.from(new Set(createdClaims.map((claim) => claim.owner))).join(', ');
      return {
        ok: true,
        claims: createdClaims,
        message:
          `Allocated ${createdClaims.length} zones atomically for owners: ${owners}. ` +
          `All workers can start in parallel.`
      };
    });
  }

  async listClaims(): Promise<ZoneClaim[]> {
    return this.withFileLock(this.claimsFile, async () => {
      const state = await this.readJsonFile<ClaimState>(this.claimsFile, { claims: [] });
      const claims = this.removeExpiredClaims(state.claims, Date.now());
      await this.writeJsonFile(this.claimsFile, { claims });
      return claims;
    });
  }

  async reportProgress(update: Omit<ProgressUpdate, 'timestamp'>): Promise<ProgressUpdate> {
    return this.withFileLock(this.progressFile, async () => {
      const state = await this.readJsonFile<ProgressState>(this.progressFile, { updates: [] });
      const entry: ProgressUpdate = {
        ...update,
        phase: update.phase.trim(),
        note: update.note?.trim(),
        timestamp: Date.now()
      };

      state.updates.push(entry);
      if (state.updates.length > this.maxProgressEntries) {
        state.updates = state.updates.slice(-this.maxProgressEntries);
      }

      await this.writeJsonFile(this.progressFile, state);
      return entry;
    });
  }

  async getProgressBoard(taskId?: string): Promise<ProgressUpdate[]> {
    return this.withFileLock(this.progressFile, async () => {
      const state = await this.readJsonFile<ProgressState>(this.progressFile, { updates: [] });
      const updates = taskId
        ? state.updates.filter((entry) => entry.taskId === taskId)
        : state.updates;
      return updates.sort((a, b) => b.timestamp - a.timestamp);
    });
  }

  private removeExpiredClaims(claims: ZoneClaim[], now: number): ZoneClaim[] {
    return claims.filter((claim) => claim.expiresAt > now);
  }

  private async withFileLock<T>(targetFile: string, operation: () => Promise<T>): Promise<T> {
    const directory = path.dirname(targetFile);
    const lockFile = `${targetFile}.lock`;
    await fs.mkdir(directory, { recursive: true });

    for (let attempt = 0; attempt < DEFAULT_LOCK_RETRIES; attempt++) {
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
        await delay(LOCK_RETRY_MS);
      }
    }

    throw new Error(`Timed out acquiring coordination lock for ${targetFile}`);
  }

  private async readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      return JSON.parse(raw) as T;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return fallback;
      }
      throw err;
    }
  }

  private async writeJsonFile<T>(filePath: string, data: T): Promise<void> {
    const directory = path.dirname(filePath);
    await fs.mkdir(directory, { recursive: true });
    const tmpFile = `${filePath}.tmp`;
    await fs.writeFile(tmpFile, JSON.stringify(data, null, 2), 'utf8');
    await fs.rename(tmpFile, filePath);
  }
}
