// Loads a model for the poser from an export zip (viewer) or a bare glb/gltf (this
// viewer's, DW1ModelConverter's or dw2_model_converter's).

import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader";
import { unzipSync } from "fflate";

import { DigimonSwaps, SwapsFile } from "../runtime/digimon-swaps";
import { BasePose } from "./sampler";

export interface LoadedModel {
  sourceName: string;
  gltf: GLTF;
  root: THREE.Object3D; // gltf.scene
  // Posable nodes by name (the game's parts). Excludes GLTFLoader's split mesh children.
  nodes: Map<string, THREE.Object3D>;
  rootName: string;
  // Mesh -> owning node name, for picking
  meshOwner: Map<THREE.Object3D, string>;
  base: BasePose;
  swaps: DigimonSwaps | null;
  swapsFile: SwapsFile | null;
  // Thumbnails (data URLs) of each texture state, from the first material
  stateThumbs: string[];
  // Original glb bytes and the zip's other files (for re-export)
  glbBytes: Uint8Array;
  zipEntries: Record<string, Uint8Array> | null;
  zipFolder: string;
}

function sliceBytes(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function bitmapToDataUrl(bitmap: ImageBitmap, size = 64) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = Math.max(1, Math.round((size * bitmap.height) / bitmap.width));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

async function textureToDataUrl(texture: THREE.Texture, size = 64) {
  const image = texture.image as ImageBitmap | HTMLImageElement | { data: Uint8ClampedArray; width: number; height: number };
  const canvas = document.createElement("canvas");
  if ("data" in image && image.data) {
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    const small = document.createElement("canvas");
    small.width = size;
    small.height = Math.max(1, Math.round((size * image.height) / image.width));
    const ctx = small.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(canvas, 0, 0, small.width, small.height);
    return small.toDataURL("image/png");
  }
  return bitmapToDataUrl(image as ImageBitmap, size);
}

// Collects the posable nodes: named objects that are not GLTFLoader's "mesh_*" children.
function collectNodes(root: THREE.Object3D) {
  const nodes = new Map<string, THREE.Object3D>();
  const meshOwner = new Map<THREE.Object3D, string>();

  const declared = (root.userData.nodeNames as string[] | undefined) ?? null;

  root.traverse((object) => {
    if (object === root) return;
    const isSplitMesh = (object as THREE.Mesh).isMesh && /^mesh[_-]?\d/.test(object.name);
    const isDeclared = declared ? declared.includes(object.name) : object.name.length > 0 && !isSplitMesh;
    if (isDeclared && !nodes.has(object.name)) nodes.set(object.name, object);
  });

  root.traverse((object) => {
    if (!(object as THREE.Mesh).isMesh) return;
    let cursor: THREE.Object3D | null = object;
    while (cursor && !nodes.has(cursor.name)) cursor = cursor.parent;
    if (cursor) meshOwner.set(object, cursor.name);
  });

  return { nodes, meshOwner };
}

// Pose from the first frame of the first clip (idle), then record it as the base
function captureBase(gltf: GLTF, nodes: Map<string, THREE.Object3D>): BasePose {
  if (gltf.animations.length) {
    const mixer = new THREE.AnimationMixer(gltf.scene);
    const idle =
      gltf.animations.find((c) => /^a00_/.test(c.name)) ??
      gltf.animations.find((c) => c.name === "anim-0") ??
      gltf.animations[0];
    const action = mixer.clipAction(idle);
    action.play();
    mixer.update(0);
    action.stop();
    mixer.stopAllAction();
    mixer.uncacheRoot(gltf.scene);
  }

  const base: BasePose = {};
  nodes.forEach((node, name) => {
    base[name] = {
      position: node.position.toArray() as [number, number, number],
      rotation: [node.rotation.x, node.rotation.y, node.rotation.z],
      scale: node.scale.toArray() as [number, number, number],
    };
  });
  return base;
}

export async function loadModelFile(file: File): Promise<LoadedModel> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const loader = new GLTFLoader();

  let gltf: GLTF;
  let swaps: DigimonSwaps | null = null;
  let swapsFile: SwapsFile | null = null;
  let stateThumbs: string[] = [];
  let glbBytes = bytes;
  let zipEntries: Record<string, Uint8Array> | null = null;
  let zipFolder = "";

  if (file.name.toLowerCase().endsWith(".zip")) {
    zipEntries = unzipSync(bytes);
    const glbPath = Object.keys(zipEntries).find((p) => p.endsWith(".glb"));
    const swapsPath = Object.keys(zipEntries).find((p) => p.endsWith(".swaps.json"));
    if (!glbPath) throw Error("zip has no .glb");

    zipFolder = glbPath.slice(0, glbPath.lastIndexOf("/") + 1);
    glbBytes = zipEntries[glbPath];
    gltf = await loader.parseAsync(sliceBytes(glbBytes), "");

    if (swapsPath) {
      swapsFile = JSON.parse(new TextDecoder().decode(zipEntries[swapsPath])) as SwapsFile;
      const textures = new Map<string, THREE.Texture[]>();
      const bitmaps: ImageBitmap[] = [];

      for (const [m, material] of swapsFile.materials.entries()) {
        const states = await Promise.all(
          material.states.map(async (path) => {
            const png = zipEntries![zipFolder + path];
            const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
            if (m === 0) bitmaps.push(bitmap);
            const texture = new THREE.Texture(bitmap);
            texture.needsUpdate = true;
            return texture;
          }),
        );
        textures.set(material.name, states);
      }

      swaps = DigimonSwaps.fromTextures(gltf.scene, swapsFile, textures);
      stateThumbs = await Promise.all(bitmaps.map((b) => bitmapToDataUrl(b)));
    }
  } else {
    gltf = await loader.parseAsync(sliceBytes(bytes), "");
    swaps = await DigimonSwaps.fromGltf(gltf);
    swapsFile = swaps.file;
    const first = swaps.materials[0];
    if (first) {
      const bound = (swaps as unknown as { bound: Array<{ states: THREE.Texture[] }> }).bound[0];
      stateThumbs = await Promise.all(bound.states.map((t) => textureToDataUrl(t)));
    }
  }

  const { nodes, meshOwner } = collectNodes(gltf.scene);
  const base = captureBase(gltf, nodes);

  // The root node is the first declared name or the top-most node
  const declared = gltf.scene.userData.nodeNames as string[] | undefined;
  const rootName =
    declared?.[0] ??
    [...nodes.entries()].find(([, n]) => n.parent === gltf.scene)?.[0] ??
    [...nodes.keys()][0];

  return {
    sourceName: file.name,
    gltf,
    root: gltf.scene,
    nodes,
    rootName,
    meshOwner,
    base,
    swaps,
    swapsFile,
    stateThumbs,
    glbBytes,
    zipEntries,
    zipFolder,
  };
}
