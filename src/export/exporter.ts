// Orchestrates one Digimon's export: glb + swaps + raw dumps + sidecars, as an in-memory
// folder of files. Zipping and downloading live in zip.ts.

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter";

import { Info } from "../models/info";
import { newSkeletonPointer, FIRST_SKELETON_POINTER } from "../structs/skeleton_pointer";
import { newNodeStructs } from "../structs/node_struct";
import { newMmd } from "../structs/mmd";
import { PSX_MEMORY_SPACE_POINTER } from "../constants";
import { ANIMATIONS } from "../contents/animations";
import {
  ANIMATION_CLAMP_IDLE,
  ANIMATION_CLAMP_POSE,
  ANIMATION_SEQUENCE_FIXES,
} from "../data/fixes";

import { bakeAnimation, BakedAnimation, AnimationFixes } from "./clip-baker";
import { buildExportScene, resolveNodeNames, ExportScene } from "./scene-builder";
import { buildClipSet, clipBaseName, ClipMeta } from "./clips";
import { buildSwaps, SwapsFile } from "./swaps";
import { imageDataToPng } from "./png";
import { dumpRaw } from "./raw";
import { TIME_UNIT_SECONDS } from "./time";

export const EXPORTER_VERSION = "0.1.0";

export interface DigimonPackage {
  index: number;
  name: string;
  folder: string;
  // path inside the folder -> bytes
  files: Record<string, Uint8Array>;
  // Kept in memory for the compare view
  glb: ArrayBuffer;
  swaps: SwapsFile;
  // state index -> per material ImageData
  swapStates: ImageData[][];
  clipNames: string[];
  warnings: string[];
}

export interface NodesSidecar {
  version: 1;
  digimonIndex: number;
  names: Record<string, string>;
}

function sanitizeFolderName(name: string) {
  const cleaned = name.replace(/[^A-Za-z0-9_]+/g, "");
  return cleaned.length ? cleaned : "Digimon";
}

export function folderNameFor(index: number, name: string) {
  return `${String(index).padStart(3, "0")}_${sanitizeFolderName(name)}`;
}

function readmeText({
  name,
  index,
  folder,
  nodeCount,
  clipNames,
}: {
  name: string;
  index: number;
  folder: string;
  nodeCount: number;
  clipNames: string[];
}) {
  return `${name} (Digimon World, PSX USA) - index ${index}

Exported by the Digimon World 1 Character Viewer, exporter ${EXPORTER_VERSION}.
Game data belongs to Bandai. The viewer's code is AGPL-3.0; these files are for your own
archive and projects.

Files
  ${folder}.glb          Model, node tree, texture(s) and the game's animations as clips.
  ${folder}.swaps.json   Texture-swap timing (eye blinks, mouth flaps) per clip.
  swaps/<material>/      PNG of each texture state referenced by swaps.json.
  nodes.json             Node naming sidecar. Edit the names, upload it in the viewer and
                         re-export to get a glb with your names.
  raw/                   Byte-exact slices of the game data and a JSON of the parsed
                         animations with raw integer values.

Rig
  ${nodeCount} nodes. The game uses rigid parts parented in a tree, not a skinned mesh:
  rotate a node and everything under it follows. Node names default to node_NN.
  The root node carries a 180 degree rotation about X (the viewer's handedness fix); leave
  it alone and pose the children. Units are the game's (no rescale).

Animations
  One clip per game animation, named aNN_<name>. Clips with a loop also ship as
  aNN_<name>__intro, __loop and __outro so you can LoopRepeat the body. __root clips hold
  root-node motion the game data carries for that animation (kept out of the main clip).
  Rotations are quaternions baked from the game's Euler XYZ keys.
  Time: one game duration unit = ${TIME_UNIT_SECONDS} s (see extras.timeUnitSeconds).
  Clip metadata lives in the scene's extras.animations[clipName].

Texture swaps
  glTF has no slot for them, so they live in ${folder}.swaps.json. Load it with the
  DigimonSwaps helper from the viewer repo (src/runtime/digimon-swaps.ts) and call
  update() after your mixer each frame.

Clips in this file
${clipNames.map((clip) => `  ${clip}`).join("\n")}
`;
}

