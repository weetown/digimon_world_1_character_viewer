// Bakes the project's clips into three.js AnimationClips and writes a new zip: glb with the
// original clips plus the custom ones, swaps.json with the face tracks, the PNG states,
// and the project file itself.

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter";
import { zipSync, Zippable } from "fflate";

import { Clip, FPS, Project, faceStateAt } from "./document";
import { BasePose, samplePosition, sampleRotation } from "./sampler";
import { LoadedModel } from "./load";
import { SwapsFile } from "../runtime/digimon-swaps";

export function customClipName(clip: Clip) {
  const cleaned = clip.name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return `c_${cleaned || "clip"}`;
}

// Eased curves are baked to one key per frame so the glb stays LINEAR and plays the same
// everywhere (three.js, Blender, the game's own timing).
export function bakeClip(
  clip: Clip,
  nodeNames: string[],
  rootName: string,
  base: BasePose,
): THREE.AnimationClip {
  const frames = Math.max(1, clip.length);
  const times: number[] = [];
  for (let f = 0; f <= frames; f++) times.push(f / FPS);

  const tracks: THREE.KeyframeTrack[] = [];
  const quat = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const pos = new THREE.Vector3();

  nodeNames.forEach((name) => {
    const rest = base[name];
    if (!rest) return;

    const keys = clip.nodes[name];
    const values: number[] = [];

    if (keys && keys.length) {
      times.forEach((t) => {
        sampleRotation(keys, t * FPS, quat);
        values.push(quat.x, quat.y, quat.z, quat.w);
      });
      tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, values));
    } else {
      euler.set(rest.rotation[0], rest.rotation[1], rest.rotation[2], "XYZ");
      quat.setFromEuler(euler);
      tracks.push(
        new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0], [quat.x, quat.y, quat.z, quat.w]),
      );
    }

    if (name === rootName && clip.root.length) {
      const positions: number[] = [];
      times.forEach((t) => {
        samplePosition(clip.root, t * FPS, pos);
        positions.push(pos.x, pos.y, pos.z);
      });
      tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, times, positions));
    } else if (name !== rootName) {
      tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, [0], [...rest.position]));
    }
  });

  const animationClip = new THREE.AnimationClip(customClipName(clip), frames / FPS, tracks);
  animationClip.optimize();
  return animationClip;
}

export function swapsEntryFor(clip: Clip) {
  const events = [{ time: 0, state: faceStateAt(clip, 0) }];
  clip.face.forEach((event) => {
    if (event.frame === 0) return;
    events.push({ time: event.frame / FPS, state: event.state });
  });
  return {
    events,
    loop: clip.loop ? { start: 0, end: clip.length / FPS, repetitions: 255 } : null,
  };
}

export async function exportProject(
  model: LoadedModel,
  project: Project,
  resetPose: () => void,
): Promise<{ bytes: Uint8Array; filename: string }> {
  resetPose();

  const nodeNames = [...model.nodes.keys()];
  // Clips with nothing in them are left out of the glb
  const clips = project.clips.filter(
    (clip) => Object.keys(clip.nodes).length || clip.root.length || clip.face.length,
  );
  const custom = clips.map((clip) => bakeClip(clip, nodeNames, model.rootName, model.base));

  // Clip metadata the viewer's exporter writes, extended with ours
  const meta = { ...((model.root.userData.animations as Record<string, unknown>) ?? {}) };
  clips.forEach((clip, i) => {
    meta[custom[i].name] = {
      animationIndex: -1,
      kind: "flat",
      custom: true,
      hasLoop: clip.loop,
      infiniteLoop: clip.loop,
      loopPops: false,
      hasRootMotion: clip.root.length > 0,
      hasTextureSwaps: clip.face.length > 0,
      hasSound: false,
      clampPose: false,
      returnToIdle: false,
    };
  });
  model.root.userData.animations = meta;

  // GLTFExporter writes scene extras only for a THREE.Scene; the loaded root is a Group, so
  // lend its children to a temporary Scene that carries the metadata, then give them back.
  const children = [...model.root.children];
  const wrapper = new THREE.Scene();
  wrapper.name = model.root.name;
  wrapper.userData = model.root.userData;
  children.forEach((child) => wrapper.add(child));

  let glb: ArrayBuffer;
  try {
    const exporter = new GLTFExporter();
    glb = (await exporter.parseAsync(wrapper, {
      binary: true,
      animations: [...model.gltf.animations, ...custom],
    })) as ArrayBuffer;
  } finally {
    children.forEach((child) => model.root.add(child));
  }

  const baseName = (model.zipFolder || model.sourceName.replace(/\.(glb|gltf|zip)$/i, "/")).replace(/\/$/, "");
  const folder = `${baseName}_custom`;
  const entries: Zippable = {};

  entries[`${folder}/${folder}.glb`] = new Uint8Array(glb);

  // swaps.json: original entries + ours
  const swaps: SwapsFile = model.swapsFile
    ? JSON.parse(JSON.stringify(model.swapsFile))
    : { version: 1, timeUnitSeconds: 1 / FPS, materials: [], animations: {} };
  clips.forEach((clip, i) => {
    swaps.animations[custom[i].name] = swapsEntryFor(clip);
  });
  entries[`${folder}/${folder}.swaps.json`] = new TextEncoder().encode(JSON.stringify(swaps, null, 2));

  // Copy the PNG states and anything else from the original zip except the glb/swaps
  if (model.zipEntries) {
    Object.entries(model.zipEntries).forEach(([path, bytes]) => {
      if (!path.startsWith(model.zipFolder)) return;
      const rel = path.slice(model.zipFolder.length);
      if (!rel || rel.endsWith(".glb") || rel.endsWith(".swaps.json") || rel.endsWith("/")) return;
      entries[`${folder}/${rel}`] = bytes;
    });
  }

  entries[`${folder}/poser-project.json`] = new TextEncoder().encode(JSON.stringify(project, null, 2));

  return { bytes: zipSync(entries, { level: 1 }), filename: `${folder}.zip` };
}

export function download(bytes: Uint8Array | string, filename: string, type = "application/zip") {
  const blob = new Blob([bytes], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
