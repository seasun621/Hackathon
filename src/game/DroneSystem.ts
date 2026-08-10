import * as THREE from 'three';
import { CONFIG } from './config';
import type { AimQuality } from './CombatTypes';

interface Drone {
  id: number;
  kind: 'scout' | 'assault';
  group: THREE.Group;
  health: number;
  maxHealth: number;
  age: number;
  phase: number;
  shootCooldown: number;
  formationAngle: number;
  rotorLeft: THREE.Mesh;
  rotorRight: THREE.Mesh;
}

interface EnemyBullet {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  life: number;
  damage: number;
  sourceId: number;
}

export interface DronePlayerHit {
  damage: number;
  sourceId: number;
}

interface DroneBurst {
  mesh: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshBasicMaterial>;
  ring: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  sparks: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  velocities: Float32Array;
  age: number;
}

export interface DroneTrack {
  targetId: number;
  kind: 'scout' | 'assault';
  ndcX: number;
  ndcY: number;
  distance: number;
  inEngageRange: boolean;
  healthRatio: number;
  quality: AimQuality;
  score: number;
  locked: boolean;
}

export interface DroneDamageResult {
  targetId: number;
  position: THREE.Vector3;
  destroyed: boolean;
  healthRatio: number;
  score: number;
  damageDealt: number;
}

export class DroneSystem {
  private readonly drones: Drone[] = [];
  private readonly bullets: EnemyBullet[] = [];
  private readonly bursts: DroneBurst[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly wallIntersections: THREE.Intersection[] = [];
  private readonly direction = new THREE.Vector3();
  private readonly strafe = new THREE.Vector3();
  private readonly formationTarget = new THREE.Vector3();
  private readonly formationForward = new THREE.Vector3();
  private readonly formationRight = new THREE.Vector3();
  private readonly projection = new THREE.Vector3();
  private readonly bulletGeometry = new THREE.BoxGeometry(0.34, 0.34, 1.9);
  private readonly scoutBulletMaterial = new THREE.MeshBasicMaterial({ color: 0xcaff35 });
  private readonly assaultBulletMaterial = new THREE.MeshBasicMaterial({ color: 0xffe24a });
  private readonly burstGeometry = new THREE.IcosahedronGeometry(1.4, 1);
  private readonly burstRingGeometry = new THREE.TorusGeometry(1.25, 0.12, 6, 28);
  private readonly pendingPlayerDamage: DronePlayerHit[] = [];
  private nextId = 1;
  private nextFormationIndex = 0;
  private spawnCooldown = 1.8;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly onShoot: (kind: 'scout' | 'assault') => void = () => undefined,
  ) {}

  reset(): void {
    for (const drone of this.drones) this.scene.remove(drone.group);
    for (const bullet of this.bullets) this.scene.remove(bullet.mesh);
    for (const burst of this.bursts) {
      this.scene.remove(burst.mesh, burst.ring, burst.sparks);
      burst.mesh.material.dispose();
      burst.ring.material.dispose();
      burst.sparks.geometry.dispose();
      burst.sparks.material.dispose();
    }
    this.drones.length = 0;
    this.bullets.length = 0;
    this.bursts.length = 0;
    this.pendingPlayerDamage.length = 0;
    this.spawnCooldown = 1.8;
    this.nextFormationIndex = 0;
  }

