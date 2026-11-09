// Viewer-side DW2 model: same surface the page uses on the DW1 `Digimon` class (info.name,
// info.digimonStruct.height/radius, animations, rootNode, setAnimationIndex, remove).
//
// The instance sits on the Alpine store, which walks enumerable properties recursively to
// make them reactive. Everything heavy (three.js graph, parsed disc data, mixer) therefore
// lives in a module-level map keyed by a numeric id on the instance, reached through
// prototype getters, so the store only ever sees plain strings and numbers. Methods run with
// `this` being Alpine's Proxy of the instance; a primitive id reads through the proxy
// unchanged, whereas a WeakMap keyed by the instance missed, and a property holding the
// object came back wrapped in a reactive Proxy that three.js's renderer rejects.

import * as THREE from "three";

import { Artboard } from "../models/artboard";
import { Dw2Disc, Dw2LoadedModel } from "./disc";
import { buildDw2Scene, buildDw2Clips, Dw2Scene, Dw2ClipMeta, matrixToThree } from "./scene";
import { IDENTITY_REST, restFromMatrix, RestTransform } from "../models/retarget";
import { RigShape } from "../models/node-map";
import { resolveParents } from "./model";

interface Heavy {
  artboard: Artboard;
  loaded: Dw2LoadedModel;
  scene: Dw2Scene;
  clips: THREE.AnimationClip[];
  clipMeta: Record<string, Dw2ClipMeta>;
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction | null;
  // A retargeted clip from the other game, playing instead of the model's own
  foreign: THREE.AnimationAction | null;
  // Set when this instance is a companion driven from the artboard's frame hooks
  frameHook: ((delta: number) => void) | null;
}

const heavyById = new Map<number, Heavy>();
let nextId = 1;

function heavyOf(instance: Dw2Digimon): Heavy {
  const value = heavyById.get(instance.heavyId);
  if (!value) throw Error("Dw2Digimon used after remove()");
  return value;
}

export class Dw2Digimon {
  // Display names, one per clip (the page reads `animations` for the list)
  readonly animations: string[];
  readonly info: { index: number; name: string; digimonStruct: { height: number; radius: number } };

  animationIndex = 0;
  readonly heavyId = nextId++;

  // `companion`: sit beside another Digimon that owns the camera and the render loop
  constructor({
    artboard,
    disc,
    index,
    animationIndex,
    companion = false,
  }: {
    artboard: Artboard;
    disc: Dw2Disc;
    index: number;
    animationIndex: number;
    companion?: boolean;
  }) {
    const loaded = disc.load(index);

    const scene = buildDw2Scene({
      model: loaded.model,
      anims: loaded.anims.map((a) => a.anim),
    });
    const { clips, meta: clipMeta } = buildDw2Clips({ anims: loaded.anims, nodeNames: scene.nodeNames });

    this.animations = clips.map((clip) => {
      const meta = clipMeta[clip.name];
      return `${meta.letter}${meta.frameIndex ? meta.frameIndex : ""} (${meta.rows} frames${meta.hasLoop ? ", loops" : ""})`;
    });

    const size = scene.bounds.getSize(new THREE.Vector3());
    const height = Math.max(size.y, 1);
    const radius = Math.max(size.x, size.z) / 2;
    this.info = { index, name: loaded.entry.name, digimonStruct: { height, radius } };

    // Stand on the floor (the viewer's floor sits at y = -3)
    scene.root.position.y = -scene.bounds.min.y;

    const mixer = new THREE.AnimationMixer(scene.root);
    const frameHook = companion ? (delta: number) => mixer.update(delta) : null;
    heavyById.set(this.heavyId, {
      artboard,
      loaded,
      scene,
      clips,
      clipMeta,
      mixer,
      action: null,
      foreign: null,
      frameHook,
    });

    artboard.add(scene.root, { shouldRender: false });

    if (frameHook) {
      artboard.frameHooks.add(frameHook);
    } else {
      // DW2 units are several times DW1's, so frame by the bounds rather than DW1's formula
      const extent = Math.max(height, radius * 2);
      const distance = Math.max(extent * 3.2, 1500);
      artboard.camera.position.set(0, height * 0.9, distance);
      // The artboard's far plane (7500) is sized for DW1; wide DW2 models sit beyond it
      artboard.camera.far = Math.max(7500, distance * 2);
      artboard.camera.updateProjectionMatrix();
      artboard.camera.lookAt(0, height * 0.45, 0);

      const clock = new THREE.Clock();
      artboard.renderer.setAnimationLoop(() => {
        const delta = artboard.frameDelta(clock.getDelta());
        mixer.update(delta);
        artboard.runFrameHooks(delta);
        artboard.render();
      });
    }

    this.setAnimationIndex(animationIndex);
  }

