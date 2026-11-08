// DigimonSwaps: applies the texture-swap animations (eye blinks, mouth flaps) that the
// Digimon World 1 exporter writes to <name>.swaps.json, on top of a glb loaded with
// GLTFLoader and driven by an ordinary AnimationMixer.
//
// Standalone: depends on three only. Works with three r150+ (handles both the old
// `encoding` and the new `colorSpace` texture properties).
//
//   const gltf = await new GLTFLoader().loadAsync("003_Agumon/003_Agumon.glb");
//   const mixer = new THREE.AnimationMixer(gltf.scene);
//   const swaps = await DigimonSwaps.load(gltf.scene, "003_Agumon/003_Agumon.swaps.json");
//   swaps.bind(mixer);
//   mixer.clipAction(gltf.animations[0]).play();
//   // each frame:
//   mixer.update(delta);
//   swaps.update();
//
// Also reads glTF produced by SydMontague's DW1ModelConverter (and jype's DW2 converter,
// which shares its exporter): those keep the swap ops in each animation's `extras`, so the
// helper rebuilds the texture states from the glb's own texture:
//
//   const swaps = await DigimonSwaps.fromGltf(gltf);

import * as THREE from "three";

export interface SwapOp {
  srcX: number;
  srcY: number;
  destX: number;
  destY: number;
  width: number;
  height: number;
}

export interface SwapEvent {
  time: number;
  state: number;
  op?: SwapOp;
}

export interface SwapClipEntry {
  events: SwapEvent[];
  loop: { start: number; end: number; repetitions: number } | null;
}

export interface SwapsFile {
  version: 1;
  timeUnitSeconds: number;
  materials: Array<{ name: string; width: number; height: number; states: string[] }>;
  animations: Record<string, SwapClipEntry>;
}

type MaterialWithMap = THREE.Material & { map: THREE.Texture | null };

interface BoundMaterial {
  material: MaterialWithMap;
  // state index -> texture
  states: THREE.Texture[];
}

function copyTextureSettings(from: THREE.Texture, to: THREE.Texture) {
  to.flipY = from.flipY;
  to.magFilter = from.magFilter;
  to.minFilter = from.minFilter;
  to.wrapS = from.wrapS;
  to.wrapT = from.wrapT;
  to.generateMipmaps = from.generateMipmaps;
  to.anisotropy = from.anisotropy;

  const source = from as unknown as Record<string, unknown>;
  const target = to as unknown as Record<string, unknown>;
  if ("colorSpace" in source) target.colorSpace = source.colorSpace;
  if ("encoding" in source) target.encoding = source.encoding;

  to.needsUpdate = true;
}

export class DigimonSwaps {
  readonly file: SwapsFile;

  private bound: BoundMaterial[] = [];
  private mixer: THREE.AnimationMixer | null = null;
  private currentState = 0;
  private custom: Record<string, SwapClipEntry> = {};

  private constructor(file: SwapsFile) {
    this.file = file;
  }

  // Fetches the JSON and its PNG states (paths resolved relative to the JSON's URL).
  static async load(
    scene: THREE.Object3D,
    url: string,
    loader = new THREE.TextureLoader(),
  ): Promise<DigimonSwaps> {
    const response = await fetch(url);
    if (!response.ok) throw Error(`DigimonSwaps: could not fetch ${url} (${response.status})`);
    const file = (await response.json()) as SwapsFile;

    const base = new URL(url, window.location.href);
    const textures = new Map<string, THREE.Texture[]>();

    for (const material of file.materials) {
      const states = await Promise.all(
        material.states.map((path) => loader.loadAsync(new URL(path, base).href)),
      );
      textures.set(material.name, states);
    }

    return DigimonSwaps.fromTextures(scene, file, textures);
  }

