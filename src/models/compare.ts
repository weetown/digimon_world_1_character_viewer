// Compare view: loads a just-exported glb back through GLTFLoader and plays it beside the
// original, so export fidelity can be eyeballed frame by frame.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";

import { Artboard } from "./artboard";
import { DigimonPackage } from "../export/exporter";
import { DigimonSwaps } from "../runtime/digimon-swaps";

export interface SavedCamera {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  far: number;
}

export function saveCamera(camera: THREE.PerspectiveCamera): SavedCamera {
  return { position: camera.position.clone(), quaternion: camera.quaternion.clone(), far: camera.far };
}

export function restoreCamera(camera: THREE.PerspectiveCamera, saved: SavedCamera) {
  camera.position.copy(saved.position);
  camera.quaternion.copy(saved.quaternion);
  camera.far = saved.far;
  camera.updateProjectionMatrix();
}

// Frames a pair standing at x = 0 and x = offsetX: shift the camera to the midpoint and back
// it off until both fit the horizontal field of view (DW2 models are several times DW1's
// size, so the Digimon's own framing is a starting point, never enough).
export function framePair(
  camera: THREE.PerspectiveCamera,
  { offsetX, height }: { offsetX: number; height: number },
) {
  const pairWidth = offsetX + Math.max(offsetX * 0.7, 400);
  const halfFovY = (camera.fov * Math.PI) / 360;
  // The canvas is its own pane now (no panels over it); leave a little margin
  const visibleFraction = 0.85;
  const needed = pairWidth / 2 / (Math.tan(halfFovY) * camera.aspect * visibleFraction) + height;
  camera.position.x = offsetX / 2;
  camera.position.z = Math.max(camera.position.z, needed);
  camera.far = Math.max(camera.far, camera.position.length() * 2);
  camera.updateProjectionMatrix();
  camera.lookAt(offsetX / 2, height / 2, 0);
}

export class CompareView {
  readonly root: THREE.Object3D;
  readonly clips: THREE.AnimationClip[];
  readonly swaps: DigimonSwaps | null;

  private artboard: Artboard;
  private savedCamera: SavedCamera | null = null;
  private mixer: THREE.AnimationMixer;
  private action: THREE.AnimationAction | null = null;
  private frameHook: (delta: number) => void;

  private constructor(
    artboard: Artboard,
    root: THREE.Object3D,
    clips: THREE.AnimationClip[],
    swaps: DigimonSwaps | null,
  ) {
    this.artboard = artboard;
    this.root = root;
    this.clips = clips;
    this.swaps = swaps;

    this.mixer = new THREE.AnimationMixer(root);
    this.swaps?.bind(this.mixer);

    this.frameHook = (delta) => {
      this.mixer.update(delta);
      this.swaps?.update();
    };
    this.artboard.frameHooks.add(this.frameHook);
  }

  static async fromPackage(
    artboard: Artboard,
    pkg: DigimonPackage,
    { offsetX, height }: { offsetX: number; height: number },
  ): Promise<CompareView> {
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(pkg.glb, "");

    const root = gltf.scene;
    root.position.x = offsetX;

    // The viewer renders its DataTextures linear-in / linear-out. GLTFLoader tags colour
    // maps sRGB; undo that here so both sides go through the same colour pipeline.
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      [mesh.material].flat().forEach((material) => {
        const map = (material as THREE.MeshStandardMaterial).map;
        if (map) {
          (map as unknown as { encoding: number }).encoding = THREE.LinearEncoding;
          map.needsUpdate = true;
        }
      });
    });

    // Texture states from the in-memory export
    let swaps: DigimonSwaps | null = null;
    if (pkg.swaps.materials.length) {
      const textures = new Map<string, THREE.Texture[]>();
      pkg.swaps.materials.forEach((material, m) => {
        textures.set(
          material.name,
          pkg.swapStates.map((state) => {
            const image = state[m];
            const texture = new THREE.DataTexture(
              image.data,
              image.width,
              image.height,
              THREE.RGBAFormat,
            );
            texture.needsUpdate = true;
            return texture;
          }),
        );
      });
      swaps = DigimonSwaps.fromTextures(root, pkg.swaps, textures);
    }

    artboard.add(root, { shouldRender: false });

    const view = new CompareView(artboard, root, gltf.animations, swaps);

    view.savedCamera = saveCamera(artboard.camera);
    framePair(artboard.camera, { offsetX, height });

    return view;
  }

  // Plays the flat clip for a game animation index (aNN_...), stopping anything else
  playAnimationIndex(index: number) {
    const prefix = `a${String(index).padStart(2, "0")}_`;
    const clip = this.clips.find(
      (c) => c.name.startsWith(prefix) && !c.name.includes("__"),
    );

    this.action?.stop();
    this.action = null;

    if (!clip) return;

    // The exporter records which animations the game loops forever; mirror the viewer there
    const meta = (this.root.userData.animations ?? {})[clip.name] as
      | { infiniteLoop?: boolean }
      | undefined;

    this.action = this.mixer.clipAction(clip);
    this.action.loop = meta?.infiniteLoop ? THREE.LoopRepeat : THREE.LoopOnce;
    this.action.clampWhenFinished = true;
    this.action.reset().play();
  }

  remove() {
    this.artboard.frameHooks.delete(this.frameHook);
    if (this.savedCamera) {
      restoreCamera(this.artboard.camera, this.savedCamera);
      this.savedCamera = null;
    }
    this.action?.stop();
    this.mixer.stopAllAction();
    this.swaps?.dispose();
    this.artboard.remove(this.root);

    this.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      [mesh.material].flat().forEach((material) => {
        (material as THREE.MeshStandardMaterial).map?.dispose();
        material.dispose();
      });
    });
  }
}
