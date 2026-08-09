import { CONFIG } from './config';
import {
  hasDiagonalBoulevard,
  gameplayZoneFor,
  hashCoordinates,
  isCivicIntersection,
  nearestLandmark,
  plannedRoadClass,
} from './MacroCityPlan';
import type { GameplayZone } from './MacroCityPlan';

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

export type DevelopmentEra = 'historic' | 'postwar' | 'modern' | 'contemporary';
export type BlockGrain = 'tight' | 'regular' | 'open';
export type PublicSpaceKind = 'none' | 'park' | 'plaza' | 'monument' | 'schoolyard' | 'campus';

export interface LocalParcelPlan {
  lotIndex: number;
  quadrantIndex: number;
  localX: number;
  localZ: number;
  spanX: number;
  spanZ: number;
  streetAxis: 'x' | 'z';
  corner: boolean;
}

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
  developmentEra: DevelopmentEra;
  blockHeightBias: number;
  parcelRhythm: number;
  gameplayZone: GameplayZone;
  dangerTier: number;
  arenaVariant: number;
  blockGrain: BlockGrain;
  publicSpaceKind: PublicSpaceKind;
}

export const ROAD_WIDTHS: Record<RoadClass, number> = {
  street: 12,
  avenue: 30,
  'grand-avenue': 42,
};

export const MAX_ROAD_WIDTH = ROAD_WIDTHS['grand-avenue'];

const RIVER_BASE_X = CONFIG.chunkSize * 5.5;
const RIVER_WAVE_LENGTH = CONFIG.chunkSize * 4;
const RIVER_AMPLITUDE = CONFIG.chunkSize * 0.55;
const RIVER_WIDTH = 42;

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function hash2D(x: number, z: number): number {
  return hashCoordinates(x, z);
}

function roadClassFor(lineIndex: number, axis: 'x' | 'z'): RoadClass {
  return plannedRoadClass(lineIndex, axis);
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
  const landmarkInfluence = nearestLandmark(chunkX, chunkZ);
  const landmarkDistance = landmarkInfluence.distance;
  const landmark = landmarkDistance < 0.1;
  const gameplay = gameplayZoneFor(chunkX, chunkZ, landmark);
  const landmarkVariant = landmarkInfluence.variant;
  const landmarkLot = landmarkVariant === 0 ? 0 : landmarkVariant === 1 ? 3 : 1;
  const roundabout = isCivicIntersection(chunkX, chunkZ);
  const river = riverPlanFor(chunkX, chunkZ);
  // Neighbouring chunks share a broader development history. This makes a
  // district read as a coherent piece of city instead of independent dice rolls.
  const eraMacroX = Math.floor(chunkX / 4);
  const eraMacroZ = Math.floor(chunkZ / 4);
  const macroHash = hash2D(eraMacroX, eraMacroZ);
  const eraRoll = positiveModulo(macroHash, 100) / 100;
  const developmentEra: DevelopmentEra = eraRoll < 0.24
    ? 'historic'
    : eraRoll < 0.5 ? 'postwar' : eraRoll < 0.78 ? 'modern' : 'contemporary';
  const blockHeightBias = 0.88 + positiveModulo(macroHash >> 3, 25) / 100;
  const parcelRhythm = positiveModulo(hash2D(chunkX, chunkZ), 4);
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

  const grainRoll = positiveModulo(macroHash >> 9, 100) / 100;
  const blockGrain: BlockGrain = developmentEra === 'historic'
    ? (grainRoll < 0.68 ? 'tight' : 'regular')
    : district === 'waterfront' || district === 'civic'
      ? (grainRoll < 0.58 ? 'open' : 'regular')
      : district === 'commercial-core'
        ? (grainRoll < 0.35 ? 'tight' : grainRoll < 0.88 ? 'regular' : 'open')
        : grainRoll < 0.24 ? 'tight' : grainRoll < 0.78 ? 'regular' : 'open';

  const civicOpenLot = hash2D(chunkX, chunkZ) % 4;
  const arenaOpenLots = [gameplay.arenaVariant % 4];
  const institutionEligible = !landmark
    && !river
    && !civic
    && gameplay.kind === 'city';
  const school = institutionEligible
    && district === 'neighborhood'
    && positiveModulo(hash2D(chunkX + 509, chunkZ - 283), 19) === 0;
  const campus = institutionEligible
    && !school
    && (district === 'neighborhood' || district === 'waterfront')
    && positiveModulo(hash2D(chunkX - 887, chunkZ + 419), 31) === 0;
  const pocketPark = institutionEligible
    && !school
    && !campus
    && positiveModulo(hash2D(chunkX + 311, chunkZ - 197), 11) === 0;
  const publicSpaceKind: PublicSpaceKind = gameplay.kind === 'safe-hub'
    ? 'monument'
    : gameplay.kind === 'combat-arena' || landmark
      ? 'plaza'
      : civic ? 'monument'
        : school ? 'schoolyard'
          : campus ? 'campus' : pocketPark ? 'park' : 'none';
  const publicLot = positiveModulo(hash2D(chunkX - 73, chunkZ + 149), 4);
  const openSpaceLots = gameplay.kind === 'safe-hub'
    ? [0]
    : gameplay.kind === 'combat-arena'
      ? arenaOpenLots
      : landmark
    ? [(landmarkLot + 2) % 4]
    : civic ? [civicOpenLot]
      : campus ? [publicLot, (publicLot + 2) % 4]
        : school || pocketPark ? [publicLot] : [];

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
    diagonalBoulevard: !roundabout && hasDiagonalBoulevard(chunkX, chunkZ),
    river,
    developmentEra,
    blockHeightBias,
    parcelRhythm,
    gameplayZone: gameplay.kind,
    dangerTier: gameplay.dangerTier,
    arenaVariant: gameplay.arenaVariant,
    blockGrain,
    publicSpaceKind,
  };
}

