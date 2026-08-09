import * as THREE from 'three';
import type { RigidBody, World } from '@dimforge/rapier3d-compat';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from './config';
import {
  MAX_ROAD_WIDTH,
  chooseBuildingArchetype,
  createChunkUrbanPlan,
  riverCenterAt,
} from './UrbanPlan';

interface CityChunk {
  group: THREE.Group;
  bodies: RigidBody[];
  meshes: THREE.Mesh[];
  anchors: THREE.Vector3[];
}

interface PendingChunk {
  x: number;
  z: number;
  key: string;
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
  private readonly wantedChunks = new Set<string>();
  private readonly pendingChunks: PendingChunk[] = [];
  private readonly pendingKeys = new Set<string>();
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
  private readonly buildingMaterial: THREE.MeshBasicMaterial;
  private readonly facadeMaterial: THREE.MeshBasicMaterial;
  private readonly brickFacadeMaterial: THREE.MeshBasicMaterial;
  private readonly verticalFacadeMaterial: THREE.MeshBasicMaterial;
  private readonly curtainFacadeMaterial: THREE.MeshBasicMaterial;
  private readonly roofMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    toneMapped: false,
  });
  private readonly antennaMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.7,
    metalness: 0.16,
  });
  private readonly roadMaterial: THREE.MeshStandardMaterial;
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
    color: 0x6e9a67,
    roughness: 1,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });
  private readonly waterMaterial = new THREE.MeshStandardMaterial({
    color: 0x4d9fbd,
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

  constructor(
    private readonly scene: THREE.Scene,
    private readonly world: World,
    private readonly textureAnisotropy: number,
  ) {
    this.buildingMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      fog: true,
      toneMapped: false,
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
      toneMapped: false,
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
      toneMapped: false,
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
      toneMapped: false,
    });
    this.curtainFacadeMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: this.createCurtainFacadeTexture(),
      transparent: false,
      depthWrite: true,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      side: THREE.DoubleSide,
      toneMapped: false,
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
    this.diagonalRoadMaterial = this.roadMaterial.clone();
    this.diagonalRoadMaterial.polygonOffsetFactor = -3;
    this.diagonalRoadMaterial.polygonOffsetUnits = -5;
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(12000, 12000),
      new THREE.MeshStandardMaterial({ color: 0x8f9288, roughness: 1, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.55;
    this.scene.add(ground);

    const groundBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, 0),
    );
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(6000, 0.5, 6000), groundBody);
  }

  update(playerPosition: THREE.Vector3, viewDirection?: THREE.Vector3): void {
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
    }

    const creationBudget = firstUpdate ? this.pendingChunks.length : 1;
    for (let index = 0; index < creationBudget; index += 1) {
      const pending = this.pendingChunks.shift();
      if (!pending) break;
      this.pendingKeys.delete(pending.key);
      if (this.wantedChunks.has(pending.key) && !this.chunks.has(pending.key)) {
        this.createChunk(pending.x, pending.z, pending.key);
      }
    }

    for (const [key, chunk] of this.chunks) {
      if (this.wantedChunks.has(key)) continue;
      this.removeChunk(key, chunk);
      break;
    }
  }

  getBuildingMeshes(): THREE.Mesh[] {
    return this.buildingMeshes;
  }

  findAssistedAnchor(camera: THREE.Camera, playerPosition: THREE.Vector3): THREE.Vector3 | null {
    camera.getWorldDirection(this.cameraDirection);
    let best: THREE.Vector3 | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const chunk of this.chunks.values()) {
      for (const anchor of chunk.anchors) {
        this.anchorDelta.copy(anchor).sub(playerPosition);
        const distance = this.anchorDelta.length();
        if (distance > CONFIG.ropeMaxRange || distance < 7) continue;
        if (this.anchorDelta.dot(this.cameraDirection) <= 1) continue;

        this.projectedAnchor.copy(anchor).project(camera);
        if (this.projectedAnchor.z < -1 || this.projectedAnchor.z > 1) continue;
        const x = Math.abs(this.projectedAnchor.x);
        const y = Math.abs(this.projectedAnchor.y);
        if (x > 0.58 || y > 0.52) continue;

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

  private createChunk(chunkX: number, chunkZ: number, key: string): void {
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
    const diagonalDistrict = plan.diagonalBoulevard;
    const lotOuterEdge = CONFIG.chunkSize / 2 - 6;
    const lotInnerX = verticalRoadWidth / 2 + 3;
    const lotInnerZ = horizontalRoadWidth / 2 + 3;
    const lotSpanX = lotOuterEdge - lotInnerX;
    const lotSpanZ = lotOuterEdge - lotInnerZ;
    const lotCenterX = (lotInnerX + lotOuterEdge) / 2;
    const lotCenterZ = (lotInnerZ + lotOuterEdge) / 2;
    const lotCentersX = [-lotCenterX, lotCenterX];
    const lotCentersZ = [-lotCenterZ, lotCenterZ];
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
    const buildings = new THREE.InstancedMesh(this.buildingGeometry, this.buildingMaterial, 16);
    const tiers = new THREE.InstancedMesh(this.buildingGeometry, this.buildingMaterial, 32);
    const cylinderBuildings = new THREE.InstancedMesh(
      this.cylinderBuildingGeometry,
      this.buildingMaterial,
      12,
    );
    const cylinderFacades = new THREE.InstancedMesh(
      this.cylinderFacadeGeometry,
      chunkFacadeMaterial,
      12,
    );
    const crowns = new THREE.InstancedMesh(this.crownGeometry, this.buildingMaterial, 10);
    const architecturalDetails = new THREE.InstancedMesh(
      this.buildingGeometry,
      this.roofMaterial,
      64,
    );
    const roofProps = new THREE.InstancedMesh(this.antennaGeometry, this.antennaMaterial, 28);
    const roads = new THREE.Mesh(
      this.getRoadGeometry(verticalRoadWidth, horizontalRoadWidth),
      this.roadMaterial,
    );
    roads.position.set(centerX, -0.44, centerZ);
    roads.renderOrder = 1;
    const diagonalRoad = diagonalDistrict
      ? new THREE.Mesh(this.diagonalRoadGeometry, this.diagonalRoadMaterial)
      : null;
    if (diagonalRoad) {
      diagonalRoad.position.set(centerX, -0.438, centerZ);
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
    const facades = new THREE.InstancedMesh(this.facadeGeometry, chunkFacadeMaterial, 96);
    const brickFacades = new THREE.InstancedMesh(
      this.facadeGeometry,
      this.brickFacadeMaterial,
      96,
    );
    const cars = new THREE.InstancedMesh(this.buildingGeometry, this.carMaterial, 20);
    const treeCanopies = new THREE.InstancedMesh(
      this.treeCanopyGeometry,
      this.treeCanopyMaterial,
      24,
    );
    const transform = new THREE.Object3D();
    const glassColors = [0x91cbd5, 0x7faed0, 0x82c7bb, 0x9eacd0, 0x83b9c7];
    const brickColors = [0xdd8068, 0xce665c, 0xe19a70, 0xbd7767, 0xd99a7d];
    const stoneColors = [0xeadfc6, 0xe0c994, 0xcbd7c8, 0xe2ddd2, 0xc1d2bd];
    const carColors = [0xb73536, 0x35536e, 0xd8d2bf, 0xd19b2d, 0x54705b, 0x777b80];
    let buildingIndex = 0;
    let tierIndex = 0;
    let cylinderIndex = 0;
    let crownIndex = 0;
    let detailIndex = 0;
    let propIndex = 0;
    let facadeIndex = 0;
    let brickFacadeIndex = 0;
    let treeIndex = 0;
    let lotIndex = 0;

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

    const addOpenSpace = (localX: number, localZ: number, plaza: boolean): void => {
      const x = centerX + localX;
      const z = centerZ + localZ;
      setInstance(
        architecturalDetails,
        detailIndex,
        x,
        -0.39,
        z,
        lotSpanX * 0.86,
        0.12,
        lotSpanZ * 0.86,
        new THREE.Color(plaza ? 0xc8c0aa : 0x7b9d68),
      );
      detailIndex += 1;

      const treeCount = plaza ? 2 : 4;
      for (let tree = 0; tree < treeCount; tree += 1) {
        const sideX = tree % 2 === 0 ? -1 : 1;
        const sideZ = tree < 2 ? -1 : 1;
        const treeX = x + sideX * lotSpanX * (0.22 + random() * 0.08);
        const treeZ = z + sideZ * lotSpanZ * (0.22 + random() * 0.08);
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

    for (const localX of lotCentersX) {
      for (const localZ of lotCentersZ) {
        const currentLot = lotIndex;
        lotIndex += 1;
        if (diagonalDistrict && Math.sign(localX) === Math.sign(localZ)) continue;
        const riverOverlap = plan.river
          && Math.abs(centerX + localX - riverCenterAt(centerZ + localZ))
            < plan.river.width / 2 + lotSpanX * 0.22;
        const plannedOpenSpace = plan.openSpaceLots.includes(currentLot);
        const densityOpenSpace = !plan.landmark && random() > plan.density;
        if (riverOverlap || plannedOpenSpace || densityOpenSpace) {
          addOpenSpace(
            localX,
            localZ,
            plannedOpenSpace && (plan.landmark || plan.district === 'civic'),
          );
          continue;
        }
        const architectureRoll = random();
        const archetype = chooseBuildingArchetype(plan, currentLot, architectureRoll);
        const avenue = plan.verticalRoad === 'grand-avenue'
          || plan.horizontalRoad === 'grand-avenue';
        const glassTower = archetype !== 'brick-midrise' && archetype !== 'courtyard';
        const brickMidrise = archetype === 'brick-midrise' || archetype === 'courtyard';
        const widthFactor = archetype === 'cylinder' || archetype === 'needle'
          ? 0.5 + random() * 0.12
          : archetype === 'courtyard'
            ? 0.86 + random() * 0.08
            : archetype === 'twin-slab'
              ? 0.78 + random() * 0.12
              : 0.62 + random() * 0.18;
        const depthFactor = archetype === 'twin-slab'
          ? 0.56 + random() * 0.12
          : archetype === 'courtyard'
            ? 0.86 + random() * 0.08
            : 0.58 + random() * 0.2;
        const width = lotSpanX * widthFactor;
        const depth = lotSpanZ * depthFactor;
        const targetHeight = plan.landmark
          ? 238 + random() * 78
          : plan.district === 'commercial-core'
            ? (72 + Math.pow(random(), 0.68) * 76) * plan.skylineScale
            : plan.district === 'waterfront'
              ? (52 + Math.pow(random(), 0.74) * 72) * plan.skylineScale
              : plan.district === 'civic'
                ? (48 + random() * 62) * plan.skylineScale
                : plan.district === 'boulevard'
                  ? (42 + Math.pow(random(), 0.76) * 66 + (avenue ? 9 : 0))
                    * plan.skylineScale
                  : (28 + Math.pow(random(), 0.9) * 42) * plan.skylineScale;
        const x = centerX + localX + (random() - 0.5) * Math.min(4, lotSpanX * 0.1);
        const z = centerZ + localZ + (random() - 0.5) * Math.min(4, lotSpanZ * 0.1);
        const palette = glassTower ? glassColors : brickMidrise ? brickColors : stoneColors;
        const facadeColor = new THREE.Color(
          palette[Math.floor(random() * palette.length)],
        );
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
        const facadeTint = facadeColor.clone().lerp(new THREE.Color(0xe8f4ef), 0.72);

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

        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(x, height / 2, z),
        );
        this.world.createCollider(RAPIER.ColliderDesc.cuboid(width / 2, height / 2, depth / 2), body);
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
        bodies.push(body);

        const insetX = tierWidth * 0.35;
        const insetZ = tierDepth * 0.35;
        const anchorLevels = roofHeight > CONFIG.ropeMaxRange * 0.92
          ? [Math.min(78, roofHeight * 0.38), roofHeight * 0.68, roofHeight + 1.4]
          : [roofHeight + 1.4];
        for (const anchorHeight of anchorLevels) {
          anchors.push(
            new THREE.Vector3(roofX - insetX, anchorHeight, roofZ - insetZ),
            new THREE.Vector3(roofX + insetX, anchorHeight, roofZ - insetZ),
            new THREE.Vector3(roofX - insetX, anchorHeight, roofZ + insetZ),
            new THREE.Vector3(roofX + insetX, anchorHeight, roofZ + insetZ),
          );
        }
      }
    }

    const streetBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    bodies.push(streetBody);
    const verticalLaneOffset = Math.max(2.7, verticalRoadWidth * 0.22);
    const horizontalLaneOffset = Math.max(2.7, horizontalRoadWidth * 0.22);
    const carPlacements = [
      { x: centerX - 42 + random() * 7, z: centerZ - horizontalLaneOffset, alongX: true },
      { x: centerX + 35 + random() * 7, z: centerZ + horizontalLaneOffset, alongX: true },
      { x: centerX - verticalLaneOffset, z: centerZ - 18 + random() * 5, alongX: false },
      { x: centerX + verticalLaneOffset, z: centerZ - 50 + random() * 6, alongX: false },
      { x: centerX - verticalLaneOffset, z: centerZ + 36 + random() * 6, alongX: false },
      { x: centerX + 17 + random() * 5, z: centerZ - horizontalLaneOffset, alongX: true },
      { x: centerX - 17 + random() * 5, z: centerZ + horizontalLaneOffset, alongX: true },
      { x: centerX + 47 + random() * 5, z: centerZ - horizontalLaneOffset, alongX: true },
      { x: centerX + verticalLaneOffset, z: centerZ + 12 + random() * 5, alongX: false },
      { x: centerX + verticalLaneOffset, z: centerZ + 48 + random() * 5, alongX: false },
    ];
    let carVisualIndex = 0;
    for (const placement of carPlacements) {
      const carColor = new THREE.Color(carColors[Math.floor(random() * carColors.length)]);
      const bodyWidth = placement.alongX ? 6.2 : 2.7;
      const bodyDepth = placement.alongX ? 2.7 : 6.2;
      const cabinWidth = placement.alongX ? 3.55 : 2.18;
      const cabinDepth = placement.alongX ? 2.18 : 3.55;
      const bodyHeight = 0.98;
      const cabinHeight = 0.74;
      const roadSurface = -0.44;

      transform.position.set(placement.x, roadSurface + bodyHeight / 2, placement.z);
      transform.scale.set(bodyWidth, bodyHeight, bodyDepth);
      transform.updateMatrix();
      cars.setMatrixAt(carVisualIndex, transform.matrix);
      cars.setColorAt(carVisualIndex, carColor);
      carVisualIndex += 1;

      transform.position.set(
        placement.x,
        roadSurface + bodyHeight + cabinHeight / 2 - 0.1,
        placement.z,
      );
      transform.scale.set(cabinWidth, cabinHeight, cabinDepth);
      transform.updateMatrix();
      cars.setMatrixAt(carVisualIndex, transform.matrix);
      cars.setColorAt(carVisualIndex, new THREE.Color(0x526b78));
      carVisualIndex += 1;

      const colliderHeight = bodyHeight + cabinHeight - 0.1;
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(bodyWidth / 2, colliderHeight / 2, bodyDepth / 2)
          .setTranslation(placement.x, roadSurface + colliderHeight / 2, placement.z),
        streetBody,
      );
    }

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
    cars.count = carVisualIndex;
    cars.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (cars.instanceColor) cars.instanceColor.needsUpdate = true;
    cars.computeBoundingSphere();
    group.add(roads, cars);
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
    this.chunks.set(key, { group, bodies, meshes, anchors });
  }

  private removeChunk(key: string, chunk: CityChunk): void {
    this.scene.remove(chunk.group);
    for (const body of chunk.bodies) this.world.removeRigidBody(body);
    for (const mesh of chunk.meshes) {
      const index = this.buildingMeshes.indexOf(mesh);
      if (index >= 0) this.buildingMeshes.splice(index, 1);
    }
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

  private createFacadeTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 192;
    canvas.height = 384;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the procedural facade texture.');
    context.clearRect(0, 0, canvas.width, canvas.height);

    const columns = 6;
    const rows = 12;
    const cellWidth = canvas.width / columns;
    const cellHeight = canvas.height / rows;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const lit = ((row * 7 + column * 11) % 11) > 7;
        context.fillStyle = lit
          ? '#ffdda0'
          : (row + column) % 4 === 0 ? '#91cbd7' : '#6597ad';
        context.fillRect(
          column * cellWidth + 7,
          row * cellHeight + 7,
          cellWidth - 14,
          cellHeight - 14,
        );
        context.strokeStyle = 'rgba(250, 247, 232, 0.82)';
        context.lineWidth = 2;
        context.strokeRect(
          column * cellWidth + 6,
          row * cellHeight + 6,
          cellWidth - 12,
          cellHeight - 12,
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

    const columns = 4;
    const rows = 10;
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
        context.fillStyle = lit ? '#ffd38b' : '#496b78';
        context.fill();
        context.strokeStyle = 'rgba(255, 237, 202, 0.92)';
        context.lineWidth = 3;
        context.stroke();
        context.fillStyle = 'rgba(255, 239, 211, 0.76)';
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

    const columns = 4;
    const rows = 8;
    const cellWidth = canvas.width / columns;
    const cellHeight = canvas.height / rows;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const left = column * cellWidth + cellWidth * 0.3;
        const top = row * cellHeight + 5;
        const lit = ((row * 5 + column * 3) % 9) > 6;
        context.fillStyle = lit ? '#ffe1a6' : column % 2 === 0 ? '#6ea3ba' : '#82bdca';
        context.fillRect(left, top, cellWidth * 0.4, cellHeight - 10);
        context.strokeStyle = 'rgba(246, 241, 222, 0.9)';
        context.lineWidth = 3;
        context.strokeRect(left - 2, top - 2, cellWidth * 0.4 + 4, cellHeight - 6);
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
    gradient.addColorStop(0, '#779eae');
    gradient.addColorStop(0.46, '#b5d7dc');
    gradient.addColorStop(0.58, '#7faab8');
    gradient.addColorStop(1, '#537b90');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);

    for (let x = 0; x <= canvas.width; x += 24) {
      context.fillStyle = x % 48 === 0 ? 'rgba(39, 66, 82, 0.78)' : 'rgba(58, 88, 103, 0.54)';
      context.fillRect(x, 0, x % 48 === 0 ? 4 : 2, canvas.height);
    }
    for (let y = 0; y <= canvas.height; y += 32) {
      context.fillStyle = 'rgba(224, 239, 237, 0.34)';
      context.fillRect(0, y, canvas.width, 2);
      if ((y / 32) % 5 === 3) {
        context.fillStyle = 'rgba(255, 218, 151, 0.36)';
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

  private createRoadTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the procedural road texture.');
    context.fillStyle = '#3b3e41';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#d8d1b3';
    context.fillRect(9, 0, 3, canvas.height);
    context.fillRect(244, 0, 3, canvas.height);
    for (let divider = 32; divider < canvas.width; divider += 32) {
      context.fillStyle = divider === 128 ? '#e7d88a' : 'rgba(230,232,224,.72)';
      for (let y = 10; y < canvas.height; y += 64) context.fillRect(divider - 1.5, y, 3, 34);
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
