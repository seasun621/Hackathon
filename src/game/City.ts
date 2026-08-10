import * as THREE from 'three';
import type { RigidBody, World } from '@dimforge/rapier3d-compat';
import RAPIER from '@dimforge/rapier3d-compat';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import cloudLayerUrl from '../../assets/environment/bright-cel-cloud-layer-v4.png';
import { CONFIG } from './config';
import {
  MAX_ROAD_WIDTH,
  chooseBuildingArchetype,
  createLocalParcelPlans,
  createChunkUrbanPlan,
  riverCenterAt,
} from './UrbanPlan';
import type { PublicSpaceKind } from './UrbanPlan';
import {
  createBuildingTraversalAnchors,
  validateAnchorCoverage,
} from './TraversalPlanner';

interface CityChunk {
  group: THREE.Group;
  bodies: RigidBody[];
  meshes: THREE.Mesh[];
  anchors: THREE.Vector3[];
  centerX: number;
  centerZ: number;
  traffic: TrafficAnimation | null;
  detailMeshes: THREE.Object3D[];
  physicsEnabled: boolean;
}

interface TrafficCar {
  alongX: boolean;
  lane: number;
  phase: number;
  speed: number;
  direction: 1 | -1;
}

interface TrafficAnimation {
  mesh: THREE.InstancedMesh;
  centerX: number;
  centerZ: number;
  cars: TrafficCar[];
}

interface PendingChunk {
  x: number;
  z: number;
  key: string;
}

interface ActiveChunkBuild {
  pending: PendingChunk;
  steps: Generator<void, void, void>;
}