  update(
    dt: number,
    playerPosition: THREE.Vector3,
    playerForward: THREE.Vector3,
    stage: number,
    buildingMeshes: THREE.Mesh[],
  ): void {
    if (dt <= 0) return;
    if (stage >= 2) {
      this.spawnCooldown -= dt;
      const desiredCount = Math.min(12, 3 + (stage - 2) * 2);
      if (this.drones.length < desiredCount && this.spawnCooldown <= 0) {
        const assaultTarget = stage >= 4 ? Math.min(4, 1 + Math.floor((stage - 4) / 2)) : 0;
        const assaultCount = this.drones.reduce(
          (count, drone) => count + (drone.kind === 'assault' ? 1 : 0),
          0,
        );
        this.spawnDrone(playerPosition, playerForward, stage, assaultCount < assaultTarget ? 'assault' : 'scout');
        this.spawnCooldown = Math.max(0.68, 2.35 - stage * 0.13) + Math.random() * 0.72;
      }
    }

    this.formationForward.copy(playerForward);
    this.formationForward.y = 0;
    if (this.formationForward.lengthSq() < 0.01) this.formationForward.set(0, 0, -1);
    this.formationForward.normalize();
    this.formationRight.set(-this.formationForward.z, 0, this.formationForward.x);

    for (let index = this.drones.length - 1; index >= 0; index -= 1) {
      const drone = this.drones[index];
      drone.age += dt;
      drone.shootCooldown -= dt;
      drone.rotorLeft.rotation.y += dt * 15;
      drone.rotorRight.rotation.y -= dt * 15;
      this.direction.copy(playerPosition).sub(drone.group.position);
      const distance = this.direction.length();
      if (distance > 230) {
        this.scene.remove(drone.group);
        this.drones.splice(index, 1);
        continue;
      }
      if (distance > 0.001 && distance < CONFIG.droneDetectionRange) {
        const orbitAngle = drone.formationAngle + Math.sin(drone.age * 0.24 + drone.phase) * 0.13;
        const formationRadius = drone.kind === 'assault' ? 49 : 39;
        this.formationTarget.copy(playerPosition)
          .addScaledVector(this.formationForward, Math.cos(orbitAngle) * formationRadius)
          .addScaledVector(this.formationRight, Math.sin(orbitAngle) * formationRadius);
        this.formationTarget.y = playerPosition.y
          + (drone.kind === 'assault' ? 9 : 5)
          + Math.sin(drone.age * 0.68 + drone.phase) * 4;
        this.direction.copy(this.formationTarget).sub(drone.group.position);
        const formationDistance = this.direction.length();
        if (formationDistance > 0.3) {
          this.direction.multiplyScalar(1 / formationDistance);
          const chaseSpeed = (CONFIG.droneMoveSpeed + Math.min(7, stage * 0.82))
            * (drone.kind === 'assault' ? 0.78 : 1);
          drone.group.position.addScaledVector(this.direction, chaseSpeed * dt);
        }
        this.strafe.set(-this.formationForward.z, 0, this.formationForward.x)
          .multiplyScalar(Math.sin(drone.age * 0.86 + drone.phase) * 1.5 * dt);
        drone.group.position.add(this.strafe);
        if (
          distance > 20
          && distance < CONFIG.droneFireRange
          && drone.shootCooldown <= 0
        ) {
          if (this.hasClearShot(drone.group.position, playerPosition, distance, buildingMeshes)) {
            this.fireAtPlayer(drone, playerPosition, stage);
            const assaultDelay = drone.kind === 'assault' ? 0.22 : 0;
            drone.shootCooldown = Math.max(0.62, 2.05 - stage * 0.11 + assaultDelay) + Math.random() * 0.42;
          } else {
            drone.shootCooldown = 0.32;
          }
        }
      }
      drone.group.position.y += Math.sin(drone.age * 1.5 + drone.phase) * 0.012;
      drone.group.lookAt(playerPosition);
    }

    for (let index = this.bullets.length - 1; index >= 0; index -= 1) {
      const bullet = this.bullets[index];
      bullet.life -= dt;
      bullet.mesh.position.addScaledVector(bullet.velocity, dt);
      if (bullet.mesh.position.distanceToSquared(playerPosition) <= 2.3 * 2.3) {
        this.pendingPlayerDamage.push({ damage: bullet.damage, sourceId: bullet.sourceId });
        this.scene.remove(bullet.mesh);
        this.bullets.splice(index, 1);
        continue;
      }
      if (bullet.life <= 0 || bullet.mesh.position.distanceToSquared(playerPosition) > 240 * 240) {
        this.scene.remove(bullet.mesh);
        this.bullets.splice(index, 1);
      }
    }

    for (let index = this.bursts.length - 1; index >= 0; index -= 1) {
      const burst = this.bursts[index];
      burst.age += dt;
      const progress = Math.min(1, burst.age / 0.62);
      burst.mesh.scale.setScalar(1 + progress * 5.5);
      burst.mesh.material.opacity = (1 - progress) * 0.85;
      burst.ring.scale.setScalar(1 + progress * 8.5);
      burst.ring.material.opacity = (1 - progress) * 0.94;
      const sparkPositions = burst.sparks.geometry.attributes.position as THREE.BufferAttribute;
      for (let spark = 0; spark < sparkPositions.count; spark += 1) {
        const offset = spark * 3;
        burst.velocities[offset + 1] -= 8 * dt;
        sparkPositions.setXYZ(
          spark,
          sparkPositions.getX(spark) + burst.velocities[offset] * dt,
          sparkPositions.getY(spark) + burst.velocities[offset + 1] * dt,
          sparkPositions.getZ(spark) + burst.velocities[offset + 2] * dt,
        );
      }
      sparkPositions.needsUpdate = true;
      burst.sparks.material.opacity = 1 - progress;
      burst.sparks.material.size = 0.65 + progress * 0.5;
      if (progress >= 1) {
        this.scene.remove(burst.mesh, burst.ring, burst.sparks);
        burst.mesh.material.dispose();
        burst.ring.material.dispose();
        burst.sparks.geometry.dispose();
        burst.sparks.material.dispose();
        this.bursts.splice(index, 1);
      }
    }
  }

