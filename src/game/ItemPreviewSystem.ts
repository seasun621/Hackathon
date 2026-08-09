import * as THREE from 'three';
import type { ItemDefinition, ItemOffer } from './ItemSystem';

interface PreviewSlot {
  host: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  model: THREE.Group | null;
  width: number;
  height: number;
}

function material(color: string, metalness = 0.48): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.32, metalness });
}

function mesh(
  geometry: THREE.BufferGeometry,
  source: THREE.Material,
  position: [number, number, number],
  scale: [number, number, number] = [1, 1, 1],
  rotation: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const result = new THREE.Mesh(geometry, source);
  result.position.set(...position);
  result.scale.set(...scale);
  result.rotation.set(...rotation);
  return result;
}

function createItemModel(definition: ItemDefinition): THREE.Group {
  const group = new THREE.Group();
  const accent = material(definition.color, 0.55);
  const dark = material('#111a29', 0.84);
  const light = material('#eefbff', 0.28);
  const glow = new THREE.MeshBasicMaterial({ color: definition.color });
  const box = new THREE.BoxGeometry(1, 1, 1);
  const cylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
  const sphere = new THREE.SphereGeometry(0.5, 12, 8);
  const cone = new THREE.ConeGeometry(0.5, 1, 8);
  const torus = new THREE.TorusGeometry(0.62, 0.08, 6, 18);

  switch (definition.model) {
    case 'medkit':
      group.add(mesh(box, dark, [0, 0, 0], [1.5, 1, 0.62]));
      group.add(mesh(box, accent, [0, 0, 0.34], [0.32, 0.74, 0.08]));
      group.add(mesh(box, accent, [0, 0, 0.34], [0.88, 0.25, 0.08]));
      group.add(mesh(cylinder, light, [0, 0.72, 0], [0.38, 0.38, 0.6], [0, 0, Math.PI / 2]));
      break;
    case 'shield':
      group.add(mesh(new THREE.CylinderGeometry(0.9, 0.62, 0.18, 6), accent, [0, 0, 0], [1, 1.25, 1], [Math.PI / 2, 0, 0]));
      group.add(mesh(torus, glow, [0, 0, 0.16], [0.82, 1.05, 0.82]));
      break;
    case 'speed':
      group.add(mesh(cone, accent, [-0.32, 0, 0], [0.65, 1.35, 0.18], [0, 0, -Math.PI / 2]));
      group.add(mesh(cone, light, [0.42, -0.16, 0], [0.48, 1.05, 0.14], [0, 0, -Math.PI / 2]));
      break;
    case 'gravity':
      group.add(mesh(sphere, dark, [0, 0, 0], [1.1, 1.1, 1.1]));
      group.add(mesh(torus, accent, [0, 0, 0], [1.25, 1.25, 1.25], [Math.PI / 2, 0, 0]));
      group.add(mesh(torus, glow, [0, 0, 0], [0.9, 0.9, 0.9], [0, Math.PI / 2, 0]));
      break;
    case 'heart':
      group.add(mesh(sphere, accent, [-0.32, 0.22, 0], [0.8, 0.8, 0.55]));
      group.add(mesh(sphere, accent, [0.32, 0.22, 0], [0.8, 0.8, 0.55]));
      group.add(mesh(cone, accent, [0, -0.36, 0], [1.15, 1.25, 0.65], [0, 0, Math.PI]));
      break;
    case 'laser':
      group.add(mesh(box, dark, [0, 0, 0], [1.35, 0.5, 0.58]));
      group.add(mesh(cylinder, accent, [0.9, 0, 0], [0.22, 1.25, 0.22], [0, 0, Math.PI / 2]));
      group.add(mesh(box, glow, [0.12, 0.34, 0], [0.62, 0.12, 0.22]));
      group.add(mesh(box, dark, [-0.35, -0.46, 0], [0.32, 0.6, 0.4], [0, 0, -0.2]));
      break;
    case 'machinegun':
      group.add(mesh(box, dark, [-0.18, 0, 0], [1.28, 0.62, 0.7]));
      for (const z of [-0.22, 0, 0.22]) {
        group.add(mesh(cylinder, accent, [0.92, 0, z], [0.1, 1.45, 0.1], [0, 0, Math.PI / 2]));
      }
      group.add(mesh(cylinder, dark, [-0.05, -0.5, 0], [0.48, 0.34, 0.48]));
      break;
    case 'shotgun':
      group.add(mesh(box, dark, [-0.4, 0, 0], [1.2, 0.55, 0.62]));
      for (const z of [-0.18, 0.18]) {
        group.add(mesh(cylinder, accent, [0.82, 0.08, z], [0.15, 1.45, 0.15], [0, 0, Math.PI / 2]));
      }
      group.add(mesh(box, accent, [-1.03, 0, 0], [0.55, 0.38, 0.5]));
      break;
    case 'katana':
      group.add(mesh(box, light, [0.25, 0.38, 0], [0.16, 2.2, 0.05], [0, 0, -0.62]));
      group.add(mesh(box, accent, [-0.45, -0.34, 0], [0.22, 0.9, 0.18], [0, 0, -0.62]));
      group.add(mesh(box, dark, [-0.18, -0.05, 0], [0.85, 0.12, 0.28], [0, 0, -0.62]));
      break;
    case 'missile':
      group.add(mesh(cylinder, accent, [0, 0, 0], [0.46, 1.9, 0.46], [0, 0, Math.PI / 2]));
      group.add(mesh(cone, light, [1.18, 0, 0], [0.48, 0.75, 0.48], [0, 0, -Math.PI / 2]));
      for (const z of [-0.48, 0.48]) group.add(mesh(box, dark, [-0.65, 0, z], [0.5, 0.08, 0.52]));
      break;
    case 'bomb':
      group.add(mesh(sphere, dark, [0, 0, 0], [1.25, 1.25, 1.25]));
      group.add(mesh(torus, accent, [0, 0, 0], [1.1, 1.1, 1.1], [Math.PI / 2, 0, 0]));
      group.add(mesh(cylinder, glow, [0, 0.82, 0], [0.18, 0.55, 0.18], [0.15, 0, 0.2]));
      break;
    case 'jetpack':
      group.add(mesh(box, dark, [0, 0, 0], [0.72, 1.25, 0.5]));
      for (const x of [-0.58, 0.58]) {
        group.add(mesh(cylinder, accent, [x, 0, 0], [0.38, 1.35, 0.38]));
        group.add(mesh(cone, glow, [x, -0.92, 0], [0.35, 0.7, 0.35], [0, 0, Math.PI]));
      }
      break;
    case 'wingsuit':
      group.add(mesh(box, dark, [0, 0, 0], [0.48, 1.2, 0.35]));
      group.add(mesh(cone, accent, [-0.82, 0.05, 0], [0.7, 1.55, 0.12], [0, 0, 1.25]));
      group.add(mesh(cone, accent, [0.82, 0.05, 0], [0.7, 1.55, 0.12], [0, 0, -1.25]));
      break;
    case 'armor':
      group.add(mesh(box, dark, [0, 0, 0], [1.15, 1.35, 0.56]));
      group.add(mesh(box, accent, [0, 0.12, 0.38], [0.82, 0.72, 0.12]));
      group.add(mesh(box, light, [0, -0.38, 0.37], [0.5, 0.22, 0.1]));
      for (const x of [-0.82, 0.82]) group.add(mesh(sphere, accent, [x, 0.42, 0], [0.58, 0.58, 0.58]));
      break;
    default:
      group.add(mesh(box, accent, [0, 0, 0], [1.2, 1.2, 1.2]));
  }

  group.rotation.set(-0.18, -0.5, 0.08);
  return group;
}

