import * as THREE from 'three';
import RAPIER, { type Collider, type RigidBody, type World } from '@dimforge/rapier3d-compat';
import { AudioSystem } from './AudioSystem';
import { City } from './City';
import { CONFIG, type RunMode, type RunStats } from './config';
import {
  TargetSystem,
  type BombDamageResult,
  type BombTrack,
  type HealthPackResult,
} from './TargetSystem';
import { DroneSystem, type DroneDamageResult, type DroneTrack } from './DroneSystem';
import { ItemSystem, type ItemOffer, type ItemStatComparison } from './ItemSystem';
import { ItemPreviewSystem } from './ItemPreviewSystem';
import type { AimQuality, CombatTargetRef } from './CombatTypes';

interface PlayerProjectile {
  mesh: THREE.Mesh;
  velocity: THREE.Vector3;
  damage: number;
  life: number;
  kind: 'bullet' | 'missile' | 'air-bomb' | 'casing';
  target?: { type: 'bomb' | 'drone'; id: number };
  blastRadius?: number;
  homingStrength?: number;
}

interface HudElements {
  score: HTMLElement;
  timer: HTMLElement;
  stage: HTMLElement;
  healthMeter: HTMLElement;
  healthFill: HTMLElement;
  healthValue: HTMLElement;
  combo: HTMLElement;
  comboValue: HTMLElement;
  multiplier: HTMLElement;
  speed: HTMLElement;
  statSpeed: HTMLElement;
  statGravity: HTMLElement;
  statDefense: HTMLElement;
  statDash: HTMLElement;
  staminaMeter: HTMLElement;
  staminaFill: HTMLElement;
  staminaValue: HTMLElement;
  ropeState: HTMLElement;
  anchorReadout: HTMLElement;
  bombMarkers: HTMLElement;
  enemyMarkers: HTMLElement;
  damageNumbers: HTMLElement;
  itemProcLayer: HTMLElement;
  inventoryBar: HTMLElement;
  toast: HTMLElement;
  hitFlash: HTMLElement;
  speedLines: HTMLElement;
  vignette: HTMLElement;
  menu: HTMLElement;
  menuEyebrow: HTMLElement;
  menuTitle: HTMLElement;
  menuTagline: HTMLElement;
  menuButton: HTMLButtonElement;
  bestScore: HTMLElement;
  results: HTMLElement;
  resultScore: HTMLElement;
  resultAccuracy: HTMLElement;
  resultCombo: HTMLElement;
  resultSpeed: HTMLElement;
  resultFalls: HTMLElement;
  recordLabel: HTMLElement;
  replayButton: HTMLButtonElement;
  resultTime: HTMLElement;
  upgradeScreen: HTMLElement;
  upgradeStage: HTMLElement;
  upgradeReels: HTMLElement;
  itemCards: HTMLButtonElement[];
  upgradeConfirmBar: HTMLElement;
  upgradeConfirmEyebrow: HTMLElement;
  upgradeConfirmName: HTMLElement;
  upgradeConfirmSummary: HTMLElement;
  upgradeReplaceWarning: HTMLElement;
  upgradeReplaceCheck: HTMLInputElement;
  upgradeReplaceText: HTMLElement;
  upgradeConfirmButton: HTMLButtonElement;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required UI element: #${id}`);
  return element as T;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(74, window.innerWidth / window.innerHeight, 0.08, 520);
  private readonly world: World;
  private readonly playerBody: RigidBody;
  private readonly playerCollider: Collider;
  private readonly city: City;
  private readonly targets: TargetSystem;
  private readonly drones: DroneSystem;
  private readonly items = new ItemSystem();
  private readonly itemPreviews: ItemPreviewSystem;
  private readonly audio = new AudioSystem();
  private readonly hud: HudElements;
  private readonly keys = new Set<string>();
  private readonly touchControlsEnabled = document.documentElement.classList.contains('touch-device');
  private readonly ropeMesh: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>;
  private readonly ropeTip: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshBasicMaterial>;
  private readonly anchorMarker: THREE.Mesh;
  private readonly leftMuzzle = new THREE.Object3D();
  private readonly rightMuzzle = new THREE.Object3D();
  private readonly weaponRig = new THREE.Group();
  private readonly dashJets: Array<THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>> = [];
  private readonly tracer: THREE.Line;
  private readonly tracerGeometry = new THREE.BufferGeometry();
  private readonly muzzleFlash: THREE.Mesh<THREE.IcosahedronGeometry, THREE.MeshBasicMaterial>;
  private readonly playerProjectiles: PlayerProjectile[] = [];
  private readonly playerBulletGeometry = new THREE.SphereGeometry(0.17, 6, 4);
  private readonly playerBulletMaterial = new THREE.MeshBasicMaterial({ color: 0xffd358 });
  private readonly casingGeometry = new THREE.BoxGeometry(0.08, 0.18, 0.08);
  private readonly casingMaterial = new THREE.MeshStandardMaterial({ color: 0xd6a84e, metalness: 0.8, roughness: 0.3 });
  private readonly playerPosition = new THREE.Vector3();
  private readonly damageProjection = new THREE.Vector3();
  private readonly cameraForward = new THREE.Vector3(0, 0, -1);
  private readonly candidateAnchor = new THREE.Vector3();
  private readonly ropeStart = new THREE.Vector3();
  private readonly ropeVisualEnd = new THREE.Vector3();
  private readonly ropeDirection = new THREE.Vector3();
  private readonly ropeUp = new THREE.Vector3(0, 1, 0);
  private readonly groundRay = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private readonly physicsForward = new THREE.Vector3();
  private readonly physicsRight = new THREE.Vector3();
  private readonly physicsMove = new THREE.Vector3();
  private readonly grappleDelta = new THREE.Vector3();
  private readonly grappleTangent = new THREE.Vector3();
  private readonly dashDirection = new THREE.Vector3(0, 0, -1);
  private hasCandidateAnchor = false;
  private grappleAnchor: THREE.Vector3 | null = null;
  private ropeLength = 0;
  private grappleInitialLength = 0;
  private ropeReelCharge = 0;
  private ropeShotProgress = 1;
  private leftHeld = false;
  private isGrounded = false;
  private mode: RunMode = 'ready';
  private stats: RunStats = this.blankStats();
  private elapsedTime = 0;
  private stage = 1;
  private nextStageScore: number = CONFIG.stageScoreBase;
  private health: number = CONFIG.playerBaseHealth;
  private maxHealth: number = CONFIG.playerBaseHealth;
  private invulnerabilityTimer = 0;
  private autoGlideTimer = 0;
  private stamina = 100;
  private dashFx = 0;
  private dashTimeRemaining = 0;
  private dashDuration = 0;
  private dashSpeed = 0;
  private yaw = 0;
  private pitch = -0.05;
  private physicsAccumulator = 0;
  private lastFrameTime = performance.now();
  private recoil = 0;
  private leftKick = 0;
  private shake = 0;
  private groundRunPhase = 0;
  private groundRunBlend = 0;
  private peakFallSpeed = 0;
  private landingTimer = 0;
  private landingIntensity = 0;
  private landingSide = 1;
  private readonly landingDuration = 0.62;
  private tracerLife = 0;
  private flashLife = 0;
  private toastTimer = 0;
  private damageTimer = 0;
  private impactTimer = 0;
  private itemGlideFeedbackTimer = 0;
  private itemSpeedFeedbackTimer = 0;
  private itemGliding = false;
  private itemSpeedActive = false;
  private itemProcWashTimeout: number | null = null;
  private bestScore = 0;
  private readonly bombMarkerElements = new Map<number, HTMLElement>();
  private readonly droneMarkerElements = new Map<number, HTMLElement>();
  private readonly visibleBombMarkerIds = new Set<number>();
  private readonly visibleDroneMarkerIds = new Set<number>();
  private activeCombatTarget: CombatTargetRef | null = null;
  private rightHeld = false;
  private primaryCooldown = 0;
  private secondaryCooldown = 0;
  private upgradeOffers: ItemOffer[] = [];
  private selectedUpgradeIndex: number | null = null;
  private anchorSelectionTimer = 0;
  private bombTrackingTimer = 0;
  private hudTimer = 0;
  private performanceTimer = 0;
  private performanceFrames = 0;
  private performancePanel: HTMLPreElement | null = null;
  private performancePanelVisible = false;
  private performanceProbeTimer = 0;
  private performanceProbeFrames = 0;
  private performanceProbeWorkTotal = 0;
  private performanceProbeWorkMax = 0;
  private performanceBaselineGeometries = 0;
  private performanceBaselineTextures = 0;
  private performanceBaselineHeap = 0;
  private readonly mobilePerformanceProfile = window.matchMedia('(pointer: coarse)').matches
    || window.innerWidth < 900;
  private readonly maximumPixelRatio = Math.min(
    window.devicePixelRatio,
    this.mobilePerformanceProfile ? 0.85 : 1,
  );
  private readonly minimumPixelRatio = this.mobilePerformanceProfile ? 0.55 : 0.64;
  private currentPixelRatio = this.maximumPixelRatio;
  private touchMovePointerId: number | null = null;
  private touchLookPointerId: number | null = null;
  private touchLookX = 0;
  private touchLookY = 0;

  constructor(root: HTMLElement, world: World) {
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.currentPixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    root.prepend(this.renderer.domElement);

    this.scene.background = this.createSkyTexture();
    this.scene.fog = new THREE.FogExp2(0xd7c4a8, 0.0046);
    this.scene.matrixWorldAutoUpdate = false;
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);

    this.addEnvironment();
    this.city = new City(this.scene, this.world, this.renderer.capabilities.getMaxAnisotropy());
    this.targets = new TargetSystem(this.scene);
    this.drones = new DroneSystem(this.scene, (kind) => this.audio.droneShoot(kind));

