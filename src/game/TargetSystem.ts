import * as THREE from 'three';
import { CONFIG, type GameMode, type TargetKind } from './config';
import type { AimQuality } from './CombatTypes';

interface Target {
  id: number;
  kind: TargetKind;
  group: THREE.Group;
  hitMesh: THREE.Mesh;
  basePosition: THREE.Vector3;
  phase: number;
  age: number;
  health: number;
  maxHealth: number;
}

interface BurstEffect {
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  velocities: Float32Array;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  flash: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshBasicMaterial>;
  age: number;
  duration: number;
  power: number;
}

export interface AimSolution {
  targetId: number;
  kind: TargetKind;
  distance: number;
  centerBonus: number;
  position: THREE.Vector3;
}

export interface BombTrack {
  targetId: number;
  kind: 'bomb' | 'health';
  ndcX: number;
  ndcY: number;
  distance: number;
  locked: boolean;
  danger: boolean;
  inEngageRange: boolean;
  quality: AimQuality;
  score: number;
}

export interface LoadedTargetChunk {
  x: number;
  z: number;
}

export interface PickupResult {
  kind: 'normal' | 'gold';
  score: number;
  position: THREE.Vector3;
}

export interface BombDamageResult {
  targetId: number;
  position: THREE.Vector3;
  destroyed: boolean;
  healthRatio: number;
  score: number;
  damageDealt: number;
}

export interface HealthPackResult {
  targetId: number;
  position: THREE.Vector3;
  healing: number;
  quality: Exclude<AimQuality, 'none'>;
}

export interface ShotResult {
  kind: TargetKind;
  baseScore: number;
  distance: number;
  centerBonus: number;
  position: THREE.Vector3;
}

const COLORS: Record<TargetKind, number> = {
  normal: 0x4ef6ff,
  gold: 0xffd34e,
  bomb: 0xff286f,
  health: 0x4dff8a,
};

