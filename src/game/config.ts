export const CONFIG = {
  runDuration: 90,
  gravity: -38,
  airAcceleration: 15,
  walkSpeed: 3.2,
  groundAcceleration: 18,
  groundDeceleration: 24,
  groundProbeDistance: 1.34,
  maxAirSpeed: 62,
  ropeMaxRange: 115,
  ropeMinLength: 7,
  ropePullSpeed: 20,
  ropeSpring: 58,
  ropeDamping: 8,
  focusDrain: 34,
  focusRecharge: 14,
  slowMotionScale: 0.36,
  hitscanRange: 145,
  bombTrackRange: 110,
  bombLockNdcRadius: 0.34,
  bombApproachSpeed: 7.5,
  bombImpactDistance: 4.5,
  minimumBombs: 2,
  bombScale: 1.34,
  staminaGroundDrain: 32,
  staminaGroundIdleDrain: 12,
  staminaAirRecharge: 18,
  staminaGrappleRecharge: 30,
  dashMinimumStamina: 30,
  dashMinimumSpeed: 46,
  dashMaximumSpeed: 74,
  dashMinimumDuration: 0.24,
  dashMaximumDuration: 0.66,
  ropeFireDuration: 0.085,
  chunkSize: 128,
  chunkRadius: 2,
  targetCount: 12,
} as const;

export type RunMode = 'ready' | 'playing' | 'paused' | 'over';
export type TargetKind = 'normal' | 'gold' | 'bomb';

export interface RunStats {
  score: number;
  combo: number;
  bestCombo: number;
  shots: number;
  hits: number;
  topSpeed: number;
  falls: number;
}