export async function exportDigimon({
  index,
  nodeNames: customNames = {},
}: {
  index: number;
  nodeNames?: Record<string, string>;
}): Promise<DigimonPackage> {
  const warnings: string[] = [];

  const info = new Info({ index });
  const name = info.name;
  const folder = folderNameFor(index, name);
  const numberOfNodes = info.digimonStruct.numberOfNodes;

  const skeletonPointer = newSkeletonPointer(index);
  const nodeStructs = newNodeStructs(
    skeletonPointer - PSX_MEMORY_SPACE_POINTER - FIRST_SKELETON_POINTER,
    numberOfNodes,
  );
  const mmd = newMmd(index, numberOfNodes);

  const { names: nodeNames, warnings: nameWarnings } = resolveNodeNames(
    numberOfNodes,
    customNames,
  );
  warnings.push(...nameWarnings);

  const fixesForDigimon = (ANIMATION_SEQUENCE_FIXES[index] ?? {}) as Record<
    number,
    AnimationFixes
  >;

  // Bake every animation
  const baked: Array<{ baked: BakedAnimation; baseName: string } | null> =
    mmd.animations.map((animation, animationIndex) => {
      if (!animation) return null;
      return {
        baked: bakeAnimation({
          animation,
          index: animationIndex,
          numberOfNodes,
          fixes: fixesForDigimon[animationIndex] ?? {},
        }),
        baseName: clipBaseName(animationIndex, ANIMATIONS[animationIndex]),
      };
    });

  const restPose = baked.find((b) => b !== null)?.baked.pose ?? [];

  const exportScene: ExportScene = buildExportScene({
    mmd,
    tim: info.tim,
    nodeStructs,
    nodeNames,
    restPose,
  });

  if (exportScene.hasUntexturedPrimitives) {
    warnings.push(
      "TMD has untextured primitives; the viewer draws them without vertex colours and so does this export",
    );
  }

  if (nodeStructs[0]?.objectIndex > -1) {
    warnings.push("root node carries a mesh; check its orientation in the glb");
  }

  // Clips + metadata
  const clips: THREE.AnimationClip[] = [];
  const clipMeta: Record<string, ClipMeta> = {};

  baked.forEach((entry) => {
    if (!entry) return;
    const { baked: animation, baseName } = entry;

    const set = buildClipSet({ baked: animation, nodeNames, baseName });

    const meta = (kind: ClipMeta["kind"]): ClipMeta => ({
      animationIndex: animation.index,
      kind,
      hasLoop: animation.hasLoop,
      infiniteLoop: animation.infiniteLoop,
      loopPops: animation.loopPops,
      hasRootMotion: animation.hasRootMotion,
      hasTextureSwaps: animation.textureEvents.length > 0,
      hasSound: animation.soundEvents.length > 0,
      clampPose: ANIMATION_CLAMP_POSE[index]?.includes(animation.index) ?? false,
      returnToIdle: ANIMATION_CLAMP_IDLE[index]?.[animation.index] !== undefined,
    });

    clips.push(set.flat);
    clipMeta[set.flat.name] = meta("flat");

    (["intro", "loop", "outro", "root"] as const).forEach((kind) => {
      const clip = set[kind];
      if (clip) {
        clips.push(clip);
        clipMeta[clip.name] = meta(kind);
      }
    });
  });

  // Scene-level metadata rides on the glTF scene extras
  const scene = new THREE.Scene();
  scene.name = folder;
  scene.add(exportScene.root);
  scene.userData = {
    game: "Digimon World (PSX, USA)",
    digimonIndex: index,
    name,
    height: info.digimonStruct.height,
    radius: info.digimonStruct.radius,
    type: info.digimonStruct.type,
    level: info.digimonStruct.level,
    timeUnitSeconds: TIME_UNIT_SECONDS,
    exporter: { tool: "digimon_world_1_character_viewer", version: EXPORTER_VERSION },
    nodeNames,
    animations: clipMeta,
  };

  const exporter = new GLTFExporter();
  const glb = (await exporter.parseAsync(scene, {
    binary: true,
    animations: clips,
    includeCustomExtensions: false,
  })) as ArrayBuffer;

  // Texture swaps
  const texturedMaterials = exportScene.materials.filter(
    (m): m is typeof m & { baseImage: ImageData } => m.baseImage !== null,
  );

  const swaps = buildSwaps({
    materials: texturedMaterials.map((m) => ({ name: m.name, baseImage: m.baseImage })),
    animations: baked.filter((b): b is NonNullable<typeof b> => b !== null),
  });

  // Files
  const files: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();

  files[`${folder}.glb`] = new Uint8Array(glb);
  files[`${folder}.swaps.json`] = encoder.encode(JSON.stringify(swaps.file, null, 2));

  for (let s = 0; s < swaps.states.length; s++) {
    for (let m = 0; m < texturedMaterials.length; m++) {
      const path = swaps.file.materials[m].states[s];
      files[path] = await imageDataToPng(swaps.states[s][m]);
    }
  }

  const sidecar: NodesSidecar = {
    version: 1,
    digimonIndex: index,
    names: Object.fromEntries(nodeNames.map((n, i) => [String(i), n])),
  };
  files["nodes.json"] = encoder.encode(JSON.stringify(sidecar, null, 2));

  Object.assign(
    files,
    dumpRaw({
      index,
      mmd,
      nodeStructs,
      skeletonPointer,
      digimonStruct: info.digimonStruct,
      name,
      fixes: fixesForDigimon,
    }),
  );

  const clipNames = clips.map((clip) => clip.name);
  files["README.txt"] = encoder.encode(
    readmeText({ name, index, folder, nodeCount: numberOfNodes, clipNames }),
  );

  // Free the export scene's GPU-side objects (none were uploaded, but be tidy)
  exportScene.materials.forEach(({ material }) => {
    (material as THREE.MeshStandardMaterial).map?.dispose();
    material.dispose();
  });

  return {
    index,
    name,
    folder,
    files,
    glb,
    swaps: swaps.file,
    swapStates: swaps.states,
    clipNames,
    warnings,
  };
}