export class TargetSystem {
  private readonly targets: Target[] = [];
  private readonly hitMeshes: THREE.Mesh[] = [];
  private readonly effects: BurstEffect[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly targetIntersections: THREE.Intersection[] = [];
  private readonly wallIntersections: THREE.Intersection[] = [];
  private readonly projectedCenter = new THREE.Vector3();
  private readonly screenCenter = new THREE.Vector2(0, 0);
  private readonly trackDirection = new THREE.Vector3();
  private readonly trackProjection = new THREE.Vector3();
  private readonly bombImpactPositions: THREE.Vector3[] = [];
  private readonly pendingPickups: PickupResult[] = [];
  private readonly normalCoreGeometry = new THREE.IcosahedronGeometry(1.38, 1);
  private readonly goldCoreGeometry = new THREE.OctahedronGeometry(1.25, 0);
  private readonly bombCoreGeometry = new THREE.SphereGeometry(1.65, 12, 8);
  private readonly healthCoreGeometry = new THREE.BoxGeometry(2.8, 2.2, 1.65);
  private readonly healthCrossGeometry = new THREE.BoxGeometry(0.52, 1.45, 0.18);
  private readonly normalRingGeometry = new THREE.TorusGeometry(2.05, 0.14, 6, 18);
  private readonly goldRingGeometry = new THREE.TorusGeometry(2.05, 0.12, 6, 18);
  private readonly bombRingGeometry = new THREE.TorusGeometry(1.78, 0.18, 6, 16);
  private readonly healthRingGeometry = new THREE.TorusGeometry(2.05, 0.12, 6, 20);
  private readonly healthHandleGeometry = new THREE.TorusGeometry(0.72, 0.12, 6, 14, Math.PI);
  private readonly burstRingGeometry = new THREE.RingGeometry(0.78, 1, 24);
  private readonly burstFlashGeometry = new THREE.IcosahedronGeometry(1, 1);
  private readonly targetMaterials = new Map<TargetKind, THREE.MeshBasicMaterial>();
  private readonly darkMaterial = new THREE.MeshStandardMaterial({
    color: 0x080a14,
    roughness: 0.42,
    metalness: 0.72,
  });
  private readonly sparkTexture: THREE.CanvasTexture;
  private nextId = 1;
  private spawnCooldown = 0;
  private bombSpawnCooldown: number = CONFIG.bombInitialSpawnDelay;
  private nextBombSide: number = Math.random() < 0.5 ? -1 : 1;
  private gameMode: GameMode = 'combat';

  constructor(private readonly scene: THREE.Scene) {
    for (const kind of Object.keys(COLORS) as TargetKind[]) {
      this.targetMaterials.set(kind, new THREE.MeshBasicMaterial({ color: COLORS[kind] }));
    }
    this.sparkTexture = this.createSparkTexture();
  }

  reset(): void {
    for (const target of this.targets) this.scene.remove(target.group);
    for (const effect of this.effects) this.removeEffect(effect);
    this.targets.length = 0;
    this.hitMeshes.length = 0;
    this.effects.length = 0;
    this.bombImpactPositions.length = 0;
    this.pendingPickups.length = 0;
    this.spawnCooldown = 0;
    this.bombSpawnCooldown = CONFIG.bombInitialSpawnDelay;
    this.nextBombSide = Math.random() < 0.5 ? -1 : 1;
  }

  setGameMode(mode: GameMode): void {
    this.gameMode = mode;
  }

  getPerformanceStats(): {
    targets: number;
    ambient: number;
    bombs: number;
    healthPacks: number;
    effects: number;
  } {
    let ambient = 0;
    let bombs = 0;
    let healthPacks = 0;
    for (const target of this.targets) {
      if (target.kind === 'bomb') bombs += 1;
      else if (target.kind === 'health') healthPacks += 1;
      else ambient += 1;
    }
    return {
      targets: this.targets.length,
      ambient,
      bombs,
      healthPacks,
      effects: this.effects.length,
    };
  }

  onChunksLoaded(chunks: LoadedTargetChunk[], playerPosition: THREE.Vector3): void {
    if (this.gameMode === 'time-attack') return;
    let ambientCount = this.targets.reduce(
      (count, target) => count + (target.kind === 'normal' || target.kind === 'gold' ? 1 : 0),
      0,
    );
    let healthCount = this.targets.reduce(
      (count, target) => count + (target.kind === 'health' ? 1 : 0),
      0,
    );
    for (const chunk of chunks) {
      const centerX = chunk.x * CONFIG.chunkSize;
      const centerZ = chunk.z * CONFIG.chunkSize;
      if (ambientCount < CONFIG.pickupTargetCount) {
        const spawnCount = 2 + Math.floor(Math.random() * 3);
        for (let index = 0; index < spawnCount; index += 1) {
          if (ambientCount >= CONFIG.pickupTargetCount) break;
          const position = new THREE.Vector3(
            centerX + (Math.random() - 0.5) * CONFIG.chunkSize * 0.76,
            16 + Math.random() * 65,
            centerZ + (Math.random() - 0.5) * CONFIG.chunkSize * 0.76,
          );
          if (position.distanceToSquared(playerPosition) < 72 * 72) continue;
          const kind: TargetKind = Math.random() < 0.24 ? 'gold' : 'normal';
          this.addTarget(kind, position);
          ambientCount += 1;
        }
      }
      if (healthCount < CONFIG.healthPackCount && Math.random() < CONFIG.healthPackSpawnChance) {
        const position = new THREE.Vector3(
          centerX + (Math.random() - 0.5) * CONFIG.chunkSize * 0.68,
          20 + Math.random() * 52,
          centerZ + (Math.random() - 0.5) * CONFIG.chunkSize * 0.68,
        );
        if (position.distanceToSquared(playerPosition) >= 74 * 74) {
          this.addTarget('health', position);
          healthCount += 1;
        }
      }
    }
  }

  update(dt: number, playerPosition: THREE.Vector3, forward: THREE.Vector3): void {
    if (dt <= 0) return;
    this.spawnCooldown -= dt;
    this.bombSpawnCooldown -= dt;
    if (this.spawnCooldown <= 0) {
      const bombCount = this.targets.reduce(
        (count, target) => count + (target.kind === 'bomb' ? 1 : 0),
        0,
      );
      const desiredBombs = this.gameMode === 'time-attack'
        ? CONFIG.timeAttackMinimumBombs
        : CONFIG.minimumBombs;
      const missingBombs = Math.max(0, desiredBombs - bombCount);
      if (missingBombs > 0 && this.bombSpawnCooldown <= 0) {
        this.spawnTarget(playerPosition, forward, 'bomb');
        this.spawnCooldown = 0.28;
      }
    }

    for (let index = this.targets.length - 1; index >= 0; index -= 1) {
      const target = this.targets[index];
      target.age += dt;
      target.group.rotation.y += dt * (target.kind === 'gold' ? 2.8 : 1.35);
      target.group.rotation.z += dt * 0.36;
      if (target.kind === 'bomb' && this.gameMode === 'combat') {
        this.trackDirection.copy(playerPosition).sub(target.basePosition);
        const threatDistance = this.trackDirection.length();
        if (threatDistance <= CONFIG.bombImpactDistance) {
          this.burst(target.group.position, 'bomb');
          this.bombImpactPositions.push(target.group.position.clone());
          this.removeTarget(index);
          continue;
        }
        if (threatDistance > 0.001) {
          const approachSpeed = CONFIG.bombApproachSpeed + Math.min(4, target.age * 0.16);
          target.basePosition.addScaledVector(this.trackDirection.multiplyScalar(1 / threatDistance), approachSpeed * dt);
        }
      }
      target.group.position.copy(target.basePosition);
      const drift = target.kind === 'bomb' ? 1.45 : 2.25;
      target.group.position.x += Math.sin(target.age * 0.74 + target.phase) * drift;
      target.group.position.y += Math.sin(target.age * 1.28 + target.phase * 1.7) * (drift * 0.72);
      target.group.position.z += Math.cos(target.age * 0.61 + target.phase * 0.8) * (drift * 0.58);
      target.group.rotation.x = Math.sin(target.age * 0.83 + target.phase) * 0.18;

      if (target.kind === 'normal' || target.kind === 'gold') {
        const collectionRadius = target.kind === 'gold'
          ? CONFIG.pickupCollectionRadiusGold
          : CONFIG.pickupCollectionRadiusNormal;
        if (target.group.position.distanceToSquared(playerPosition) <= collectionRadius * collectionRadius) {
          const kind = target.kind;
          this.pendingPickups.push({
            kind,
            score: kind === 'gold' ? CONFIG.pickupGoldScore : CONFIG.pickupNormalScore,
            position: target.group.position.clone(),
          });
          this.burst(target.group.position, kind);
          this.removeTarget(index);
          continue;
        }
      }

      const removalRange = target.kind === 'bomb' ? 210 : 280;
      if (target.group.position.distanceToSquared(playerPosition) > removalRange * removalRange) {
        this.removeTarget(index);
      }
    }

    for (let index = this.effects.length - 1; index >= 0; index -= 1) {
      const effect = this.effects[index];
      effect.age += dt;
      const progress = Math.min(1, effect.age / effect.duration);
      const positions = effect.points.geometry.attributes.position as THREE.BufferAttribute;
      for (let particle = 0; particle < positions.count; particle += 1) {
        const offset = particle * 3;
        effect.velocities[offset + 1] -= 11 * dt;
        positions.setXYZ(
          particle,
          positions.getX(particle) + effect.velocities[offset] * dt,
          positions.getY(particle) + effect.velocities[offset + 1] * dt,
          positions.getZ(particle) + effect.velocities[offset + 2] * dt,
        );
      }
      positions.needsUpdate = true;
      effect.points.material.opacity = 1 - progress;
      effect.points.material.size = (1.15 + progress * 0.55) * effect.power;
      effect.ring.lookAt(playerPosition);
      effect.ring.scale.setScalar(1 + progress * 8.5 * effect.power);
      effect.ring.material.opacity = (1 - progress) * 0.95;
      effect.flash.scale.setScalar(1 + progress * 5.5 * effect.power);
      effect.flash.material.opacity = (1 - progress) * 0.8;

      if (progress >= 1) {
        this.removeEffect(effect);
        this.effects.splice(index, 1);
      }
    }
  }

  getAimSolution(camera: THREE.Camera, buildingMeshes: THREE.Mesh[]): AimSolution | null {
    this.raycaster.setFromCamera(this.screenCenter, camera);
    this.raycaster.far = CONFIG.hitscanRange;
    this.targetIntersections.length = 0;
    this.raycaster.intersectObjects(this.hitMeshes, false, this.targetIntersections);
    const firstTargetHit = this.targetIntersections[0];
    if (!firstTargetHit) return null;

    this.wallIntersections.length = 0;
    this.raycaster.intersectObjects(buildingMeshes, false, this.wallIntersections);
    if (this.wallIntersections[0]?.distance < firstTargetHit.distance) return null;

    const targetId = firstTargetHit.object.userData.targetId as number | undefined;
    const target = this.targets.find((candidate) => candidate.id === targetId);
    if (!target) return null;
    this.projectedCenter.copy(target.group.position).project(camera);
    const offset = Math.hypot(this.projectedCenter.x, this.projectedCenter.y);
    return {
      targetId: target.id,
      kind: target.kind,
      distance: firstTargetHit.distance,
      centerBonus: offset < 0.012 ? 1.5 : offset < 0.028 ? 1.25 : 1,
      position: firstTargetHit.point.clone(),
    };
  }

  getBombTracks(camera: THREE.Camera, buildingMeshes: THREE.Mesh[], weaponRange: number): BombTrack[] {
    const tracks: BombTrack[] = [];

    for (const target of this.targets) {
      if (target.kind !== 'bomb' && target.kind !== 'health') continue;
      const distance = camera.position.distanceTo(target.group.position);
      const trackRange = target.kind === 'health' ? CONFIG.healthPackTrackRange : CONFIG.bombTrackRange;
      if (distance > trackRange) continue;
      this.trackProjection.copy(target.group.position).project(camera);
      if (this.trackProjection.z < -1 || this.trackProjection.z > 1) continue;
      if (Math.abs(this.trackProjection.x) > 1.08 || Math.abs(this.trackProjection.y) > 1.08) continue;

      const angularOffset = Math.hypot(this.trackProjection.x, this.trackProjection.y);
      let clearLine = false;
      const inEngageRange = distance <= weaponRange;
      if (inEngageRange && angularOffset <= CONFIG.bombLockNdcRadius) {
        this.trackDirection.copy(target.group.position).sub(camera.position).normalize();
        this.raycaster.set(camera.position, this.trackDirection);
        this.raycaster.far = distance;
        this.wallIntersections.length = 0;
        this.raycaster.intersectObjects(buildingMeshes, false, this.wallIntersections);
        clearLine = !this.wallIntersections[0] || this.wallIntersections[0].distance >= distance - 1.8;
      }

      const quality: AimQuality = !inEngageRange || !clearLine
        ? 'none'
        : angularOffset <= CONFIG.aimPerfectNdcRadius
          ? 'perfect'
          : angularOffset <= CONFIG.aimGrazeNdcRadius
            ? 'graze'
            : 'none';
      const score = angularOffset * 3 + distance * 0.002;
      tracks.push({
        targetId: target.id,
        kind: target.kind,
        ndcX: this.trackProjection.x,
        ndcY: this.trackProjection.y,
        distance,
        locked: false,
        danger: target.kind === 'bomb' && distance < 24,
        inEngageRange,
        quality,
        score,
      });
    }
    return tracks;
  }

  consumePickup(): PickupResult | null {
    return this.pendingPickups.shift() ?? null;
  }

  detonateBombById(targetId: number, quality: Exclude<AimQuality, 'none'> = 'perfect'): BombDamageResult | null {
    const index = this.targets.findIndex((target) => target.id === targetId && target.kind === 'bomb');
    if (index < 0) return null;
    const target = this.targets[index];
    const position = target.group.position.clone();
    const result: BombDamageResult = {
      targetId,
      position,
      destroyed: true,
      healthRatio: 0,
      score: quality === 'perfect' ? 600 : 300,
      damageDealt: 0,
    };
    this.burst(position, 'bomb');
    this.removeTarget(index);
    return result;
  }

  activateHealthPackById(
    targetId: number,
    quality: Exclude<AimQuality, 'none'> = 'perfect',
  ): HealthPackResult | null {
    const index = this.targets.findIndex((target) => target.id === targetId && target.kind === 'health');
    if (index < 0) return null;
    const target = this.targets[index];
    const result: HealthPackResult = {
      targetId,
      position: target.group.position.clone(),
      healing: quality === 'perfect' ? CONFIG.healthPackHealPerfect : CONFIG.healthPackHealGraze,
      quality,
    };
    this.burst(result.position, 'health');
    this.removeTarget(index);
    return result;
  }

  detonateBombAtPoint(position: THREE.Vector3, radius: number): BombDamageResult | null {
    let bestIndex = -1;
    let bestDistance = radius * radius;
    for (let index = 0; index < this.targets.length; index += 1) {
      const target = this.targets[index];
      if (target.kind !== 'bomb') continue;
      const distance = target.group.position.distanceToSquared(position);
      if (distance > bestDistance) continue;
      bestDistance = distance;
      bestIndex = index;
    }
    if (bestIndex < 0) return null;
    return this.detonateBombById(this.targets[bestIndex].id);
  }

  detonateBombsInRadius(position: THREE.Vector3, radius: number): BombDamageResult[] {
    const results: BombDamageResult[] = [];
    for (let index = this.targets.length - 1; index >= 0; index -= 1) {
      const target = this.targets[index];
      if (target.kind !== 'bomb') continue;
      const distance = target.group.position.distanceTo(position);
      if (distance > radius) continue;
      const result = this.detonateBombById(target.id);
      if (result) results.push(result);
    }
    return results;
  }

  findNearestBomb(position: THREE.Vector3, range: number): { id: number; position: THREE.Vector3 } | null {
    let best: Target | null = null;
    let bestDistance = range * range;
    for (const target of this.targets) {
      if (target.kind !== 'bomb') continue;
      const distance = target.group.position.distanceToSquared(position);
      if (distance > bestDistance) continue;
      bestDistance = distance;
      best = target;
    }
    return best ? { id: best.id, position: best.group.position.clone() } : null;
  }

  getBombPosition(targetId: number): THREE.Vector3 | null {
    return this.targets.find((target) => target.id === targetId && target.kind === 'bomb')
      ?.group.position.clone() ?? null;
  }

  getHealthPackPosition(targetId: number): THREE.Vector3 | null {
    return this.targets.find((target) => target.id === targetId && target.kind === 'health')
      ?.group.position.clone() ?? null;
  }

  shootBombById(targetId: number, cameraPosition: THREE.Vector3): ShotResult | null {
    const result = this.detonateBombById(targetId);
    if (!result) return null;
    return {
      kind: 'bomb',
      baseScore: result.score,
      distance: cameraPosition.distanceTo(result.position),
      centerBonus: 1,
      position: result.position,
    };
  }

  consumeBombImpact(): THREE.Vector3 | null {
    return this.bombImpactPositions.shift() ?? null;
  }

  shoot(camera: THREE.Camera, buildingMeshes: THREE.Mesh[]): ShotResult | null {
    const solution = this.getAimSolution(camera, buildingMeshes);
    if (!solution) return null;
    const index = this.targets.findIndex((target) => target.id === solution.targetId);
    if (index < 0) return null;
    const target = this.targets[index];
    const result: ShotResult = {
      kind: target.kind,
      baseScore: target.kind === 'gold' ? 260 : target.kind === 'bomb' ? 420 : 100,
      distance: solution.distance,
      centerBonus: solution.centerBonus,
      position: solution.position,
    };

    this.burst(target.group.position, target.kind);
    this.removeTarget(index);
    return result;
  }

  private spawnTarget(
    playerPosition: THREE.Vector3,
    forwardInput: THREE.Vector3,
    forcedKind?: TargetKind,
  ): void {
    const roll = Math.random();
    const kind: TargetKind = forcedKind ?? (roll < 0.22 ? 'gold' : 'normal');
    const forward = forwardInput.clone();
    if (forward.lengthSq() < 0.01) forward.set(0, 0, -1);
    forward.normalize();
    const horizontalForward = forward.clone();
    horizontalForward.y = 0;
    if (horizontalForward.lengthSq() < 0.01) horizontalForward.set(0, 0, -1);
    horizontalForward.normalize();
    const right = new THREE.Vector3(-horizontalForward.z, 0, horizontalForward.x);
    const bombDistance = THREE.MathUtils.lerp(
      this.gameMode === 'time-attack' ? CONFIG.timeAttackBombSpawnDistanceMin : CONFIG.bombSpawnDistanceMin,
      this.gameMode === 'time-attack' ? CONFIG.timeAttackBombSpawnDistanceMax : CONFIG.bombSpawnDistanceMax,
      Math.random(),
    );
    const distance = kind === 'bomb' ? bombDistance : 36 + Math.random() * 76;
    const bombLateral = THREE.MathUtils.lerp(
      CONFIG.bombSpawnLateralMin,
      CONFIG.bombSpawnLateralMax,
      Math.random(),
    ) * this.nextBombSide;
    const lateral = kind === 'bomb' ? bombLateral : (Math.random() - 0.5) * 66;
    const position = playerPosition.clone()
      .addScaledVector(kind === 'bomb' ? forward : horizontalForward, distance)
      .addScaledVector(right, lateral);

    if (Math.random() > 0.5) {
      position.x = Math.round(position.x / CONFIG.chunkSize) * CONFIG.chunkSize
        + (Math.random() - 0.5) * 15;
    } else {
      position.z = Math.round(position.z / CONFIG.chunkSize) * CONFIG.chunkSize
        + (Math.random() - 0.5) * 15;
    }
    if (kind === 'bomb') {
      position.y = THREE.MathUtils.clamp(position.y + (Math.random() - 0.35) * 18, 18, 150);
      this.nextBombSide *= -1;
    } else {
      position.y = 15 + Math.random() * 49;
    }
    this.addTarget(kind, position);
  }

  private addTarget(kind: TargetKind, position: THREE.Vector3): void {
    const group = this.makeTarget(kind);
    group.position.copy(position);
    this.scene.add(group);
    const hitMesh = group.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh && child.userData.hitSurface === true,
    );
    if (!hitMesh) throw new Error('Target was created without a hit surface.');
    const id = this.nextId++;
    hitMesh.userData.targetId = id;
    this.targets.push({
      id,
      kind,
      group,
      hitMesh,
      basePosition: position.clone(),
      phase: Math.random() * Math.PI * 2,
      age: 0,
      health: 1,
      maxHealth: 1,
    });
    if (kind === 'bomb' || kind === 'health') this.hitMeshes.push(hitMesh);
  }