  get loaded() {
    return heavyOf(this).loaded;
  }

  get scene() {
    return heavyOf(this).scene;
  }

  get clips() {
    return heavyOf(this).clips;
  }

  get clipMeta() {
    return heavyOf(this).clipMeta;
  }

  get rootNode() {
    return heavyOf(this).scene.root;
  }

  get nodeNames() {
    return heavyOf(this).scene.nodeNames;
  }

  // Tree shape for cross-game node matching (index 0 is the synthetic root)
  get rigShape(): RigShape {
    const { model } = heavyOf(this).loaded;
    const parents = resolveParents(model.skeleton);
    return {
      parents: [-1, ...parents.map((p) => (p >= 0 ? p + 1 : 0))],
      vertexCounts: [0, ...model.objects.map((o) => o.vertices.length)],
    };
  }

  // Rest pose per node (first row of the first animation file, as the scene is built)
  get restTransforms(): RestTransform[] {
    const h = heavyOf(this);
    const anim = h.loaded.anims[0]?.anim;
    const row = anim?.frames[0]?.rows[0];
    return h.scene.nodeNames.map((_, index) => {
      if (index === 0 || !anim || !row) return IDENTITY_REST;
      const object = index - 1;
      const matrix = anim.keyframes[object]?.[row[object]] ?? anim.keyframes[object]?.[0];
      return matrix ? restFromMatrix(matrixToThree(matrix)) : IDENTITY_REST;
    });
  }

  // Plays a clip whose tracks name this rig's nodes instead of the model's own animation
  playForeignClip(clip: THREE.AnimationClip) {
    const h = heavyOf(this);
    h.action?.stop();
    this.dropForeign(h);
    h.foreign = h.mixer.clipAction(clip);
    h.foreign.setLoop(THREE.LoopRepeat, Infinity);
    h.foreign.reset().play();
  }

  get foreignClipPlaying() {
    return heavyOf(this).foreign !== null;
  }

  // Starts the current clip (own or foreign) again from its first frame
  restartAnimation() {
    const h = heavyOf(this);
    (h.foreign ?? h.action)?.reset().play();
  }

  stopForeignClip() {
    const h = heavyOf(this);
    if (!h.foreign) return;
    this.dropForeign(h);
    this.setAnimationIndex(this.animationIndex);
  }

  private dropForeign(h: Heavy) {
    if (!h.foreign) return;
    const clip = h.foreign.getClip();
    h.foreign.stop();
    h.mixer.uncacheClip(clip);
    h.foreign = null;
  }

  setAnimationIndex(index: number) {
    const h = heavyOf(this);
    this.dropForeign(h);
    const clip = h.clips[index] ?? h.clips[0];
    this.animationIndex = h.clips[index] ? index : 0;
    h.action?.stop();
    if (!clip) return;
    h.action = h.mixer.clipAction(clip);
    h.action.reset();
    // Everything loops in the viewer so a short clip can be studied
    h.action.setLoop(THREE.LoopRepeat, Infinity);
    h.action.play();
  }

  remove() {
    const h = heavyOf(this);
    h.action?.stop();
    h.mixer.stopAllAction();
    h.mixer.uncacheRoot(h.scene.root);
    if (h.frameHook) {
      h.artboard.frameHooks.delete(h.frameHook);
    } else {
      h.artboard.renderer.setAnimationLoop(null);
    }
    h.artboard.remove(h.scene.root);
    h.scene.materials.forEach(({ material }) => {
      material.map?.dispose();
      material.dispose();
    });
    h.scene.nodes.forEach((node) => (node as THREE.Mesh).geometry?.dispose());
    heavyById.delete(this.heavyId);
  }
}
