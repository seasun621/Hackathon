export type PlannedRoadClass = 'street' | 'avenue' | 'grand-avenue';

export interface LandmarkInfluence {
  chunkX: number;
  chunkZ: number;
  distance: number;
  macroX: number;
  macroZ: number;
  variant: number;
}

export type GameplayZone = 'safe-hub' | 'combat-arena' | 'reward-landmark' | 'city';

export interface GameplayZonePlan {
  kind: GameplayZone;
  dangerTier: number;
  arenaVariant: number;
}

const LANDMARK_CELL_SIZE = 9;

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

export function hashCoordinates(x: number, z: number): number {
  const value = Math.imul(x + 1703, 73856093) ^ Math.imul(z - 2909, 19349663);
  return Math.abs(value | 0);
}

function hashLine(index: number, axis: 'x' | 'z'): number {
  return hashCoordinates(index, axis === 'x' ? 7411 : -6271);
}

function isLocalMinimum(index: number, axis: 'x' | 'z', radius: number): boolean {
  const score = hashLine(index, axis);
  for (let offset = -radius; offset <= radius; offset += 1) {
    if (offset === 0) continue;
    if (hashLine(index + offset, axis) < score) return false;
  }
  return true;
}

/** Long road lines are selected by deterministic spacing, not a visible modulo. */
export function plannedRoadClass(index: number, axis: 'x' | 'z'): PlannedRoadClass {
  if (index === 0) return 'grand-avenue';
  if (isLocalMinimum(index, axis, 4)) return 'grand-avenue';
  if (isLocalMinimum(index, axis, 1)) return 'avenue';
  return 'street';
}

function landmarkForCell(macroX: number, macroZ: number): LandmarkInfluence {
  const hash = hashCoordinates(macroX, macroZ);
  const margin = 1;
  const usable = LANDMARK_CELL_SIZE - margin * 2;
  const chunkX = macroX * LANDMARK_CELL_SIZE + margin + positiveModulo(hash, usable);
  const chunkZ = macroZ * LANDMARK_CELL_SIZE
    + margin
    + positiveModulo(hash >> 7, usable);
  return {
    chunkX,
    chunkZ,
    distance: 0,
    macroX,
    macroZ,
    variant: positiveModulo(hash >> 13, 3),
  };
}

export function nearestLandmark(chunkX: number, chunkZ: number): LandmarkInfluence {
  const baseMacroX = Math.floor(chunkX / LANDMARK_CELL_SIZE);
  const baseMacroZ = Math.floor(chunkZ / LANDMARK_CELL_SIZE);
  let nearest = landmarkForCell(baseMacroX, baseMacroZ);
  nearest.distance = Math.hypot(chunkX - nearest.chunkX, chunkZ - nearest.chunkZ);

  for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
    for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
      const candidate = landmarkForCell(baseMacroX + offsetX, baseMacroZ + offsetZ);
      candidate.distance = Math.hypot(chunkX - candidate.chunkX, chunkZ - candidate.chunkZ);
      if (candidate.distance < nearest.distance) nearest = candidate;
    }
  }
  return nearest;
}

/** Select a few continuous diagonal city axes without repeating every N chunks. */
export function hasDiagonalBoulevard(chunkX: number, chunkZ: number): boolean {
  const diagonalId = chunkX - chunkZ;
  return positiveModulo(hashLine(diagonalId, 'x'), 23) === 0;
}

export function isCivicIntersection(chunkX: number, chunkZ: number): boolean {
  if (chunkX === 0 && chunkZ === 0) return true;
  const vertical = plannedRoadClass(chunkX, 'x');
  const horizontal = plannedRoadClass(chunkZ, 'z');
  return vertical === 'grand-avenue'
    && horizontal === 'grand-avenue'
    && positiveModulo(hashCoordinates(chunkX, chunkZ), 4) === 0;
}

function arenaForCell(cellX: number, cellZ: number): { chunkX: number; chunkZ: number } {
  const hash = hashCoordinates(cellX + 917, cellZ - 431);
  const size = 5;
  return {
    chunkX: cellX * size + 1 + positiveModulo(hash, size - 2),
    chunkZ: cellZ * size + 1 + positiveModulo(hash >> 6, size - 2),
  };
}

/**
 * Spatial metadata for a future run/stage director. It is deliberately pure:
 * the city exposes useful spaces without depending on combat or economy code.
 */
export function gameplayZoneFor(
  chunkX: number,
  chunkZ: number,
  landmark: boolean,
): GameplayZonePlan {
  const distanceFromStart = Math.hypot(chunkX, chunkZ);
  const dangerTier = Math.min(5, Math.max(0, Math.floor(distanceFromStart / 5)));
  if (distanceFromStart < 1.1) {
    return { kind: 'safe-hub', dangerTier: 0, arenaVariant: 0 };
  }
  if (landmark) {
    return {
      kind: 'reward-landmark',
      dangerTier,
      arenaVariant: positiveModulo(hashCoordinates(chunkX, chunkZ), 3),
    };
  }

  const cellSize = 5;
  const cellX = Math.floor(chunkX / cellSize);
  const cellZ = Math.floor(chunkZ / cellSize);
  for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
    for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
      const arena = arenaForCell(cellX + offsetX, cellZ + offsetZ);
      if (arena.chunkX === chunkX && arena.chunkZ === chunkZ) {
        return {
          kind: 'combat-arena',
          dangerTier: Math.max(1, dangerTier),
          arenaVariant: positiveModulo(hashCoordinates(cellX, cellZ) >> 9, 3),
        };
      }
    }
  }
  return { kind: 'city', dangerTier, arenaVariant: 0 };
}
