import { CONFIG } from './config';

export type RoadClass = 'street' | 'avenue' | 'grand-avenue';
export type DistrictKind =
  | 'landmark-core'
  | 'commercial-core'
  | 'boulevard'
  | 'waterfront'
  | 'civic'
  | 'neighborhood';

export type BuildingArchetype =
  | 'needle'
  | 'art-deco'
  | 'stepped'
  | 'podium-tower'
  | 'wedge'
  | 'twin-slab'
  | 'cylinder'
  | 'courtyard'
  | 'brick-midrise';

export interface RiverPlan {
  centerX: number;
  width: number;
  yaw: number;
}

export interface ChunkUrbanPlan {
  verticalRoad: RoadClass;
  horizontalRoad: RoadClass;
  verticalRoadWidth: number;
  horizontalRoadWidth: number;
  district: DistrictKind;
  density: number;
  skylineScale: number;
  landmark: boolean;
  landmarkVariant: number;
  landmarkLot: number;
  openSpaceLots: readonly number[];
  roundabout: boolean;
  diagonalBoulevard: boolean;
  river: RiverPlan | null;
}

export const ROAD_WIDTHS: Record<RoadClass, number> = {
  street: 12,
  avenue: 30,
  'grand-avenue': 50,
};

export const MAX_ROAD_WIDTH = ROAD_WIDTHS['grand-avenue'];

const LANDMARK_PERIOD = 10;
const LANDMARK_OFFSET_X = 2;
const LANDMARK_OFFSET_Z = 1;
const RIVER_BASE_X = CONFIG.chunkSize * 5.5;
const RIVER_WAVE_LENGTH = CONFIG.chunkSize * 4;
const RIVER_AMPLITUDE = CONFIG.chunkSize * 0.55;
const RIVER_WIDTH = 42;

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function signedWrappedDistance(value: number, target: number, period: number): number {
  const wrapped = positiveModulo(value - target + period / 2, period) - period / 2;
  return wrapped;
}

function hash2D(x: number, z: number): number {
  const value = Math.imul(x + 1703, 73856093) ^ Math.imul(z - 2909, 19349663);
  return Math.abs(value | 0);
}

function roadClassFor(lineIndex: number, axis: 'x' | 'z'): RoadClass {
  // Long, uninterrupted axes form the readable city skeleton. The different
  // periods stop every major intersection from becoming an identical square.
  const grandPeriod = axis === 'x' ? 10 : 8;
  if (positiveModulo(lineIndex, grandPeriod) === 0) return 'grand-avenue';

  const avenueOffset = axis === 'x' ? 1 : 2;
  if (positiveModulo(lineIndex + avenueOffset, 4) === 0) return 'avenue';
  return 'street';
}

export function riverCenterAt(worldZ: number): number {
  return RIVER_BASE_X + Math.sin(worldZ / RIVER_WAVE_LENGTH) * RIVER_AMPLITUDE;
}

function riverPlanFor(chunkX: number, chunkZ: number): RiverPlan | null {
  const centerX = chunkX * CONFIG.chunkSize;
  const centerZ = chunkZ * CONFIG.chunkSize;
  const riverX = riverCenterAt(centerZ);
  const intersects = Math.abs(centerX - riverX) < CONFIG.chunkSize / 2 + RIVER_WIDTH / 2;
  if (!intersects) return null;

  const slope = (RIVER_AMPLITUDE / RIVER_WAVE_LENGTH) * Math.cos(centerZ / RIVER_WAVE_LENGTH);
  return {
    centerX: riverX,
    width: RIVER_WIDTH,
    yaw: Math.atan(slope),
  };
}