  // DW1ModelConverter / dw2_model_converter output: swap ops live in animation extras.
  // `gltf` is the object GLTFLoader resolves with (needs .scene, .animations, .parser).
  static async fromGltf(gltf: {
    scene: THREE.Object3D;
    animations: THREE.AnimationClip[];
    parser: { json: { animations?: Array<{ name?: string; extras?: ConverterExtras }> } };
  }): Promise<DigimonSwaps> {
    const defs = gltf.parser.json.animations ?? [];

    // Every material shares one texture in that exporter; collect the distinct maps
    const materials: MaterialWithMap[] = [];
    gltf.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      [mesh.material].flat().forEach((material) => {
        const withMap = material as MaterialWithMap;
        if (withMap.map && !materials.includes(withMap)) materials.push(withMap);
      });
    });

    const baseImages = new Map<THREE.Texture, ImageData>();
    for (const material of materials) {
      const map = material.map!;
      if (!baseImages.has(map)) baseImages.set(map, await textureToImageData(map));
    }

    const file: SwapsFile = {
      version: 1,
      timeUnitSeconds: 1 / 20,
      materials: materials.map((m, i) => ({
        name: m.name || `material_${i}`,
        width: baseImages.get(m.map!)!.width,
        height: baseImages.get(m.map!)!.height,
        states: [],
      })),
      animations: {},
    };

    // Give unnamed materials a name so the lookup below can find them
    materials.forEach((m, i) => {
      if (!m.name) m.name = file.materials[i].name;
    });

    const states: ImageData[][] = [materials.map((m) => baseImages.get(m.map!)!)];
    const stateByHash = new Map<string, number>([[hashImages(states[0]), 0]]);

    defs.forEach((def, i) => {
      const extras = def.extras;
      if (!extras?.textures?.length) return;

      const clipName = gltf.animations[i]?.name ?? def.name ?? `anim-${i}`;
      const events: SwapEvent[] = [{ time: 0, state: 0 }];
      let current = states[0];

      [...extras.textures]
        .sort((a, b) => a.time - b.time)
        .forEach((entry) => {
          const op: SwapOp = {
            // The converter writes "srxX" (typo) for the source X
            srcX: entry.srcX ?? entry.srxX ?? 0,
            srcY: entry.srcY,
            destX: entry.destX,
            destY: entry.destY,
            width: entry.width,
            height: entry.height,
          };

          current = current.map((image) => applySwapOp(image, op));
          const hash = hashImages(current);
          let state = stateByHash.get(hash);
          if (state === undefined) {
            states.push(current);
            state = states.length - 1;
            stateByHash.set(hash, state);
          }

          events.push({ time: entry.time, state, op });
        });

      const start = parseFloat(String(extras.endlessStart ?? "-1"));
      const end = parseFloat(String(extras.endlessEnd ?? "-1"));

      file.animations[clipName] = {
        events,
        loop: start >= 0 && end > start ? { start, end, repetitions: 255 } : null,
      };
    });

    const textures = new Map<string, THREE.Texture[]>();
    materials.forEach((material, m) => {
      textures.set(
        material.name,
        states.map((state) => {
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

    return DigimonSwaps.fromTextures(gltf.scene, file, textures);
  }

  // For callers that already hold the state textures (e.g. built from a zip in memory).
  static fromTextures(
    scene: THREE.Object3D,
    file: SwapsFile,
    texturesByMaterial: Map<string, THREE.Texture[]>,
  ): DigimonSwaps {
    if (file.version !== 1) {
      throw Error(`DigimonSwaps: unsupported swaps.json version ${String(file.version)}`);
    }

    const swaps = new DigimonSwaps(file);

    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;

      [mesh.material].flat().forEach((material) => {
        const withMap = material as MaterialWithMap;
        const states = texturesByMaterial.get(material.name);
        if (!states || !withMap.map) return;
        if (swaps.bound.some((b) => b.material === withMap)) return;

        states.forEach((texture) => copyTextureSettings(withMap.map!, texture));
        // Keep the glb's own texture as state 0 so nothing changes until a swap fires
        states[0] = withMap.map;

        swaps.bound.push({ material: withMap, states });
      });
    });

    return swaps;
  }

  get materials() {
    return this.bound.map((b) => b.material);
  }

  get state() {
    return this.currentState;
  }

  // Shows a texture state right now (manual posing, or your own timing logic).
  setState(state: number) {
    if (state === this.currentState) return;

    this.bound.forEach(({ material, states }) => {
      const texture = states[state];
      if (!texture) return;
      material.map = texture;
      material.needsUpdate = true;
    });

    this.currentState = state;
  }

  // Registers (or replaces) the swap track for a clip name, e.g. for a custom animation.
  sequence(clipName: string, events: SwapEvent[], loop: SwapClipEntry["loop"] = null) {
    this.custom[clipName] = {
      events: [...events].sort((a, b) => a.time - b.time),
      loop,
    };
  }

  entryFor(clipName: string): SwapClipEntry | undefined {
    return this.custom[clipName] ?? this.file.animations[clipName];
  }

  // Follows the running actions on this mixer. Call update() after mixer.update().
  bind(mixer: THREE.AnimationMixer) {
    this.mixer = mixer;
  }

  unbind() {
    this.mixer = null;
  }

  update() {
    if (!this.mixer) return;

    // AnimationMixer keeps its actions private; the first nActiveActions are the running
    // ones. There is no public way to enumerate them.
    const actions = (this.mixer as unknown as { _actions: THREE.AnimationAction[] })._actions;
    const active = (this.mixer as unknown as { _nActiveActions: number })._nActiveActions;

    let best: { weight: number; state: number } | null = null;

    for (let i = 0; i < active; i++) {
      const action = actions[i];
      if (!action.isRunning() && !action.paused) continue;

      const entry = this.entryFor(action.getClip().name);
      if (!entry) continue;

      const weight = action.getEffectiveWeight();
      if (weight <= 0) continue;

      const state = stateAt(entry, action.time);
      if (best === null || weight > best.weight) best = { weight, state };
    }

    if (best) this.setState(best.state);
  }

  dispose() {
    this.unbind();
    this.bound.forEach(({ states }) => {
      // state 0 belongs to the glb; the rest are ours
      states.slice(1).forEach((texture) => texture.dispose());
    });
    this.bound = [];
  }
}

// Shape of the animation extras DW1ModelConverter writes (GLTF.cpp buildAnimations)
interface ConverterExtras {
  textures?: Array<{
    time: number;
    srxX?: number;
    srcX?: number;
    srcY: number;
    destX: number;
    destY: number;
    width: number;
    height: number;
  }>;
  sounds?: Array<{ time: number; vabId: number; soundId: number }>;
  endlessStart?: string | number;
  endlessEnd?: string | number;
}

// Copies a rect inside the texture, the way the game's opcode 3 does
export function applySwapOp(image: ImageData, op: SwapOp): ImageData {
  const next = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);

  for (let h = 0; h < op.height; h++) {
    for (let w = 0; w < op.width; w++) {
      const sx = op.srcX + w;
      const sy = op.srcY + h;
      const dx = op.destX + w;
      const dy = op.destY + h;
      if (sx >= image.width || sy >= image.height || dx >= image.width || dy >= image.height) {
        continue;
      }
      const src = (sy * image.width + sx) * 4;
      const dest = (dy * image.width + dx) * 4;
      next.data[dest] = image.data[src];
      next.data[dest + 1] = image.data[src + 1];
      next.data[dest + 2] = image.data[src + 2];
      next.data[dest + 3] = image.data[src + 3];
    }
  }

  return next;
}