  getTracks(camera: THREE.Camera, buildingMeshes: THREE.Mesh[], weaponRange: number): DroneTrack[] {
    const tracks: DroneTrack[] = [];
    for (const drone of this.drones) {
      const distance = camera.position.distanceTo(drone.group.position);
      if (distance > CONFIG.combatTrackRange) continue;
      this.projection.copy(drone.group.position).project(camera);
      if (this.projection.z < -1 || this.projection.z > 1) continue;
      if (Math.abs(this.projection.x) > 1.08 || Math.abs(this.projection.y) > 1.08) continue;
      const angularOffset = Math.hypot(this.projection.x, this.projection.y);
      let clearLine = false;
      const inEngageRange = distance <= weaponRange;
      if (inEngageRange && angularOffset <= CONFIG.droneAimGrazeNdcRadius) {
        this.direction.copy(drone.group.position).sub(camera.position).normalize();
        this.raycaster.set(camera.position, this.direction);
        this.raycaster.far = distance;
        this.wallIntersections.length = 0;
        this.raycaster.intersectObjects(buildingMeshes, false, this.wallIntersections);
        clearLine = !this.wallIntersections[0] || this.wallIntersections[0].distance >= distance - 2.4;
      }
      const quality: AimQuality = !inEngageRange || !clearLine
        ? 'none'
        : angularOffset <= CONFIG.droneAimPerfectNdcRadius
          ? 'perfect'
          : angularOffset <= CONFIG.droneAimGrazeNdcRadius
            ? 'graze'
            : 'none';
      tracks.push({
        targetId: drone.id,
        kind: drone.kind,
        ndcX: this.projection.x,
        ndcY: this.projection.y,
        distance,
        inEngageRange,
        healthRatio: drone.health / drone.maxHealth,
        quality,
        score: angularOffset * 3 + distance * 0.0015,
        locked: false,
      });
    }
    return tracks;
  }

  damageDroneById(targetId: number, damage: number, qualityMultiplier = 1): DroneDamageResult | null {
    const index = this.drones.findIndex((drone) => drone.id === targetId);
    if (index < 0) return null;
    return this.damageDrone(index, damage * qualityMultiplier);
  }

  damageAtPoint(position: THREE.Vector3, radius: number, damage: number): DroneDamageResult | null {
    let bestIndex = -1;
    let bestDistance = radius * radius;
    for (let index = 0; index < this.drones.length; index += 1) {
      const distance = this.drones[index].group.position.distanceToSquared(position);
      if (distance > bestDistance) continue;
      bestDistance = distance;
      bestIndex = index;
    }
    return bestIndex >= 0 ? this.damageDrone(bestIndex, damage) : null;
  }

  damageInRadius(position: THREE.Vector3, radius: number, damage: number): DroneDamageResult[] {
    const results: DroneDamageResult[] = [];
    for (let index = this.drones.length - 1; index >= 0; index -= 1) {
      const distance = this.drones[index].group.position.distanceTo(position);
      if (distance > radius) continue;
      const falloff = 1 - (distance / Math.max(0.001, radius)) * 0.48;
      results.push(this.damageDrone(index, damage * falloff));
    }
    return results;
  }

  findNearestTarget(position: THREE.Vector3, range: number): { id: number; position: THREE.Vector3 } | null {
    let best: Drone | null = null;
    let bestDistance = range * range;
    for (const drone of this.drones) {
      const distance = drone.group.position.distanceToSquared(position);
      if (distance > bestDistance) continue;
      bestDistance = distance;
      best = drone;
    }
    return best ? { id: best.id, position: best.group.position.clone() } : null;
  }

  getTargetPosition(targetId: number): THREE.Vector3 | null {
    return this.drones.find((drone) => drone.id === targetId)?.group.position.clone() ?? null;
  }

  consumePlayerDamage(): DronePlayerHit | null {
    return this.pendingPlayerDamage.shift() ?? null;
  }

