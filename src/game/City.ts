import * as THREE from 'three';
import type { RigidBody, World } from '@dimforge/rapier3d-compat';
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from './config';

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

const ROAD_WIDTHS = [10, 28, 46] as const;
const MAX_ROAD_WIDTH = ROAD_WIDTHS[ROAD_WIDTHS.length - 1];

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function roadWidthFor(lineIndex: number, salt: number): number {
  const hash = Math.abs(Math.imul(lineIndex + salt, 0x45d9f3b));
  const roll = hash % 10;
  if (roll < 3) return ROAD_WIDTHS[0];
  if (roll < 8) return ROAD_WIDTHS[1];
  return ROAD_WIDTHS[2];
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
  private readonly roadGeometries = new Map<string, THREE.BufferGeometry>();
  private readonly diagonalRoadGeometry = createDiagonalRoadGeometry(18);
  private readonly facadeGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly buildingMaterial: THREE.MeshBasicMaterial;
  private readonly facadeMaterial: THREE.MeshBasicMaterial;
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
  private readonly cameraDirection = new THREE.Vector3();
  private readonly anchorDelta = new THREE.Vector3();
  private readonly projectedAnchor = new THREE.Vector3();
  private lastCenterX = Number.NaN;
  private lastCenterZ = Number.NaN;

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

  update(playerPosition: THREE.Vector3): void {
    const centerX = Math.floor(playerPosition.x / CONFIG.chunkSize);
    const centerZ = Math.floor(playerPosition.z / CONFIG.chunkSize);
    const firstUpdate = Number.isNaN(this.lastCenterX);
    if (centerX !== this.lastCenterX || centerZ !== this.lastCenterZ) {
      this.lastCenterX = centerX;
      this.lastCenterZ = centerZ;
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
    const group = new THREE.Group();
    group.name = `city-chunk-${key}`;
    const bodies: RigidBody[] = [];
    const meshes: THREE.Mesh[] = [];
    const anchors: THREE.Vector3[] = [];
    const centerX = chunkX * CONFIG.chunkSize;
    const centerZ = chunkZ * CONFIG.chunkSize;
    const verticalRoadWidth = roadWidthFor(chunkX, 271);
    const horizontalRoadWidth = roadWidthFor(chunkZ, 619);
    const diagonalDistrict = positiveModulo(chunkX - chunkZ, 7) === 0;
    const lotOuterEdge = CONFIG.chunkSize / 2 - 6;
    const lotInnerX = verticalRoadWidth / 2 + 3;
    const lotInnerZ = horizontalRoadWidth / 2 + 3;
    const lotSpanX = lotOuterEdge - lotInnerX;
    const lotSpanZ = lotOuterEdge - lotInnerZ;
    const lotCenterX = (lotInnerX + lotOuterEdge) / 2;
    const lotCenterZ = (lotInnerZ + lotOuterEdge) / 2;
    const lotCentersX = [-lotCenterX, lotCenterX];
    const lotCentersZ = [-lotCenterZ, lotCenterZ];
    const buildings = new THREE.InstancedMesh(this.buildingGeometry, this.buildingMaterial, 4);
    const tiers = new THREE.InstancedMesh(this.buildingGeometry, this.buildingMaterial, 4);
    const architecturalDetails = new THREE.InstancedMesh(
      this.buildingGeometry,
      this.roofMaterial,
      12,
    );
    const roofProps = new THREE.InstancedMesh(this.antennaGeometry, this.antennaMaterial, 4);
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
    const facades = new THREE.InstancedMesh(this.facadeGeometry, this.facadeMaterial, 8);
    const cars = new THREE.InstancedMesh(this.buildingGeometry, this.carMaterial, 20);
    const transform = new THREE.Object3D();
    const glassColors = [0x91cbd5, 0x7faed0, 0x82c7bb, 0x9eacd0, 0x83b9c7];
    const brickColors = [0xdd8068, 0xce665c, 0xe19a70, 0xbd7767, 0xd99a7d];
    const stoneColors = [0xeadfc6, 0xe0c994, 0xcbd7c8, 0xe2ddd2, 0xc1d2bd];
    const carColors = [0xb73536, 0x35536e, 0xd8d2bf, 0xd19b2d, 0x54705b, 0x777b80];
    let buildingIndex = 0;
    let tierIndex = 0;
    let detailIndex = 0;
    let propIndex = 0;
    let facadeIndex = 0;

    for (const localX of lotCentersX) {
      for (const localZ of lotCentersZ) {
        if (diagonalDistrict && Math.sign(localX) === Math.sign(localZ)) continue;
        const architectureRoll = random();
        const avenue = verticalRoadWidth === MAX_ROAD_WIDTH || horizontalRoadWidth === MAX_ROAD_WIDTH;
        const glassTower = architectureRoll < (avenue ? 0.42 : 0.22);
        const brickMidrise = !glassTower && architectureRoll < 0.62;
        const slabBuilding = !glassTower && !brickMidrise && architectureRoll > 0.84;
        const widthFactor = glassTower
          ? 0.46 + random() * 0.18
          : slabBuilding ? 0.78 + random() * 0.14 : 0.64 + random() * 0.24;
        const depthFactor = glassTower
          ? 0.48 + random() * 0.2
          : slabBuilding ? 0.48 + random() * 0.14 : 0.65 + random() * 0.23;
        const width = lotSpanX * widthFactor;
        const depth = lotSpanZ * depthFactor;
        const height = glassTower
          ? 68 + Math.pow(random(), 0.66) * 70 + (avenue ? 14 : 0)
          : brickMidrise
            ? 25 + Math.pow(random(), 0.82) * 45
            : slabBuilding
              ? 34 + random() * 42
              : 30 + Math.pow(random(), 0.72) * 64 + (avenue ? 10 : 0);
        const x = centerX + localX + (random() - 0.5) * Math.min(4, lotSpanX * 0.1);
        const z = centerZ + localZ + (random() - 0.5) * Math.min(4, lotSpanZ * 0.1);
        const palette = glassTower ? glassColors : brickMidrise ? brickColors : stoneColors;
        const facadeColor = new THREE.Color(
          palette[Math.floor(random() * palette.length)],
        );

        transform.position.set(x, height / 2, z);
        transform.scale.set(width, height, depth);
        transform.updateMatrix();
        buildings.setMatrixAt(buildingIndex, transform.matrix);
        buildings.setColorAt(
          buildingIndex,
          facadeColor,
        );

        const hasTier = glassTower || random() > 0.42;
        const tierHeight = hasTier ? (glassTower ? 9 + random() * 17 : 4 + random() * 9) : 0;
        const tierWidth = hasTier ? width * (glassTower ? 0.38 + random() * 0.2 : 0.52 + random() * 0.2) : width;
        const tierDepth = hasTier ? depth * (glassTower ? 0.4 + random() * 0.2 : 0.5 + random() * 0.22) : depth;
        const tierOffsetX = hasTier ? (random() - 0.5) * width * 0.18 : 0;
        const tierOffsetZ = hasTier ? (random() - 0.5) * depth * 0.18 : 0;
        const roofX = x + tierOffsetX;
        const roofZ = z + tierOffsetZ;
        const roofHeight = height + tierHeight;
        if (hasTier) {
          transform.position.set(roofX, height + tierHeight / 2, roofZ);
          transform.scale.set(tierWidth, tierHeight, tierDepth);
          transform.updateMatrix();
          tiers.setMatrixAt(tierIndex, transform.matrix);
          tiers.setColorAt(tierIndex, facadeColor.clone().multiplyScalar(0.92));
          tierIndex += 1;
        }

        const streetX = localX > 0 ? x - width / 2 - 0.025 : x + width / 2 + 0.025;
        transform.position.set(streetX, height * 0.51, z);
        transform.rotation.set(0, Math.PI / 2, 0);
        transform.scale.set(depth * 0.86, height * 0.9, 1);
        transform.updateMatrix();
        facades.setMatrixAt(facadeIndex, transform.matrix);
        facadeIndex += 1;

        const streetZ = localZ > 0 ? z - depth / 2 - 0.025 : z + depth / 2 + 0.025;
        transform.position.set(x, height * 0.51, streetZ);
        transform.rotation.set(0, 0, 0);
        transform.scale.set(width * 0.86, height * 0.9, 1);
        transform.updateMatrix();
        facades.setMatrixAt(facadeIndex, transform.matrix);
        facadeIndex += 1;

        transform.position.set(x, -0.42, z);
        transform.scale.set(width + 4.2, 0.16, depth + 4.2);
        transform.updateMatrix();
        architecturalDetails.setMatrixAt(detailIndex, transform.matrix);
        architecturalDetails.setColorAt(detailIndex, new THREE.Color(0x96948d));
        detailIndex += 1;

        transform.position.set(roofX, roofHeight + 0.18, roofZ);
        transform.scale.set(tierWidth + 0.75, 0.36, tierDepth + 0.75);
        transform.updateMatrix();
        architecturalDetails.setMatrixAt(detailIndex, transform.matrix);
        architecturalDetails.setColorAt(detailIndex, facadeColor.clone().multiplyScalar(0.76));
        detailIndex += 1;

        if (random() > 0.38) {
          transform.position.set(x, height * (0.42 + random() * 0.2), z);
          transform.scale.set(width + 0.42, 0.3, depth + 0.42);
          transform.updateMatrix();
          architecturalDetails.setMatrixAt(detailIndex, transform.matrix);
          architecturalDetails.setColorAt(
            detailIndex,
            facadeColor.clone().lerp(new THREE.Color(glassTower ? 0xd8ffff : 0xffe6b8), 0.68),
          );
          detailIndex += 1;
        }

        if (random() > 0.28) {
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
        if (hasTier) {
          this.world.createCollider(
            RAPIER.ColliderDesc.cuboid(tierWidth / 2, tierHeight / 2, tierDepth / 2)
              .setTranslation(tierOffsetX, height / 2 + tierHeight / 2, tierOffsetZ),
            body,
          );
        }
        bodies.push(body);

        const insetX = tierWidth * 0.35;
        const insetZ = tierDepth * 0.35;
        anchors.push(
          new THREE.Vector3(roofX - insetX, roofHeight + 1.4, roofZ - insetZ),
          new THREE.Vector3(roofX + insetX, roofHeight + 1.4, roofZ - insetZ),
          new THREE.Vector3(roofX - insetX, roofHeight + 1.4, roofZ + insetZ),
          new THREE.Vector3(roofX + insetX, roofHeight + 1.4, roofZ + insetZ),
        );
        buildingIndex += 1;
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
    buildings.count = buildingIndex;
    buildings.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (buildings.instanceColor) buildings.instanceColor.needsUpdate = true;
    if (buildingIndex > 0) buildings.computeBoundingSphere();
    tiers.count = tierIndex;
    tiers.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (tiers.instanceColor) tiers.instanceColor.needsUpdate = true;
    if (tierIndex > 0) tiers.computeBoundingSphere();
    architecturalDetails.count = detailIndex;
    architecturalDetails.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (architecturalDetails.instanceColor) architecturalDetails.instanceColor.needsUpdate = true;
    architecturalDetails.computeBoundingSphere();
    roofProps.count = propIndex;
    roofProps.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (roofProps.instanceColor) roofProps.instanceColor.needsUpdate = true;
    if (propIndex > 0) roofProps.computeBoundingSphere();
    facades.count = facadeIndex;
    facades.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    facades.computeBoundingSphere();
    cars.count = carVisualIndex;
    cars.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    if (cars.instanceColor) cars.instanceColor.needsUpdate = true;
    cars.computeBoundingSphere();
    group.add(roads, cars, architecturalDetails, buildings, facades);
    if (diagonalRoad) group.add(diagonalRoad);
    if (tierIndex > 0) group.add(tiers);
    if (propIndex > 0) group.add(roofProps);
    meshes.push(buildings);
    this.buildingMeshes.push(buildings);
    if (tierIndex > 0) {
      meshes.push(tiers);
      this.buildingMeshes.push(tiers);
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
