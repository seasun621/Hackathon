import * as THREE from 'three';
import RAPIER, { type Collider, type RigidBody, type World } from '@dimforge/rapier3d-compat';
import { AudioSystem } from './AudioSystem';
import { City } from './City';
import { CONFIG, type RunMode, type RunStats } from './config';
import { TargetSystem, type BombTrack, type ShotResult } from './TargetSystem';

interface HudElements {
  score: HTMLElement;
  timer: HTMLElement;
  combo: HTMLElement;
  comboValue: HTMLElement;
  multiplier: HTMLElement;
  speed: HTMLElement;
  focusFill: HTMLElement;
  staminaMeter: HTMLElement;
  staminaFill: HTMLElement;
  staminaValue: HTMLElement;
  ropeState: HTMLElement;
  anchorReadout: HTMLElement;
  bombMarkers: HTMLElement;
  toast: HTMLElement;
  hitFlash: HTMLElement;
  speedLines: HTMLElement;
  focusFx: HTMLElement;
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
  private readonly audio = new AudioSystem();
  private readonly hud: HudElements;
  private readonly keys = new Set<string>();
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
  private readonly playerPosition = new THREE.Vector3();
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
  private timeRemaining: number = CONFIG.runDuration;
  private runEndCueStarted = false;
  private focus = 100;
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
  private tracerLife = 0;
  private flashLife = 0;
  private toastTimer = 0;
  private damageTimer = 0;
  private impactTimer = 0;
  private bestScore = 0;
  private simulationScale = 1;
  private readonly bombMarkerElements = new Map<number, HTMLElement>();
  private readonly visibleBombMarkerIds = new Set<number>();
  private lockedBombId: number | null = null;
  private focusing = false;
  private anchorSelectionTimer = 0;
  private bombTrackingTimer = 0;
  private hudTimer = 0;
  private performanceTimer = 0;
  private performanceFrames = 0;
  private readonly maximumPixelRatio = Math.min(window.devicePixelRatio, 1.15);
  private currentPixelRatio = this.maximumPixelRatio;

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
    this.loadBestScore();
    this.bindEvents();
    this.resetPlayer();
    this.city.update(this.playerPosition, this.cameraForward);
    this.updateCamera(0);
    this.updateAnchorSelection(0);
    this.updateHud();
    this.renderer.setAnimationLoop(this.frame);
  }

  private readonly frame = (timestamp: number): void => {
    const realDt = clamp((timestamp - this.lastFrameTime) / 1000, 0, 0.05);
    this.lastFrameTime = timestamp;

    if (this.mode === 'playing') this.updatePlaying(realDt);
    else this.updateIdle(realDt);

    this.city.update(this.playerPosition, this.cameraForward);
    this.updateEffects(realDt);
    this.updateCamera(realDt);
    this.updateAnchorSelection(realDt);
    this.updateRopeVisual(realDt);
    this.targets.update(
      this.mode === 'playing' ? realDt * this.simulationScale : 0,
      this.playerPosition,
      this.cameraForward,
    );
    let bombImpact = this.targets.consumeBombImpact();
    while (bombImpact) {
      this.handleBombImpact();
      bombImpact = this.targets.consumeBombImpact();
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
  };

  private updatePlaying(realDt: number): void {
    this.timeRemaining = Math.max(0, this.timeRemaining - realDt);
    if (!this.runEndCueStarted && this.timeRemaining <= CONFIG.runEndBellLead) {
      this.runEndCueStarted = true;
      this.audio.startRunEndCue(CONFIG.runEndBellLead - this.timeRemaining);
    }
    if (this.timeRemaining <= 0) {
      this.finishRun();
      return;
    }

    const focusing = this.keys.has('Space') && this.focus > 0;
    const timeScale = focusing ? CONFIG.slowMotionScale : 1;
    this.setFocusEffect(focusing);
    this.simulationScale = timeScale;
    this.focus = focusing
      ? Math.max(0, this.focus - CONFIG.focusDrain * realDt)
      : Math.min(100, this.focus + CONFIG.focusRecharge * realDt);

    const scaledDt = realDt * timeScale;
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
    // The street and every rooftop are valid play spaces. This guard now only
    // handles an impossible physics escape below the oversized ground collider.
    if (this.playerPosition.y < -20) this.respawnAfterFall();
  }

  private updateIdle(realDt: number): void {
    this.setFocusEffect(false);
    const translation = this.playerBody.translation();
    this.playerPosition.set(translation.x, translation.y, translation.z);
    this.weaponRig.rotation.z = Math.sin(performance.now() * 0.001) * 0.005;
    this.anchorMarker.rotation.z += realDt * 0.6;
  }

  private stepPhysics(dt: number): void {
    this.updateGroundedState();
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
      const targetX = hasMoveInput ? this.physicsMove.x * CONFIG.walkSpeed : 0;
      const targetZ = hasMoveInput ? this.physicsMove.z * CONFIG.walkSpeed : 0;
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
      this.physicsMove.multiplyScalar(CONFIG.airAcceleration * dt);
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
    if (speed > CONFIG.maxAirSpeed) {
      const scale = CONFIG.maxAirSpeed / speed;
      this.playerBody.setLinvel(
        { x: velocity.x * scale, y: velocity.y * scale, z: velocity.z * scale },
        true,
      );
    }
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
    const speed = THREE.MathUtils.lerp(
      CONFIG.dashMinimumSpeed,
      CONFIG.dashMaximumSpeed,
      charge,
    );
    const duration = THREE.MathUtils.lerp(
      CONFIG.dashMinimumDuration,
      CONFIG.dashMaximumDuration,
      charge,
    );
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
  }

  private updateCamera(dt: number): void {
    const translation = this.playerBody.translation();
    this.playerPosition.set(translation.x, translation.y, translation.z);
    const shakeAmount = this.shake * this.shake * 0.08;
    this.camera.position.set(
      translation.x + (Math.random() - 0.5) * shakeAmount,
      translation.y + 0.18 + (Math.random() - 0.5) * shakeAmount,
      translation.z + (Math.random() - 0.5) * shakeAmount,
    );
    this.camera.rotation.set(this.pitch, this.yaw, 0);
    this.camera.getWorldDirection(this.cameraForward);

    const velocity = this.playerBody.linvel();
    const speed = Math.hypot(velocity.x, velocity.y, velocity.z);
    this.audio.setMotionState(
      this.grappleAnchor !== null,
      this.mode === 'playing' && !this.isGrounded,
      speed,
      this.leftHeld,
      this.focusing,
      dt,
    );
    const targetFov = 74
      + clamp((speed - 16) / 38, 0, 1) * 10
      + this.dashFx * 14
      - (this.keys.has('Space') ? 2.5 : 0);
    const nextFov = THREE.MathUtils.damp(this.camera.fov, targetFov, 6, dt);
    if (Math.abs(nextFov - this.camera.fov) > 0.01) {
      this.camera.fov = nextFov;
      this.camera.updateProjectionMatrix();
    }

    this.recoil = THREE.MathUtils.damp(this.recoil, 0, 18, dt);
    this.leftKick = THREE.MathUtils.damp(this.leftKick, 0, 12, dt);
    this.weaponRig.position.y = Math.sin(performance.now() * 0.008) * Math.min(0.012, speed * 0.00035);
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
    const tracks = this.mode === 'playing'
      ? this.targets.getBombTracks(this.camera, this.city.getBuildingMeshes())
      : [];
    this.visibleBombMarkerIds.clear();
    this.lockedBombId = null;

    for (const track of tracks) {
      this.visibleBombMarkerIds.add(track.targetId);
      if (track.locked) this.lockedBombId = track.targetId;
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

    for (const [targetId, marker] of this.bombMarkerElements) {
      if (this.visibleBombMarkerIds.has(targetId)) continue;
      marker.remove();
      this.bombMarkerElements.delete(targetId);
    }
  }

  private updateBombMarker(marker: HTMLElement, track: BombTrack): void {
    const x = clamp((track.ndcX * 0.5 + 0.5) * 100, 4, 96);
    const y = clamp((-track.ndcY * 0.5 + 0.5) * 100, 6, 94);
    const scale = clamp(1.22 - track.distance / 260, 0.72, 1.08);
    marker.style.left = `${x}%`;
    marker.style.top = `${y}%`;
    marker.style.setProperty('--marker-scale', String(scale));
    marker.classList.toggle('ready', track.locked);
    marker.classList.toggle('urgent', track.danger && !track.locked);
    const label = marker.querySelector<HTMLElement>('.bomb-lock-label');
    if (label) {
      label.textContent = track.locked
        ? 'FIRE NOW // RMB'
        : track.danger
          ? `DANGER // ${Math.round(track.distance)} M`
          : `ALIGN // ${Math.round(track.distance)} M`;
    }
  }

  private setFocusEffect(active: boolean): void {
    if (this.focusing === active) return;
    this.focusing = active;
    this.audio.setFocus(active);
    this.hud.focusFx.classList.toggle('active', active);
    this.hud.speedLines.classList.toggle('focus-mode', active);
    this.renderer.domElement.classList.toggle('focus-active', active);
  }

  private updateAdaptiveResolution(dt: number): void {
    if (this.mode !== 'playing') {
      this.performanceTimer = 0;
      this.performanceFrames = 0;
      return;
    }
    this.performanceTimer += dt;
    this.performanceFrames += 1;
    if (this.performanceTimer < 1.4) return;

    const fps = this.performanceFrames / this.performanceTimer;
    let nextRatio = this.currentPixelRatio;
    if (fps < 52) nextRatio = Math.max(0.68, this.currentPixelRatio - 0.12);
    else if (fps > 58) nextRatio = Math.min(this.maximumPixelRatio, this.currentPixelRatio + 0.04);
    if (Math.abs(nextRatio - this.currentPixelRatio) >= 0.049) {
      this.currentPixelRatio = nextRatio;
      this.renderer.setPixelRatio(this.currentPixelRatio);
    }
    this.renderer.domElement.dataset.fps = fps.toFixed(1);
    this.renderer.domElement.dataset.pixelRatio = this.currentPixelRatio.toFixed(2);
    this.renderer.domElement.dataset.drawCalls = String(this.renderer.info.render.calls);
    this.renderer.domElement.dataset.triangles = String(this.renderer.info.render.triangles);
    this.performanceTimer = 0;
    this.performanceFrames = 0;
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
    if (this.mode !== 'playing') return;
    this.stats.shots += 1;
    this.audio.shoot();
    this.recoil = 1;
    this.shake = Math.max(this.shake, 0.24);
    this.flashLife = 0.045;

    this.camera.updateMatrixWorld();
    const muzzlePosition = new THREE.Vector3();
    this.rightMuzzle.getWorldPosition(muzzlePosition);
    const result = this.lockedBombId !== null
      ? this.targets.shootBombById(this.lockedBombId, this.camera.position)
      : this.targets.shoot(this.camera, this.city.getBuildingMeshes());
    const tracerEnd = result
      ? result.position
      : muzzlePosition.clone().addScaledVector(this.cameraForward, 150);
    this.showTracer(muzzlePosition, tracerEnd);

    if (!result) {
      this.stats.combo = 0;
      return;
    }

    this.stats.hits += 1;
    if (result.kind === 'bomb') this.handleBombDefused(result);
    else this.handlePositiveHit(result);
  }

  private handlePositiveHit(result: ShotResult): void {
    this.stats.combo += result.kind === 'gold' ? 3 : 1;
    this.stats.bestCombo = Math.max(this.stats.bestCombo, this.stats.combo);
    const velocity = this.playerBody.linvel();
    const speed = this.isGrounded ? 0 : Math.hypot(velocity.x, velocity.y, velocity.z);
    const comboMultiplier = this.comboMultiplier();
    const speedMultiplier = clamp(1 + speed / 38, 1, 2.5);
    const distanceMultiplier = clamp(result.distance / 42, 0.8, 2.2);
    const earned = Math.round(
      result.baseScore * comboMultiplier * speedMultiplier * distanceMultiplier * result.centerBonus,
    );
    this.stats.score += earned;
    const hitLabel = result.kind === 'gold'
      ? 'GOLD BREAK'
      : result.centerBonus > 1
        ? `CENTER ×${result.centerBonus.toFixed(2)}`
        : 'TARGET BREAK';
    this.showToast(`+${earned.toLocaleString('ko-KR')}\n${hitLabel}`, 'positive');
    this.punchCombo();
    this.impactTimer = result.kind === 'gold' ? 0.24 : 0.16;
    this.shake = Math.max(this.shake, result.kind === 'gold' ? 0.85 : 0.62);
    if (result.kind === 'gold') this.audio.gold();
    else this.audio.hit();
  }

  private handleBombDefused(result: ShotResult): void {
    this.stats.combo += 2;
    this.stats.bestCombo = Math.max(this.stats.bestCombo, this.stats.combo);
    const velocity = this.playerBody.linvel();
    const speed = this.isGrounded ? 0 : Math.hypot(velocity.x, velocity.y, velocity.z);
    const earned = Math.round(
      result.baseScore
      * clamp(1 + speed / 45, 1, 2.3)
      * clamp(result.distance / 50, 0.9, 1.9)
      * result.centerBonus,
    );
    this.stats.score += earned;
    this.lockedBombId = null;
    this.showToast(`+${earned.toLocaleString('ko-KR')}\nBOMB DEFUSED`, 'positive');
    this.impactTimer = 0.28;
    this.shake = 0.95;
    this.punchCombo();
    this.audio.defuse();
  }

  private handleBombImpact(): void {
    this.stats.combo = 0;
    this.stats.score = Math.max(0, this.stats.score - 900);
    this.damageTimer = 0.34;
    this.shake = 1;
    this.showToast('-900\nBOMB IMPACT', 'negative');
    this.audio.bomb();
  }

  private respawnAfterFall(): void {
    this.stats.falls += 1;
    this.stats.combo = 0;
    this.stats.score = Math.max(0, this.stats.score - 350);
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
    this.showToast('-350  RECOVER', 'negative');
    this.audio.fall();
  }

  private beginRun(): void {
    this.mode = 'playing';
    this.stats = this.blankStats();
    this.timeRemaining = CONFIG.runDuration;
    this.runEndCueStarted = false;
    this.focus = 100;
    this.stamina = 100;
    this.simulationScale = 1;
    this.physicsAccumulator = 0;
    this.targets.reset();
    this.resetPlayer();
    this.audio.resetRunEndCue();
    this.audio.resume();
    this.tryDash(true);
    this.hud.results.classList.add('hidden');
    this.hud.menu.classList.add('hidden');
  }

  private finishRun(): void {
    this.mode = 'over';
    this.audio.setPaused(true, true);
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
      if (event.button === 2) this.shoot();
    });

    document.addEventListener('mouseup', (event) => {
      if (event.button === 0) this.detach();
    });

    document.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener('keydown', (event) => {
      if (
        this.mode === 'playing'
        && document.pointerLockElement === this.renderer.domElement
      ) this.audio.resume();
      this.keys.add(event.code);
      if (event.code === 'Space') event.preventDefault();
      if (event.code === 'KeyQ' && !event.repeat) this.tryDash();
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
  }

  private requestPlayLock(): void {
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
    this.hud.timer.textContent = `${Math.ceil(this.timeRemaining)}`;
    this.hud.timer.classList.toggle('danger', this.mode === 'playing' && this.timeRemaining <= 10);
    this.hud.comboValue.textContent = `x${this.stats.combo}`;
    this.hud.multiplier.textContent = `${this.comboMultiplier().toFixed(2)} MULTI`;
    this.hud.speed.textContent = String(Math.round(speed * 3.6));
    this.hud.focusFill.style.transform = `scaleX(${this.focus / 100})`;
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
      combo: requiredElement('combo'),
      comboValue: requiredElement('comboValue'),
      multiplier: requiredElement('multiplier'),
      speed: requiredElement('speedValue'),
      focusFill: requiredElement('focusFill'),
      staminaMeter: requiredElement('staminaMeter'),
      staminaFill: requiredElement('staminaFill'),
      staminaValue: requiredElement('staminaValue'),
      ropeState: requiredElement('ropeState'),
      anchorReadout: requiredElement('anchorReadout'),
      bombMarkers: requiredElement('bombMarkers'),
      toast: requiredElement('toast'),
      hitFlash: requiredElement('hitFlash'),
      speedLines: requiredElement('speedLines'),
      focusFx: requiredElement('focusFx'),
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
      recordLabel: requiredElement('recordLabel'),
      replayButton: requiredElement<HTMLButtonElement>('replayButton'),
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