  private damageDrone(index: number, damage: number): DroneDamageResult {
    const drone = this.drones[index];
    const previousHealth = drone.health;
    drone.health = Math.max(0, drone.health - damage);
    const destroyed = drone.health <= 0;
    const position = drone.group.position.clone();
    const result: DroneDamageResult = {
      targetId: drone.id,
      position,
      destroyed,
      healthRatio: drone.health / drone.maxHealth,
      score: destroyed ? Math.round(560 + drone.maxHealth * 1.4) : 0,
      damageDealt: previousHealth - drone.health,
    };
    if (destroyed) {
      this.createBurst(position);
      this.scene.remove(drone.group);
      this.drones.splice(index, 1);
    }
    return result;
  }

  private spawnDrone(
    playerPosition: THREE.Vector3,
    playerForward: THREE.Vector3,
    stage: number,
    kind: 'scout' | 'assault',
  ): void {
    const forward = playerForward.clone();
    forward.y = THREE.MathUtils.clamp(forward.y, -0.12, 0.28);
    if (forward.lengthSq() < 0.01) forward.set(0, 0.05, -1);
    forward.normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x).normalize();
    const formationAngles = [0, -0.42, 0.42, -0.82, 0.82, 2.72, -2.72, -1.18, 1.18, 0.18, -0.18, Math.PI];
    const formationAngle = kind === 'assault'
      ? (this.nextFormationIndex % 2 === 0 ? 0.24 : -0.24)
      : formationAngles[this.nextFormationIndex % formationAngles.length];
    this.nextFormationIndex += 1;
    const spawnDirection = forward.clone().multiplyScalar(Math.cos(formationAngle))
      .addScaledVector(right, Math.sin(formationAngle));
    const distance = 86 + Math.random() * 42;
    const position = playerPosition.clone()
      .addScaledVector(spawnDirection, distance)
      .addScaledVector(right, (Math.random() - 0.5) * 18);
    position.y = Math.max(14, position.y + (Math.random() - 0.3) * 26);
    const { group, rotorLeft, rotorRight } = this.createDroneModel(kind);
    group.position.copy(position);
    this.scene.add(group);
    const maxHealth = (125 + stage * 34) * (kind === 'assault' ? 2.45 : 1);
    this.drones.push({
      id: this.nextId++,
      kind,
      group,
      health: maxHealth,
      maxHealth,
      age: 0,
      phase: Math.random() * Math.PI * 2,
      shootCooldown: (kind === 'assault' ? 1.7 : 1.2) + Math.random(),
      formationAngle,
      rotorLeft,
      rotorRight,
    });
  }

  private createDroneModel(kind: 'scout' | 'assault'): { group: THREE.Group; rotorLeft: THREE.Mesh; rotorRight: THREE.Mesh } {
    const group = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({
      color: 0x071722,
      roughness: 0.28,
      metalness: 0.82,
      emissive: 0x07131b,
      emissiveIntensity: 0.55,
    });
    const armor = new THREE.MeshStandardMaterial({
      color: kind === 'assault' ? 0xffb61f : 0xffdf36,
      roughness: 0.34,
      metalness: 0.46,
      emissive: 0x5a3c00,
      emissiveIntensity: kind === 'assault' ? 0.72 : 0.52,
    });
    const neon = new THREE.MeshBasicMaterial({ color: 0xb6ff35 });
    const core = new THREE.Mesh(new THREE.DodecahedronGeometry(1.7, 0), dark);
    core.scale.set(1.3, 0.72, 1);
    group.add(core);
    const face = new THREE.Mesh(new THREE.BoxGeometry(1.72, 0.6, 0.32), armor);
    face.position.z = 1.3;
    group.add(face);
    const eye = new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.18, 0.1), neon);
    eye.position.set(0, 0.03, 1.49);
    group.add(eye);
    const crown = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.86, 0.82), armor);
    crown.position.set(0, 1.15, -0.18);
    crown.rotation.z = Math.PI * 0.25;
    group.add(crown);
    for (const x of [-2.25, 2.25]) {
      const arm = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.3, 0.46), armor);
      arm.position.x = x * 0.48;
      group.add(arm);
      const signal = new THREE.Mesh(new THREE.BoxGeometry(0.64, 0.09, 0.56), neon);
      signal.position.set(x * 0.72, 0.2, 0.02);
      group.add(signal);
    }
    const rotorGeometry = new THREE.TorusGeometry(0.9, 0.12, 6, 18);
    const rotorLeft = new THREE.Mesh(rotorGeometry, neon);
    rotorLeft.rotation.x = Math.PI / 2;
    rotorLeft.position.x = -2.15;
    const rotorRight = rotorLeft.clone();
    rotorRight.position.x = 2.15;
    group.add(rotorLeft, rotorRight);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 1.48), dark);
    gun.position.set(0, -0.7, 1.18);
    group.add(gun);
    const muzzle = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.46, 0.2), neon);
    muzzle.position.set(0, -0.7, 1.88);
    group.add(muzzle);
    if (kind === 'assault') {
      const armorRing = new THREE.Mesh(new THREE.TorusGeometry(1.78, 0.22, 7, 22), armor);
      armorRing.rotation.x = Math.PI / 2;
      group.add(armorRing);
      for (const x of [-1.35, 1.35]) {
        const shoulder = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.72, 1.34), armor);
        shoulder.position.set(x, 0.08, 0.28);
        group.add(shoulder);
        const cannon = gun.clone();
        cannon.position.set(x, -0.48, 1.25);
        group.add(cannon);
        const cannonMuzzle = muzzle.clone();
        cannonMuzzle.position.set(x, -0.48, 1.94);
        group.add(cannonMuzzle);
      }
      group.scale.setScalar(1.62);
    }
    return { group, rotorLeft, rotorRight };
  }

  private fireAtPlayer(drone: Drone, playerPosition: THREE.Vector3, stage: number): void {
    const bullet = new THREE.Mesh(
      this.bulletGeometry,
      drone.kind === 'assault' ? this.assaultBulletMaterial : this.scoutBulletMaterial,
    );
    if (drone.kind === 'assault') bullet.scale.set(1.55, 1.55, 1.28);
    this.direction.copy(playerPosition).sub(drone.group.position).normalize();
    bullet.position.copy(drone.group.position).addScaledVector(this.direction, 2.8);
    bullet.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.direction);
    bullet.renderOrder = 4;
    const velocity = this.direction.multiplyScalar(CONFIG.droneBulletSpeed + stage * 1.2).clone();
    this.scene.add(bullet);
    this.bullets.push({
      mesh: bullet,
      velocity,
      life: 4.8,
      damage: (CONFIG.droneBulletDamage + stage * 1.4) * (drone.kind === 'assault' ? 1.75 : 1),
      sourceId: drone.id,
    });
    this.onShoot(drone.kind);
  }

  private hasClearShot(
    origin: THREE.Vector3,
    playerPosition: THREE.Vector3,
    distance: number,
    buildingMeshes: THREE.Mesh[],
  ): boolean {
    this.direction.copy(playerPosition).sub(origin).normalize();
    this.raycaster.set(origin, this.direction);
    this.raycaster.far = distance;
    this.wallIntersections.length = 0;
    this.raycaster.intersectObjects(buildingMeshes, false, this.wallIntersections);
    return !this.wallIntersections[0] || this.wallIntersections[0].distance >= distance - 2.2;
  }

  private createBurst(position: THREE.Vector3): void {
    const source = new THREE.MeshBasicMaterial({
      color: 0xb8ff37,
      transparent: true,
      opacity: 0.85,
      wireframe: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const burst = new THREE.Mesh(this.burstGeometry, source);
    burst.position.copy(position);
    const ring = new THREE.Mesh(
      this.burstRingGeometry,
      new THREE.MeshBasicMaterial({
        color: 0xffdf38,
        transparent: true,
        opacity: 0.94,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    ring.position.copy(position);
    const sparkCount = 24;
    const sparkPositions = new Float32Array(sparkCount * 3);
    const velocities = new Float32Array(sparkCount * 3);
    for (let spark = 0; spark < sparkCount; spark += 1) {
      const offset = spark * 3;
      const direction = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() - 0.25,
        Math.random() - 0.5,
      ).normalize().multiplyScalar(9 + Math.random() * 17);
      velocities[offset] = direction.x;
      velocities[offset + 1] = direction.y;
      velocities[offset + 2] = direction.z;
    }
    const sparkGeometry = new THREE.BufferGeometry();
    sparkGeometry.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3));
    const sparks = new THREE.Points(
      sparkGeometry,
      new THREE.PointsMaterial({
        color: 0xc8ff45,
        size: 0.65,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    sparks.position.copy(position);
    this.scene.add(burst, ring, sparks);
    this.bursts.push({ mesh: burst, ring, sparks, velocities, age: 0 });
  }
}