function disposeModel(model: THREE.Group): void {
  model.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const source of materials) source.dispose();
  });
}

export class ItemPreviewSystem {
  private readonly slots: PreviewSlot[];
  private active = false;

  constructor(hosts: HTMLElement[]) {
    this.slots = hosts.map((host) => {
      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' });
      renderer.setPixelRatio(Math.min(1.15, window.devicePixelRatio));
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.className = 'item-preview-canvas';
      host.append(renderer.domElement);
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xdff9ff, 0x182033, 2.5));
      const key = new THREE.DirectionalLight(0xffffff, 3.2);
      key.position.set(3, 4, 5);
      scene.add(key);
      const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 30);
      camera.position.set(0, 0, 5.7);
      return { host, renderer, scene, camera, model: null, width: 0, height: 0 };
    });
  }

  show(offers: ItemOffer[]): void {
    this.active = true;
    this.slots.forEach((slot, index) => {
      if (slot.model) {
        slot.scene.remove(slot.model);
        disposeModel(slot.model);
      }
      const offer = offers[index];
      slot.model = offer ? createItemModel(offer.definition) : null;
      if (slot.model) slot.scene.add(slot.model);
    });
  }

  hide(): void {
    this.active = false;
  }

  update(dt: number): void {
    if (!this.active) return;
    for (const slot of this.slots) {
      const width = Math.max(1, Math.floor(slot.host.clientWidth));
      const height = Math.max(1, Math.floor(slot.host.clientHeight));
      if (slot.width !== width || slot.height !== height) {
        slot.width = width;
        slot.height = height;
        slot.renderer.setSize(width, height, false);
        slot.camera.aspect = width / height;
        slot.camera.updateProjectionMatrix();
      }
      if (slot.model) slot.model.rotation.y += dt * 0.7;
      slot.renderer.render(slot.scene, slot.camera);
    }
  }
}