  private makeTarget(kind: TargetKind): THREE.Group {
    const group = new THREE.Group();
    const material = this.targetMaterials.get(kind);
    if (!material) throw new Error(`Missing target material for ${kind}.`);

    if (kind === 'normal') {
      const core = new THREE.Mesh(this.normalCoreGeometry, material);
      core.userData.hitSurface = true;
      group.add(core);
      const ring = new THREE.Mesh(this.normalRingGeometry, this.darkMaterial);
      group.add(ring);
      const ring2 = ring.clone();
      ring2.rotation.y = Math.PI / 2;
      group.add(ring2);
    } else if (kind === 'gold') {
      const core = new THREE.Mesh(this.goldCoreGeometry, material);
      core.userData.hitSurface = true;
      group.add(core);
      const ring = new THREE.Mesh(this.goldRingGeometry, material);
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
    } else if (kind === 'bomb') {
      const core = new THREE.Mesh(this.bombCoreGeometry, this.darkMaterial);
      core.userData.hitSurface = true;
      group.add(core);
      const warningRing = new THREE.Mesh(this.bombRingGeometry, material);
      warningRing.rotation.x = Math.PI / 2;
      group.add(warningRing);
      const warningRing2 = warningRing.clone();
      warningRing2.rotation.y = Math.PI / 2;
      group.add(warningRing2);
      group.scale.setScalar(CONFIG.bombScale);
    } else {
      const caseMesh = new THREE.Mesh(this.healthCoreGeometry, this.darkMaterial);
      caseMesh.userData.hitSurface = true;
      group.add(caseMesh);
      const crossVertical = new THREE.Mesh(this.healthCrossGeometry, material);
      crossVertical.position.z = 0.92;
      group.add(crossVertical);
      const crossHorizontal = crossVertical.clone();
      crossHorizontal.rotation.z = Math.PI / 2;
      group.add(crossHorizontal);
      const ring = new THREE.Mesh(this.healthRingGeometry, material);
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
      const handle = new THREE.Mesh(this.healthHandleGeometry, material);
      handle.position.y = 1.26;
      handle.rotation.z = Math.PI;
      group.add(handle);
      group.scale.setScalar(1.18);
    }

    return group;
  }