export interface LoadedCityChunk {
  x: number;
  z: number;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function chunkSeed(x: number, z: number): number {
  return Math.imul(x + 1703, 73856093) ^ Math.imul(z - 2909, 19349663);
}

function appendRoadRect(
  positions: number[],
  normals: number[],
  uvs: number[],
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  along: 'x' | 'z',
): void {
  const vertices = [
    [x0, z0], [x1, z1], [x1, z0],
    [x0, z0], [x0, z1], [x1, z1],
  ];
  const acrossWidth = along === 'z' ? x1 - x0 : z1 - z0;
  const uMin = 0.5 - acrossWidth / (2 * MAX_ROAD_WIDTH);
  const uMax = 0.5 + acrossWidth / (2 * MAX_ROAD_WIDTH);
  for (const [x, z] of vertices) {
    positions.push(x, 0, z);
    normals.push(0, 1, 0);
    const across = along === 'z'
      ? (x - x0) / Math.max(0.001, x1 - x0)
      : (z - z0) / Math.max(0.001, z1 - z0);
    const alongValue = along === 'z'
      ? (z - z0) / Math.max(0.001, z1 - z0)
      : (x - x0) / Math.max(0.001, x1 - x0);
    uvs.push(THREE.MathUtils.lerp(uMin, uMax, across), alongValue);
  }
}

function createCrossRoadGeometry(verticalWidth: number, horizontalWidth: number): THREE.BufferGeometry {
  const half = CONFIG.chunkSize / 2;
  const verticalHalf = verticalWidth / 2;
  const horizontalHalf = horizontalWidth / 2;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  appendRoadRect(positions, normals, uvs, -verticalHalf, verticalHalf, -half, half, 'z');
  appendRoadRect(positions, normals, uvs, -half, -verticalHalf, -horizontalHalf, horizontalHalf, 'x');
  appendRoadRect(positions, normals, uvs, verticalHalf, half, -horizontalHalf, horizontalHalf, 'x');
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

function createDiagonalRoadGeometry(width: number): THREE.BufferGeometry {
  const half = CONFIG.chunkSize / 2;
  const offset = width * Math.SQRT1_2;
  const points = [
    [-half, -half + offset],
    [half - offset, half],
    [half, half - offset],
    [-half + offset, -half],
  ];
  const order = [0, 1, 2, 0, 2, 3];
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const uMin = 0.5 - width / (2 * MAX_ROAD_WIDTH);
  const uMax = 0.5 + width / (2 * MAX_ROAD_WIDTH);
  for (const index of order) {
    const [x, z] = points[index];
    positions.push(x, 0, z);
    normals.push(0, 1, 0);
    const across = clamp01((z - x + offset) / (offset * 2));
    const along = clamp01((x + z + CONFIG.chunkSize) / (CONFIG.chunkSize * 2));
    uvs.push(THREE.MathUtils.lerp(uMin, uMax, across), along);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export class City {
  private readonly chunks = new Map<string, CityChunk>();
  private readonly buildingMeshes: THREE.Mesh[] = [];
  private readonly nearbyBuildingMeshes: THREE.Mesh[] = [];
  private readonly wantedChunks = new Set<string>();
  private readonly pendingChunks: PendingChunk[] = [];
  private readonly pendingKeys = new Set<string>();
  private activeChunkBuild: ActiveChunkBuild | null = null;
  private readonly loadedChunkEvents: LoadedCityChunk[] = [];
  private readonly buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly antennaGeometry = new THREE.CylinderGeometry(0.7, 1, 1, 6);
  private readonly cylinderBuildingGeometry = new THREE.CylinderGeometry(1, 1, 1, 10);
  private readonly cylinderFacadeGeometry = new THREE.CylinderGeometry(1.012, 1.012, 1, 10, 1, true);
  private readonly crownGeometry = new THREE.ConeGeometry(1, 1, 4);
  private readonly treeCanopyGeometry = new THREE.IcosahedronGeometry(1, 1);
  private readonly roundaboutGeometry = new THREE.CircleGeometry(11, 28);
  private readonly roadGeometries = new Map<string, THREE.BufferGeometry>();
  private readonly diagonalRoadGeometry = createDiagonalRoadGeometry(18);
  private readonly facadeGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly buildingMaterial: THREE.MeshStandardMaterial;
  private readonly facadeMaterial: THREE.MeshBasicMaterial;
  private readonly brickFacadeMaterial: THREE.MeshBasicMaterial;
  private readonly verticalFacadeMaterial: THREE.MeshBasicMaterial;
  private readonly curtainFacadeMaterial: THREE.MeshBasicMaterial;
  private readonly roofMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.82,
    metalness: 0.04,
  });
  private readonly antennaMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.7,
    metalness: 0.16,
  });
  private readonly roadMaterial: THREE.MeshStandardMaterial;
  private readonly sidewalkMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.98,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: 4,
    polygonOffsetUnits: 4,
  });
  private readonly diagonalRoadMaterial: THREE.MeshStandardMaterial;
  private readonly carMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    toneMapped: false,
  });
  private readonly treeCanopyMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    toneMapped: false,
  });
  private readonly parkMaterial = new THREE.MeshStandardMaterial({
    color: 0x66775f,
    roughness: 1,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
  private readonly waterMaterial = new THREE.MeshStandardMaterial({
    color: 0x4f7888,
    roughness: 0.34,
    metalness: 0.12,
    transparent: true,
    opacity: 0.88,
  });
  private readonly cameraDirection = new THREE.Vector3();
  private readonly anchorDelta = new THREE.Vector3();
  private readonly projectedAnchor = new THREE.Vector3();
  private lastCenterX = Number.NaN;
  private lastCenterZ = Number.NaN;
  private lastPrefetchX = Number.NaN;
  private lastPrefetchZ = Number.NaN;
  private lastTrafficUpdate = 0;
  private activePhysicsBodies = 0;
  private readonly trafficTransform = new THREE.Object3D();
  private readonly aerialEnvironment: THREE.Group;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: World,
    private readonly textureAnisotropy: number,
  ) {
    this.buildingMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      fog: true,
      roughness: 0.7,
      metalness: 0.08,
    });
    this.facadeMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: this.createFacadeTexture(),
      transparent: false,
      alphaTest: 0.22,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    this.brickFacadeMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: this.createBrickFacadeTexture(),
      transparent: false,
      alphaTest: 0.2,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    this.verticalFacadeMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: this.createVerticalFacadeTexture(),
      transparent: false,
      alphaTest: 0.2,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    this.curtainFacadeMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: this.createCurtainFacadeTexture(),
      transparent: false,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    this.roadMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: this.createRoadTexture(),
      roughness: 0.96,
      metalness: 0.02,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2,
    });
    this.sidewalkMaterial.map = this.createSidewalkTexture();
    this.sidewalkMaterial.needsUpdate = true;
    this.diagonalRoadMaterial = this.roadMaterial.clone();
    this.diagonalRoadMaterial.polygonOffsetFactor = -3;
    this.diagonalRoadMaterial.polygonOffsetUnits = -5;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(12000, 12000),
      new THREE.MeshStandardMaterial({ color: 0x777975, roughness: 1, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.55;
    this.scene.add(ground);
    this.aerialEnvironment = this.createAerialEnvironment();
    this.scene.add(this.aerialEnvironment);

    const groundBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, 0),
    );
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(6000, 0.5, 6000), groundBody);
  }

  update(playerPosition: THREE.Vector3, viewDirection?: THREE.Vector3): void {
    // A slow-following horizon keeps the procedural world visually bounded
    // without introducing gameplay geometry or a finite map edge.
    this.aerialEnvironment.position.x = playerPosition.x * 0.86;
    this.aerialEnvironment.position.y = 0;
    this.aerialEnvironment.position.z = playerPosition.z * 0.86;
    const centerX = Math.floor(playerPosition.x / CONFIG.chunkSize);
    const centerZ = Math.floor(playerPosition.z / CONFIG.chunkSize);
    const firstUpdate = Number.isNaN(this.lastCenterX);
    const horizontalX = viewDirection?.x ?? 0;
    const horizontalZ = viewDirection?.z ?? -1;
    const prefetchX = Math.abs(horizontalX) > Math.abs(horizontalZ)
      ? Math.sign(horizontalX) || 1
      : 0;
    const prefetchZ = prefetchX === 0 ? Math.sign(horizontalZ) || -1 : 0;
    if (
      centerX !== this.lastCenterX
      || centerZ !== this.lastCenterZ
      || prefetchX !== this.lastPrefetchX
      || prefetchZ !== this.lastPrefetchZ
    ) {
      this.lastCenterX = centerX;
      this.lastCenterZ = centerZ;
      this.lastPrefetchX = prefetchX;
      this.lastPrefetchZ = prefetchZ;
      this.wantedChunks.clear();

      for (let dx = -CONFIG.chunkRadius; dx <= CONFIG.chunkRadius; dx += 1) {
        for (let dz = -CONFIG.chunkRadius; dz <= CONFIG.chunkRadius; dz += 1) {
          const x = centerX + dx;
          const z = centerZ + dz;
          const key = `${x}:${z}`;
          this.wantedChunks.add(key);
          if (!this.chunks.has(key) && !this.pendingKeys.has(key)) {
            this.pendingChunks.push({ x, z, key });
            this.pendingKeys.add(key);
          }
        }
      }

      // Keep one extra strip ready in the direction the player is looking.
      // This hides high-altitude pop-in without paying for a full 7 x 7 radius.
      const forwardDistance = CONFIG.chunkRadius + 1;
      for (let lateral = -CONFIG.chunkRadius; lateral <= CONFIG.chunkRadius; lateral += 1) {
        const x = centerX + prefetchX * forwardDistance + (prefetchZ !== 0 ? lateral : 0);
        const z = centerZ + prefetchZ * forwardDistance + (prefetchX !== 0 ? lateral : 0);
        const key = `${x}:${z}`;
        this.wantedChunks.add(key);
        if (!this.chunks.has(key) && !this.pendingKeys.has(key)) {
          this.pendingChunks.push({ x, z, key });
          this.pendingKeys.add(key);
        }
      }

      for (let index = this.pendingChunks.length - 1; index >= 0; index -= 1) {
        const pending = this.pendingChunks[index];
        if (this.wantedChunks.has(pending.key)) continue;
        this.pendingChunks.splice(index, 1);
        this.pendingKeys.delete(pending.key);
      }
      this.pendingChunks.sort((a, b) => {
        const aDistance = Math.hypot(a.x - centerX, a.z - centerZ);
        const bDistance = Math.hypot(b.x - centerX, b.z - centerZ);
        const aForward = (a.x - centerX) * prefetchX + (a.z - centerZ) * prefetchZ;
        const bForward = (b.x - centerX) * prefetchX + (b.z - centerZ) * prefetchZ;
        return (aDistance - aForward * 0.12) - (bDistance - bForward * 0.12);
      });
    }

    // A chunk contains many procedural buildings, colliders, facade instances,
    // and traffic data. Advance a generator within a small time budget instead
    // of completing all of that work in one frame.
    this.processChunkBuildQueue(firstUpdate ? 8.5 : 2.4);

    for (const [key, chunk] of this.chunks) {
      const detailDistance = Math.hypot(
        chunk.centerX - playerPosition.x,
        chunk.centerZ - playerPosition.z,
      );
      const showFineDetail = detailDistance < CONFIG.chunkSize * 1.5;
      for (const mesh of chunk.detailMeshes) mesh.visible = showFineDetail;
      if (chunk.traffic) chunk.traffic.mesh.visible = detailDistance < CONFIG.chunkSize * 1.65;
      const enablePhysics = detailDistance < CONFIG.chunkSize * 1.72;
      if (chunk.physicsEnabled !== enablePhysics) {
        chunk.physicsEnabled = enablePhysics;
        for (const body of chunk.bodies) body.setEnabled(enablePhysics);
      }
      if (this.wantedChunks.has(key)) continue;
      this.removeChunk(key, chunk);
      break;
    }

    this.nearbyBuildingMeshes.length = 0;
    this.activePhysicsBodies = 0;
    const raycastDistance = CONFIG.chunkSize * 1.9;
    for (const chunk of this.chunks.values()) {
      const dx = chunk.centerX - playerPosition.x;
      const dz = chunk.centerZ - playerPosition.z;
      const distanceSquared = dx * dx + dz * dz;
      if (chunk.physicsEnabled) this.activePhysicsBodies += chunk.bodies.length;
      if (distanceSquared > raycastDistance * raycastDistance) continue;
      this.nearbyBuildingMeshes.push(...chunk.meshes);
    }

    const now = performance.now() * 0.001;
    if (now - this.lastTrafficUpdate >= 1 / 30) {
      this.lastTrafficUpdate = now;
      for (const chunk of this.chunks.values()) {
        if (!chunk.traffic) continue;
        const dx = chunk.centerX - playerPosition.x;
        const dz = chunk.centerZ - playerPosition.z;
        if (dx * dx + dz * dz > (CONFIG.chunkSize * 2.4) ** 2) continue;
        this.updateTraffic(chunk.traffic, now);
      }
    }
  }

  getBuildingMeshes(): THREE.Mesh[] {
    return this.nearbyBuildingMeshes;
  }

  private processChunkBuildQueue(timeBudgetMs: number): void {
    const startedAt = performance.now();
    let advancedSteps = 0;
    while (performance.now() - startedAt < timeBudgetMs && advancedSteps < 12) {
      if (!this.activeChunkBuild) {
        let pending = this.pendingChunks.shift();
        while (pending && (!this.wantedChunks.has(pending.key) || this.chunks.has(pending.key))) {
          this.pendingKeys.delete(pending.key);
          pending = this.pendingChunks.shift();
        }
        if (!pending) return;
        this.activeChunkBuild = {
          pending,
          steps: this.createChunkSteps(pending.x, pending.z, pending.key),
        };
      }

      const active = this.activeChunkBuild;
      const result = active.steps.next();
      advancedSteps += 1;
      if (!result.done) continue;

      this.pendingKeys.delete(active.pending.key);
      this.activeChunkBuild = null;
      const completed = this.chunks.get(active.pending.key);
      if (completed && !this.wantedChunks.has(active.pending.key)) {
        this.removeChunk(active.pending.key, completed);
      }
    }
  }

  getPerformanceStats(): {
    chunks: number;
    physicsBodies: number;
    raycastMeshes: number;
    buildQueue: number;
    buildActive: boolean;
  } {
    return {
      chunks: this.chunks.size,
      physicsBodies: this.activePhysicsBodies,
      raycastMeshes: this.nearbyBuildingMeshes.length,
      buildQueue: this.pendingChunks.length + (this.activeChunkBuild ? 1 : 0),
      buildActive: this.activeChunkBuild !== null,
    };
  }

  consumeLoadedChunks(): LoadedCityChunk[] {
    return this.loadedChunkEvents.splice(0);
  }

  findAssistedAnchor(camera: THREE.Camera, playerPosition: THREE.Vector3): THREE.Vector3 | null {
    camera.getWorldDirection(this.cameraDirection);
    let best: THREE.Vector3 | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const chunk of this.chunks.values()) {
      if (Math.abs(chunk.centerX - playerPosition.x) > CONFIG.ropeMaxRange + 90
        || Math.abs(chunk.centerZ - playerPosition.z) > CONFIG.ropeMaxRange + 90) continue;
      for (const anchor of chunk.anchors) {
        this.anchorDelta.copy(anchor).sub(playerPosition);
        const distance = this.anchorDelta.length();
        if (distance > CONFIG.ropeMaxRange || distance < 7) continue;
        const forwardAlignment = this.anchorDelta.dot(this.cameraDirection) / distance;
        if (forwardAlignment < 0.78) continue;

        this.projectedAnchor.copy(anchor).project(camera);
        if (this.projectedAnchor.z < -1 || this.projectedAnchor.z > 1) continue;
        const x = Math.abs(this.projectedAnchor.x);
        const y = Math.abs(this.projectedAnchor.y);
        if (x > 0.38 || y > 0.34) continue;

        const tooLowPenalty = anchor.y < playerPosition.y + 2 ? 0.48 : 0;
        const score = x * 1.25 + y + distance * 0.0024 + tooLowPenalty;
        if (score < bestScore) {
          bestScore = score;
          best = anchor;
        }
      }
    }

    return best?.clone() ?? null;
  }

  private *createChunkSteps(chunkX: number, chunkZ: number, key: string): Generator<void, void, void> {
    const random = seededRandom(chunkSeed(chunkX, chunkZ));
    const plan = createChunkUrbanPlan(chunkX, chunkZ);
    const group = new THREE.Group();
    group.name = `city-chunk-${key}`;
    const bodies: RigidBody[] = [];
    const meshes: THREE.Mesh[] = [];
    const anchors: THREE.Vector3[] = [];
    const centerX = chunkX * CONFIG.chunkSize;
    const centerZ = chunkZ * CONFIG.chunkSize;
    const verticalRoadWidth = plan.verticalRoadWidth;
    const horizontalRoadWidth = plan.horizontalRoadWidth;
    const sidewalkWidthFor = (roadClass: typeof plan.verticalRoad): number => roadClass === 'grand-avenue'
      ? 6.5
      : roadClass === 'avenue' ? 5.8 : 5.2;
    const verticalSidewalkWidth = sidewalkWidthFor(plan.verticalRoad);
    const horizontalSidewalkWidth = sidewalkWidthFor(plan.horizontalRoad);
    const diagonalDistrict = plan.diagonalBoulevard;
    const lotOuterEdge = CONFIG.chunkSize / 2 - 6;
    const lotInnerX = verticalRoadWidth / 2 + verticalSidewalkWidth + 0.8;
    const lotInnerZ = horizontalRoadWidth / 2 + horizontalSidewalkWidth + 0.8;
    const parcels = createLocalParcelPlans(plan, lotInnerX, lotInnerZ, lotOuterEdge);
    const facadeStyle = Math.abs(chunkSeed(chunkX, chunkZ)) % 4;
    const chunkFacadeMaterial = plan.district === 'waterfront'
      || (plan.district === 'commercial-core' && facadeStyle !== 0)
      ? this.curtainFacadeMaterial
      : plan.district === 'civic'
        || plan.district === 'landmark-core'
        || (plan.district === 'boulevard' && facadeStyle === 1)
        ? this.verticalFacadeMaterial
        : facadeStyle === 3
          ? this.curtainFacadeMaterial
          : this.facadeMaterial;
    const buildings = new THREE.InstancedMesh(this.buildingGeometry, this.buildingMaterial, 48);
    const tiers = new THREE.InstancedMesh(this.buildingGeometry, this.buildingMaterial, 72);
    const cylinderBuildings = new THREE.InstancedMesh(
      this.cylinderBuildingGeometry,
      this.buildingMaterial,
      24,
    );
    const cylinderFacades = new THREE.InstancedMesh(
      this.cylinderFacadeGeometry,
      chunkFacadeMaterial,
      24,
    );
    const crowns = new THREE.InstancedMesh(this.crownGeometry, this.buildingMaterial, 24);
    const architecturalDetails = new THREE.InstancedMesh(
      this.buildingGeometry,
      this.roofMaterial,
      128,
    );
    const roofProps = new THREE.InstancedMesh(this.antennaGeometry, this.antennaMaterial, 64);
    const roads = new THREE.Mesh(
      this.getRoadGeometry(verticalRoadWidth, horizontalRoadWidth),
      this.roadMaterial,
    );
    roads.position.set(centerX, -0.42, centerZ);
    roads.renderOrder = 1;
    const sidewalks = new THREE.Mesh(
      this.getRoadGeometry(
        verticalRoadWidth + verticalSidewalkWidth * 2,
        horizontalRoadWidth + horizontalSidewalkWidth * 2,
      ),
      this.sidewalkMaterial,
    );
    sidewalks.position.set(centerX, -0.49, centerZ);
    sidewalks.renderOrder = 0;
    const diagonalRoad = diagonalDistrict
      ? new THREE.Mesh(this.diagonalRoadGeometry, this.diagonalRoadMaterial)
      : null;
    if (diagonalRoad) {
      diagonalRoad.position.set(centerX, -0.398, centerZ);
      diagonalRoad.renderOrder = 2;
    }
    const roundaboutIsland = plan.roundabout
      ? new THREE.Mesh(this.roundaboutGeometry, this.parkMaterial)
      : null;
    if (roundaboutIsland) {
      roundaboutIsland.rotation.x = -Math.PI / 2;
      roundaboutIsland.position.set(centerX, -0.412, centerZ);
      roundaboutIsland.renderOrder = 3;
    }
    const river = plan.river
      ? new THREE.Mesh(this.buildingGeometry, this.waterMaterial)
      : null;
    if (river && plan.river) {
      river.position.set(plan.river.centerX, -0.5, centerZ);
      river.rotation.y = plan.river.yaw;
      river.scale.set(plan.river.width, 0.08, CONFIG.chunkSize * 1.22);
      river.renderOrder = 0;
    }
    const facades = new THREE.InstancedMesh(this.facadeGeometry, chunkFacadeMaterial, 256);
    const brickFacades = new THREE.InstancedMesh(
      this.facadeGeometry,
      this.brickFacadeMaterial,
      256,
    );
    const cars = new THREE.InstancedMesh(this.buildingGeometry, this.carMaterial, 20);
    const treeCanopies = new THREE.InstancedMesh(
      this.treeCanopyGeometry,
      this.treeCanopyMaterial,
      48,
    );
    const streetFurniture = new THREE.InstancedMesh(
      this.buildingGeometry,
      this.roofMaterial,
      128,
    );
    const streetTreeCanopies = new THREE.InstancedMesh(
      this.treeCanopyGeometry,
      this.treeCanopyMaterial,
      48,
    );
    const transform = new THREE.Object3D();
    const glassColors = [0x526b73, 0x4c626c, 0x566a65, 0x5a5f6b, 0x49646b];
    const brickColors = [0x745048, 0x68463f, 0x7c594b, 0x66504a, 0x7d5d50];
    const stoneColors = [0x9b9589, 0x928875, 0x8b918c, 0x92908a, 0x858d88];
    const carColors = [0x823f3e, 0x354957, 0xaaa89f, 0x9a783c, 0x4b5d52, 0x616468];
    let buildingIndex = 0;
    let tierIndex = 0;
    let cylinderIndex = 0;
    let crownIndex = 0;
    let detailIndex = 0;
    let propIndex = 0;
    let facadeIndex = 0;
    let brickFacadeIndex = 0;
    let treeIndex = 0;
    let streetFurnitureIndex = 0;
    let streetTreeIndex = 0;

    const setInstance = (
      mesh: THREE.InstancedMesh,
      index: number,
      x: number,
      y: number,
      z: number,
      width: number,
      height: number,
      depth: number,
      color: THREE.Color,
      rotationY = 0,
    ): void => {
      transform.position.set(x, y, z);
      transform.rotation.set(0, rotationY, 0);
      transform.scale.set(width, height, depth);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
      mesh.setColorAt(index, color);
    };

    const addOpenSpace = (
      localX: number,
      localZ: number,
      spanX: number,
      spanZ: number,
      kind: Exclude<PublicSpaceKind, 'none'>,
    ): void => {
      const x = centerX + localX;
      const z = centerZ + localZ;
      const openSpaceColor = plan.gameplayZone === 'safe-hub'
        ? 0x697d6d
        : plan.gameplayZone === 'combat-arena'
          ? (plan.arenaVariant === 1 ? 0x887968 : 0x786e6b)
          : kind === 'park' || kind === 'campus'
            ? 0x68775f
            : kind === 'schoolyard' ? 0x8a876f : 0x999386;
      setInstance(
        architecturalDetails,
        detailIndex,
        x,
        -0.39,
        z,
        spanX * 0.86,
        0.12,
        spanZ * 0.86,
        new THREE.Color(openSpaceColor),
      );
      detailIndex += 1;

      // Civic squares get a compact stone plinth and a dark bronze abstract
      // monument. It is deliberately assembled from shared instances so it
      // adds identity without introducing unique models or draw calls.
      if (kind === 'monument') {
        setInstance(
          architecturalDetails,
          detailIndex,
          x,
          0.08,
          z,
          Math.min(7.2, spanX * 0.24),
          0.82,
          Math.min(7.2, spanZ * 0.24),
          new THREE.Color(0x77746d),
        );
        detailIndex += 1;
        setInstance(
          roofProps,
          propIndex,
          x,
          4.15,
          z,
          1.15,
          7.1,
          1.15,
          new THREE.Color(0x35403c),
        );
        propIndex += 1;
      }

      const treeCount = kind === 'park' || kind === 'campus' ? 4 : 2;
      for (let tree = 0; tree < treeCount; tree += 1) {
        const sideX = tree % 2 === 0 ? -1 : 1;
        const sideZ = tree < 2 ? -1 : 1;
        const treeX = x + sideX * spanX * (0.22 + random() * 0.08);
        const treeZ = z + sideZ * spanZ * (0.22 + random() * 0.08);
        setInstance(
          roofProps,
          propIndex,
          treeX,
          0.78,
          treeZ,
          0.34,
          1.9,
          0.34,
          new THREE.Color(0x6f5037),
        );
        propIndex += 1;
        setInstance(
          treeCanopies,
          treeIndex,
          treeX,
          2.65 + random() * 0.4,
          treeZ,
          1.45 + random() * 0.35,
          1.65 + random() * 0.35,
          1.45 + random() * 0.35,
          new THREE.Color(random() > 0.45 ? 0x4f895d : 0x6d9f62),
        );
        treeIndex += 1;
      }
    };

    const streetTreeColor = new THREE.Color(plan.district === 'waterfront' ? 0x5f9168 : 0x537e56);
    const placeStreetTree = (x: number, z: number, scale = 1): void => {
      setInstance(
        streetFurniture,
        streetFurnitureIndex++,
        x,
        1.1 * scale,
        z,
        0.42 * scale,
        2.75 * scale,
        0.42 * scale,
        new THREE.Color(0x65503c),
      );
      setInstance(
        streetTreeCanopies,
        streetTreeIndex++,
        x,
        3.55 * scale,
        z,
        1.75 * scale,
        2.05 * scale,
        1.75 * scale,
        streetTreeColor.clone().offsetHSL((random() - 0.5) * 0.025, 0, (random() - 0.5) * 0.05),
      );
    };

    const placeStreetLamp = (x: number, z: number): void => {
      setInstance(
        streetFurniture,
        streetFurnitureIndex++,
        x,
        2.45,
        z,
        0.18,
        5.15,
        0.18,
        new THREE.Color(0x343b3d),
      );
      setInstance(
        streetFurniture,
        streetFurnitureIndex++,
        x,
        5.05,
        z,
        0.7,
        0.22,
        0.42,
        new THREE.Color(0xe8dec0),
      );
    };

    const placeBench = (x: number, z: number, alongX: boolean): void => {
      setInstance(
        streetFurniture,
        streetFurnitureIndex++,
        x,
        0.42,
        z,
        alongX ? 2.15 : 0.55,
        0.28,
        alongX ? 0.55 : 2.15,
        new THREE.Color(0x66513e),
      );
      setInstance(
        streetFurniture,
        streetFurnitureIndex++,
        x + (alongX ? 0 : 0.22),
        0.78,
        z + (alongX ? 0.22 : 0),
        alongX ? 2.15 : 0.18,
        0.65,
        alongX ? 0.18 : 2.15,
        new THREE.Color(0x554637),
      );
    };

    const isRiverFurnitureConflict = (x: number, z: number): boolean => Boolean(
      plan.river
      && Math.abs(x - riverCenterAt(z)) < plan.river.width / 2 + 3,
    );
    const curbColor = new THREE.Color(0xb9b5ab);
    const verticalCurbLength = (CONFIG.chunkSize - horizontalRoadWidth) / 2 - 5;
    const horizontalCurbLength = (CONFIG.chunkSize - verticalRoadWidth) / 2 - 5;
    for (const side of [-1, 1]) {
      for (const end of [-1, 1]) {
        setInstance(
          streetFurniture,
          streetFurnitureIndex++,
          centerX + side * (verticalRoadWidth / 2 + 0.18),
          -0.32,
          centerZ + end * (horizontalRoadWidth / 2 + 2.5 + verticalCurbLength / 2),
          0.36,
          0.16,
          verticalCurbLength,
          curbColor,
        );
        setInstance(
          streetFurniture,
          streetFurnitureIndex++,
          centerX + end * (verticalRoadWidth / 2 + 2.5 + horizontalCurbLength / 2),
          -0.32,
          centerZ + side * (horizontalRoadWidth / 2 + 0.18),
          horizontalCurbLength,
          0.16,
          0.36,
          curbColor,
        );
      }
    }
    const streetIntervals = [-52, -36, -20, 20, 36, 52];
    for (const along of streetIntervals) {
      if (Math.abs(along) > horizontalRoadWidth / 2 + 8) {
        for (const side of [-1, 1]) {
          const x = centerX + side * (verticalRoadWidth / 2 + verticalSidewalkWidth * 0.55);
          const z = centerZ + along + (random() - 0.5) * 1.8;
          if (!isRiverFurnitureConflict(x, z)) {
            placeStreetTree(x, z, 0.88 + random() * 0.2);
            if (Math.abs(along) === 36) placeStreetLamp(x, z + 3.4);
            if (along === -52 && side === 1) placeBench(x + 1.15, z, false);
          }
        }
      }
      if (Math.abs(along) > verticalRoadWidth / 2 + 8) {
        for (const side of [-1, 1]) {
          const x = centerX + along + (random() - 0.5) * 1.8;
          const z = centerZ + side * (horizontalRoadWidth / 2 + horizontalSidewalkWidth * 0.55);
          if (!isRiverFurnitureConflict(x, z)) {
            placeStreetTree(x, z, 0.88 + random() * 0.2);
            if (Math.abs(along) === 36) placeStreetLamp(x + 3.4, z);
            if (along === 52 && side === -1) placeBench(x, z + 1.15, true);
          }
        }
      }
    }

    for (const parcel of parcels) {
        // Each parcel is a self-contained slice of work: building instances,
        // facade layout, collider creation, and traversal anchors.
        yield;
        const { localX, localZ, spanX, spanZ, streetAxis, quadrantIndex } = parcel;
        if (diagonalDistrict && Math.sign(localX) === Math.sign(localZ)) continue;
        const riverOverlap = plan.river
          && Math.abs(centerX + localX - riverCenterAt(centerZ + localZ))
            < plan.river.width / 2 + spanX * 0.22;
        const plannedOpenSpace = plan.openSpaceLots.includes(quadrantIndex);
        // Density used to be evaluated four times per chunk. With subdivided
        // frontage parcels, applying the old probability unchanged would turn
        // whole streets into gaps, so only a restrained share becomes vacant.
        const parcelOccupancy = 0.992;
        const densityOpenSpace = !plan.landmark && random() > parcelOccupancy;
        if (riverOverlap || plannedOpenSpace || densityOpenSpace) {
          const openSpaceKind: Exclude<PublicSpaceKind, 'none'> = riverOverlap
            ? 'park'
            : plannedOpenSpace && plan.publicSpaceKind !== 'none'
              ? plan.publicSpaceKind
              : 'park';
          addOpenSpace(
            localX,
            localZ,
            spanX,
            spanZ,
            openSpaceKind,
          );
          continue;
        }
        const architectureRoll = random();
        const institutionalBlock = plan.publicSpaceKind === 'schoolyard'
          || plan.publicSpaceKind === 'campus';
        const archetype = plan.publicSpaceKind === 'schoolyard'
          ? 'brick-midrise'
          : plan.publicSpaceKind === 'campus'
            ? (architectureRoll < 0.62 ? 'courtyard' : 'brick-midrise')
            : chooseBuildingArchetype(plan, quadrantIndex, architectureRoll);
        const frontageRoad = streetAxis === 'x' ? plan.verticalRoad : plan.horizontalRoad;
        const roadHeightBonus = frontageRoad === 'grand-avenue'
          ? 18
          : frontageRoad === 'avenue' ? 8 : 0;
        const glassTower = archetype !== 'brick-midrise' && archetype !== 'courtyard';
        const brickMidrise = archetype === 'brick-midrise' || archetype === 'courtyard';
        const widthFactor = archetype === 'cylinder' || archetype === 'needle'
          ? 0.62 + random() * 0.1
          : archetype === 'courtyard'
            ? 0.92 + random() * 0.05
            : archetype === 'twin-slab'
              ? 0.84 + random() * 0.1
              : 0.88 + random() * 0.08;
        const depthFactor = archetype === 'twin-slab'
          ? 0.68 + random() * 0.12
          : archetype === 'courtyard'
            ? 0.92 + random() * 0.05
            : 0.84 + random() * 0.12;
        const grainCoverage = plan.blockGrain === 'tight'
          ? 1.02
          : plan.blockGrain === 'open' ? 0.72 : 0.9;
        const width = spanX * Math.min(0.98, widthFactor * grainCoverage);
        const depth = spanZ * Math.min(0.98, depthFactor * grainCoverage);
        const eraHeightFactor = plan.developmentEra === 'historic'
          ? 0.76
          : plan.developmentEra === 'postwar' ? 0.9
            : plan.developmentEra === 'contemporary' ? 1.08 : 1;
        const rawTargetHeight = plan.landmark
          ? 238 + random() * 78
          : plan.publicSpaceKind === 'schoolyard'
            ? 18 + random() * 14
            : plan.publicSpaceKind === 'campus'
              ? 22 + random() * 20
          : plan.district === 'commercial-core'
            ? (72 + Math.pow(random(), 0.68) * 76) * plan.skylineScale
            : plan.district === 'waterfront'
              ? (52 + Math.pow(random(), 0.74) * 72) * plan.skylineScale
              : plan.district === 'civic'
                ? (48 + random() * 62) * plan.skylineScale
                : plan.district === 'boulevard'
                  ? (42 + Math.pow(random(), 0.76) * 66 + roadHeightBonus)
                    * plan.skylineScale
                  : (28 + Math.pow(random(), 0.9) * 42) * plan.skylineScale;
        const contextualHeight = plan.landmark || institutionalBlock
          ? rawTargetHeight
          : rawTargetHeight * plan.blockHeightBias * eraHeightFactor;
        let targetHeight = contextualHeight;
        if (!plan.landmark && !institutionalBlock) {
          const heightMix = random();
          if (contextualHeight > 92 && heightMix < 0.22) {
            // Older mid-rise fabric surviving between newer towers.
            targetHeight = 46 + random() * 34;
          } else if (contextualHeight < 72 && heightMix > 0.76) {
            // An occasional infill tower prevents low-rise districts from
            // becoming one uniformly flat slab without erasing their identity.
            targetHeight = Math.max(contextualHeight * 1.22, 68 + random() * 46);
          } else {
            targetHeight = contextualHeight * (0.9 + random() * 0.2);
          }
          targetHeight = THREE.MathUtils.clamp(targetHeight, 26, 188);
        }
        // Keep the street wall close to the road edge. Variation happens along
        // the frontage, not by floating every building around the lot centre.
        const grainSetback = plan.blockGrain === 'tight'
          ? 0.35 + random() * 0.8
          : plan.blockGrain === 'open'
            ? 4.5 + random() * 4.5
            : (plan.district === 'neighborhood' ? 2.1 : 1.0) + random() * 1.2;
        const boulevardSetback = frontageRoad === 'grand-avenue'
          ? 2.6
          : frontageRoad === 'avenue' ? 1.1 : 0;
        const streetSetback = grainSetback + boulevardSetback;
        const x = centerX + (streetAxis === 'x'
          ? (Math.sign(localX) * (lotInnerX + streetSetback + width / 2))
          : localX + (random() - 0.5) * Math.min(1.2, spanX * 0.04));
        const z = centerZ + (streetAxis === 'z'
          ? (Math.sign(localZ) * (lotInnerZ + streetSetback + depth / 2))
          : localZ + (random() - 0.5) * Math.min(1.2, spanZ * 0.04));
        const palette = glassTower ? glassColors : brickMidrise ? brickColors : stoneColors;
        const facadeColor = new THREE.Color(
          palette[Math.floor(random() * palette.length)],
        );
        if (plan.dangerTier > 0) {
          const dangerTint = plan.gameplayZone === 'combat-arena'
            ? new THREE.Color(0x8c5f5b)
            : new THREE.Color(0x555c76);
          facadeColor.lerp(dangerTint, Math.min(0.16, plan.dangerTier * 0.025));
        }
        if (plan.gameplayZone === 'reward-landmark') {
          facadeColor.lerp(new THREE.Color(0x86c8c2), 0.12);
        }
        let height = targetHeight;
        let roofX = x;
        let roofZ = z;
        let roofHeight = targetHeight;
        let tierWidth = width;
        let tierDepth = depth;
        let upperColliderWidth = width;
        let upperColliderDepth = depth;
        let upperColliderOffsetX = 0;
        let upperColliderOffsetZ = 0;
        let preciseColliderParts: Array<{
          x: number;
          z: number;
          width: number;
          height: number;
          depth: number;
          bottom: number;
        }> | null = null;
        const facadeTint = facadeColor.clone().lerp(new THREE.Color(0xb8c2bf), 0.18);

        const addFacadeInstance = (
          instanceX: number,
          instanceY: number,
          instanceZ: number,
          instanceWidth: number,
          instanceHeight: number,
          color: THREE.Color,
          rotationY = 0,
        ): void => {
          const facadeMesh = brickMidrise ? brickFacades : facades;
          const index = brickMidrise ? brickFacadeIndex : facadeIndex;
          setInstance(
            facadeMesh,
            index,
            instanceX,
            instanceY,
            instanceZ,
            instanceWidth,
            instanceHeight,
            1,
            color,
            rotationY,
          );
          if (brickMidrise) brickFacadeIndex += 1;
          else facadeIndex += 1;
        };

        const addFacadePair = (
          partX: number,
          partZ: number,
          partWidth: number,
          partHeight: number,
          partDepth: number,
          bottom: number,
        ): void => {
          const streetX = localX > 0
            ? partX - partWidth / 2 - 0.028
            : partX + partWidth / 2 + 0.028;
          addFacadeInstance(
            streetX,
            bottom + partHeight * 0.5,
            partZ,
            partDepth * 0.9,
            partHeight * 0.92,
            facadeTint,
            Math.PI / 2,
          );

          const oppositeX = localX > 0
            ? partX + partWidth / 2 + 0.028
            : partX - partWidth / 2 - 0.028;
          addFacadeInstance(
            oppositeX,
            bottom + partHeight * 0.5,
            partZ,
            partDepth * 0.9,
            partHeight * 0.92,
            facadeTint.clone().multiplyScalar(0.84),
            Math.PI / 2,
          );

          const streetZ = localZ > 0
            ? partZ - partDepth / 2 - 0.028
            : partZ + partDepth / 2 + 0.028;
          addFacadeInstance(
            partX,
            bottom + partHeight * 0.5,
            streetZ,
            partWidth * 0.9,
            partHeight * 0.92,
            facadeTint,
          );

          const oppositeZ = localZ > 0
            ? partZ + partDepth / 2 + 0.028
            : partZ - partDepth / 2 - 0.028;
          addFacadeInstance(
            partX,
            bottom + partHeight * 0.5,
            oppositeZ,
            partWidth * 0.9,
            partHeight * 0.92,
            facadeTint.clone().multiplyScalar(0.84),
          );
        };

        const addBasePart = (
          partX: number,
          partZ: number,
          partWidth: number,
          partHeight: number,
          partDepth: number,
          shade = 1,
        ): void => {
          setInstance(
            buildings,
            buildingIndex,
            partX,
            partHeight / 2,
            partZ,
            partWidth,
            partHeight,
            partDepth,
            facadeColor.clone().multiplyScalar(shade),
          );
          buildingIndex += 1;
          addFacadePair(partX, partZ, partWidth, partHeight, partDepth, 0);
          setInstance(
            architecturalDetails,
            detailIndex,
            partX,
            partHeight + 0.07,
            partZ,
            partWidth + 0.18,
            0.14,
            partDepth + 0.18,
            facadeColor.clone().multiplyScalar(0.8),
          );
          detailIndex += 1;
        };
        const addTierPart = (
          partX: number,
          partZ: number,
          partWidth: number,
          partHeight: number,
          partDepth: number,
          bottom: number,
          shade = 0.94,
        ): void => {
          setInstance(
            tiers,
            tierIndex,
            partX,
            bottom + partHeight / 2,
            partZ,
            partWidth,
            partHeight,
            partDepth,
            facadeColor.clone().multiplyScalar(shade),
          );
          tierIndex += 1;
          addFacadePair(partX, partZ, partWidth, partHeight, partDepth, bottom);
          setInstance(
            architecturalDetails,
            detailIndex,
            partX,
            bottom + 0.11,
            partZ,
            partWidth + 0.48,
            0.22,
            partDepth + 0.48,
            facadeColor.clone().lerp(new THREE.Color(0xf1e3bf), 0.58),
          );
          detailIndex += 1;
        };
        const addCylinderPart = (
          partWidth: number,
          partHeight: number,
          partDepth: number,
          bottom: number,
        ): void => {
          setInstance(
            cylinderBuildings,
            cylinderIndex,
            x,
            bottom + partHeight / 2,
            z,
            partWidth / 2,
            partHeight,
            partDepth / 2,
            facadeColor.clone().multiplyScalar(0.97),
          );
          setInstance(
            cylinderFacades,
            cylinderIndex,
            x,
            bottom + partHeight / 2,
            z,
            partWidth / 2,
            partHeight * 0.96,
            partDepth / 2,
            facadeTint,
          );
          cylinderIndex += 1;
        };
        const addCrownPart = (
          partX: number,
          partZ: number,
          partWidth: number,
          partHeight: number,
          partDepth: number,
          bottom: number,
          rotationY = Math.PI / 4,
        ): void => {
          setInstance(
            crowns,
            crownIndex,
            partX,
            bottom + partHeight / 2,
            partZ,
            partWidth / 2,
            partHeight,
            partDepth / 2,
            facadeColor.clone().lerp(new THREE.Color(0xcfe4e8), 0.38),
            rotationY,
          );
          crownIndex += 1;
        };

        switch (archetype) {
          case 'needle': {
            height = 18 + random() * 6;
            addBasePart(x, z, width, height, depth);
            const crownHeight = 17;
            const segmentSpace = targetHeight - height - crownHeight;
            const segmentHeights = [segmentSpace * 0.42, segmentSpace * 0.34, segmentSpace * 0.24];
            const segmentScales = [0.62, 0.48, 0.34];
            let bottom = height;
            for (let segment = 0; segment < segmentHeights.length; segment += 1) {
              const segmentHeight = segmentHeights[segment];
              tierWidth = width * segmentScales[segment];
              tierDepth = depth * segmentScales[segment];
              addTierPart(x, z, tierWidth, segmentHeight, tierDepth, bottom, 1 - segment * 0.045);
              bottom += segmentHeight;
            }
            addCrownPart(x, z, tierWidth * 1.02, crownHeight, tierDepth * 1.02, bottom);
            roofHeight = bottom + crownHeight;
            upperColliderWidth = width * 0.62;
            upperColliderDepth = depth * 0.62;
            const spireHeight = 16 + random() * 10;
            setInstance(
              roofProps,
              propIndex,
              x,
              roofHeight + spireHeight / 2,
              z,
              0.22,
              spireHeight,
              0.22,
              new THREE.Color(0x637e8b),
            );
            propIndex += 1;
            break;
          }
          case 'art-deco': {
            height = targetHeight * 0.48;
            addBasePart(x, z, width, height, depth);
            let bottom = height;
            for (const scale of [0.76, 0.56, 0.38]) {
              const segmentHeight = targetHeight * (scale === 0.76 ? 0.22 : scale === 0.56 ? 0.16 : 0.1);
              tierWidth = width * scale;
              tierDepth = depth * scale;
              addTierPart(x, z, tierWidth, segmentHeight, tierDepth, bottom, scale + 0.2);
              bottom += segmentHeight;
            }
            const crownHeight = Math.max(6, targetHeight - bottom);
            addCrownPart(x, z, tierWidth, crownHeight, tierDepth, bottom);
            roofHeight = bottom + crownHeight;
            upperColliderWidth = width * 0.76;
            upperColliderDepth = depth * 0.76;
            break;
          }
          case 'stepped': {
            height = targetHeight * 0.44;
            addBasePart(x, z, width, height, depth);
            let bottom = height;
            const remaining = targetHeight - height;
            const direction = localX > 0 ? -1 : 1;
            for (let step = 0; step < 3; step += 1) {
              const scale = 0.76 - step * 0.17;
              const segmentHeight = remaining / 3;
              roofX = x + direction * width * step * 0.055;
              tierWidth = width * scale;
              tierDepth = depth * (scale + 0.05);
              addTierPart(roofX, z, tierWidth, segmentHeight, tierDepth, bottom, 0.96 - step * 0.04);
              bottom += segmentHeight;
            }
            roofHeight = bottom;
            upperColliderWidth = width * 0.76;
            upperColliderDepth = depth * 0.81;
            upperColliderOffsetX = roofX - x;
            break;
          }
          case 'podium-tower': {
            height = 16 + random() * 10;
            addBasePart(x, z, width, height, depth);
            const capHeight = 6 + random() * 5;
            const towerHeight = targetHeight - height - capHeight;
            const offsetX = (random() - 0.5) * width * 0.14;
            const offsetZ = (random() - 0.5) * depth * 0.14;
            roofX = x + offsetX;
            roofZ = z + offsetZ;
            tierWidth = width * (0.48 + random() * 0.1);
            tierDepth = depth * (0.5 + random() * 0.1);
            addTierPart(roofX, roofZ, tierWidth, towerHeight, tierDepth, height);
            addTierPart(
              roofX,
              roofZ,
              tierWidth * 0.7,
              capHeight,
              tierDepth * 0.7,
              height + towerHeight,
              0.86,
            );
            roofHeight = targetHeight;
            upperColliderWidth = tierWidth;
            upperColliderDepth = tierDepth;
            upperColliderOffsetX = offsetX;
            upperColliderOffsetZ = offsetZ;
            break;
          }
          case 'wedge': {
            height = targetHeight * 0.3;
            addBasePart(x, z, width, height, depth);
            const direction = localX > 0 ? -1 : 1;
            let bottom = height;
            const remaining = targetHeight - height - 8;
            for (let step = 0; step < 4; step += 1) {
              const scale = 0.82 - step * 0.14;
              const segmentHeight = remaining / 4;
              roofX = x + direction * width * step * 0.065;
              tierWidth = width * scale;
              tierDepth = depth * (0.9 - step * 0.09);
              addTierPart(roofX, z, tierWidth, segmentHeight, tierDepth, bottom, 1 - step * 0.035);
              bottom += segmentHeight;
            }
            addCrownPart(roofX, z, tierWidth, 8, tierDepth, bottom, direction * Math.PI / 4);
            roofHeight = bottom + 8;
            upperColliderWidth = width * 0.82;
            upperColliderDepth = depth * 0.9;
            upperColliderOffsetX = roofX - x;
            break;
          }
          case 'twin-slab': {
            height = 14 + random() * 9;
            addBasePart(x, z, width, height, depth);
            const towerHeight = targetHeight - height;
            const splitAlongX = width >= depth;
            const offset = (splitAlongX ? width : depth) * 0.22;
            const towerWidth = splitAlongX ? width * 0.34 : width * 0.62;
            const towerDepth = splitAlongX ? depth * 0.62 : depth * 0.34;
            addTierPart(
              x + (splitAlongX ? -offset : 0),
              z + (splitAlongX ? 0 : -offset),
              towerWidth,
              towerHeight,
              towerDepth,
              height,
              0.96,
            );
            addTierPart(
              x + (splitAlongX ? offset : 0),
              z + (splitAlongX ? 0 : offset),
              towerWidth,
              towerHeight * 0.88,
              towerDepth,
              height,
              0.86,
            );
            preciseColliderParts = [
              { x, z, width, height, depth, bottom: 0 },
              {
                x: x + (splitAlongX ? -offset : 0),
                z: z + (splitAlongX ? 0 : -offset),
                width: towerWidth,
                height: towerHeight,
                depth: towerDepth,
                bottom: height,
              },
              {
                x: x + (splitAlongX ? offset : 0),
                z: z + (splitAlongX ? 0 : offset),
                width: towerWidth,
                height: towerHeight * 0.88,
                depth: towerDepth,
                bottom: height,
              },
            ];
            roofHeight = targetHeight;
            tierWidth = splitAlongX ? width * 0.82 : towerWidth;
            tierDepth = splitAlongX ? towerDepth : depth * 0.82;
            upperColliderWidth = tierWidth;
            upperColliderDepth = tierDepth;
            break;
          }
          case 'cylinder': {
            height = 10 + random() * 7;
            addBasePart(x, z, width, height, depth);
            const crownHeight = 8 + random() * 5;
            const towerHeight = targetHeight - height - crownHeight;
            tierWidth = width * 0.68;
            tierDepth = depth * 0.68;
            addCylinderPart(tierWidth, towerHeight, tierDepth, height);
            addCrownPart(x, z, tierWidth, crownHeight, tierDepth, height + towerHeight, 0);
            roofHeight = targetHeight;
            upperColliderWidth = tierWidth;
            upperColliderDepth = tierDepth;
            break;
          }
          case 'courtyard': {
            height = targetHeight;
            const wing = Math.min(width, depth) * 0.26;
            addBasePart(x - width * 0.34, z, wing, height, depth, 0.94);
            addBasePart(x + width * 0.34, z, wing, height * 0.9, depth, 0.88);
            addBasePart(x, z + depth * 0.36, width * 0.72, height * 0.78, wing, 1);
            preciseColliderParts = [
              { x: x - width * 0.34, z, width: wing, height, depth, bottom: 0 },
              {
                x: x + width * 0.34,
                z,
                width: wing,
                height: height * 0.9,
                depth,
                bottom: 0,
              },
              {
                x,
                z: z + depth * 0.36,
                width: width * 0.72,
                height: height * 0.78,
                depth: wing,
                bottom: 0,
              },
            ];
            roofHeight = height;
            break;
          }
          case 'brick-midrise': {
            height = targetHeight * 0.84;
            addBasePart(x, z, width, height, depth);
            const penthouseHeight = targetHeight - height;
            tierWidth = width * (0.58 + random() * 0.1);
            tierDepth = depth * (0.58 + random() * 0.1);
            addTierPart(x, z, tierWidth, penthouseHeight, tierDepth, height, 0.82);
            roofHeight = targetHeight;
            upperColliderWidth = tierWidth;
            upperColliderDepth = tierDepth;
            break;
          }
        }

        transform.rotation.set(0, 0, 0);
        transform.position.set(x, -0.42, z);
        transform.scale.set(width + 4.2, 0.16, depth + 4.2);
        transform.updateMatrix();
        architecturalDetails.setMatrixAt(detailIndex, transform.matrix);
        architecturalDetails.setColorAt(detailIndex, new THREE.Color(0x96948d));
        detailIndex += 1;

        if (random() > 0.38 && archetype !== 'courtyard') {
          transform.position.set(x, height * (0.42 + random() * 0.2), z);
          transform.scale.set(width + 0.16, 0.18, depth + 0.16);
          transform.updateMatrix();
          architecturalDetails.setMatrixAt(detailIndex, transform.matrix);
          architecturalDetails.setColorAt(
            detailIndex,
            facadeColor.clone().lerp(new THREE.Color(glassTower ? 0xd8ffff : 0xffe6b8), 0.68),
          );
          detailIndex += 1;
        }

        // A readable ground floor has more impact at swing height than another
        // tower silhouette. Reuse the shared detail instances for entrances
        // and canopies instead of creating per-building meshes or materials.
        const entranceColor = facadeColor.clone().lerp(new THREE.Color(0x263b43), 0.72);
        const frontageSign = streetAxis === 'x' ? Math.sign(localX) : Math.sign(localZ);
        if (streetAxis === 'x') {
          const facadeX = x - frontageSign * (width / 2 + 0.62);
          setInstance(
            architecturalDetails,
            detailIndex,
            facadeX,
            3.15,
            z,
            1.35,
            0.32,
            Math.min(8.5, depth * 0.5),
            entranceColor,
          );
        } else {
          const facadeZ = z - frontageSign * (depth / 2 + 0.62);
          setInstance(
            architecturalDetails,
            detailIndex,
            x,
            3.15,
            facadeZ,
            Math.min(8.5, width * 0.5),
            0.32,
            1.35,
            entranceColor,
          );
        }
        detailIndex += 1;

        if (parcel.corner && plan.district !== 'commercial-core' && treeIndex < 47) {
          const treeX = streetAxis === 'x'
            ? x - frontageSign * (width / 2 + 3.1)
            : x + Math.sign(localX) * Math.min(width * 0.3, 4.5);
          const treeZ = streetAxis === 'z'
            ? z - frontageSign * (depth / 2 + 3.1)
            : z + Math.sign(localZ) * Math.min(depth * 0.3, 4.5);
          setInstance(
            roofProps,
            propIndex,
            treeX,
            0.82,
            treeZ,
            0.32,
            2,
            0.32,
            new THREE.Color(0x6f5037),
          );
          propIndex += 1;
          setInstance(
            treeCanopies,
            treeIndex,
            treeX,
            2.9,
            treeZ,
            1.35,
            1.7,
            1.35,
            new THREE.Color(plan.district === 'waterfront' ? 0x5f9670 : 0x56865b),
          );
          treeIndex += 1;
        }

        if (random() > 0.28 && archetype !== 'needle' && archetype !== 'wedge') {
          const waterTank = random() < 0.48;
          const propHeight = waterTank ? 2.6 : 7 + random() * 8;
          transform.position.set(roofX, roofHeight + propHeight / 2 + 0.36, roofZ);
          transform.scale.set(waterTank ? 1.9 : 0.22, propHeight, waterTank ? 1.9 : 0.22);
          transform.updateMatrix();
          roofProps.setMatrixAt(propIndex, transform.matrix);
          roofProps.setColorAt(
            propIndex,
            new THREE.Color(waterTank ? 0x6d7778 : random() > 0.5 ? 0xc55a45 : 0x657783),
          );
          propIndex += 1;
        }

        const body = this.world.createRigidBody(preciseColliderParts
          ? RAPIER.RigidBodyDesc.fixed()
          : RAPIER.RigidBodyDesc.fixed().setTranslation(x, height / 2, z));
        body.setEnabled(false);
        if (preciseColliderParts) {
          for (const part of preciseColliderParts) {
            this.world.createCollider(
              RAPIER.ColliderDesc.cuboid(part.width / 2, part.height / 2, part.depth / 2)
                .setTranslation(part.x, part.bottom + part.height / 2, part.z),
              body,
            );
          }
        } else {
          this.world.createCollider(
            RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2),
            body,
          );
          const upperHeight = roofHeight - height;
          if (upperHeight > 0.5) {
            this.world.createCollider(
              RAPIER.ColliderDesc.cuboid(
                upperColliderWidth / 2,
                upperHeight / 2,
                upperColliderDepth / 2,
              ).setTranslation(
                upperColliderOffsetX,
                height / 2 + upperHeight / 2,
                upperColliderOffsetZ,
              ),
              body,
            );
          }
        }
        bodies.push(body);

        if (preciseColliderParts) {
          const anchorParts = archetype === 'courtyard'
            ? preciseColliderParts
            : preciseColliderParts.slice(1);
          for (const part of anchorParts) {
            anchors.push(...createBuildingTraversalAnchors({
              roofX: part.x,
              roofZ: part.z,
              roofHeight: part.bottom + part.height,
              width: part.width,
              depth: part.depth,
            }));
          }
        } else {
          anchors.push(...createBuildingTraversalAnchors({
            roofX,
            roofZ,
            roofHeight,
            width: tierWidth,
            depth: tierDepth,
          }));
        }
    }

    yield;

    // The validator is intentionally advisory: it improves city generation
    // without changing selection, rope forces, or any other gameplay system.
    group.userData.anchorCoverageValid = validateAnchorCoverage(anchors);

    const verticalLaneOffset = Math.max(2.7, verticalRoadWidth * 0.22);
    const horizontalLaneOffset = Math.max(2.7, horizontalRoadWidth * 0.22);
    const trafficCars: TrafficCar[] = [];
    const trafficCount = plan.gameplayZone === 'safe-hub'
      ? 0
      : plan.gameplayZone === 'combat-arena' ? 3 : 6;
    for (let carIndex = 0; carIndex < trafficCount; carIndex += 1) {
      const alongX = carIndex % 2 === 0;
      const direction: 1 | -1 = carIndex % 4 < 2 ? 1 : -1;
      trafficCars.push({
        alongX,
        lane: direction * (alongX ? horizontalLaneOffset : verticalLaneOffset),
        phase: random() * CONFIG.chunkSize,
        speed: 7.5 + random() * 5.5,
        direction,
      });
    }
    let carVisualIndex = 0;
    for (let trafficIndex = 0; trafficIndex < trafficCars.length; trafficIndex += 1) {
      const carColor = new THREE.Color(carColors[Math.floor(random() * carColors.length)]);
      cars.setColorAt(carVisualIndex, carColor);
      carVisualIndex += 1;
      cars.setColorAt(carVisualIndex, new THREE.Color(0x526b78));
      carVisualIndex += 1;
    }
    const traffic = trafficCars.length > 0
      ? { mesh: cars, centerX, centerZ, cars: trafficCars }
      : null;
    if (traffic) this.updateTraffic(traffic, performance.now() * 0.001);

    yield;

    buildings.userData.isBuilding = true;
    tiers.userData.isBuilding = true;
    cylinderBuildings.userData.isBuilding = true;
    crowns.userData.isBuilding = true;
    buildings.count = buildingIndex;
    buildings.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;
    if (buildingIndex > 0) buildings.computeBoundingSphere();
    tiers.count = tierIndex;
    tiers.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (tiers.instanceColor) tiers.instanceColor.needsUpdate = true;
    if (tierIndex > 0) tiers.computeBoundingSphere();
    cylinderBuildings.count = cylinderIndex;
    cylinderBuildings.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (cylinderBuildings.instanceColor) cylinderBuildings.instanceColor.needsUpdate = true;
    if (cylinderIndex > 0) cylinderBuildings.computeBoundingSphere();
    cylinderFacades.count = cylinderIndex;
    cylinderFacades.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (cylinderFacades.instanceColor) cylinderFacades.instanceColor.needsUpdate = true;
    if (cylinderIndex > 0) cylinderFacades.computeBoundingSphere();
    crowns.count = crownIndex;
    crowns.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
    if (crownIndex > 0) crowns.computeBoundingSphere();
    architecturalDetails.count = detailIndex;
    architecturalDetails.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (architecturalDetails.instanceColor) architecturalDetails.instanceColor.needsUpdate = true;
    if (detailIndex > 0) architecturalDetails.computeBoundingSphere();
    roofProps.count = propIndex;
    roofProps.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (roofProps.instanceColor) roofProps.instanceColor.needsUpdate = true;
    if (propIndex > 0) roofProps.computeBoundingSphere();
    facades.count = facadeIndex;
    facades.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (facades.instanceColor) facades.instanceColor.needsUpdate = true;
    if (facadeIndex > 0) facades.computeBoundingSphere();
    brickFacades.count = brickFacadeIndex;
    brickFacades.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (brickFacades.instanceColor) brickFacades.instanceColor.needsUpdate = true;
    if (brickFacadeIndex > 0) brickFacades.computeBoundingSphere();
    treeCanopies.count = treeIndex;
    treeCanopies.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (treeCanopies.instanceColor) treeCanopies.instanceColor.needsUpdate = true;
    if (treeIndex > 0) treeCanopies.computeBoundingSphere();
    streetFurniture.count = streetFurnitureIndex;
    streetFurniture.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (streetFurniture.instanceColor) streetFurniture.instanceColor.needsUpdate = true;
    if (streetFurnitureIndex > 0) streetFurniture.computeBoundingSphere();
    streetTreeCanopies.count = streetTreeIndex;
    streetTreeCanopies.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (streetTreeCanopies.instanceColor) streetTreeCanopies.instanceColor.needsUpdate = true;
    if (streetTreeIndex > 0) streetTreeCanopies.computeBoundingSphere();
    cars.count = carVisualIndex;
    cars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (cars.instanceColor) cars.instanceColor.needsUpdate = true;
    if (carVisualIndex > 0) {
      cars.boundingSphere = new THREE.Sphere(
        new THREE.Vector3(centerX, 0, centerZ),
        CONFIG.chunkSize * 0.82,
      );
    }
    group.add(sidewalks, roads);
    if (carVisualIndex > 0) group.add(cars);
    if (river) group.add(river);
    if (roundaboutIsland) group.add(roundaboutIsland);
    if (diagonalRoad) group.add(diagonalRoad);
    if (detailIndex > 0) group.add(architecturalDetails);
    if (buildingIndex > 0) group.add(buildings);
    if (facadeIndex > 0) group.add(facades);
    if (brickFacadeIndex > 0) group.add(brickFacades);
    if (tierIndex > 0) group.add(tiers);
    if (cylinderIndex > 0) group.add(cylinderBuildings);
    if (cylinderIndex > 0) group.add(cylinderFacades);
    if (crownIndex > 0) group.add(crowns);
    if (propIndex > 0) group.add(roofProps);
    if (treeIndex > 0) group.add(treeCanopies);
    if (streetFurnitureIndex > 0) group.add(streetFurniture);
    if (streetTreeIndex > 0) group.add(streetTreeCanopies);
    if (buildingIndex > 0) {
      meshes.push(buildings);
      this.buildingMeshes.push(buildings);
    }
    if (tierIndex > 0) {
      meshes.push(tiers);
      this.buildingMeshes.push(tiers);
    }
    if (cylinderIndex > 0) {
      meshes.push(cylinderBuildings);
      this.buildingMeshes.push(cylinderBuildings);
    }
    if (crownIndex > 0) {
      meshes.push(crowns);
      this.buildingMeshes.push(crowns);
    }

    this.scene.add(group);
    const detailMeshes: THREE.Object3D[] = [
      facades,
      brickFacades,
      cylinderFacades,
      architecturalDetails,
      roofProps,
      treeCanopies,
      streetFurniture,
      streetTreeCanopies,
    ];
    this.chunks.set(key, {
      group,
      bodies,
      meshes,
      anchors,
      centerX,
      centerZ,
      traffic,
      detailMeshes,
      physicsEnabled: false,
    });
    this.loadedChunkEvents.push({ x: chunkX, z: chunkZ });
  }

  private updateTraffic(traffic: TrafficAnimation, time: number): void {
    const routeLength = CONFIG.chunkSize + 28;
    const roadSurface = -0.42;
    let instanceIndex = 0;
    for (const car of traffic.cars) {
      const progress = ((car.phase + time * car.speed * car.direction) % routeLength
        + routeLength) % routeLength - routeLength / 2;
      const x = car.alongX ? traffic.centerX + progress : traffic.centerX + car.lane;
      const z = car.alongX ? traffic.centerZ + car.lane : traffic.centerZ + progress;
      const bodyWidth = car.alongX ? 5.1 : 2.15;
      const bodyDepth = car.alongX ? 2.15 : 5.1;
      const cabinWidth = car.alongX ? 2.9 : 1.78;
      const cabinDepth = car.alongX ? 1.78 : 2.9;
      const bodyHeight = 0.82;
      const cabinHeight = 0.62;

      this.trafficTransform.position.set(x, roadSurface + bodyHeight / 2, z);
      this.trafficTransform.rotation.set(0, 0, 0);
      this.trafficTransform.scale.set(bodyWidth, bodyHeight, bodyDepth);
      this.trafficTransform.updateMatrix();
      traffic.mesh.setMatrixAt(instanceIndex, this.trafficTransform.matrix);
      instanceIndex += 1;

      this.trafficTransform.position.set(
        x,
        roadSurface + bodyHeight + cabinHeight / 2 - 0.08,
        z,
      );
      this.trafficTransform.scale.set(cabinWidth, cabinHeight, cabinDepth);
      this.trafficTransform.updateMatrix();
      traffic.mesh.setMatrixAt(instanceIndex, this.trafficTransform.matrix);
      instanceIndex += 1;
    }
    traffic.mesh.instanceMatrix.needsUpdate = true;
  }

  private removeChunk(key: string, chunk: CityChunk): void {
    this.scene.remove(chunk.group);
    for (const body of chunk.bodies) this.world.removeRigidBody(body);
    for (const mesh of chunk.meshes) {
      const index = this.buildingMeshes.indexOf(mesh);
      if (index >= 0) this.buildingMeshes.splice(index, 1);
    }
    chunk.group.traverse((object) => {
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    this.chunks.delete(key);
  }

  private getRoadGeometry(verticalWidth: number, horizontalWidth: number): THREE.BufferGeometry {
    const key = `${verticalWidth}:${horizontalWidth}`;
    let geometry = this.roadGeometries.get(key);
    if (!geometry) {
      geometry = createCrossRoadGeometry(verticalWidth, horizontalWidth);
      this.roadGeometries.set(key, geometry);
    }
    return geometry;
  }

  private createAerialEnvironment(): THREE.Group {
    const environment = new THREE.Group();
    environment.name = 'city-aerial-environment';

    const blueLift = new THREE.Mesh(
      new THREE.SphereGeometry(458, 24, 14),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        fog: false,
        vertexShader: `
          varying float vHeight;
          void main() {
            vHeight = normalize(position).y;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying float vHeight;
          void main() {
            float zenith = smoothstep(-0.08, 0.92, vHeight);
            vec3 color = mix(vec3(0.2, 0.58, 0.78), vec3(0.015, 0.25, 0.62), zenith);
            gl_FragColor = vec4(color, 0.12 + zenith * 0.34);
          }
        `,
      }),
    );
    blueLift.frustumCulled = false;
    blueLift.renderOrder = -1001;
    environment.add(blueLift);

    const cloudTexture = this.createCloudLayerTexture();
    const skyMaterial = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      fog: false,
      uniforms: {
        cloudMap: { value: cloudTexture },
      },
      vertexShader: `
        varying vec2 vUv;
        varying float vSkyHeight;
        void main() {
          vUv = uv;
          vSkyHeight = normalize(position).y;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec2 vUv;
        varying float vSkyHeight;
        uniform sampler2D cloudMap;
        void main() {
          vec4 cloud = texture2D(cloudMap, vUv);
          float lowerPoleFade = smoothstep(0.16, 0.32, vUv.y);
          float upperPoleFade = 1.0 - smoothstep(0.76, 0.94, vUv.y);
          float horizonClearance = smoothstep(0.22, 0.4, vSkyHeight);
          float naturalCoverage = lowerPoleFade * upperPoleFade * horizonClearance;
          gl_FragColor = vec4(cloud.rgb, cloud.a * naturalCoverage * 0.9);
        }
      `,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(460, 32, 20), skyMaterial);
    sky.frustumCulled = false;
    sky.renderOrder = -1000;
    environment.add(sky);

    const sunPosition = new THREE.Vector3(-245, 250, -255);
    const sunCore = new THREE.Mesh(
      new THREE.SphereGeometry(7.5, 18, 12),
      new THREE.MeshBasicMaterial({
        color: 0xfff5cf,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.96,
        depthWrite: false,
        fog: false,
      }),
    );
    sunCore.position.copy(sunPosition);
    sunCore.renderOrder = -8;
    environment.add(sunCore);

    const lensflare = new Lensflare();
    const flareTexture = this.createSunHaloTexture();
    const ghostTexture = this.createLensGhostTexture();
    const streakTexture = this.createAnamorphicFlareTexture();
    lensflare.addElement(new LensflareElement(flareTexture, 224, 0, new THREE.Color(0xfff4d4)));
    lensflare.addElement(new LensflareElement(streakTexture, 440, 0.012, new THREE.Color(0xd4edff)));
    lensflare.addElement(new LensflareElement(ghostTexture, 54, 0.34, new THREE.Color(0xffd49a)));
    lensflare.addElement(new LensflareElement(ghostTexture, 78, 0.61, new THREE.Color(0x9fc7df)));
    lensflare.addElement(new LensflareElement(ghostTexture, 44, 0.82, new THREE.Color(0xb5a3ca)));
    sunCore.add(lensflare);

    const mountainPositions: number[] = [];
    const mountainColors: number[] = [];
    const mountainSegments = 72;
    const heights: number[] = [];
    const radii: number[] = [];
    for (let index = 0; index <= mountainSegments; index += 1) {
      const broad = Math.sin(index * 0.47) * 34 + Math.sin(index * 0.19 + 1.7) * 46;
      const ridge = Math.abs(Math.sin(index * 1.37)) * 38;
      heights.push(62 + broad + ridge);
      radii.push(390 + Math.sin(index * 0.63) * 28);
    }
    const pushMountainVertex = (x: number, y: number, z: number, top: boolean): void => {
      mountainPositions.push(x, y, z);
      const color = new THREE.Color(top ? 0x78939b : 0xaebfc0);
      mountainColors.push(color.r, color.g, color.b);
    };
    for (let index = 0; index < mountainSegments; index += 1) {
      const angle0 = (index / mountainSegments) * Math.PI * 2;
      const angle1 = ((index + 1) / mountainSegments) * Math.PI * 2;
      const x0 = Math.cos(angle0) * radii[index];
      const z0 = Math.sin(angle0) * radii[index];
      const x1 = Math.cos(angle1) * radii[index + 1];
      const z1 = Math.sin(angle1) * radii[index + 1];
      pushMountainVertex(x0, -22, z0, false);
      pushMountainVertex(x1, -22, z1, false);
      pushMountainVertex(x1, heights[index + 1], z1, true);
      pushMountainVertex(x0, -22, z0, false);
      pushMountainVertex(x1, heights[index + 1], z1, true);
      pushMountainVertex(x0, heights[index], z0, true);
    }
    const mountainGeometry = new THREE.BufferGeometry();
    mountainGeometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(mountainPositions, 3),
    );
    mountainGeometry.setAttribute('color', new THREE.Float32BufferAttribute(mountainColors, 3));
    mountainGeometry.computeVertexNormals();
    const mountains = new THREE.Mesh(
      mountainGeometry,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        fog: false,
      }),
    );
    mountains.visible = false;

    // A low atmospheric wall suggests a continuing city beyond streamed
    // chunks without showing a floating mountain silhouette or open void.
    const distantCityHaze = new THREE.Mesh(
      new THREE.CylinderGeometry(420, 420, 105, 64, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x8fa1a4,
        transparent: true,
        opacity: 0.34,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    distantCityHaze.position.y = 12;
    distantCityHaze.renderOrder = -15;
    environment.add(distantCityHaze);

    return environment;
  }

  private createCloudLayerTexture(): THREE.Texture {
    const generatedSky = new THREE.TextureLoader().load(cloudLayerUrl);
    generatedSky.colorSpace = THREE.SRGBColorSpace;
    generatedSky.wrapS = THREE.RepeatWrapping;
    generatedSky.wrapT = THREE.ClampToEdgeWrapping;
    generatedSky.magFilter = THREE.LinearFilter;
    generatedSky.minFilter = THREE.LinearMipmapLinearFilter;
    generatedSky.anisotropy = Math.min(4, this.textureAnisotropy);
    return generatedSky;
    /* Previous procedural fallback retained temporarily for reference.
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the sky panorama texture.');

    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#0d72bb');
    gradient.addColorStop(0.28, '#3f9bd2');
    gradient.addColorStop(0.5, '#91c9e4');
    gradient.addColorStop(0.62, '#dcecf0');
    gradient.addColorStop(1, '#e8e4da');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    const cloudRandom = seededRandom(0x51c0a7);
    const drawCloud = (centerX: number, centerY: number, scale: number, opacity: number): void => {
      context.save();
      context.globalAlpha = opacity;
      const shadow = context.createLinearGradient(0, centerY - scale, 0, centerY + scale);
      shadow.addColorStop(0, 'rgba(255,255,255,.96)');
      shadow.addColorStop(0.72, 'rgba(245,248,247,.82)');
      shadow.addColorStop(1, 'rgba(178,201,211,.38)');
      context.fillStyle = shadow;
      for (let puff = 0; puff < 7; puff += 1) {
        const offsetX = (puff - 3) * scale * 0.48 + (cloudRandom() - 0.5) * scale * 0.3;
        const offsetY = (cloudRandom() - 0.55) * scale * 0.34;
        context.beginPath();
        context.ellipse(
          centerX + offsetX,
          centerY + offsetY,
          scale * (0.58 + cloudRandom() * 0.34),
          scale * (0.22 + cloudRandom() * 0.16),
          0,
          0,
          Math.PI * 2,
        );
        context.fill();
      }
      context.restore();
    };

    for (let cloud = 0; cloud < 17; cloud += 1) {
      const x = cloudRandom() * canvas.width;
      const y = 118 + cloudRandom() * 155;
      const scale = 24 + cloudRandom() * 34;
      drawCloud(x, y, scale, 0.42 + cloudRandom() * 0.35);
      if (x < scale * 4) drawCloud(x + canvas.width, y, scale, 0.56);
      if (x > canvas.width - scale * 4) drawCloud(x - canvas.width, y, scale, 0.56);
    }

    const sunGlow = context.createRadialGradient(770, 196, 2, 770, 196, 72);
    sunGlow.addColorStop(0, 'rgba(255,249,211,.94)');
    sunGlow.addColorStop(0.12, 'rgba(255,244,196,.56)');
    sunGlow.addColorStop(1, 'rgba(255,244,196,0)');
    context.fillStyle = sunGlow;
    context.fillRect(690, 116, 160, 160);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.anisotropy = Math.min(4, this.textureAnisotropy);
    return texture;
    */
  }

  private createSunHaloTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the sun halo texture.');
    const glow = context.createRadialGradient(128, 128, 4, 128, 128, 126);
    glow.addColorStop(0, 'rgba(255,255,241,1)');
    glow.addColorStop(0.08, 'rgba(255,247,215,1)');
    glow.addColorStop(0.25, 'rgba(255,228,166,.58)');
    glow.addColorStop(0.58, 'rgba(255,210,136,.2)');
    glow.addColorStop(1, 'rgba(255,200,120,0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.save();
    context.translate(128, 128);
    context.globalCompositeOperation = 'lighter';
    for (let ray = 0; ray < 24; ray += 1) {
      const angle = (ray / 24) * Math.PI * 2;
      context.setTransform(1, 0, 0, 1, 128, 128);
      context.rotate(angle);
      const length = ray % 3 === 0 ? 112 : ray % 2 === 0 ? 82 : 58;
      const rayGradient = context.createLinearGradient(10, 0, length, 0);
      rayGradient.addColorStop(0, 'rgba(255,246,214,.62)');
      rayGradient.addColorStop(1, 'rgba(255,226,170,0)');
      context.strokeStyle = rayGradient;
      context.lineWidth = ray % 3 === 0 ? 1.8 : 0.9;
      context.beginPath();
      context.moveTo(10, 0);
      context.lineTo(length, 0);
      context.stroke();
    }
    context.restore();
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    return texture;
  }

  private createLensGhostTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the lens ghost texture.');
    const aperture = context.createRadialGradient(128, 128, 10, 128, 128, 124);
    aperture.addColorStop(0, 'rgba(255,255,255,.13)');
    aperture.addColorStop(0.46, 'rgba(255,255,255,.09)');
    aperture.addColorStop(0.72, 'rgba(255,255,255,.14)');
    aperture.addColorStop(0.9, 'rgba(255,255,255,.025)');
    aperture.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = aperture;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    return texture;
  }

  private createAnamorphicFlareTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the anamorphic flare texture.');
    const horizontal = context.createLinearGradient(0, 64, canvas.width, 64);
    horizontal.addColorStop(0, 'rgba(255,255,255,0)');
    horizontal.addColorStop(0.38, 'rgba(220,240,255,.07)');
    horizontal.addColorStop(0.5, 'rgba(255,250,224,.52)');
    horizontal.addColorStop(0.62, 'rgba(220,240,255,.07)');
    horizontal.addColorStop(1, 'rgba(255,255,255,0)');
    const vertical = context.createLinearGradient(0, 46, 0, 82);
    vertical.addColorStop(0, 'rgba(255,255,255,0)');
    vertical.addColorStop(0.5, 'rgba(255,255,255,1)');
    vertical.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = horizontal;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = 'destination-in';
    context.fillStyle = vertical;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    return texture;
  }

  private createFacadeTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 384;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the procedural facade texture.');
    context.clearRect(0, 0, canvas.width, canvas.height);

    const columns = 8;
    const rows = 24;
    const cellWidth = canvas.width / columns;
    const cellHeight = canvas.height / rows;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const lit = ((row * 7 + column * 11) % 11) > 7;
        context.fillStyle = lit
          ? '#c9ab79'
          : (row + column) % 4 === 0 ? '#526a72' : '#42545d';
        context.fillRect(
          column * cellWidth + 4,
          row * cellHeight + 3,
          cellWidth - 8,
          cellHeight - 6,
        );
        context.strokeStyle = 'rgba(195, 201, 196, 0.48)';
        context.lineWidth = 1;
        context.strokeRect(
          column * cellWidth + 3,
          row * cellHeight + 2,
          cellWidth - 6,
          cellHeight - 4,
        );
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    return texture;
  }

  private createBrickFacadeTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 384;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the brick facade texture.');
    context.clearRect(0, 0, canvas.width, canvas.height);

    const columns = 5;
    const rows = 14;
    const cellWidth = canvas.width / columns;
    const cellHeight = canvas.height / rows;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const width = cellWidth * 0.46;
        const height = cellHeight * 0.62;
        const left = column * cellWidth + (cellWidth - width) / 2;
        const top = row * cellHeight + (cellHeight - height) / 2;
        const lit = ((row * 3 + column * 7) % 13) > 9;
        context.beginPath();
        context.roundRect(left, top, width, height, [6, 6, 2, 2]);
        context.fillStyle = lit ? '#c9aa76' : '#3d4c50';
        context.fill();
        context.strokeStyle = 'rgba(204, 198, 180, 0.58)';
        context.lineWidth = 2;
        context.stroke();
        context.fillStyle = 'rgba(175, 164, 143, 0.58)';
        context.fillRect(left - 3, top + height + 2, width + 6, 3);
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    return texture;
  }

  private createVerticalFacadeTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 384;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the vertical facade texture.');
    context.clearRect(0, 0, canvas.width, canvas.height);

    const columns = 6;
    const rows = 18;
    const cellWidth = canvas.width / columns;
    const cellHeight = canvas.height / rows;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const left = column * cellWidth + cellWidth * 0.3;
        const top = row * cellHeight + 3;
        const lit = ((row * 5 + column * 3) % 9) > 6;
        context.fillStyle = lit ? '#cbb184' : column % 2 === 0 ? '#4f6974' : '#5d7880';
        context.fillRect(left, top, cellWidth * 0.4, cellHeight - 6);
        context.strokeStyle = 'rgba(190, 198, 193, 0.52)';
        context.lineWidth = 1.5;
        context.strokeRect(left - 1, top - 1, cellWidth * 0.4 + 2, cellHeight - 4);
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    return texture;
  }

  private createCurtainFacadeTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 384;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the curtain-wall facade texture.');

    const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
    gradient.addColorStop(0, '#526c76');
    gradient.addColorStop(0.46, '#78939a');
    gradient.addColorStop(0.58, '#58747d');
    gradient.addColorStop(1, '#405b68');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    for (let x = 0; x <= canvas.width; x += 24) {
      context.fillStyle = x % 48 === 0 ? 'rgba(39, 66, 82, 0.78)' : 'rgba(58, 88, 103, 0.54)';
      context.fillRect(x, 0, x % 48 === 0 ? 4 : 2, canvas.height);
    }
    for (let y = 0; y <= canvas.height; y += 18) {
      context.fillStyle = 'rgba(224, 239, 237, 0.34)';
      context.fillRect(0, y, canvas.width, 2);
      if ((y / 18) % 7 === 3) {
        context.fillStyle = 'rgba(211, 181, 126, 0.24)';
        context.fillRect(28 + (y % 64), y + 5, 36, 21);
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.anisotropy = Math.min(8, this.textureAnisotropy);
    return texture;
  }

  private createSidewalkTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the procedural sidewalk texture.');

    // Warm, slightly beige New York-style concrete. Large slab joints and
    // restrained wear keep it clearly separate from the blue-gray asphalt.
    context.fillStyle = '#b7b2a8';
    context.fillRect(0, 0, canvas.width, canvas.height);
    for (let slab = 0; slab < 24; slab += 1) {
      const x = (slab * 71) % canvas.width;
      const y = (slab * 109) % canvas.height;
      context.fillStyle = slab % 3 === 0
        ? 'rgba(92, 91, 87, 0.055)'
        : 'rgba(242, 238, 228, 0.075)';
      context.fillRect(x, y, 12 + (slab % 4) * 9, 7 + (slab % 3) * 8);
    }
    context.strokeStyle = 'rgba(102, 101, 96, 0.24)';
    context.lineWidth = 1.4;
    for (let line = 0; line <= canvas.width; line += 64) {
      context.beginPath();
      context.moveTo(line, 0);
      context.lineTo(line, canvas.height);
      context.stroke();
    }
    for (let line = 0; line <= canvas.height; line += 64) {
      context.beginPath();
      context.moveTo(0, line);
      context.lineTo(canvas.width, line);
      context.stroke();
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2.2, 4.4);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.anisotropy = Math.min(8, this.textureAnisotropy);
    return texture;
  }

  private createRoadTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the procedural road texture.');
    context.fillStyle = '#34373a';
    context.fillRect(0, 0, canvas.width, canvas.height);
    // Subtle aggregate and repair patches keep the road from reading as one
    // perfectly clean toy texture while remaining deterministic and cheap.
    for (let patch = 0; patch < 34; patch += 1) {
      const x = (patch * 67) % canvas.width;
      const y = (patch * 113) % canvas.height;
      context.fillStyle = patch % 3 === 0 ? 'rgba(20,22,24,.12)' : 'rgba(118,122,120,.06)';
      context.fillRect(x, y, 18 + (patch % 5) * 7, 5 + (patch % 4) * 3);
    }
    context.fillStyle = '#d7d2bd';
    context.fillRect(10, 0, 2, canvas.height);
    context.fillRect(244, 0, 2, canvas.height);

    // Two-way urban road: a double centre line and restrained broken lane marks.
    context.fillStyle = '#d7bb62';
    context.fillRect(125, 0, 2, canvas.height);
    context.fillRect(130, 0, 2, canvas.height);
    for (const divider of [68, 96, 160, 188]) {
      context.fillStyle = 'rgba(232,234,227,.7)';
      for (let y = 12; y < canvas.height; y += 72) context.fillRect(divider, y, 2, 31);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1, 3.5);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.anisotropy = Math.min(8, this.textureAnisotropy);
    return texture;
  }

}