export function createChunkUrbanPlan(chunkX: number, chunkZ: number): ChunkUrbanPlan {
  const verticalRoad = roadClassFor(chunkX, 'x');
  const horizontalRoad = roadClassFor(chunkZ, 'z');
  const dx = signedWrappedDistance(chunkX, LANDMARK_OFFSET_X, LANDMARK_PERIOD);
  const dz = signedWrappedDistance(chunkZ, LANDMARK_OFFSET_Z, LANDMARK_PERIOD);
  const landmarkDistance = Math.hypot(dx, dz);
  const landmark = landmarkDistance < 0.1;
  const macroX = Math.floor((chunkX - LANDMARK_OFFSET_X) / LANDMARK_PERIOD);
  const macroZ = Math.floor((chunkZ - LANDMARK_OFFSET_Z) / LANDMARK_PERIOD);
  const landmarkVariant = hash2D(macroX, macroZ) % 3;
  const landmarkLot = landmarkVariant === 0 ? 0 : landmarkVariant === 1 ? 3 : 1;
  const roundabout = verticalRoad === 'grand-avenue'
    && horizontalRoad === 'grand-avenue'
    && positiveModulo(chunkX / 2 + chunkZ, 2) === 0;
  const river = riverPlanFor(chunkX, chunkZ);
  const onMajorAxis = verticalRoad === 'grand-avenue' || horizontalRoad === 'grand-avenue';
  const onAvenue = verticalRoad !== 'street' || horizontalRoad !== 'street';
  const civic = !landmark && !river && roundabout;

  let district: DistrictKind;
  let density: number;
  let skylineScale: number;
  if (landmark) {
    district = 'landmark-core';
    density = 0.28;
    skylineScale = 2.25;
  } else if (river) {
    district = 'waterfront';
    density = 0.7;
    skylineScale = landmarkDistance < 3.2 ? 1.35 : 1.02;
  } else if (civic) {
    district = 'civic';
    density = 0.62;
    skylineScale = 1.08;
  } else if (landmarkDistance <= 2.5) {
    district = 'commercial-core';
    density = 0.96;
    skylineScale = 1.38 - landmarkDistance * 0.08;
  } else if (onMajorAxis || onAvenue) {
    district = 'boulevard';
    density = onMajorAxis ? 0.9 : 0.8;
    skylineScale = onMajorAxis ? 1.18 : 1.02;
  } else {
    district = 'neighborhood';
    density = 0.72;
    skylineScale = 0.78;
  }

  const civicOpenLot = hash2D(chunkX, chunkZ) % 4;
  const openSpaceLots = landmark
    ? [0, 1, 2, 3].filter((index) => index !== landmarkLot)
    : civic ? [civicOpenLot] : [];

  return {
    verticalRoad,
    horizontalRoad,
    verticalRoadWidth: ROAD_WIDTHS[verticalRoad],
    horizontalRoadWidth: ROAD_WIDTHS[horizontalRoad],
    district,
    density,
    skylineScale,
    landmark,
    landmarkVariant,
    landmarkLot,
    openSpaceLots,
    roundabout,
    diagonalBoulevard: !roundabout && positiveModulo(chunkX - chunkZ, 9) === 0,
    river,
  };
}

export function chooseBuildingArchetype(
  plan: ChunkUrbanPlan,
  lotIndex: number,
  roll: number,
): BuildingArchetype {
  if (plan.landmark && lotIndex === plan.landmarkLot) {
    return plan.landmarkVariant === 0
      ? 'needle'
      : plan.landmarkVariant === 1 ? 'art-deco' : 'wedge';
  }

  switch (plan.district) {
    case 'commercial-core':
      if (roll < 0.2) return 'podium-tower';
      if (roll < 0.38) return 'stepped';
      if (roll < 0.54) return 'wedge';
      if (roll < 0.7) return 'twin-slab';
      if (roll < 0.84) return 'cylinder';
      return 'art-deco';
    case 'waterfront':
      if (roll < 0.3) return 'cylinder';
      if (roll < 0.56) return 'twin-slab';
      if (roll < 0.78) return 'podium-tower';
      return 'stepped';
    case 'boulevard':
      if (roll < 0.24) return 'brick-midrise';
      if (roll < 0.45) return 'podium-tower';
      if (roll < 0.64) return 'stepped';
      if (roll < 0.82) return 'twin-slab';
      return 'courtyard';
    case 'civic':
      if (roll < 0.38) return 'art-deco';
      if (roll < 0.7) return 'stepped';
      return 'podium-tower';
    case 'neighborhood':
      if (roll < 0.48) return 'brick-midrise';
      if (roll < 0.78) return 'courtyard';
      return 'twin-slab';
    default:
      return 'needle';
  }
}
