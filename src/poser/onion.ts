// Onion skinning: translucent ghosts of the model posed at neighbouring keyframes.
// Earlier keys are drawn as wireframes, later keys as solid translucent shells, so the two
// directions differ in shape as well as colour.

import * as THREE from "three";

import { Clip, keyedFrames } from "./document";
import { LoadedModel } from "./load";
import { applyClipPose } from "./sampler";

export interface OnionSettings {
  enabled: boolean;
  keysEachSide: number; // 1..3
  opacity: number; // 0..1
}

interface Ghost {
  root: THREE.Object3D;
  nodes: Map<string, THREE.Object3D>;
  materials: THREE.MeshBasicMaterial[];
  // ghost mesh -> name of the node that owns it, for hiding parts that did not move
  meshOwner: Map<THREE.Mesh, string>;
}

const SAME_EPSILON = 1e-3;

function sameWorldMatrix(a: THREE.Object3D, b: THREE.Object3D) {
  const ea = a.matrixWorld.elements;
  const eb = b.matrixWorld.elements;
  for (let i = 0; i < 16; i++) if (Math.abs(ea[i] - eb[i]) > SAME_EPSILON) return false;
  return true;
}

const EARLIER = 0xf87171; // red-ish
const LATER = 0x60a5fa; // blue-ish

export class OnionSkin {
  private scene: THREE.Scene;
  private model: LoadedModel | null = null;
  private ghosts: Ghost[] = [];

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  setModel(model: LoadedModel | null) {
    this.clear();
    this.model = model;
  }

  clear() {
    this.ghosts.forEach((ghost) => {
      this.scene.remove(ghost.root);
      ghost.materials.forEach((m) => m.dispose());
    });
    this.ghosts = [];
  }

  // Builds (or reuses) one ghost per requested slot
  private ensureGhosts(count: number) {
    while (this.ghosts.length > count) {
      const ghost = this.ghosts.pop()!;
      this.scene.remove(ghost.root);
      ghost.materials.forEach((m) => m.dispose());
    }
    while (this.ghosts.length < count && this.model) {
      const root = this.model.root.clone(true);
      root.name = `onion_${this.ghosts.length}`;
      const nodes = new Map<string, THREE.Object3D>();
      const materials: THREE.MeshBasicMaterial[] = [];
      const meshOwner = new Map<THREE.Mesh, string>();

      root.traverse((object) => {
        if (this.model!.nodes.has(object.name)) nodes.set(object.name, object);
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) {
          const material = new THREE.MeshBasicMaterial({
            transparent: true,
            depthWrite: false,
            opacity: 0.3,
          });
          mesh.material = material;
          mesh.raycast = () => {}; // never pickable
          materials.push(material);

          let cursor: THREE.Object3D | null = mesh;
          while (cursor && !this.model!.nodes.has(cursor.name)) cursor = cursor.parent;
          if (cursor) meshOwner.set(mesh, cursor.name);
        }
      });

      this.scene.add(root);
      this.ghosts.push({ root, nodes, materials, meshOwner });
    }
  }

  // Poses ghosts at the keyed frames around `frame`
  update(clip: Clip | null, frame: number, settings: OnionSettings, playing: boolean) {
    if (!this.model || !clip || !settings.enabled || playing) {
      this.ensureGhosts(0);
      return;
    }

    const frames = keyedFrames(clip);
    const earlier = frames.filter((f) => f < frame).slice(-settings.keysEachSide).reverse();
    const later = frames.filter((f) => f > frame).slice(0, settings.keysEachSide);

    const slots = [
      ...earlier.map((f, i) => ({ frame: f, kind: "earlier" as const, rank: i })),
      ...later.map((f, i) => ({ frame: f, kind: "later" as const, rank: i })),
    ];

    this.ensureGhosts(slots.length);

    slots.forEach((slot, i) => {
      const ghost = this.ghosts[i];
      applyClipPose(clip, slot.frame, ghost.nodes, this.model!.rootName, this.model!.base);
      // Match the live root's transform (user may have rotated the view object)
      ghost.root.position.copy(this.model!.root.position);
      ghost.root.quaternion.copy(this.model!.root.quaternion);

      // Only show the parts that sit somewhere else at that key; identical parts would just
      // paint over the live model and hide the useful silhouette
      this.model!.root.updateMatrixWorld(true);
      ghost.root.updateMatrixWorld(true);
      ghost.meshOwner.forEach((owner, mesh) => {
        const live = this.model!.nodes.get(owner);
        const ghostNode = ghost.nodes.get(owner);
        mesh.visible = !(live && ghostNode && sameWorldMatrix(live, ghostNode));
      });

      const falloff = 1 / (slot.rank + 1);
      ghost.materials.forEach((material) => {
        material.color.setHex(slot.kind === "earlier" ? EARLIER : LATER);
        material.wireframe = slot.kind === "earlier";
        material.opacity = settings.opacity * falloff;
      });
    });
  }
}