  private burst(position: THREE.Vector3, kind: TargetKind): void {
    const count = kind === 'normal' ? 28 : kind === 'gold' ? 44 : kind === 'health' ? 38 : 84;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      const direction = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() - 0.32,
        Math.random() - 0.5,
      ).normalize();
      const speed = kind === 'bomb'
        ? 13 + Math.random() * 31
        : 9 + Math.random() * 19;
      velocities[offset] = direction.x * speed;
      velocities[offset + 1] = direction.y * speed;
      velocities[offset + 2] = direction.z * speed;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const pointsMaterial = new THREE.PointsMaterial({
      color: COLORS[kind],
      map: this.sparkTexture,
      size: 1.15,
      sizeAttenuation: true,
      transparent: true,
      opacity: 1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const points = new THREE.Points(geometry, pointsMaterial);
    points.position.copy(position);

    const ringMaterial = new THREE.MeshBasicMaterial({
      color: COLORS[kind],
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(this.burstRingGeometry, ringMaterial);
    ring.position.copy(position);

    const flashMaterial = new THREE.MeshBasicMaterial({
      color: kind === 'gold' ? 0xffffff : COLORS[kind],
      transparent: true,
      opacity: 0.8,
      wireframe: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const flash = new THREE.Mesh(this.burstFlashGeometry, flashMaterial);
    flash.position.copy(position);
    this.scene.add(points, ring, flash);
    this.effects.push({
      points,
      velocities,
      ring,
      flash,
      age: 0,
      duration: kind === 'normal' ? 0.58 : kind === 'gold' ? 0.76 : kind === 'health' ? 0.7 : 0.95,
      power: kind === 'bomb' ? 1.45 : kind === 'gold' ? 1.18 : 1,
    });
  }

  private removeTarget(index: number): void {
    const target = this.targets[index];
    if (target.kind === 'bomb') {
      this.bombSpawnCooldown = THREE.MathUtils.lerp(
        this.gameMode === 'time-attack' ? CONFIG.timeAttackBombRespawnDelayMin : CONFIG.bombRespawnDelayMin,
        this.gameMode === 'time-attack' ? CONFIG.timeAttackBombRespawnDelayMax : CONFIG.bombRespawnDelayMax,
        Math.random(),
      );
    }
    this.scene.remove(target.group);
    this.targets.splice(index, 1);
    const meshIndex = this.hitMeshes.indexOf(target.hitMesh);
    if (meshIndex >= 0) this.hitMeshes.splice(meshIndex, 1);
  }

  private removeEffect(effect: BurstEffect): void {
    this.scene.remove(effect.points, effect.ring, effect.flash);
    effect.points.geometry.dispose();
    effect.points.material.dispose();
    effect.ring.material.dispose();
    effect.flash.material.dispose();
  }

  private createSparkTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the spark texture.');
    const gradient = context.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.28, 'rgba(255,255,255,.9)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 32, 32);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }
}
