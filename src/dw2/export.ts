// DW2 export: same package shape as the DW1 exporter (glb + swaps.json + nodes.json + raw
// dumps + README) so the compare view, the poser and the zip code work unchanged.

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter";

import { DigimonPackage, EXPORTER_VERSION, NodesSidecar, folderNameFor } from "../export/exporter";
import { resolveNodeNames } from "../export/scene-builder";
import { SwapsFile } from "../export/swaps";
import { imageDataToPng } from "../export/png";
import { Dw2Disc } from "./disc";
import { buildDw2Scene, buildDw2Clips, DW2_ROOT_NAME } from "./scene";
import { DW2_FRAME_RATE } from "./anim";
import { paletteImage } from "./model";
import { parseBlink, blinkIndices } from "./blink";

function readmeText({ name, folder, nodeCount, clipNames, reversedWinding }: { name: string; folder: string; nodeCount: number; clipNames: string[]; reversedWinding: boolean }) {
  return `${name} (Digimon World 2, PSX USA)

Exported by the Digimon World 1 Character Viewer, exporter ${EXPORTER_VERSION} (DW2 path).
Game data belongs to Bandai. The viewer's code is AGPL-3.0; these files are for your own
archive and projects.

Files
  ${folder}.glb          Model, node tree, texture(s) and the game's animations as clips.
  ${folder}.swaps.json   Texture states per material. State 0 is the stored texture; the
                         others copy each spare eye image from the model's blink table over
                         the eye rectangle (extras.blink). The game's blink timing is not
                         decoded, so no clip carries events: key the states by hand.
  swaps/<material>/      PNG of each state.
  nodes.json             Node naming sidecar. Edit, upload in the viewer, re-export.
  raw/                   Byte-exact copies of the M (model) and A..K (animation) files, plus
                         a JSON of the parsed skeleton and animation tables.

Rig
  ${nodeCount} nodes: a synthetic "${DW2_ROOT_NAME}" carrying the half-turn about X, then one
  rigid part per game object (node_NN), parented as the game's skeleton table says. The game
  stores a full 3x3 matrix + translation per keyframe; those are decomposed to TRS here.
  Winding ${reversedWinding ? "was" : "was not"} reversed to agree with the stored normals.

Animations
  One clip per animation file (A..K) and frame block, named aNN_<letter>. Rows are sampled
  at ${DW2_FRAME_RATE} fps (dw2_model_converter's assumption; extras.timeUnitSeconds).
  extras.animations[clip] carries terminationMask (0xfe loops) and loopMask.

Clips in this file
${clipNames.map((clip) => `  ${clip}`).join("\n")}
`;
}

