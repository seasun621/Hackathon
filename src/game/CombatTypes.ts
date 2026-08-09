export type AimQuality = 'none' | 'graze' | 'perfect';

export type CombatTargetType = 'bomb' | 'drone' | 'health';

export interface CombatTargetRef {
  type: CombatTargetType;
  id: number;
  quality: Exclude<AimQuality, 'none'>;
  score: number;
}
