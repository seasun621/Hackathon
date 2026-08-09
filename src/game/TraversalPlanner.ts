import * as THREE from 'three';
import { CONFIG } from './config';

export interface BuildingTraversalProfile {
  roofX: number;
  roofZ: number;
  roofHeight: number;
  width: number;
  depth: number;
}

/**
 * Produces facade-supported anchor bands whose vertical gaps stay inside the
 * rope range. This remains a city concern and does not alter rope physics.
 */
export function createBuildingTraversalAnchors(
  profile: BuildingTraversalProfile,
): THREE.Vector3[] {
  const insetX = Math.max(1.8, profile.width * 0.35);
  const insetZ = Math.max(1.8, profile.depth * 0.35);
  const highest = profile.roofHeight + 1.4;
  const usableGap = CONFIG.ropeMaxRange * 0.58;
  const bandCount = Math.max(1, Math.ceil(highest / usableGap));
  const levels: number[] = [];

  for (let band = 1; band <= bandCount; band += 1) {
    const height = Math.min(highest, Math.max(18, (highest * band) / bandCount));
    if (levels.length === 0 || height - levels[levels.length - 1] > 8) levels.push(height);
  }

  const anchors: THREE.Vector3[] = [];
  for (const height of levels) {
    anchors.push(
      new THREE.Vector3(profile.roofX - insetX, height, profile.roofZ - insetZ),
      new THREE.Vector3(profile.roofX + insetX, height, profile.roofZ - insetZ),
      new THREE.Vector3(profile.roofX - insetX, height, profile.roofZ + insetZ),
      new THREE.Vector3(profile.roofX + insetX, height, profile.roofZ + insetZ),
    );
  }
  return anchors;
}

export function validateAnchorCoverage(anchors: readonly THREE.Vector3[]): boolean {
  if (anchors.length < 8) return false;
  const maxGap = CONFIG.ropeMaxRange * 0.92;
  return anchors.every((anchor, index) => anchors.some((candidate, candidateIndex) => (
    candidateIndex !== index && anchor.distanceTo(candidate) <= maxGap
  )));
}