/**
 * Subdivide the four pieces around a crossroad into street-fronting parcels.
 * Chunk coordinates remain a streaming concern; the parcel rhythm and shared
 * macro history prevent every chunk from reading as the same four toy lots.
 */
export function createLocalParcelPlans(
  plan: ChunkUrbanPlan,
  lotInnerX: number,
  lotInnerZ: number,
  lotOuterEdge: number,
): LocalParcelPlan[] {
  const parcels: LocalParcelPlan[] = [];
  const fullSpanX = lotOuterEdge - lotInnerX;
  const fullSpanZ = lotOuterEdge - lotInnerZ;
  let lotIndex = 0;

  for (const signX of [-1, 1]) {
    for (const signZ of [-1, 1]) {
      const quadrantIndex = (signX > 0 ? 2 : 0) + (signZ > 0 ? 1 : 0);
      const landmarkLot = plan.landmark && quadrantIndex === plan.landmarkLot;
      const openLot = plan.openSpaceLots.includes(quadrantIndex);
      const streetAxis: 'x' | 'z' = positiveModulo(
        plan.parcelRhythm + quadrantIndex,
        2,
      ) === 0 ? 'x' : 'z';
      const denseDistrict = plan.district === 'commercial-core'
        || plan.district === 'boulevard'
        || plan.district === 'neighborhood';
      const divisions = landmarkLot || openLot
        ? 1
        : plan.blockGrain === 'tight'
          ? (denseDistrict ? 3 : 2)
          : plan.blockGrain === 'open' ? 1
            : denseDistrict ? (plan.developmentEra === 'historic' ? 3 : 2) : 2;

      for (let division = 0; division < divisions; division += 1) {
        const spanX = streetAxis === 'x' ? fullSpanX : fullSpanX / divisions;
        const spanZ = streetAxis === 'z' ? fullSpanZ : fullSpanZ / divisions;
        const centerX = streetAxis === 'x'
          ? (lotInnerX + lotOuterEdge) / 2
          : lotInnerX + spanX * (division + 0.5);
        const centerZ = streetAxis === 'z'
          ? (lotInnerZ + lotOuterEdge) / 2
          : lotInnerZ + spanZ * (division + 0.5);
        parcels.push({
          lotIndex,
          quadrantIndex,
          localX: centerX * signX,
          localZ: centerZ * signZ,
          spanX,
          spanZ,
          streetAxis,
          corner: division === 0 || division === divisions - 1,
        });
        lotIndex += 1;
      }
    }
  }
  return parcels;
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

  // Older quarters keep a narrow masonry street wall even when they sit near
  // valuable avenues. Newer quarters are more likely to consolidate parcels
  // into podium developments.
  if (plan.developmentEra === 'historic'
    && plan.district !== 'landmark-core'
    && roll < 0.42) {
    return roll < 0.29 ? 'brick-midrise' : 'courtyard';
  }
  if (plan.developmentEra === 'contemporary'
    && (plan.district === 'commercial-core' || plan.district === 'boulevard')
    && roll < 0.26) {
    return 'podium-tower';
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