export async function exportDw2Digimon({
  disc,
  index,
  nodeNames: customNames = {},
}: {
  disc: Dw2Disc;
  index: number;
  nodeNames?: Record<string, string>;
}): Promise<DigimonPackage> {
  const warnings: string[] = [];
  const loaded = disc.load(index);
  const { entry, model, anims } = loaded;
  const name = entry.name;
  const folder = folderNameFor(entry.number, `${entry.code}`);
  const nodeCount = model.objects.length + 1;

  // Custom names are keyed by node index (0 = root) like the DW1 sidecar
  const defaults = [DW2_ROOT_NAME, ...model.objects.map((_, i) => `node_${String(i).padStart(2, "0")}`)];
  const { names: nodeNames, warnings: nameWarnings } = resolveNodeNames(nodeCount, {
    ...Object.fromEntries(defaults.map((n, i) => [String(i), n])),
    ...customNames,
  });
  warnings.push(...nameWarnings);

  const scene = buildDw2Scene({ model, anims: anims.map((a) => a.anim), nodeNames });
  const { clips, meta } = buildDw2Clips({ anims, nodeNames });

  if (!anims.length) warnings.push("no animation files; rest pose is the identity");
  // Several root objects per model are the norm (upper and lower body), so not a warning;
  // raw/parsed.json carries the parent table.

  const wrapper = new THREE.Scene();
  wrapper.name = folder;
  wrapper.add(scene.root);
  wrapper.userData = {
    game: "Digimon World 2 (PSX, USA)",
    digimonIndex: entry.number,
    modelStem: entry.stem,
    name,
    height: scene.bounds.getSize(new THREE.Vector3()).y,
    radius: Math.max(scene.bounds.getSize(new THREE.Vector3()).x, scene.bounds.getSize(new THREE.Vector3()).z) / 2,
    timeUnitSeconds: 1 / DW2_FRAME_RATE,
    exporter: { tool: "digimon_world_1_character_viewer", version: EXPORTER_VERSION },
    nodeNames,
    animations: meta,
    blink: Array.from(model.blink),
  };

  const glb = (await new GLTFExporter().parseAsync(wrapper, {
    binary: true,
    animations: clips,
    includeCustomExtensions: false,
  })) as ArrayBuffer;

  const files: Record<string, Uint8Array> = {};
  const encoder = new TextEncoder();
  files[`${folder}.glb`] = new Uint8Array(glb);

  // Swaps file: state 0 is the texture as stored; states 1..N copy each blink source over
  // the eye rectangle. The game's blink timing is not decoded, so no clip has events; the
  // states are there for hand-keyed faces in the poser.
  const blink = parseBlink(model.blink);
  const stateCount = 1 + (blink?.sources.length ?? 0);
  const stateName = (s: number) => `state_${String(s).padStart(2, "0")}.png`;

  const swapStates: ImageData[][] = [];
  for (let s = 0; s < stateCount; s++) {
    const tim = s === 0 || !blink ? model.tim : { ...model.tim, indices: blinkIndices(model.tim, blink, s - 1) };
    swapStates.push(scene.materials.map((m) => paletteImage(tim, m.clut, m.semiTransparent)));
  }

  const swaps: SwapsFile = {
    version: 1,
    timeUnitSeconds: 1 / DW2_FRAME_RATE,
    materials: scene.materials.map((m) => ({
      name: m.name,
      width: m.baseImage.width,
      height: m.baseImage.height,
      states: Array.from({ length: stateCount }, (_, s) => `swaps/${m.name}/${stateName(s)}`),
    })),
    animations: {},
    extras: blink
      ? { blink: { dest: blink.dest, sources: blink.sources, raw: blink.raw } }
      : { blinkRaw: Array.from(model.blink) },
  };
  files[`${folder}.swaps.json`] = encoder.encode(JSON.stringify(swaps, null, 2));
  for (let s = 0; s < stateCount; s++) {
    for (const [m, material] of scene.materials.entries()) {
      files[`swaps/${material.name}/${stateName(s)}`] = await imageDataToPng(swapStates[s][m]);
    }
  }
  if (!blink) warnings.push("blink bytes not understood; only the stored texture is exported");

  const sidecar: NodesSidecar = {
    version: 1,
    digimonIndex: entry.number,
    names: Object.fromEntries(nodeNames.map((n, i) => [String(i), n])),
  };
  files["nodes.json"] = encoder.encode(JSON.stringify(sidecar, null, 2));

  files[`raw/${entry.stem}/M${entry.stem}.BIN`] = loaded.modelBytes;
  anims.forEach((a) => (files[`raw/${entry.stem}/${a.letter}${entry.stem}.BIN`] = a.bytes));
  files["raw/parsed.json"] = encoder.encode(
    JSON.stringify(
      {
        stem: entry.stem,
        skeleton: model.skeleton,
        parents: model.parents,
        blink: Array.from(model.blink),
        timStart: model.timStart,
        timEnd: model.timEnd,
        objects: model.objects.map((o) => ({ vertices: o.vertices.length, normals: o.normals.length, primitives: o.primitives.length })),
        animations: anims.map((a) => ({
          letter: a.letter,
          keyframesPerObject: a.anim.keyframes.map((k) => k.length),
          frames: a.anim.frames.map((f) => ({ rows: f.rows.length, terminationMask: f.terminationMask, loopMask: f.loopMask })),
        })),
        units: { matrix: "3.12 fixed point, stored row-major, read transposed (see scene.ts)", translation: "raw int16", frameRate: DW2_FRAME_RATE },
      },
      null,
      2,
    ),
  );

  const clipNames = clips.map((c) => c.name);
  files["README.txt"] = encoder.encode(readmeText({ name, folder, nodeCount, clipNames, reversedWinding: scene.reversedWinding }));

  scene.materials.forEach(({ material }) => {
    material.map?.dispose();
    material.dispose();
  });

  return { index, name, folder, files, glb, swaps, swapStates, clipNames, warnings };
}