    this.playerBody = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, 18, 30)
        .setLinearDamping(0.08)
        .setCcdEnabled(true)
        .lockRotations(),
    );
    const playerCollider = RAPIER.ColliderDesc.capsule(0.64, 0.48)
      .setFriction(0)
      .setRestitution(0.08)
      .setDensity(1.05);
    this.playerCollider = this.world.createCollider(playerCollider, this.playerBody);

    const ropeMaterial = new THREE.MeshBasicMaterial({
      color: 0x67f8ff,
      transparent: true,
      opacity: 0.96,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.ropeMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1, 8), ropeMaterial);
    this.ropeMesh.frustumCulled = false;
    this.ropeMesh.visible = false;
    this.scene.add(this.ropeMesh);
    this.ropeTip = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.28, 0),
      new THREE.MeshBasicMaterial({
        color: 0xc6fdff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.ropeTip.frustumCulled = false;
    this.ropeTip.visible = false;
    this.scene.add(this.ropeTip);

    this.anchorMarker = new THREE.Mesh(
      new THREE.TorusGeometry(0.92, 0.075, 8, 28),
      new THREE.MeshBasicMaterial({
        color: 0xffd84a,
        transparent: true,
        opacity: 0.98,
        depthTest: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.anchorMarker.renderOrder = 20;
    this.anchorMarker.visible = false;
    this.scene.add(this.anchorMarker);

    this.tracerGeometry.setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.tracer = new THREE.Line(
      this.tracerGeometry,
      new THREE.LineBasicMaterial({ color: 0xff477f, transparent: true, opacity: 0 }),
    );
    this.tracer.frustumCulled = false;
    this.scene.add(this.tracer);

    this.muzzleFlash = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.09, 0),
      new THREE.MeshBasicMaterial({
        color: 0xff477f,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.muzzleFlash.visible = false;
    this.scene.add(this.muzzleFlash);
    this.createWeaponRig();

    this.hud = this.collectHud();
    if (import.meta.env.DEV) this.performancePanel = this.createPerformancePanel(root);
    this.itemPreviews = new ItemPreviewSystem([
      requiredElement('itemPreview0'),
      requiredElement('itemPreview1'),
      requiredElement('itemPreview2'),
    ]);
    this.loadBestScore();
    this.bindEvents();
    this.resetPlayer();
    this.city.update(this.playerPosition, this.cameraForward);
    this.updateCamera(0);
    this.updateAnchorSelection(0);
    this.updateHud();
    void this.renderer.compileAsync(this.scene, this.camera);
    this.renderer.setAnimationLoop(this.frame);
  }

  private readonly frame = (timestamp: number): void => {
    const workStartedAt = performance.now();
    const rawDt = Math.max(0, (timestamp - this.lastFrameTime) / 1000);
    const realDt = clamp(rawDt, 0, 0.05);
    this.lastFrameTime = timestamp;

    if (this.mode === 'playing') this.updatePlaying(realDt);
    else this.updateIdle(realDt);

    this.city.update(this.playerPosition, this.cameraForward);
    this.targets.onChunksLoaded(this.city.consumeLoadedChunks(), this.playerPosition);
    this.updateEffects(realDt);
    this.itemPreviews.update(realDt);
    this.updateCamera(realDt);
    this.updateAnchorSelection(realDt);
    this.updateRopeVisual(realDt);
    this.targets.update(
      this.mode === 'playing' ? realDt : 0,
      this.playerPosition,
      this.cameraForward,
    );
    this.drones.update(
      this.mode === 'playing' ? realDt : 0,
      this.playerPosition,
      this.cameraForward,
      this.stage,
      this.city.getBuildingMeshes(),
    );
    let pickup = this.targets.consumePickup();
    while (pickup) {
      this.handlePickup(pickup.kind, pickup.score);
      pickup = this.targets.consumePickup();
    }
    let bombImpact = this.targets.consumeBombImpact();
    while (bombImpact) {
      this.handleBombImpact();
      bombImpact = this.targets.consumeBombImpact();
    }
    let droneDamage = this.drones.consumePlayerDamage();
    while (droneDamage !== null) {
      this.takeDamage(droneDamage.damage, 'DRONE FIRE', droneDamage.sourceId);
      droneDamage = this.drones.consumePlayerDamage();
    }
    this.scene.updateMatrixWorld();
    this.bombTrackingTimer -= realDt;
    if (this.bombTrackingTimer <= 0) {
      this.bombTrackingTimer = 1 / 30;
      this.updateBombTracking();
    }
    this.hudTimer -= realDt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 1 / 20;
      this.updateHud();
    }
    this.updateAdaptiveResolution(realDt);
    this.renderer.render(this.scene, this.camera);
    this.updatePerformancePanel(rawDt, performance.now() - workStartedAt);
  };

  private updatePlaying(realDt: number): void {
    this.elapsedTime += realDt;
    this.invulnerabilityTimer = Math.max(0, this.invulnerabilityTimer - realDt);
    this.autoGlideTimer = Math.max(0, this.autoGlideTimer - realDt);

    const scaledDt = realDt;
    this.primaryCooldown = Math.max(0, this.primaryCooldown - scaledDt);
    this.secondaryCooldown = Math.max(0, this.secondaryCooldown - scaledDt);
    if (this.rightHeld) this.shoot();
    this.updatePlayerProjectiles(scaledDt);
    const physicsStep = 1 / 60;
    this.physicsAccumulator = Math.min(this.physicsAccumulator + scaledDt, physicsStep * 5);
    while (this.physicsAccumulator >= physicsStep) {
      this.stepPhysics(physicsStep);
      this.world.timestep = physicsStep;
      this.world.step();
      this.physicsAccumulator -= physicsStep;
    }

    const translation = this.playerBody.translation();
    this.playerPosition.set(translation.x, translation.y, translation.z);
    const velocity = this.playerBody.linvel();
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    this.stats.topSpeed = Math.max(this.stats.topSpeed, speed);
    this.updateStamina(realDt);
    if (this.stats.score >= this.nextStageScore) this.enterUpgradeSelection();
    // The street and every rooftop are valid play spaces. This guard now only
    // handles an impossible physics escape below the oversized ground collider.
    if (this.playerPosition.y < -20) this.respawnAfterFall();
  }

  private updateIdle(realDt: number): void {
    const translation = this.playerBody.translation();
    this.playerPosition.set(translation.x, translation.y, translation.z);
    this.weaponRig.rotation.z = Math.sin(performance.now() * 0.001) * 0.005;
    this.anchorMarker.rotation.z += realDt * 0.6;
  }

  private stepPhysics(dt: number): void {
    const verticalSpeed = this.playerBody.linvel().y;
    // Preserve generous ascent time, then smoothly strengthen gravity after
    // the apex so falling has readable speed without making jumps feel heavy.
    const fallTransition = THREE.MathUtils.smoothstep(
      2 - verticalSpeed,
      0,
      CONFIG.gravityTransitionSpeed,
    );
    const airborneGravityScale = THREE.MathUtils.lerp(
      CONFIG.risingGravityScale,
      CONFIG.fallingGravityScale,
      fallTransition,
    );
    const motionGravityScale = this.grappleAnchor || this.isGrounded
      ? 1
      : airborneGravityScale;
    this.world.gravity.y = CONFIG.gravity
      * motionGravityScale
      * this.items.getGravityMultiplier(this.grappleAnchor !== null);
    const wasGrounded = this.isGrounded;
    const preGroundVelocity = this.playerBody.linvel();
    if (!wasGrounded) this.peakFallSpeed = Math.max(this.peakFallSpeed, Math.max(0, -preGroundVelocity.y));
    this.updateGroundedState();
    if (!wasGrounded && this.isGrounded) {
      this.triggerParkourLanding(
        this.peakFallSpeed,
        Math.hypot(preGroundVelocity.x, preGroundVelocity.z),
        preGroundVelocity.x,
        preGroundVelocity.z,
      );
      this.peakFallSpeed = 0;
    } else if (this.isGrounded) this.peakFallSpeed = 0;
    if (this.dashTimeRemaining > 0) {
      this.dashTimeRemaining = Math.max(0, this.dashTimeRemaining - dt);
      const thrustRatio = this.dashDuration > 0 ? this.dashTimeRemaining / this.dashDuration : 0;
      const propulsion = this.dashSpeed * (0.88 + thrustRatio * 0.12);
      this.playerBody.setLinvel(
        {
          x: this.dashDirection.x * propulsion,
          y: this.dashDirection.y * propulsion,
          z: this.dashDirection.z * propulsion,
        },
        true,
      );
      this.dashFx = 1;
      this.isGrounded = false;
      return;
    }
    if (this.autoGlideTimer > 0 && !this.grappleAnchor) {
      const glideForward = this.cameraForward.clone();
      glideForward.y = Math.max(0.02, glideForward.y * 0.22);
      glideForward.normalize();
      this.playerBody.applyImpulse(
        { x: glideForward.x * 7 * dt, y: 4.5 * dt, z: glideForward.z * 7 * dt },
        true,
      );
    }
    this.physicsForward.copy(this.cameraForward);
    this.physicsForward.y = 0;
    this.physicsForward.normalize();
    this.physicsRight.set(-this.physicsForward.z, 0, this.physicsForward.x);
    this.physicsMove.set(0, 0, 0);
    if (this.keys.has('KeyW')) this.physicsMove.add(this.physicsForward);
    if (this.keys.has('KeyS')) this.physicsMove.sub(this.physicsForward);
    if (this.keys.has('KeyD')) this.physicsMove.add(this.physicsRight);
    if (this.keys.has('KeyA')) this.physicsMove.sub(this.physicsRight);
    const hasMoveInput = this.physicsMove.lengthSq() > 0;
    if (hasMoveInput) this.physicsMove.normalize();
    if (this.isGrounded && !this.grappleAnchor) {
      const velocity = this.playerBody.linvel();
      const moveSpeed = CONFIG.walkSpeed * this.items.getSpeedMultiplier();
      const targetX = hasMoveInput ? this.physicsMove.x * moveSpeed : 0;
      const targetZ = hasMoveInput ? this.physicsMove.z * moveSpeed : 0;
      const rate = hasMoveInput ? CONFIG.groundAcceleration : CONFIG.groundDeceleration;
      const maxChange = rate * dt;
      this.playerBody.setLinvel(
        {
          x: velocity.x + clamp(targetX - velocity.x, -maxChange, maxChange),
          y: velocity.y,
          z: velocity.z + clamp(targetZ - velocity.z, -maxChange, maxChange),
        },
        true,
      );
    } else if (hasMoveInput) {
      this.physicsMove.multiplyScalar(CONFIG.airAcceleration * this.items.getSpeedMultiplier() * dt);
      this.playerBody.applyImpulse(
        { x: this.physicsMove.x, y: this.physicsMove.y, z: this.physicsMove.z },
        true,
      );
    }

    if (this.grappleAnchor) {
      const translation = this.playerBody.translation();
      this.grappleDelta.set(
        this.grappleAnchor.x - translation.x,
        this.grappleAnchor.y - translation.y,
        this.grappleAnchor.z - translation.z,
      );
      const distance = this.grappleDelta.length();
      const reelRatio = this.grappleInitialLength > CONFIG.ropeMinLength
        ? clamp(
          1 - (this.ropeLength - CONFIG.ropeMinLength)
            / (this.grappleInitialLength - CONFIG.ropeMinLength),
          0,
          1,
        )
        : 1;
      if (this.leftHeld) {
        const reelSpeed = THREE.MathUtils.lerp(
          CONFIG.ropePullSpeed,
          CONFIG.ropePullMaxSpeed,
          Math.pow(reelRatio, 0.68),
        );
        this.ropeLength = Math.max(CONFIG.ropeMinLength, this.ropeLength - reelSpeed * dt);
        this.ropeReelCharge = clamp(
          this.ropeReelCharge + (0.2 + reelRatio * 0.95) * dt,
          0,
          1,
        );
      }
      if (distance > 0.001) {
        this.grappleDelta.multiplyScalar(1 / distance);
        const velocity = this.playerBody.linvel();
        const towardSpeed = velocity.x * this.grappleDelta.x
          + velocity.y * this.grappleDelta.y
          + velocity.z * this.grappleDelta.z;
        const excess = Math.max(0, distance - this.ropeLength);
        const damping = Math.max(0, -towardSpeed) * CONFIG.ropeDamping;
        const pull = this.leftHeld
          ? THREE.MathUtils.lerp(8, CONFIG.ropeReelRadialForce, reelRatio)
          : 0;
        const impulse = (excess * CONFIG.ropeSpring + damping + pull) * dt;
        this.playerBody.applyImpulse(
          {
            x: this.grappleDelta.x * impulse,
            y: this.grappleDelta.y * impulse,
            z: this.grappleDelta.z * impulse,
          },
          true,
        );

        if (this.leftHeld) {
          this.grappleTangent.set(velocity.x, velocity.y, velocity.z)
            .addScaledVector(this.grappleDelta, -towardSpeed);
          if (this.grappleTangent.lengthSq() < 4) {
            this.grappleTangent.copy(this.cameraForward)
              .addScaledVector(
                this.grappleDelta,
                -this.cameraForward.dot(this.grappleDelta),
              );
          }
          if (this.grappleTangent.lengthSq() > 0.001) {
            this.grappleTangent.normalize();
            const tensionMix = clamp(excess / 4, 0, 1);
            const reelAcceleration = THREE.MathUtils.lerp(
              CONFIG.ropeReelAcceleration,
              CONFIG.ropeReelMaxAcceleration,
              Math.pow(reelRatio, 0.72),
            ) * (0.58 + tensionMix * 0.42);
            this.playerBody.applyImpulse(
              {
                x: this.grappleTangent.x * reelAcceleration * dt,
                y: this.grappleTangent.y * reelAcceleration * dt,
                z: this.grappleTangent.z * reelAcceleration * dt,
              },
              true,
            );
          }
        }
      }
    }

    const velocity = this.playerBody.linvel();
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    const maximumAirSpeed = CONFIG.maxAirSpeed * this.items.getSpeedMultiplier();
    if (speed > maximumAirSpeed) {
      const scale = maximumAirSpeed / speed;
      this.playerBody.setLinvel(
        { x: velocity.x * scale, y: velocity.y * scale, z: velocity.z * scale },
        true,
      );
    }
  }

  private triggerParkourLanding(
    fallSpeed: number,
    horizontalSpeed: number,
    velocityX: number,
    velocityZ: number,
  ): void {
    if (fallSpeed < 5.8) return;
    this.landingIntensity = clamp((fallSpeed - 4.5) / 22 + horizontalSpeed / 160, 0.28, 1);
    this.landingTimer = this.landingDuration;
    const lateralVelocity = velocityX * Math.cos(this.yaw) - velocityZ * Math.sin(this.yaw);
    this.landingSide = Math.abs(lateralVelocity) > 0.45
      ? Math.sign(lateralVelocity)
      : Math.random() > 0.5 ? 1 : -1;
    this.shake = Math.max(this.shake, 0.32 + this.landingIntensity * 0.42);
    this.audio.land(this.landingIntensity);
  }

  private updateGroundedState(): void {
    const translation = this.playerBody.translation();
    this.groundRay.origin.x = translation.x;
    this.groundRay.origin.y = translation.y;
    this.groundRay.origin.z = translation.z;
    const hit = this.world.castRay(
      this.groundRay,
      CONFIG.groundProbeDistance,
      true,
      undefined,
      undefined,
      this.playerCollider,
      this.playerBody,
    );
    this.isGrounded = hit !== null && this.playerBody.linvel().y <= 1.2;
  }

  private updateStamina(dt: number): void {
    if (this.dashTimeRemaining > 0) return;
    const moving = this.keys.has('KeyW') || this.keys.has('KeyA')
      || this.keys.has('KeyS') || this.keys.has('KeyD');
    if (this.isGrounded) {
      const drain = moving ? CONFIG.staminaGroundDrain : CONFIG.staminaGroundIdleDrain;
      this.stamina = Math.max(0, this.stamina - drain * dt);
      return;
    }
    const recharge = this.grappleAnchor
      ? CONFIG.staminaGrappleRecharge
      : CONFIG.staminaAirRecharge;
    this.stamina = Math.min(100, this.stamina + recharge * dt);
  }

  private tryDash(initialLaunch = false): void {
    if (this.mode !== 'playing') return;
    if (!initialLaunch && this.stamina < CONFIG.dashMinimumStamina) {
      this.showToast(`DASH LOCKED\n${Math.floor(this.stamina)}%`, 'negative');
      this.audio.denied();
      return;
    }

    const charge = clamp(this.stamina / 100, 0, 1);
    const dashMultiplier = this.items.getDashMultiplier();
    const speed = THREE.MathUtils.lerp(
      CONFIG.dashMinimumSpeed,
      CONFIG.dashMaximumSpeed,
      charge,
    ) * dashMultiplier;
    const duration = THREE.MathUtils.lerp(
      CONFIG.dashMinimumDuration,
      CONFIG.dashMaximumDuration,
      charge,
    ) * (1 + (dashMultiplier - 1) * 0.45);
    if (initialLaunch) this.physicsForward.set(0, 0.18, -1);
    else {
      this.physicsForward.copy(this.cameraForward);
      this.physicsForward.y = clamp(this.physicsForward.y, -0.08, 0.52);
    }
    if (this.physicsForward.lengthSq() < 0.01) this.physicsForward.set(0, 0.08, -1);
    this.dashDirection.copy(this.physicsForward).normalize();
    this.dashDuration = duration;
    this.dashTimeRemaining = duration;
    this.dashSpeed = speed;
    this.playerBody.setLinvel(
      {
        x: this.dashDirection.x * speed,
        y: this.dashDirection.y * speed,
        z: this.dashDirection.z * speed,
      },
      true,
    );
    this.stamina = 0;
    this.dashFx = 1;
    this.shake = Math.max(this.shake, initialLaunch ? 0.82 : 1.08);
    this.audio.dash(charge);
    if (!initialLaunch) this.showToast(`${Math.round(charge * 100)}%\nGAS BURST`, 'positive');
    if (!initialLaunch && dashMultiplier > 1) {
      this.showItemProc(
        'boost',
        '제트팩 증폭',
        `THRUST +${Math.round((dashMultiplier - 1) * 100)}%`,
        ['jetpack'],
      );
    }
  }

  private tryJumpBoost(): void {
    if (this.mode !== 'playing') return;
    if (this.stamina < CONFIG.dashMinimumStamina) {
      this.showToast(`JUMP LOCKED\n${Math.floor(this.stamina)}%`, 'negative');
      this.audio.denied();
      return;
    }

    const charge = clamp(this.stamina / 100, 0, 1);
    const boostMultiplier = this.items.getDashMultiplier();
    const verticalSpeed = THREE.MathUtils.lerp(
      CONFIG.jumpBoostMinimumSpeed,
      CONFIG.jumpBoostMaximumSpeed,
      charge,
    ) * boostMultiplier;
    const velocity = this.playerBody.linvel();
    this.physicsForward.copy(this.cameraForward);
    this.physicsForward.y = 0;
    if (this.physicsForward.lengthSq() < 0.01) this.physicsForward.set(0, 0, -1);
    this.physicsForward.normalize();
    const forwardKick = THREE.MathUtils.lerp(5, 11, charge) * boostMultiplier;

    // A vertical gas burst cancels an active forward dash, preserves some
    // momentum, then launches decisively upward with a small aiming-direction kick.
    this.dashTimeRemaining = 0;
    this.playerBody.setLinvel(
      {
        x: velocity.x * 0.82 + this.physicsForward.x * forwardKick,
        y: Math.max(velocity.y * 0.35, verticalSpeed),
        z: velocity.z * 0.82 + this.physicsForward.z * forwardKick,
      },
      true,
    );
    this.stamina = 0;
    this.dashFx = 1;
    this.shake = Math.max(this.shake, 1.04);
    this.audio.jumpBoost(charge);
    this.showToast(`${Math.round(charge * 100)}%\nVERTICAL BURST`, 'positive');
    if (boostMultiplier > 1) {
      this.showItemProc(
        'boost',
        '제트팩 증폭',
        `VERTICAL THRUST +${Math.round((boostMultiplier - 1) * 100)}%`,
        ['jetpack'],
      );
    }
  }

  private updateCamera(dt: number): void {
    const translation = this.playerBody.translation();
    this.playerPosition.set(translation.x, translation.y, translation.z);
    const shakeAmount = this.shake * this.shake * 0.08;
    const velocity = this.playerBody.linvel();
    const horizontalSpeed = Math.hypot(velocity.x, velocity.z);
    const hasMoveInput = this.keys.has('KeyW') || this.keys.has('KeyA')
      || this.keys.has('KeyS') || this.keys.has('KeyD');
    const runTarget = this.isGrounded && hasMoveInput
      ? clamp(horizontalSpeed / Math.max(1, CONFIG.walkSpeed), 0, 1)
      : 0;
    this.groundRunBlend = THREE.MathUtils.damp(this.groundRunBlend, runTarget, 11, dt);
    this.groundRunPhase += dt * (8.4 + horizontalSpeed * 0.72) * Math.max(0.18, this.groundRunBlend);
    const step = Math.sin(this.groundRunPhase);
    const bobY = Math.abs(step) * 0.082 * this.groundRunBlend;
    const bobSide = Math.sin(this.groundRunPhase * 0.5) * 0.034 * this.groundRunBlend;
    const landingProgress = this.landingTimer > 0
      ? 1 - this.landingTimer / this.landingDuration
      : 1;
    const landingArc = this.landingTimer > 0
      ? Math.sin(landingProgress * Math.PI) * this.landingIntensity
      : 0;
    const landingRoll = this.landingTimer > 0
      ? Math.sin(landingProgress * Math.PI * 1.15) * this.landingSide * this.landingIntensity
      : 0;
    const rightX = Math.cos(this.yaw);
    const rightZ = -Math.sin(this.yaw);
    this.camera.position.set(
      translation.x + rightX * bobSide + (Math.random() - 0.5) * shakeAmount,
      translation.y + 0.18 + bobY - landingArc * 0.32 + (Math.random() - 0.5) * shakeAmount,
      translation.z + rightZ * bobSide + (Math.random() - 0.5) * shakeAmount,
    );
    this.camera.rotation.set(
      this.pitch + Math.cos(this.groundRunPhase * 2) * 0.006 * this.groundRunBlend + landingArc * 0.048,
      this.yaw,
      -step * 0.009 * this.groundRunBlend + landingRoll * 0.095,
    );
    this.camera.getWorldDirection(this.cameraForward);

    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    this.audio.setMotionState(
      this.grappleAnchor !== null,
      this.mode === 'playing' && !this.isGrounded,
      speed,
      this.leftHeld,
      dt,
    );
    const targetFov = 74
      + clamp((speed - 16) / 38, 0, 1) * 10
      + this.dashFx * 14
      + landingArc * 2.4;
    const nextFov = THREE.MathUtils.damp(this.camera.fov, targetFov, 6, dt);
    if (Math.abs(nextFov - this.camera.fov) > 0.01) {
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }

    this.recoil = THREE.MathUtils.damp(this.recoil, 0, 18, dt);
    this.leftKick = THREE.MathUtils.damp(this.leftKick, 0, 12, dt);
    this.weaponRig.position.y = Math.sin(performance.now() * 0.008) * Math.min(0.012, speed * 0.00035)
      - bobY * 0.5 - landingArc * 0.17;
    this.weaponRig.position.x = -bobSide * 0.42;
    const idleWeaponRoll = this.mode === 'playing' ? 0 : Math.sin(performance.now() * 0.001) * 0.005;
    this.weaponRig.rotation.z = idleWeaponRoll - landingRoll * 0.28;
    const rightDevice = this.weaponRig.getObjectByName('right-device');
    const leftDevice = this.weaponRig.getObjectByName('left-device');
    if (rightDevice) {
      rightDevice.position.z = -0.64 + this.recoil * 0.13;
      rightDevice.rotation.x = -0.05 + this.recoil * 0.08;
    }
    if (leftDevice) leftDevice.rotation.x = -0.08 - this.leftKick * 0.08;
    const dashActive = this.dashTimeRemaining > 0;
    for (let index = 0; index < this.dashJets.length; index += 1) {
      const jet = this.dashJets[index];
      jet.visible = dashActive;
      if (!dashActive) continue;
      const flicker = 0.88 + Math.random() * 0.28;
      jet.scale.set(0.9 + this.dashFx * 0.28, flicker * (1.1 + this.dashFx * 0.58), 0.9 + this.dashFx * 0.28);
      jet.material.opacity = 0.3 + Math.random() * 0.18;
    }
    this.landingTimer = Math.max(0, this.landingTimer - dt);
  }

  private updateAnchorSelection(dt: number): void {
    if (this.grappleAnchor) {
      this.hasCandidateAnchor = false;
      this.anchorMarker.visible = true;
      (this.anchorMarker.material as THREE.MeshBasicMaterial).color.setHex(0x58f7ff);
      this.anchorMarker.position.copy(this.grappleAnchor);
      this.anchorMarker.quaternion.copy(this.camera.quaternion);
      const scale = clamp(this.camera.position.distanceTo(this.grappleAnchor) * 0.012, 0.75, 1.7);
      this.anchorMarker.scale.setScalar(scale);
      return;
    }

    this.anchorSelectionTimer -= dt;
    if (this.anchorSelectionTimer > 0) return;
    this.anchorSelectionTimer = 0.045;

    const anchor = this.city.findAssistedAnchor(this.camera, this.playerPosition);
    this.hasCandidateAnchor = anchor !== null;
    if (anchor) {
      this.candidateAnchor.copy(anchor);
      this.anchorMarker.visible = true;
      (this.anchorMarker.material as THREE.MeshBasicMaterial).color.setHex(0xffd84a);
      this.anchorMarker.position.copy(anchor);
      this.anchorMarker.quaternion.copy(this.camera.quaternion);
      const pulse = 1 + Math.sin(performance.now() * 0.009) * 0.1;
      const scale = clamp(this.camera.position.distanceTo(anchor) * 0.012, 0.75, 1.7) * pulse;
      this.anchorMarker.scale.setScalar(scale);
    } else {
      this.anchorMarker.visible = false;
    }
  }

  private updateRopeVisual(dt: number): void {
    if (!this.grappleAnchor) {
      this.ropeMesh.visible = false;
      this.ropeTip.visible = false;
      return;
    }
    this.camera.updateMatrixWorld();
    this.leftMuzzle.getWorldPosition(this.ropeStart);
    this.ropeShotProgress = Math.min(1, this.ropeShotProgress + dt / CONFIG.ropeFireDuration);
    const easedProgress = 1 - Math.pow(1 - this.ropeShotProgress, 3);
    this.ropeVisualEnd.lerpVectors(this.ropeStart, this.grappleAnchor, easedProgress);
    this.ropeDirection.copy(this.ropeVisualEnd).sub(this.ropeStart);
    const length = this.ropeDirection.length();
    if (length <= 0.001) {
      this.ropeMesh.visible = false;
      this.ropeTip.visible = false;
      return;
    }
    this.ropeMesh.position.copy(this.ropeStart).addScaledVector(this.ropeDirection, 0.5);
    this.ropeMesh.quaternion.setFromUnitVectors(this.ropeUp, this.ropeDirection.normalize());
    const launchPulse = 1 + (1 - this.ropeShotProgress) * 0.72;
    this.ropeMesh.scale.set(launchPulse, length, launchPulse);
    this.ropeMesh.visible = true;
    this.ropeTip.position.copy(this.ropeVisualEnd);
    this.ropeTip.scale.setScalar(0.8 + (1 - this.ropeShotProgress) * 1.5);
    this.ropeTip.visible = this.ropeShotProgress < 1;
  }

  private updateBombTracking(): void {
    const weaponRange = this.items.getPrimaryStats().range;
    const bombTracks = this.mode === 'playing'
      ? this.targets.getBombTracks(this.camera, this.city.getBuildingMeshes(), weaponRange)
      : [];
    const droneTracks = this.mode === 'playing'
      ? this.drones.getTracks(this.camera, this.city.getBuildingMeshes(), weaponRange)
      : [];
    const candidates: CombatTargetRef[] = [];
    for (const track of bombTracks) {
      if (track.quality === 'none') continue;
      const missingHealth = 1 - this.health / Math.max(1, this.maxHealth);
      const healthPriority = track.kind === 'health' ? (missingHealth > 0.05 ? -0.42 * missingHealth : 0.8) : 0;
      candidates.push({ type: track.kind, id: track.targetId, quality: track.quality, score: track.score + healthPriority });
    }
    for (const track of droneTracks) {
      if (track.quality === 'none') continue;
      candidates.push({ type: 'drone', id: track.targetId, quality: track.quality, score: track.score });
    }
    candidates.sort((a, b) => {
      const qualityDifference = (a.quality === 'perfect' ? 0 : 1) - (b.quality === 'perfect' ? 0 : 1);
      return qualityDifference || a.score - b.score;
    });
    this.activeCombatTarget = candidates[0] ?? null;
    this.visibleBombMarkerIds.clear();
    this.visibleDroneMarkerIds.clear();

    for (const track of bombTracks) {
      this.visibleBombMarkerIds.add(track.targetId);
      track.locked = this.activeCombatTarget?.type === track.kind
        && this.activeCombatTarget.id === track.targetId;
      let marker = this.bombMarkerElements.get(track.targetId);
      if (!marker) {
        marker = document.createElement('div');
        marker.className = 'bomb-lock';
        marker.innerHTML = '<span class="bomb-lock-label"></span><i></i>';
        this.hud.bombMarkers.append(marker);
        this.bombMarkerElements.set(track.targetId, marker);
      }
      this.updateBombMarker(marker, track);
    }

    for (const track of droneTracks) {
      this.visibleDroneMarkerIds.add(track.targetId);
      track.locked = this.activeCombatTarget?.type === 'drone'
        && this.activeCombatTarget.id === track.targetId;
      let marker = this.droneMarkerElements.get(track.targetId);
      if (!marker) {
        marker = document.createElement('div');
        marker.className = 'drone-lock';
        marker.innerHTML = '<span class="drone-lock-label">HOSTILE DRONE</span><div class="drone-health"><i></i></div>';
        this.hud.enemyMarkers.append(marker);
        this.droneMarkerElements.set(track.targetId, marker);
      }
      this.updateDroneMarker(marker, track);
    }

    for (const [targetId, marker] of this.bombMarkerElements) {
      if (this.visibleBombMarkerIds.has(targetId)) continue;
      marker.remove();
      this.bombMarkerElements.delete(targetId);
    }
    for (const [targetId, marker] of this.droneMarkerElements) {
      if (this.visibleDroneMarkerIds.has(targetId)) continue;
      marker.remove();
      this.droneMarkerElements.delete(targetId);
    }
  }

  private updateBombMarker(marker: HTMLElement, track: BombTrack): void {
    const x = clamp((track.ndcX * 0.5 + 0.5) * 100, 4, 96);
    const y = clamp((-track.ndcY * 0.5 + 0.5) * 100, 6, 94);
    const scale = clamp(1.22 - track.distance / 260, 0.72, 1.08);
    marker.style.left = `${x}%`;
    marker.style.top = `${y}%`;
    marker.style.setProperty('--marker-scale', String(scale));
    marker.classList.toggle('health-pack', track.kind === 'health');
    marker.classList.toggle('selected', track.locked);
    marker.classList.toggle('perfect', track.locked && track.quality === 'perfect');
    marker.classList.toggle('graze', track.locked && track.quality === 'graze');
    marker.classList.toggle('distant', !track.inEngageRange);
    marker.classList.toggle('urgent', track.danger && track.quality === 'none');
    marker.classList.toggle('distant', !track.inEngageRange);
    const label = marker.querySelector<HTMLElement>('.bomb-lock-label');
    if (label) {
      label.textContent = track.kind === 'health' && track.locked && track.quality === 'perfect'
        ? `MED +${CONFIG.healthPackHealPerfect} // ${this.touchControlsEnabled ? 'TAP' : 'RMB'}`
        : track.kind === 'health' && track.locked && track.quality === 'graze'
          ? `MED +${CONFIG.healthPackHealGraze} // ${this.touchControlsEnabled ? 'TAP' : 'RMB'}`
          : track.kind === 'health'
            ? `MEDKIT // ${Math.round(track.distance)} M`
            : track.locked && track.quality === 'perfect'
        ? `DIRECT // ${this.touchControlsEnabled ? 'TAP' : 'RMB'}`
        : track.locked && track.quality === 'graze'
          ? `GRAZE // ${this.touchControlsEnabled ? 'TAP' : 'RMB'}`
        : track.danger
          ? `DANGER // ${Math.round(track.distance)} M`
          : !track.inEngageRange
            ? `CHASE // ${Math.round(track.distance)} M`
            : `ALIGN // ${Math.round(track.distance)} M`;
    }
  }

  private updateDroneMarker(marker: HTMLElement, track: DroneTrack): void {
    const x = clamp((track.ndcX * 0.5 + 0.5) * 100, 4, 96);
    const y = clamp((-track.ndcY * 0.5 + 0.5) * 100, 7, 91);
    marker.style.left = `${x}%`;
    marker.style.top = `${y}%`;
    marker.style.setProperty('--health-ratio', String(track.healthRatio));
    marker.classList.toggle('assault', track.kind === 'assault');
    marker.classList.toggle('selected', track.locked);
    marker.classList.toggle('perfect', track.locked && track.quality === 'perfect');
    marker.classList.toggle('graze', track.locked && track.quality === 'graze');
    const label = marker.querySelector<HTMLElement>('.drone-lock-label');
    if (label) {
      label.textContent = track.locked
        ? track.quality === 'perfect'
          ? `${track.kind === 'assault' ? 'HEAVY ' : ''}AUTO DIRECT // ${this.touchControlsEnabled ? 'TAP' : 'RMB'}`
          : `${track.kind === 'assault' ? 'HEAVY ' : ''}AUTO GRAZE // ${this.touchControlsEnabled ? 'TAP' : 'RMB'}`
        : !track.inEngageRange
          ? `OUT OF RANGE // ${Math.round(track.distance)} M`
          : `${track.kind === 'assault' ? 'HEAVY ' : ''}AUTO SCAN // ${Math.round(track.distance)} M`;
    }
  }

  private updateAdaptiveResolution(dt: number): void {
    if (this.mode !== 'playing') {
      this.performanceTimer = 0;
      this.performanceFrames = 0;
      return;
    }
    this.performanceTimer += dt;
    this.performanceFrames += 1;
    if (this.performanceTimer < 1.2) return;

    const fps = this.performanceFrames / this.performanceTimer;
    const lowerTarget = this.mobilePerformanceProfile ? 44 : 52;
    const upperTarget = this.mobilePerformanceProfile ? 51 : 58;
    let nextRatio = this.currentPixelRatio;
    if (fps < lowerTarget) {
      nextRatio = Math.max(this.minimumPixelRatio, this.currentPixelRatio - 0.14);
    } else if (fps > upperTarget) {
      nextRatio = Math.min(this.maximumPixelRatio, this.currentPixelRatio + 0.035);
    }
    if (Math.abs(nextRatio - this.currentPixelRatio) >= 0.049) {
      this.currentPixelRatio = nextRatio;
      this.renderer.setPixelRatio(this.currentPixelRatio);
    }
    this.renderer.domElement.dataset.fps = fps.toFixed(1);
    this.renderer.domElement.dataset.pixelRatio = this.currentPixelRatio.toFixed(2);
    this.renderer.domElement.dataset.drawCalls = String(this.renderer.info.render.calls);
    this.renderer.domElement.dataset.triangles = String(this.renderer.info.render.triangles);
    const cityStats = this.city.getPerformanceStats();
    this.renderer.domElement.dataset.cityChunks = String(cityStats.chunks);
    this.renderer.domElement.dataset.physicsBodies = String(cityStats.physicsBodies);
    this.renderer.domElement.dataset.raycastMeshes = String(cityStats.raycastMeshes);
    this.performanceTimer = 0;
    this.performanceFrames = 0;
  }

  private createPerformancePanel(root: HTMLElement): HTMLPreElement {
    const panel = document.createElement('pre');
    panel.className = 'performance-probe';
    panel.hidden = true;
    panel.textContent = 'PERF PROBE // COLLECTING';
    root.append(panel);
    return panel;
  }

  private togglePerformancePanel(): void {
    if (!this.performancePanel) return;
    this.performancePanelVisible = !this.performancePanelVisible;
    this.performancePanel.hidden = !this.performancePanelVisible;
    this.performanceProbeTimer = 0;
    this.performanceProbeFrames = 0;
    this.performanceProbeWorkTotal = 0;
    this.performanceProbeWorkMax = 0;
    this.performanceBaselineGeometries = this.renderer.info.memory.geometries;
    this.performanceBaselineTextures = this.renderer.info.memory.textures;
    const memory = (performance as Performance & {
      memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    this.performanceBaselineHeap = memory?.usedJSHeapSize ?? 0;
    if (this.performancePanelVisible) {
      this.performancePanel.dataset.level = 'good';
      this.performancePanel.textContent = 'PERF PROBE // COLLECTING  [SHIFT + T]';
    }
  }

  private updatePerformancePanel(frameIntervalSeconds: number, workMilliseconds: number): void {
    if (!this.performancePanelVisible || !this.performancePanel) return;
    if (frameIntervalSeconds <= 0 || frameIntervalSeconds > 0.25) return;
    this.performanceProbeTimer += frameIntervalSeconds;
    this.performanceProbeFrames += 1;
    this.performanceProbeWorkTotal += workMilliseconds;
    this.performanceProbeWorkMax = Math.max(this.performanceProbeWorkMax, workMilliseconds);
    if (this.performanceProbeTimer < 0.5) return;

    const fps = this.performanceProbeFrames / this.performanceProbeTimer;
    const frameMilliseconds = this.performanceProbeTimer * 1000 / this.performanceProbeFrames;
    const averageWork = this.performanceProbeWorkTotal / this.performanceProbeFrames;
    const render = this.renderer.info.render;
    const rendererMemory = this.renderer.info.memory;
    const city = this.city.getPerformanceStats();
    const drones = this.drones.getPerformanceStats();
    const targets = this.targets.getPerformanceStats();
    const audio = this.audio.getPerformanceStats();
    const browserMemory = (performance as Performance & {
      memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
    }).memory;
    const heapText = browserMemory
      ? `${(browserMemory.usedJSHeapSize / 1048576).toFixed(1)} MB  `
        + `(+${Math.max(0, (browserMemory.usedJSHeapSize - this.performanceBaselineHeap) / 1048576).toFixed(1)})  `
        + `/ ${(browserMemory.jsHeapSizeLimit / 1073741824).toFixed(1)} GB`
      : 'not exposed by browser';
    const formatCount = (value: number): string => value >= 1_000_000
      ? `${(value / 1_000_000).toFixed(2)}M`
      : value >= 1_000
        ? `${(value / 1_000).toFixed(1)}K`
        : String(value);

    this.performancePanel.dataset.level = fps < 40 ? 'danger' : fps < 52 ? 'warn' : 'good';
    this.performancePanel.textContent = [
      'PERF PROBE // LOCAL DEV ONLY                         [SHIFT + T]',
      `FPS       ${fps.toFixed(1).padStart(6)}   FRAME ${frameMilliseconds.toFixed(2).padStart(6)} ms`,
      `MAIN CPU  AVG ${averageWork.toFixed(2).padStart(6)} ms   PEAK ${this.performanceProbeWorkMax.toFixed(2).padStart(6)} ms`,
      `RES       PR ${this.currentPixelRatio.toFixed(2)}   ${this.renderer.domElement.width} x ${this.renderer.domElement.height}`,
      `RENDER    DRAW ${String(render.calls).padStart(4)}   TRI ${formatCount(render.triangles).padStart(7)}   PROGRAM ${String(this.renderer.info.programs?.length ?? 0).padStart(3)}`,
      `GPU MEM   GEO ${String(rendererMemory.geometries).padStart(5)} (+${rendererMemory.geometries - this.performanceBaselineGeometries})   TEX ${String(rendererMemory.textures).padStart(4)} (+${rendererMemory.textures - this.performanceBaselineTextures})`,
      `CITY      CHUNK ${String(city.chunks).padStart(3)}   BODY ${String(city.physicsBodies).padStart(4)}   RAY MESH ${String(city.raycastMeshes).padStart(3)}`,
      `DRONES    ALL ${String(drones.drones).padStart(2)} [S ${drones.scouts} / A ${drones.assaults}]   BULLET ${String(drones.bullets).padStart(3)}   BURST ${drones.bursts}`,
      `TARGETS   ALL ${String(targets.targets).padStart(2)} [ORB ${targets.ambient} / BOMB ${targets.bombs} / MED ${targets.healthPacks}]   FX ${targets.effects}`,
      `RUNTIME   AUDIO ${String(audio.oneShots).padStart(3)} + LOOP ${audio.loops} (${audio.contextState})   DAMAGE DOM ${this.hud.damageNumbers.childElementCount}   PLAYER FX ${this.playerProjectiles.length}`,
      `HEAP      ${heapText}`,
      `RUN       STAGE ${this.stage}   SCORE ${this.stats.score.toLocaleString('en-US')}   TIME ${this.formatElapsedTime(this.elapsedTime)}`,
    ].join('\n');

    this.performanceProbeTimer = 0;
    this.performanceProbeFrames = 0;
    this.performanceProbeWorkTotal = 0;
    this.performanceProbeWorkMax = 0;
  }

  private tryAttach(): void {
    if (!this.hasCandidateAnchor || this.mode !== 'playing') return;
    this.grappleAnchor = this.candidateAnchor.clone();
    this.ropeShotProgress = 0;
    const distance = this.grappleAnchor.distanceTo(this.playerPosition);
    this.ropeLength = Math.max(CONFIG.ropeMinLength, distance * 0.88);
    this.grappleInitialLength = this.ropeLength;
    this.ropeReelCharge = 0;
    const direction = this.grappleAnchor.clone().sub(this.playerPosition).normalize().multiplyScalar(2.1);
    this.playerBody.applyImpulse({ x: direction.x, y: direction.y, z: direction.z }, true);
    this.leftKick = 1;
    this.audio.attach();
  }

  private detach(): void {
    if (this.grappleAnchor) {
      if (this.leftHeld && this.mode === 'playing' && this.ropeReelCharge > 0.04) {
        const velocity = this.playerBody.linvel();
        this.grappleTangent.set(velocity.x, Math.max(0, velocity.y * 0.18), velocity.z);
        if (this.grappleTangent.lengthSq() < 4) {
          this.grappleTangent.copy(this.cameraForward);
          this.grappleTangent.y = Math.max(0.08, this.grappleTangent.y);
        }
        this.grappleTangent.normalize();
        const releaseBoost = CONFIG.ropeReleaseBoost * this.ropeReelCharge;
        this.playerBody.applyImpulse(
          {
            x: this.grappleTangent.x * releaseBoost,
            y: this.grappleTangent.y * releaseBoost
              + CONFIG.ropeReleaseLift * this.ropeReelCharge,
            z: this.grappleTangent.z * releaseBoost,
          },
          true,
        );
        this.dashFx = Math.max(this.dashFx, this.ropeReelCharge * 0.42);
        this.shake = Math.max(this.shake, this.ropeReelCharge * 0.34);
      }
      this.audio.detach();
    }
    this.grappleAnchor = null;
    this.ropeShotProgress = 1;
    this.grappleInitialLength = 0;
    this.ropeReelCharge = 0;
    this.ropeMesh.visible = false;
    this.ropeTip.visible = false;
    this.leftHeld = false;
  }

  private shoot(): void {
    if (this.mode !== 'playing' || this.primaryCooldown > 0) return;
    const weapon = this.items.getPrimaryStats();
    this.primaryCooldown = weapon.cooldown;
    this.stats.shots += 1;
    this.audio.shoot(weapon.id);
    this.recoil = 1;
    this.shake = Math.max(this.shake, 0.24);
    this.flashLife = 0.045;

    this.camera.updateMatrixWorld();
    const muzzlePosition = new THREE.Vector3();
    this.rightMuzzle.getWorldPosition(muzzlePosition);
    const target = this.activeCombatTarget;
    const targetPosition = target ? this.getCombatTargetPosition(target) : null;
    if (weapon.id === 'machinegun' && (!target || !targetPosition)) {
      this.spawnMachinegunRound(muzzlePosition, weapon.damage);
      return;
    }

    this.showTracer(
      muzzlePosition,
      targetPosition ?? muzzlePosition.clone().addScaledVector(this.cameraForward, 150),
    );
    if (!target) return;
    if (weapon.id === 'machinegun') this.spawnMachinegunCasing(muzzlePosition);
    const qualityMultiplier = target.quality === 'perfect' ? 1 : 0.45;
    this.applyCombatDamage(target, weapon.damage, qualityMultiplier);
  }

  private handlePickup(kind: 'normal' | 'gold', baseScore: number): void {
    this.stats.combo += kind === 'gold' ? 2 : 1;
    this.stats.bestCombo = Math.max(this.stats.bestCombo, this.stats.combo);
    const velocity = this.playerBody.linvel();
    const speed = this.isGrounded ? 0 : Math.hypot(velocity.x, velocity.y, velocity.z);
    const earned = Math.round(baseScore * this.comboMultiplier() * clamp(1 + speed / 70, 1, 1.8));
    this.stats.score += earned;
    this.showToast(
      `+${earned.toLocaleString('ko-KR')}\n${kind === 'gold' ? 'GOLD ENERGY' : 'FLOW ENERGY'}`,
      'positive',
    );
    this.punchCombo();
    this.impactTimer = kind === 'gold' ? 0.18 : 0.1;
    this.shake = Math.max(this.shake, kind === 'gold' ? 0.52 : 0.22);
    if (kind === 'gold') this.audio.gold();
    else this.audio.hit();
  }

  private applyCombatDamage(target: CombatTargetRef, damage: number, qualityMultiplier: number): void {
    if (target.type === 'health') {
      const healthPack = this.targets.activateHealthPackById(target.id, target.quality);
      if (healthPack) this.handleHealthPack(healthPack);
      else this.clearCombatMarker(target);
      return;
    }
    const result = target.type === 'bomb'
      ? this.targets.detonateBombById(target.id, target.quality)
      : this.drones.damageDroneById(target.id, damage, qualityMultiplier);
    if (!result) {
      this.clearCombatMarker(target);
      return;
    }
    this.handleCombatDamage(target.type, result, target.quality);
  }

  private handleHealthPack(result: HealthPackResult): void {
    const previousHealth = this.health;
    this.health = Math.min(this.maxHealth, this.health + result.healing);
    const restored = Math.max(0, this.health - previousHealth);
    this.stats.hits += 1;
    this.impactTimer = 0.2;
    this.shake = Math.max(this.shake, 0.28);
    this.showToast(
      `+${Math.round(restored)} HP\n${result.quality === 'perfect' ? 'DIRECT MEDKIT' : 'GRAZE MEDKIT'}`,
      'positive',
    );
    this.audio.gold();
    if (restored > 0) {
      this.showItemProc('heal', '체력 회복', `+${Math.round(restored)} HP · MEDKIT`, []);
    }
    this.clearCombatMarker({ type: 'health', id: result.targetId });
  }

  private handleCombatDamage(
    type: 'bomb' | 'drone',
    result: BombDamageResult | DroneDamageResult,
    quality: AimQuality = 'perfect',
    countAsWeaponHit = true,
  ): void {
    const playHitSound = this.impactTimer <= 0;
    if (countAsWeaponHit) this.stats.hits += 1;
    this.impactTimer = quality === 'perfect' ? 0.17 : 0.1;
    this.shake = Math.max(this.shake, quality === 'perfect' ? 0.48 : 0.22);
    if (type === 'drone') {
      this.showDamageNumber(result.position, result.damageDealt, quality, result.destroyed);
    }
    if (type === 'drone') this.audio.droneHit();
    else if (playHitSound && !result.destroyed) this.audio.hit();
    if (!result.destroyed) return;
    this.stats.combo += type === 'bomb' ? 3 : 2;
    this.stats.bestCombo = Math.max(this.stats.bestCombo, this.stats.combo);
    const qualityMultiplier = type === 'bomb' ? 1 : quality === 'perfect' ? 1 : 0.48;
    const earned = Math.round(result.score * this.comboMultiplier() * qualityMultiplier);
    this.stats.score += earned;
    this.showToast(
      `+${earned.toLocaleString('ko-KR')}\n${type === 'bomb' ? 'BOMB DEFUSED' : 'DRONE DOWN'}`,
      'positive',
    );
    this.punchCombo();
    this.clearCombatMarker({ type, id: result.targetId });
    this.audio.defuse();
  }

  private getCombatTargetPosition(target: CombatTargetRef): THREE.Vector3 | null {
    if (target.type === 'bomb') return this.targets.getBombPosition(target.id);
    if (target.type === 'health') return this.targets.getHealthPackPosition(target.id);
    return this.drones.getTargetPosition(target.id);
  }

  private spawnMachinegunRound(muzzlePosition: THREE.Vector3, damage: number): void {
    const bullet = new THREE.Mesh(this.playerBulletGeometry, this.playerBulletMaterial);
    bullet.position.copy(muzzlePosition);
    const spread = 0.018;
    const direction = this.cameraForward.clone().add(
      new THREE.Vector3(
        (Math.random() - 0.5) * spread,
        (Math.random() - 0.5) * spread,
        (Math.random() - 0.5) * spread,
      ),
    ).normalize();
    const playerVelocity = this.playerBody.linvel();
    const velocity = direction.multiplyScalar(92 + this.items.getPrimaryStats().level * 7);
    velocity.add(new THREE.Vector3(playerVelocity.x, playerVelocity.y, playerVelocity.z));
    this.scene.add(bullet);
    this.playerProjectiles.push({ mesh: bullet, velocity, damage, life: 2.1, kind: 'bullet' });

    this.spawnMachinegunCasing(muzzlePosition);
  }

  private spawnMachinegunCasing(muzzlePosition: THREE.Vector3): void {
    const casing = new THREE.Mesh(this.casingGeometry, this.casingMaterial);
    casing.position.copy(muzzlePosition).add(new THREE.Vector3(0.14, 0.03, 0));
    const casingVelocity = new THREE.Vector3(2.5 + Math.random() * 2, 1.8 + Math.random(), 0.4 - Math.random() * 1.4);
    casingVelocity.applyQuaternion(this.camera.quaternion);
    this.scene.add(casing);
    this.playerProjectiles.push({ mesh: casing, velocity: casingVelocity, damage: 0, life: 0.7, kind: 'casing' });
  }

  private clearCombatMarker(target: Pick<CombatTargetRef, 'type' | 'id'>): void {
    const markerMap = target.type === 'drone' ? this.droneMarkerElements : this.bombMarkerElements;
    markerMap.get(target.id)?.remove();
    markerMap.delete(target.id);
    if (this.activeCombatTarget?.type === target.type && this.activeCombatTarget.id === target.id) {
      this.activeCombatTarget = null;
    }
  }

  private updatePlayerProjectiles(dt: number): void {
    for (let index = this.playerProjectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.playerProjectiles[index];
      projectile.life -= dt;
      if (projectile.kind === 'casing') {
        projectile.velocity.y -= 18 * dt;
        projectile.mesh.rotation.x += dt * 15;
        projectile.mesh.rotation.z += dt * 11;
      } else if (projectile.kind === 'missile' && projectile.target) {
        const targetPosition = projectile.target.type === 'bomb'
          ? this.targets.getBombPosition(projectile.target.id)
          : this.drones.getTargetPosition(projectile.target.id);
        if (targetPosition) {
          const desiredVelocity = targetPosition.sub(projectile.mesh.position).normalize().multiplyScalar(58);
          projectile.velocity.lerp(
            desiredVelocity,
            Math.min(1, dt * (projectile.homingStrength ?? 4.5)),
          );
          projectile.mesh.lookAt(projectile.mesh.position.clone().add(projectile.velocity));
          if (projectile.mesh.position.distanceToSquared(targetPosition) < 3.2 * 3.2) {
            const result = projectile.target.type === 'bomb'
              ? this.targets.detonateBombById(projectile.target.id)
              : this.drones.damageDroneById(projectile.target.id, projectile.damage);
            if (result) this.handleCombatDamage(projectile.target.type, result, 'perfect');
            this.removePlayerProjectile(index);
            continue;
          }
        }
      }
      projectile.mesh.position.addScaledVector(projectile.velocity, dt);

      if (projectile.kind === 'bullet') {
        const droneHit = this.drones.damageAtPoint(projectile.mesh.position, 1.9, projectile.damage);
        const bombHit = droneHit ? null : this.targets.detonateBombAtPoint(projectile.mesh.position, 2.1);
        if (droneHit || bombHit) {
          if (droneHit) this.handleCombatDamage('drone', droneHit, 'perfect');
          if (bombHit) this.handleCombatDamage('bomb', bombHit, 'perfect');
          this.removePlayerProjectile(index);
          continue;
        }
      }

      if (projectile.life > 0) continue;
      if (projectile.kind === 'air-bomb') {
        const radius = projectile.blastRadius ?? 14;
        const droneHits = this.drones.damageInRadius(projectile.mesh.position, radius, projectile.damage);
        const bombHits = this.targets.detonateBombsInRadius(projectile.mesh.position, radius);
        for (const result of droneHits) this.handleCombatDamage('drone', result, 'perfect');
        for (const result of bombHits) this.handleCombatDamage('bomb', result, 'perfect');
        this.shake = Math.max(this.shake, 0.85);
      }
      this.removePlayerProjectile(index);
    }
  }

  private removePlayerProjectile(index: number): void {
    const projectile = this.playerProjectiles[index];
    this.scene.remove(projectile.mesh);
    this.playerProjectiles.splice(index, 1);
  }

  private handleBombImpact(): void {
    this.stats.combo = 0;
    this.damageTimer = 0.34;
    this.shake = 1;
    this.audio.bomb();
    this.takeDamage(28 + this.stage * 2, 'BOMB IMPACT');
  }

  private respawnAfterFall(): void {
    this.stats.falls += 1;
    this.stats.combo = 0;
    this.takeDamage(18 + this.stage, 'FALL DAMAGE');
    if (this.mode === 'over') return;
    const safeX = Math.round(this.playerPosition.x / CONFIG.chunkSize) * CONFIG.chunkSize;
    const safeZ = Math.round(this.playerPosition.z / CONFIG.chunkSize) * CONFIG.chunkSize;
    this.playerBody.setTranslation({ x: safeX, y: 19, z: safeZ }, true);
    const forward = this.cameraForward.clone();
    forward.y = 0;
    if (forward.lengthSq() < 0.01) forward.set(0, 0, -1);
    forward.normalize().multiplyScalar(13);
    this.playerBody.setLinvel({ x: forward.x, y: 2, z: forward.z }, true);
    this.detach();
    this.damageTimer = 0.28;
    this.shake = 0.8;
    this.audio.fall();
  }

  private takeDamage(rawDamage: number, source: string, attackerId?: number): void {
    if (this.mode !== 'playing' || this.invulnerabilityTimer > 0 || rawDamage <= 0) return;
    const damageReduction = this.items.getDamageReduction();
    const damage = Math.max(1, rawDamage * (1 - damageReduction));
    const prevented = Math.max(0, rawDamage - damage);
    this.health = Math.max(0, this.health - damage);
    this.stats.combo = 0;
    this.damageTimer = 0.38;
    this.shake = Math.max(this.shake, 0.76);
    this.showToast(`-${Math.round(damage)} HP\n${source}`, 'negative');
    if (prevented >= 0.5) {
      const contributors: string[] = [];
      if (this.items.getDamageGuardReduction() > 0) contributors.push('damage_guard');
      if (this.items.getArmorDamageReduction() > 0) contributors.push('armor');
      this.showItemProc(
        'defense',
        '데미지 감소',
        `-${Math.round(prevented)} DAMAGE · ${Math.round(damageReduction * 100)}% CUT`,
        contributors,
      );
    }
    if (source === 'DRONE FIRE') this.audio.playerHit();

    const siphonRatio = this.items.getBloodSiphonRatio();
    if (attackerId !== undefined && siphonRatio > 0) {
      const siphonResult = this.drones.damageDroneById(attackerId, damage * siphonRatio);
      if (siphonResult) {
        const previousHealth = this.health;
        this.health = Math.min(this.maxHealth, this.health + siphonResult.damageDealt);
        const restored = Math.max(0, this.health - previousHealth);
        this.handleCombatDamage('drone', siphonResult, 'perfect', false);
        this.showItemProc(
          'siphon',
          '피흡 반격',
          `+${Math.round(restored)} HP · ${Math.round(siphonResult.damageDealt)} DAMAGE RETURN`,
          ['blood_siphon'],
        );
      }
    }
    if (this.health <= 0) this.finishRun();
  }

  private enterUpgradeSelection(): void {
    if (this.mode !== 'playing') return;
    this.mode = 'upgrade';
    this.rightHeld = false;
    this.keys.clear();
    this.detach();
    this.audio.setIntermission(true);
    this.upgradeOffers = this.items.rollOffers(3);
    this.selectedUpgradeIndex = null;
    this.hud.upgradeConfirmBar.classList.add('hidden');
    this.hud.upgradeReplaceWarning.classList.add('hidden');
    this.hud.upgradeReplaceCheck.checked = false;
    this.hud.upgradeConfirmButton.disabled = true;
    this.hud.upgradeStage.textContent = `STAGE ${String(this.stage + 1).padStart(2, '0')}`;
    this.hud.upgradeReels.classList.add('rolling');
    this.hud.upgradeScreen.classList.remove('hidden');
    this.hud.itemCards.forEach((card, index) => this.populateItemCard(card, this.upgradeOffers[index]));
    this.itemPreviews.show(this.upgradeOffers);
    window.setTimeout(() => this.hud.upgradeReels.classList.remove('rolling'), 620);
    if (document.pointerLockElement === this.renderer.domElement) void document.exitPointerLock();
  }

  private populateItemCard(card: HTMLButtonElement, offer: ItemOffer | undefined): void {
    if (!offer) {
      card.disabled = true;
      return;
    }
    card.disabled = false;
    const { definition } = offer;
    card.className = `item-card category-${definition.category} status-${offer.status.toLowerCase()}`;
    card.setAttribute('aria-pressed', 'false');
    card.classList.toggle('will-replace', Boolean(offer.replacedItem));
    card.classList.toggle('is-upgrade', offer.status === 'UPGRADE');
    card.style.setProperty('--item-color', definition.color);
    const category = card.querySelector<HTMLElement>('.item-category');
    const status = card.querySelector<HTMLElement>('.item-status');
    const name = card.querySelector<HTMLElement>('.item-name');
    const level = card.querySelector<HTMLElement>('.item-level');
    const description = card.querySelector<HTMLElement>('.item-description');
    const stats = card.querySelector<HTMLElement>('.item-stats');
    const replace = card.querySelector<HTMLElement>('.item-replace');
    if (category) category.textContent = definition.category.toUpperCase();
    if (status) {
      status.textContent = offer.status === 'NEW'
        ? 'NEW'
        : offer.status === 'UPGRADE'
          ? 'UPGRADE'
          : offer.status === 'REPLACE'
            ? 'REPLACE'
            : 'USE';
    }
    if (name) name.textContent = definition.name;
    if (level) level.textContent = definition.maxLevel === 0 ? 'ONE SHOT' : `LV.${offer.nextLevel}`;
    if (description) description.textContent = definition.description;
    if (stats) this.renderItemStats(stats, this.items.getOfferStatComparisons(offer));
    if (replace) {
      replace.textContent = offer.replacedItem
        ? `REPLACE // ${offer.replacedItem.name}`
        : definition.slot === 'primary'
          ? 'PRIMARY // RMB'
          : definition.slot === 'secondary'
            ? 'SECONDARY'
            : definition.slot === 'equipment'
              ? 'EQUIPMENT // ONE SLOT'
              : 'PASSIVE // STACKABLE';
    }
  }

  private renderItemStats(host: HTMLElement, comparisons: ItemStatComparison[]): void {
    host.replaceChildren();
    for (const comparison of comparisons) {
      const row = document.createElement('div');
      const improved = comparison.lowerIsBetter
        ? comparison.next < comparison.current
        : comparison.next > comparison.current;
      row.className = `item-stat-box ${comparison.loss ? 'loss' : improved ? 'gain' : 'steady'}`;
      const header = document.createElement('div');
      header.className = 'item-stat-head';
      const label = document.createElement('span');
      label.textContent = comparison.label;
      const value = document.createElement('strong');
      const format = (amount: number): string => amount.toFixed(comparison.decimals ?? 0);
      value.textContent = `${format(comparison.current)}${comparison.unit} → ${format(comparison.next)}${comparison.unit}`;
      header.append(label, value);
      const track = document.createElement('div');
      track.className = 'item-stat-track';
      const ceiling = Math.max(0.001, comparison.max, comparison.current, comparison.next);
      const before = document.createElement('i');
      before.className = 'item-stat-before';
      before.style.width = `${clamp(comparison.current / ceiling, 0, 1) * 100}%`;
      const after = document.createElement('i');
      after.className = 'item-stat-after';
      after.style.width = `${clamp(comparison.next / ceiling, 0, 1) * 100}%`;
      track.append(before, after);
      row.append(header, track);
      host.append(row);
    }
  }

  private previewUpgradeSelection(index: number): void {
    if (this.mode !== 'upgrade') return;
    const offer = this.upgradeOffers[index];
    if (!offer) return;
    this.selectedUpgradeIndex = index;
    this.hud.itemCards.forEach((card, cardIndex) => {
      const selected = cardIndex === index;
      card.classList.toggle('selected', selected);
      card.setAttribute('aria-pressed', String(selected));
    });
    this.hud.upgradeConfirmBar.classList.remove('hidden');
    this.hud.upgradeConfirmEyebrow.textContent = offer.status === 'REPLACE'
      ? 'LOADOUT CHANGE SELECTED'
      : `${offer.status} SELECTED`;
    this.hud.upgradeConfirmName.textContent = offer.definition.name;
    this.hud.upgradeConfirmSummary.textContent = offer.definition.description;
    this.hud.upgradeReplaceCheck.checked = false;
    const requiresWarning = Boolean(offer.replacedItem);
    this.hud.upgradeReplaceWarning.classList.toggle('hidden', !requiresWarning);
    this.hud.upgradeConfirmButton.disabled = requiresWarning;
    this.hud.upgradeConfirmButton.textContent = requiresWarning ? 'ACKNOWLEDGE & EQUIP' : 'CONFIRM LOADOUT';
    if (offer.replacedItem) {
      this.hud.upgradeReplaceText.textContent = `현재 장비 [${offer.replacedItem.name}] → [${offer.definition.name}]. 교체에 동의합니다.`;
    } else this.hud.upgradeReplaceText.textContent = '';
  }

  private getStageScoreGate(stage: number): number {
    const intervalCount = Math.max(1, Math.floor(stage));
    return intervalCount * CONFIG.stageScoreBase
      + CONFIG.stageScoreGrowth * intervalCount * (intervalCount - 1) * 0.5;
  }

  private selectUpgrade(index: number): void {
    if (this.mode !== 'upgrade') return;
    const offer = this.upgradeOffers[index];
    if (!offer) return;
    if (this.selectedUpgradeIndex !== index) return;
    if (offer.replacedItem && !this.hud.upgradeReplaceCheck.checked) return;
    const result = this.items.applyOffer(offer);
    const previousMaxHealth = this.maxHealth;
    this.maxHealth = CONFIG.playerBaseHealth
      + this.items.getPermanentHealthBonus()
      + this.items.getEquipmentHealthBonus();
    const armorCapacityHeal = result.definition.id === 'armor'
      ? Math.max(0, this.maxHealth - previousMaxHealth)
      : 0;
    const previousHealth = this.health;
    this.health = clamp(this.health + result.instantHeal + armorCapacityHeal, 0, this.maxHealth);
    const restoredHealth = Math.max(0, this.health - previousHealth);
    this.stage += 1;
    this.nextStageScore = this.getStageScoreGate(this.stage);
    this.invulnerabilityTimer = CONFIG.stageTransitionDuration;
    this.autoGlideTimer = CONFIG.stageTransitionDuration;
    this.primaryCooldown = 0;
    this.secondaryCooldown = 0;
    this.mode = 'playing';
    this.hud.upgradeScreen.classList.add('hidden');
    this.hud.upgradeConfirmBar.classList.add('hidden');
    this.selectedUpgradeIndex = null;
    this.itemPreviews.hide();
    this.updateInventoryHud();
    this.audio.setIntermission(false);
    this.audio.setPaused(false);
    this.audio.resume();
    const launch = this.cameraForward.clone();
    launch.y = clamp(launch.y, 0.08, 0.35);
    if (launch.lengthSq() < 0.01) launch.set(0, 0.12, -1);
    launch.normalize().multiplyScalar(31 * this.items.getSpeedMultiplier());
    this.playerBody.setLinvel({ x: launch.x, y: launch.y, z: launch.z }, true);
    this.showToast(`STAGE ${String(this.stage).padStart(2, '0')}\n${result.definition.name}`, 'positive');
    if (restoredHealth > 0) {
      this.showItemProc(
        'heal',
        result.instantMaxHealth > 0 ? '최대 체력 확장' : '체력 회복',
        `+${Math.round(restoredHealth)} HP`,
        [result.definition.id],
      );
    }
    this.requestPlayLock();
  }

  private updateInventoryHud(): void {
    this.hud.inventoryBar.replaceChildren();
    for (const item of this.items.getOwnedItems()) {
      const icon = document.createElement('div');
      icon.className = `inventory-item category-${item.definition.category}`;
      icon.dataset.itemId = item.definition.id;
      icon.style.setProperty('--item-color', item.definition.color);
      icon.title = `${item.definition.name} LV.${item.level}`;
      icon.innerHTML = `<span class="inventory-name">${item.definition.name}</span><b class="inventory-level"><small>LEVEL</small>${item.level}</b>`;
      this.hud.inventoryBar.append(icon);
    }
  }

  private beginRun(): void {
    this.mode = 'playing';
    this.resetTouchControls();
    this.stats = this.blankStats();
    this.elapsedTime = 0;
    this.itemGlideFeedbackTimer = 0;
    this.itemSpeedFeedbackTimer = 0;
    this.itemGliding = false;
    this.itemSpeedActive = false;
    this.hud.itemProcLayer.replaceChildren();
    this.hud.itemProcLayer.classList.remove('glide-active', 'wash-active');
    if (this.itemProcWashTimeout !== null) window.clearTimeout(this.itemProcWashTimeout);
    this.itemProcWashTimeout = null;
    this.stage = 1;
    this.nextStageScore = this.getStageScoreGate(1);
    this.items.reset();
    this.maxHealth = CONFIG.playerBaseHealth;
    this.health = this.maxHealth;
    this.invulnerabilityTimer = 1.25;
    this.autoGlideTimer = 0;
    this.primaryCooldown = 0;
    this.secondaryCooldown = 0;
    this.rightHeld = false;
    this.stamina = 100;
    this.physicsAccumulator = 0;
    this.groundRunPhase = 0;
    this.groundRunBlend = 0;
    this.targets.reset();
    this.drones.reset();
    while (this.playerProjectiles.length > 0) this.removePlayerProjectile(this.playerProjectiles.length - 1);
    this.resetPlayer();
    this.audio.setIntermission(false);
    this.audio.resume();
    this.tryDash(true);
    this.updateInventoryHud();
    this.itemPreviews.hide();
    this.hud.upgradeScreen.classList.add('hidden');
    this.hud.results.classList.add('hidden');
    this.hud.menu.classList.add('hidden');
  }

  private finishRun(): void {
    this.mode = 'over';
    this.rightHeld = false;
    this.resetTouchControls();
    this.audio.setIntermission(false);
    this.audio.setPaused(true);
    this.dashTimeRemaining = 0;
    this.detach();
    const accuracy = this.stats.shots > 0 ? Math.round((this.stats.hits / this.stats.shots) * 100) : 0;
    const isRecord = this.stats.score > this.bestScore;
    if (isRecord) {
      this.bestScore = this.stats.score;
      try {
        localStorage.setItem('neon-tether-best', String(this.bestScore));
      } catch {
        // Local storage can be unavailable in privacy-restricted browser contexts.
      }
    }

    this.hud.resultScore.textContent = this.stats.score.toLocaleString('ko-KR');
    this.hud.resultAccuracy.textContent = `${accuracy}%`;
    this.hud.resultCombo.textContent = `x${this.stats.bestCombo}`;
    this.hud.resultSpeed.textContent = `${Math.round(this.stats.topSpeed * 3.6)} km/h`;
    this.hud.resultFalls.textContent = String(this.stats.falls);
    this.hud.resultTime.textContent = this.formatElapsedTime(this.elapsedTime);
    this.hud.recordLabel.textContent = isRecord ? 'NEW PERSONAL RECORD' : `BEST ${this.bestScore.toLocaleString('ko-KR')}`;
    this.hud.recordLabel.classList.toggle('new-record', isRecord);
    this.hud.results.classList.remove('hidden');
    if (document.pointerLockElement === this.renderer.domElement) void document.exitPointerLock();
  }

  private resetPlayer(): void {
    this.detach();
    this.dashTimeRemaining = 0;
    this.dashDuration = 0;
    this.dashSpeed = 0;
    for (const jet of this.dashJets) jet.visible = false;
    this.yaw = 0;
    this.pitch = -0.05;
    this.peakFallSpeed = 0;
    this.landingTimer = 0;
    this.landingIntensity = 0;
    this.playerBody.setTranslation({ x: 0, y: 18, z: 30 }, true);
    this.playerBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.playerBody.resetForces(true);
    this.playerBody.resetTorques(true);
    this.playerPosition.set(0, 18, 30);
  }

  private bindEvents(): void {
    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.setPixelRatio(this.currentPixelRatio);
    });

    document.addEventListener('mousemove', (event) => {
      if (document.pointerLockElement !== this.renderer.domElement) return;
      this.yaw -= event.movementX * 0.0018;
      this.pitch = clamp(this.pitch - event.movementY * 0.00165, -1.43, 1.38);
    });

    document.addEventListener('mousedown', (event) => {
      if (document.pointerLockElement !== this.renderer.domElement) return;
      this.audio.resume();
      if (event.button === 0) {
        this.leftHeld = true;
        this.tryAttach();
      }
      if (event.button === 2) {
        this.rightHeld = true;
        this.shoot();
      }
    });

    document.addEventListener('mouseup', (event) => {
      if (event.button === 0) this.detach();
      if (event.button === 2) this.rightHeld = false;
    });

    document.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener('keydown', (event) => {
      if (
        import.meta.env.DEV
        && event.shiftKey
        && event.code === 'KeyT'
        && !event.repeat
      ) {
        event.preventDefault();
        this.togglePerformancePanel();
      }
      if (
        this.mode === 'playing'
        && document.pointerLockElement === this.renderer.domElement
      ) this.audio.resume();
      this.keys.add(event.code);
      if (event.code === 'Space') event.preventDefault();
      if (event.code === 'KeyQ' && !event.repeat) this.tryDash();
      if (event.code === 'Space' && !event.repeat) this.tryJumpBoost();
      if (
        import.meta.env.DEV
        && event.code === 'KeyU'
        && !event.repeat
        && (this.mode === 'playing' || this.mode === 'paused')
      ) {
        if (this.mode === 'paused') {
          this.mode = 'playing';
          this.hud.menu.classList.add('hidden');
        }
        this.stats.score = this.nextStageScore;
        this.enterUpgradeSelection();
      }
      if (event.code === 'KeyR' && document.pointerLockElement === this.renderer.domElement) this.beginRun();
    });
    document.addEventListener('keyup', (event) => this.keys.delete(event.code));

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.renderer.domElement;
      if (locked) {
        if (this.mode === 'paused') this.mode = 'playing';
        this.audio.setPaused(false);
        this.hud.menu.classList.add('hidden');
        return;
      }
      this.keys.clear();
      this.leftHeld = false;
      this.rightHeld = false;
      if (this.mode === 'playing') {
        this.mode = 'paused';
        this.audio.setPaused(true);
        this.detach();
        this.showPauseMenu();
      }
    });

    this.hud.menuButton.addEventListener('pointerdown', () => this.audio.resume());
    this.hud.replayButton.addEventListener('pointerdown', () => this.audio.resume());

    this.hud.menuButton.addEventListener('click', () => {
      this.audio.resume();
      if (this.mode === 'ready') this.beginRun();
      this.requestPlayLock();
    });
    this.hud.replayButton.addEventListener('click', () => {
      this.beginRun();
      this.requestPlayLock();
    });
    this.hud.itemCards.forEach((card, index) => {
      card.addEventListener('click', () => this.previewUpgradeSelection(index));
    });
    this.hud.upgradeReplaceCheck.addEventListener('change', () => {
      const offer = this.selectedUpgradeIndex === null
        ? undefined
        : this.upgradeOffers[this.selectedUpgradeIndex];
      this.hud.upgradeConfirmButton.disabled = Boolean(offer?.replacedItem)
        && !this.hud.upgradeReplaceCheck.checked;
    });
    this.hud.upgradeConfirmButton.addEventListener('click', () => {
      if (this.selectedUpgradeIndex !== null) this.selectUpgrade(this.selectedUpgradeIndex);
    });

    if (this.touchControlsEnabled) this.bindTouchControls();
  }

  private requestPlayLock(): void {
    if (this.touchControlsEnabled) {
      if (this.mode === 'paused') this.mode = 'playing';
      this.audio.setPaused(false);
      this.hud.menu.classList.add('hidden');
      return;
    }
    this.renderer.domElement.requestPointerLock().catch(() => {
      if (this.mode !== 'playing') return;
      this.mode = 'paused';
      this.audio.setPaused(true);
      this.detach();
      this.showPauseMenu();
    });
  }

  private showPauseMenu(): void {
    this.hud.menuEyebrow.textContent = 'RUN PAUSED';
    this.hud.menuTitle.textContent = 'PAUSE';
    this.hud.menuTagline.textContent = '도시는 기다린다. 준비되면 다시 흐름에 올라타자.';
    this.hud.menuButton.textContent = '계속하기';
    this.hud.menu.classList.remove('hidden');
  }

  private bindTouchControls(): void {
    const joystick = requiredElement('touchJoystick');
    const joystickKnob = requiredElement('touchJoystickKnob');
    const lookZone = requiredElement('touchLookZone');
    const grappleButton = requiredElement<HTMLButtonElement>('touchGrapple');
    const fireButton = requiredElement<HTMLButtonElement>('touchFire');
    const dashButton = requiredElement<HTMLButtonElement>('touchDash');
    const jumpButton = requiredElement<HTMLButtonElement>('touchJump');
    const pauseButton = requiredElement<HTMLButtonElement>('touchPause');

    const setMoveKey = (code: string, active: boolean): void => {
      if (active) this.keys.add(code);
      else this.keys.delete(code);
    };

    const updateJoystick = (event: PointerEvent): void => {
      const bounds = joystick.getBoundingClientRect();
      const radius = Math.min(bounds.width, bounds.height) * 0.31;
      const rawX = event.clientX - (bounds.left + bounds.width * 0.5);
      const rawY = event.clientY - (bounds.top + bounds.height * 0.5);
      const length = Math.hypot(rawX, rawY);
      const scale = length > radius ? radius / length : 1;
      const x = rawX * scale;
      const y = rawY * scale;
      const normalizedX = x / radius;
      const normalizedY = y / radius;
      const threshold = 0.24;
      joystickKnob.style.setProperty('--stick-x', `${x.toFixed(1)}px`);
      joystickKnob.style.setProperty('--stick-y', `${y.toFixed(1)}px`);
      setMoveKey('KeyA', normalizedX < -threshold);
      setMoveKey('KeyD', normalizedX > threshold);
      setMoveKey('KeyW', normalizedY < -threshold);
      setMoveKey('KeyS', normalizedY > threshold);
    };

    joystick.addEventListener('pointerdown', (event) => {
      if (this.mode !== 'playing' || this.touchMovePointerId !== null) return;
      event.preventDefault();
      this.touchMovePointerId = event.pointerId;
      joystick.setPointerCapture(event.pointerId);
      joystick.classList.add('active');
      updateJoystick(event);
    });
    joystick.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this.touchMovePointerId) return;
      event.preventDefault();
      updateJoystick(event);
    });
    const releaseJoystick = (event: PointerEvent): void => {
      if (event.pointerId !== this.touchMovePointerId) return;
      this.touchMovePointerId = null;
      this.clearTouchMovement();
    };
    joystick.addEventListener('pointerup', releaseJoystick);
    joystick.addEventListener('pointercancel', releaseJoystick);
    joystick.addEventListener('lostpointercapture', releaseJoystick);

    lookZone.addEventListener('pointerdown', (event) => {
      if (this.mode !== 'playing' || this.touchLookPointerId !== null) return;
      event.preventDefault();
      this.touchLookPointerId = event.pointerId;
      this.touchLookX = event.clientX;
      this.touchLookY = event.clientY;
      lookZone.setPointerCapture(event.pointerId);
      lookZone.classList.add('active');
    });
    lookZone.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this.touchLookPointerId) return;
      event.preventDefault();
      const movementX = event.clientX - this.touchLookX;
      const movementY = event.clientY - this.touchLookY;
      this.touchLookX = event.clientX;
      this.touchLookY = event.clientY;
      this.yaw -= movementX * 0.004;
      this.pitch = clamp(this.pitch - movementY * 0.0036, -1.43, 1.38);
    });
    const releaseLook = (event: PointerEvent): void => {
      if (event.pointerId !== this.touchLookPointerId) return;
      this.touchLookPointerId = null;
      lookZone.classList.remove('active');
    };
    lookZone.addEventListener('pointerup', releaseLook);
    lookZone.addEventListener('pointercancel', releaseLook);
    lookZone.addEventListener('lostpointercapture', releaseLook);

    const bindHoldButton = (
      button: HTMLButtonElement,
      onPress: () => void,
      onRelease: () => void,
    ): void => {
      let pointerId: number | null = null;
      button.addEventListener('pointerdown', (event) => {
        if (this.mode !== 'playing' || pointerId !== null) return;
        event.preventDefault();
        event.stopPropagation();
        pointerId = event.pointerId;
        button.setPointerCapture(event.pointerId);
        button.classList.add('active');
        this.audio.resume();
        onPress();
      });
      const release = (event: PointerEvent): void => {
        if (event.pointerId !== pointerId) return;
        pointerId = null;
        button.classList.remove('active');
        onRelease();
      };
      button.addEventListener('pointerup', release);
      button.addEventListener('pointercancel', release);
      button.addEventListener('lostpointercapture', release);
    };

    bindHoldButton(
      grappleButton,
      () => {
        this.leftHeld = true;
        this.tryAttach();
      },
      () => this.detach(),
    );
    bindHoldButton(
      fireButton,
      () => {
        this.rightHeld = true;
        this.shoot();
      },
      () => { this.rightHeld = false; },
    );
    bindHoldButton(dashButton, () => this.tryDash(), () => undefined);
    bindHoldButton(jumpButton, () => this.tryJumpBoost(), () => undefined);

    pauseButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.pauseTouchRun();
    });
    window.addEventListener('blur', () => this.pauseTouchRun());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.pauseTouchRun();
    });
  }

  private clearTouchMovement(): void {
    this.keys.delete('KeyW');
    this.keys.delete('KeyA');
    this.keys.delete('KeyS');
    this.keys.delete('KeyD');
    const joystick = document.getElementById('touchJoystick');
    const knob = document.getElementById('touchJoystickKnob');
    joystick?.classList.remove('active');
    knob?.style.setProperty('--stick-x', '0px');
    knob?.style.setProperty('--stick-y', '0px');
  }

  private resetTouchControls(): void {
    if (!this.touchControlsEnabled) return;
    this.touchMovePointerId = null;
    this.touchLookPointerId = null;
    this.leftHeld = false;
    this.rightHeld = false;
    this.clearTouchMovement();
    document.getElementById('touchLookZone')?.classList.remove('active');
    document.querySelectorAll('.touch-action.active').forEach((element) => element.classList.remove('active'));
  }

  private pauseTouchRun(): void {
    if (!this.touchControlsEnabled || this.mode !== 'playing') return;
    this.resetTouchControls();
    this.mode = 'paused';
    this.audio.setPaused(true);
    this.detach();
    this.showPauseMenu();
  }

  private updateEffects(dt: number): void {
    this.shake = THREE.MathUtils.damp(this.shake, 0, 9, dt);
    this.dashFx = this.dashTimeRemaining > 0
      ? 1
      : THREE.MathUtils.damp(this.dashFx, 0, 4.2, dt);
    this.flashLife -= dt;
    this.muzzleFlash.visible = this.flashLife > 0;
    this.muzzleFlash.material.opacity = clamp(this.flashLife / 0.045, 0, 1);
    if (this.flashLife > 0) {
      this.rightMuzzle.getWorldPosition(this.muzzleFlash.position);
      this.muzzleFlash.scale.setScalar(1 + Math.random() * 2.4);
    }

    this.tracerLife -= dt;
    const tracerMaterial = this.tracer.material as THREE.LineBasicMaterial;
    tracerMaterial.opacity = clamp(this.tracerLife / 0.08, 0, 0.9);
    this.tracer.visible = this.tracerLife > 0;

    this.toastTimer -= dt;
    if (this.toastTimer <= 0) this.hud.toast.classList.remove('show');
    this.damageTimer -= dt;
    this.impactTimer -= dt;
    this.hud.vignette.classList.toggle('damage', this.damageTimer > 0);
    this.hud.vignette.classList.toggle('impact', this.impactTimer > 0);
    this.hud.vignette.classList.toggle(
      'critical',
      this.mode === 'playing' && this.health / Math.max(1, this.maxHealth) <= 0.25,
    );
    this.updateItemActivityFeedback(dt);
  }

  private updateItemActivityFeedback(dt: number): void {
    this.itemGlideFeedbackTimer = Math.max(0, this.itemGlideFeedbackTimer - dt);
    this.itemSpeedFeedbackTimer = Math.max(0, this.itemSpeedFeedbackTimer - dt);
    const velocity = this.playerBody.linvel();
    const gravityCut = this.items.getGravityCutReduction();
    const wingsuitCut = this.items.getWingsuitGravityReduction();
    const totalGlideCut = Math.min(0.52, gravityCut + wingsuitCut);
    const gliding = this.mode === 'playing'
      && !this.isGrounded
      && !this.grappleAnchor
      && this.dashTimeRemaining <= 0
      && velocity.y <= 1.5
      && totalGlideCut > 0;
    this.hud.itemProcLayer.classList.toggle('glide-active', gliding);
    if (gliding && (!this.itemGliding || this.itemGlideFeedbackTimer <= 0)) {
      const contributors: string[] = [];
      if (gravityCut > 0) contributors.push('gravity_cut');
      if (wingsuitCut > 0) contributors.push('wingsuit');
      this.showItemProc(
        'glide',
        wingsuitCut > 0 ? '활공 보조' : '반중력 가동',
        `GRAVITY -${Math.round(totalGlideCut * 100)}%`,
        contributors,
      );
      this.itemGlideFeedbackTimer = 4.6;
    }
    this.itemGliding = gliding;

    const speedBonus = this.items.getSpeedBonus();
    const hasMoveInput = this.keys.has('KeyW') || this.keys.has('KeyA')
      || this.keys.has('KeyS') || this.keys.has('KeyD');
    const speedActive = this.mode === 'playing' && hasMoveInput && speedBonus > 0;
    if (speedActive && (!this.itemSpeedActive || this.itemSpeedFeedbackTimer <= 0)) {
      this.showItemProc(
        'speed',
        '신경 가속',
        `MOVE SPEED +${Math.round(speedBonus * 100)}%`,
        ['speed_boost'],
      );
      this.itemSpeedFeedbackTimer = 5.2;
    }
    this.itemSpeedActive = speedActive;
  }

  private showTracer(start: THREE.Vector3, end: THREE.Vector3): void {
    const positions = this.tracerGeometry.attributes.position as THREE.BufferAttribute;
    positions.setXYZ(0, start.x, start.y, start.z);
    positions.setXYZ(1, end.x, end.y, end.z);
    positions.needsUpdate = true;
    this.tracerGeometry.computeBoundingSphere();
    this.tracerLife = 0.08;
    this.tracer.visible = true;
  }

  private showDamageNumber(
    position: THREE.Vector3,
    damage: number,
    quality: AimQuality,
    destroyed: boolean,
  ): void {
    this.damageProjection.copy(position).project(this.camera);
    if (
      this.damageProjection.z < -1
      || this.damageProjection.z > 1
      || Math.abs(this.damageProjection.x) > 1.15
      || Math.abs(this.damageProjection.y) > 1.15
    ) return;
    const number = document.createElement('div');
    number.className = `damage-number ${quality} ${destroyed ? 'destroyed' : ''}`;
    number.style.left = `${(this.damageProjection.x * 0.5 + 0.5) * 100}%`;
    number.style.top = `${clamp((-this.damageProjection.y * 0.5 + 0.5) * 100 - 6.5, 6, 88)}%`;
    number.style.setProperty('--damage-drift', `${(Math.random() - 0.5) * 34}px`);
    number.innerHTML = `<strong>-${Math.max(1, Math.round(damage))}</strong><span>${destroyed ? 'BREAK' : quality === 'perfect' ? 'DIRECT' : 'GRAZE'}</span>`;
    this.hud.damageNumbers.append(number);
    window.setTimeout(() => number.remove(), 720);
  }

  private showItemProc(
    kind: 'defense' | 'glide' | 'heal' | 'siphon' | 'speed' | 'boost',
    title: string,
    detail: string,
    itemIds: string[],
  ): void {
    const procColors: Record<typeof kind, string> = {
      defense: '75, 192, 255',
      glide: '190, 199, 207',
      heal: '67, 255, 153',
      siphon: '255, 76, 148',
      speed: '255, 218, 74',
      boost: '255, 147, 55',
    };
    this.hud.itemProcLayer.style.setProperty('--proc-rgb', procColors[kind]);
    this.hud.itemProcLayer.classList.remove('wash-active');
    void this.hud.itemProcLayer.offsetWidth;
    this.hud.itemProcLayer.classList.add('wash-active');
    if (this.itemProcWashTimeout !== null) window.clearTimeout(this.itemProcWashTimeout);
    this.itemProcWashTimeout = window.setTimeout(() => {
      this.hud.itemProcLayer.classList.remove('wash-active');
      this.itemProcWashTimeout = null;
    }, 780);
    while (this.hud.itemProcLayer.childElementCount >= 3) {
      this.hud.itemProcLayer.firstElementChild?.remove();
    }
    const proc = document.createElement('div');
    proc.className = `item-proc ${kind}`;
    const eyebrow = document.createElement('span');
    eyebrow.textContent = kind === 'heal' ? 'RECOVERY TRIGGER' : kind === 'siphon' ? 'COUNTER TRIGGER' : 'PASSIVE TRIGGER';
    const heading = document.createElement('strong');
    heading.textContent = title;
    const stats = document.createElement('em');
    stats.textContent = detail;
    proc.append(eyebrow, heading, stats);
    this.hud.itemProcLayer.append(proc);
    for (const itemId of itemIds) {
      for (const item of this.hud.inventoryBar.querySelectorAll<HTMLElement>('.inventory-item')) {
        if (item.dataset.itemId !== itemId) continue;
        item.classList.remove('proc-active');
        void item.offsetWidth;
        item.classList.add('proc-active');
        window.setTimeout(() => item.classList.remove('proc-active'), 850);
      }
    }
    window.setTimeout(() => proc.remove(), 1750);
  }

  private showToast(message: string, kind: 'positive' | 'negative'): void {
    const [primary, ...detailParts] = message.split('\n');
    const detail = detailParts.join(' ');
    const bomb = message.includes('BOMB');
    const boost = message.includes('GAS BURST');
    const badge = kind === 'negative'
      ? 'WARNING!'
      : message.includes('GOLD')
        ? 'JACKPOT!'
        : message.includes('CENTER')
          ? 'CRITICAL!'
          : message.includes('GAS')
            ? 'BOOST!'
            : bomb
              ? 'PERFECT!'
              : 'BREAK!';
    const badgeElement = this.hud.toast.querySelector<HTMLElement>('.toast-badge');
    const pointsElement = this.hud.toast.querySelector<HTMLElement>('.toast-points');
    const detailElement = this.hud.toast.querySelector<HTMLElement>('.toast-detail');
    if (badgeElement) badgeElement.textContent = badge;
    if (pointsElement) pointsElement.textContent = primary;
    if (detailElement) detailElement.textContent = detail;
    this.hud.toast.classList.remove('show', 'positive', 'negative', 'bomb', 'boost');
    this.hud.hitFlash.classList.remove('show', 'positive', 'negative', 'bomb');
    void this.hud.toast.offsetWidth;
    void this.hud.hitFlash.offsetWidth;
    this.hud.toast.classList.add('show', kind);
    this.hud.hitFlash.classList.add('show', kind);
    if (bomb) {
      this.hud.toast.classList.add('bomb');
      this.hud.hitFlash.classList.add('bomb');
    }
    if (boost) this.hud.toast.classList.add('boost');
    this.hud.score.classList.remove('score-punch');
    void this.hud.score.offsetWidth;
    this.hud.score.classList.add('score-punch');
    window.setTimeout(() => {
      this.hud.hitFlash.classList.remove('show', 'positive', 'negative', 'bomb');
      this.hud.score.classList.remove('score-punch');
    }, 520);
    this.toastTimer = 0.9;
  }

  private punchCombo(): void {
    this.hud.combo.classList.remove('punch');
    void this.hud.combo.offsetWidth;
    this.hud.combo.classList.add('punch');
    window.setTimeout(() => this.hud.combo.classList.remove('punch'), 190);
  }

  private updateHud(): void {
    const velocity = this.playerBody.linvel();
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    this.hud.score.textContent = this.stats.score.toLocaleString('ko-KR').padStart(6, '0');
    this.hud.timer.textContent = this.formatElapsedTime(this.elapsedTime);
    this.hud.stage.textContent = `STAGE ${String(this.stage).padStart(2, '0')}`;
    const healthRatio = clamp(this.health / Math.max(1, this.maxHealth), 0, 1);
    this.hud.healthFill.style.transform = `scaleX(${healthRatio})`;
    this.hud.healthValue.textContent = `${Math.ceil(this.health)} / ${Math.round(this.maxHealth)}`;
    this.hud.healthMeter.classList.toggle('critical', healthRatio <= 0.25);
    this.hud.healthMeter.classList.toggle('invulnerable', this.invulnerabilityTimer > 0);
    this.hud.comboValue.textContent = `x${this.stats.combo}`;
    this.hud.multiplier.textContent = `${this.comboMultiplier().toFixed(2)} MULTI`;
    this.hud.speed.textContent = String(Math.round(speed * 3.6));
    this.hud.statSpeed.textContent = `x${this.items.getSpeedMultiplier().toFixed(2)}`;
    this.hud.statGravity.textContent = `x${this.items.getGravityMultiplier(false).toFixed(2)}`;
    this.hud.statDefense.textContent = `x${(1 - this.items.getDamageReduction()).toFixed(2)}`;
    this.hud.statDash.textContent = `x${this.items.getDashMultiplier().toFixed(2)}`;
    this.hud.staminaFill.style.transform = `scaleX(${this.stamina / 100})`;
    this.hud.staminaValue.textContent = `${Math.round(this.stamina)}%`;
    const dashReady = this.stamina >= CONFIG.dashMinimumStamina;
    this.hud.staminaMeter.classList.toggle('low', !dashReady);
    this.hud.staminaMeter.classList.toggle('ready', dashReady);
    this.hud.ropeState.textContent = this.grappleAnchor
      ? `TETHER // REEL ${Math.round(this.ropeReelCharge * 100)}%`
      : 'TETHER // FREE';
    this.hud.ropeState.classList.toggle('active', this.grappleAnchor !== null);
    this.hud.anchorReadout.textContent = this.grappleAnchor ? 'ANCHOR LOCKED' : 'ASSIST ANCHOR';
    this.hud.anchorReadout.classList.toggle('visible', this.grappleAnchor !== null || this.hasCandidateAnchor);
    const speedIntensity = clamp((speed - 12) / 42, 0, 1);
    const edgeIntensity = clamp(speedIntensity * 0.72 + this.dashFx * 0.86, 0, 1);
    this.hud.speedLines.style.opacity = String(edgeIntensity * 0.9);
    this.hud.speedLines.style.setProperty(
      '--ray-duration',
      `${Math.max(0.1, 0.34 - edgeIntensity * 0.16 - this.dashFx * 0.08).toFixed(2)}s`,
    );
    this.hud.speedLines.classList.toggle('dash', this.dashFx > 0.12);
  }

  private formatElapsedTime(seconds: number): string {
    const wholeSeconds = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(wholeSeconds / 60);
    return `${String(minutes).padStart(2, '0')}:${String(wholeSeconds % 60).padStart(2, '0')}`;
  }

  private comboMultiplier(): number {
    return Math.min(3, 1 + Math.floor(this.stats.combo / 5) * 0.25);
  }

  private addEnvironment(): void {
    const hemisphere = new THREE.HemisphereLight(0xe8f4ff, 0xa29278, 2.75);
    this.scene.add(hemisphere);
    const ambient = new THREE.AmbientLight(0xffead0, 0.82);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffd19a, 3.45);
    sun.position.set(-115, 165, -70);
    this.scene.add(sun);
    const skyFill = new THREE.DirectionalLight(0xb9dbef, 1.05);
    skyFill.position.set(95, 90, 120);
    this.scene.add(skyFill);
  }

  private createSkyTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the procedural daylight sky.');
    const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
    gradient.addColorStop(0, '#5f93bb');
    gradient.addColorStop(0.48, '#a9cbdc');
    gradient.addColorStop(0.78, '#ead7b7');
    gradient.addColorStop(1, '#f3c989');
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    return texture;
  }

  private createWeaponRig(): void {
    const dark = new THREE.MeshStandardMaterial({ color: 0x101626, roughness: 0.3, metalness: 0.86 });
    const cyan = new THREE.MeshBasicMaterial({ color: 0x4ef6ff });
    const pink = new THREE.MeshBasicMaterial({ color: 0xff3d78 });
    const jetMaterial = new THREE.MeshBasicMaterial({
      color: 0xc8fbff,
      transparent: true,
      opacity: 0.62,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const left = new THREE.Group();
    left.name = 'left-device';
    left.position.set(-0.46, -0.34, -0.66);
    left.rotation.set(-0.08, 0.08, -0.08);
    const leftBody = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.52), dark);
    left.add(leftBody);
    const spool = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.1, 12), cyan);
    spool.rotation.z = Math.PI / 2;
    spool.position.set(0, 0.03, -0.04);
    left.add(spool);
    const leftBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.055, 0.42, 8), dark);
    leftBarrel.rotation.x = Math.PI / 2;
    leftBarrel.position.z = -0.34;
    left.add(leftBarrel);
    this.leftMuzzle.position.set(0, 0, -0.56);
    left.add(this.leftMuzzle);

    const right = new THREE.Group();
    right.name = 'right-device';
    right.position.set(0.46, -0.34, -0.64);
    right.rotation.set(-0.05, -0.08, 0.06);
    const rightBody = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.22, 0.55), dark);
    right.add(rightBody);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.07, 0.46, 8), dark);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = -0.38;
    right.add(barrel);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.045, 0.2), pink);
    sight.position.set(0, 0.13, -0.13);
    right.add(sight);
    this.rightMuzzle.position.set(0, 0, -0.62);
    right.add(this.rightMuzzle);

    for (const x of [-0.45, 0.45]) {
      const jet = new THREE.Mesh(
        new THREE.CylinderGeometry(0.025, 0.13, 1.08, 7, 1, true),
        jetMaterial.clone(),
      );
      jet.position.set(x, -0.31, -0.2);
      jet.rotation.x = -Math.PI / 2;
      jet.rotation.z = x < 0 ? -0.08 : 0.08;
      jet.visible = false;
      jet.frustumCulled = false;
      this.dashJets.push(jet);
      this.weaponRig.add(jet);
    }

    this.weaponRig.add(left, right);
    this.camera.add(this.weaponRig);
  }

  private collectHud(): HudElements {
    return {
      score: requiredElement('scoreValue'),
      timer: requiredElement('timerValue'),
      stage: requiredElement('stageValue'),
      healthMeter: requiredElement('healthMeter'),
      healthFill: requiredElement('healthFill'),
      healthValue: requiredElement('healthValue'),
      combo: requiredElement('combo'),
      comboValue: requiredElement('comboValue'),
      multiplier: requiredElement('multiplier'),
      speed: requiredElement('speedValue'),
      statSpeed: requiredElement('statSpeed'),
      statGravity: requiredElement('statGravity'),
      statDefense: requiredElement('statDefense'),
      statDash: requiredElement('statDash'),
      staminaMeter: requiredElement('staminaMeter'),
      staminaFill: requiredElement('staminaFill'),
      staminaValue: requiredElement('staminaValue'),
      ropeState: requiredElement('ropeState'),
      anchorReadout: requiredElement('anchorReadout'),
      bombMarkers: requiredElement('bombMarkers'),
      enemyMarkers: requiredElement('enemyMarkers'),
      damageNumbers: requiredElement('damageNumbers'),
      itemProcLayer: requiredElement('itemProcLayer'),
      inventoryBar: requiredElement('inventoryBar'),
      toast: requiredElement('toast'),
      hitFlash: requiredElement('hitFlash'),
      speedLines: requiredElement('speedLines'),
      vignette: requiredElement('vignette'),
      menu: requiredElement('menuScreen'),
      menuEyebrow: requiredElement('menuEyebrow'),
      menuTitle: requiredElement('menuTitle'),
      menuTagline: requiredElement('menuTagline'),
      menuButton: requiredElement<HTMLButtonElement>('menuButton'),
      bestScore: requiredElement('bestScore'),
      results: requiredElement('resultsScreen'),
      resultScore: requiredElement('resultScore'),
      resultAccuracy: requiredElement('resultAccuracy'),
      resultCombo: requiredElement('resultCombo'),
      resultSpeed: requiredElement('resultSpeed'),
      resultFalls: requiredElement('resultFalls'),
      resultTime: requiredElement('resultTime'),
      recordLabel: requiredElement('recordLabel'),
      replayButton: requiredElement<HTMLButtonElement>('replayButton'),
      upgradeScreen: requiredElement('upgradeScreen'),
      upgradeStage: requiredElement('upgradeStageValue'),
      upgradeReels: requiredElement('upgradeReels'),
      itemCards: Array.from(document.querySelectorAll<HTMLButtonElement>('.item-card')),
      upgradeConfirmBar: requiredElement('upgradeConfirmBar'),
      upgradeConfirmEyebrow: requiredElement('upgradeConfirmEyebrow'),
      upgradeConfirmName: requiredElement('upgradeConfirmName'),
      upgradeConfirmSummary: requiredElement('upgradeConfirmSummary'),
      upgradeReplaceWarning: requiredElement('upgradeReplaceWarning'),
      upgradeReplaceCheck: requiredElement<HTMLInputElement>('upgradeReplaceCheck'),
      upgradeReplaceText: requiredElement('upgradeReplaceText'),
      upgradeConfirmButton: requiredElement<HTMLButtonElement>('upgradeConfirmButton'),
    };
  }

  private loadBestScore(): void {
    try {
      const saved = Number(localStorage.getItem('neon-tether-best') ?? '0');
      this.bestScore = Number.isFinite(saved) ? saved : 0;
    } catch {
      this.bestScore = 0;
    }
    this.hud.bestScore.textContent = this.bestScore.toLocaleString('ko-KR');
  }

  private blankStats(): RunStats {
    return { score: 0, combo: 0, bestCombo: 0, shots: 0, hits: 0, topSpeed: 0, falls: 0 };
  }
}