function hashImages(images: ImageData[]) {
  return images
    .map((image) => {
      let hash = 0x811c9dc5;
      for (let i = 0; i < image.data.length; i++) {
        hash ^= image.data[i];
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      return `${image.width}x${image.height}:${hash.toString(16)}`;
    })
    .join("|");
}

// Reads a loaded texture's pixels (DataTexture directly, anything else via a canvas)
async function textureToImageData(texture: THREE.Texture): Promise<ImageData> {
  const image = texture.image as
    | ImageData
    | HTMLImageElement
    | ImageBitmap
    | HTMLCanvasElement
    | { data: Uint8Array | Uint8ClampedArray; width: number; height: number };

  if ("data" in image && image.data) {
    return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  }

  const source = image as HTMLImageElement | ImageBitmap | HTMLCanvasElement;
  if ("decode" in source && typeof source.decode === "function" && !(source as HTMLImageElement).complete) {
    await (source as HTMLImageElement).decode();
  }

  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext("2d");
  if (!context) throw Error("DigimonSwaps: no 2d canvas context");
  context.drawImage(source, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

export function stateAt(entry: SwapClipEntry, time: number): number {
  let t = time;

  if (entry.loop && t >= entry.loop.start) {
    const length = entry.loop.end - entry.loop.start;
    if (length > 0) t = entry.loop.start + ((t - entry.loop.start) % length);
  }

  let state = 0;
  for (const event of entry.events) {
    if (event.time <= t) state = event.state;
    else break;
  }

  return state;
}
