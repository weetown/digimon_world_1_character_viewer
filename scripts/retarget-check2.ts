// Companion to retarget-check: (1) DW1 body/head world rotation over the clip relative to the
// idle pose, as axis-angle, (2) per part, the angle between DW1 idle world orientation and DW2
// rest world orientation (0 would mean the local axes are the same too).
//   npx vite-node scripts/retarget-check2.ts 22 GARU 2
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { IsoImage } from "../src/dw2/iso";
import { Dw2Disc } from "../src/dw2/disc";
import { matrixToThree } from "../src/dw2/scene";
import { resolveParents } from "../src/dw2/model";
import { buildNodeMap, RigShape } from "../src/models/node-map";
import { restFromEuler, restFromMatrix, RestTransform, IDENTITY_REST, worldRestRotations } from "../src/models/retarget";
import { GAME_BYTE_LENGTH, PSX_SECTOR_FOOTER_SIZE, PSX_SECTOR_HEADER_SIZE, PSX_SECTOR_SIZE } from "../src/constants";

function clean(buffer: ArrayBuffer): ArrayBuffer {
  const sectors = buffer.byteLength / PSX_SECTOR_SIZE;
  const size = PSX_SECTOR_SIZE - PSX_SECTOR_HEADER_SIZE - PSX_SECTOR_FOOTER_SIZE;
  const out = new Uint8Array(sectors * size);
  for (let i = 0; i < sectors; i++) out.set(new Uint8Array(buffer, i * PSX_SECTOR_SIZE + PSX_SECTOR_HEADER_SIZE, size), i * size);
  return out.buffer;
}
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
function sampleQ(track: THREE.KeyframeTrack | undefined, t: number, fallback: THREE.Quaternion) {
  if (!track) return fallback.clone();
  const times = track.times, v = track.values;
  if (t <= times[0]) return new THREE.Quaternion().fromArray(v, 0);
  const last = times.length - 1;
  if (t >= times[last]) return new THREE.Quaternion().fromArray(v, last * 4);
  let lo = 0, hi = last;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
  const a = new THREE.Quaternion().fromArray(v, lo * 4), b = new THREE.Quaternion().fromArray(v, hi * 4);
  return a.slerp(b, (t - times[lo]) / (times[hi] - times[lo]));
}
function worldAt(clip: THREE.AnimationClip, names: string[], rest: RestTransform[], parents: number[], t: number) {
  const world: THREE.Quaternion[] = [];
  for (let i = 0; i < parents.length; i++) {
    const track = clip.tracks.find((tr) => tr.name === `${names[i]}.quaternion`);
    const local = sampleQ(track, t, new THREE.Quaternion().fromArray((rest[i] ?? IDENTITY_REST).quaternion));
    world[i] = parents[i] >= 0 ? world[parents[i]].clone().multiply(local) : local;
  }
  return world;
}
function axisAngle(q: THREE.Quaternion) {
  const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
  const s = Math.sqrt(Math.max(0, 1 - q.w * q.w));
  const axis = s < 1e-6 ? new THREE.Vector3() : new THREE.Vector3(q.x, q.y, q.z).divideScalar(s).multiplyScalar(Math.sign(q.w) || 1);
  return `${(angle * 180 / Math.PI).toFixed(1).padStart(6)}° about (${axis.x.toFixed(2)}, ${axis.y.toFixed(2)}, ${axis.z.toFixed(2)})`;
}

async function main() {
  const [dw1Arg, code, animArg] = process.argv.slice(2);
  const dw1Index = parseInt(dw1Arg ?? "22", 10);
  const animIndex = parseInt(animArg ?? "2", 10);
  const dw1Raw = ab(readFileSync("Digimon World (USA).bin"));
  if (dw1Raw.byteLength !== GAME_BYTE_LENGTH) throw Error("DW1 size");
  (globalThis as any).window = { value: clean(dw1Raw) };
  const disc = new Dw2Disc(new IsoImage(ab(readFileSync("Digimon World 2 (USA).bin"))));
  const { newDigimonStruct } = await import("../src/structs/digimon_struct");
  const { newSkeletonPointer, FIRST_SKELETON_POINTER } = await import("../src/structs/skeleton_pointer");
  const { newNodeStructs } = await import("../src/structs/node_struct");
  const { newMmd } = await import("../src/structs/mmd");
  const { bakeAnimation } = await import("../src/export/clip-baker");
  const { buildClipSet, clipBaseName } = await import("../src/export/clips");
  const { defaultNodeName } = await import("../src/export/scene-builder");
  const { PSX_MEMORY_SPACE_POINTER } = await import("../src/constants");

  const n = newDigimonStruct(dw1Index).numberOfNodes;
  const ns = newNodeStructs(newSkeletonPointer(dw1Index) - PSX_MEMORY_SPACE_POINTER - FIRST_SKELETON_POINTER, n);
  const mmd = newMmd(dw1Index, n);
  const dw1Shape: RigShape = { parents: ns.map((s, i) => (i === 0 ? -1 : s.nodeIndex)), vertexCounts: ns.map((s) => (s.objectIndex > -1 ? mmd.tmd.objects[s.objectIndex].vertices.length : 0)) };
  const dw1Names = ns.map((_, i) => defaultNodeName(i));
  const first = mmd.animations.findIndex((a) => a !== null);
  const restBaked = bakeAnimation({ animation: mmd.animations[first]!, index: first, numberOfNodes: n });
  const dw1Rest: RestTransform[] = ns.map((_, i) => (i === 0 ? IDENTITY_REST : restFromEuler(restBaked.pose[i].position, restBaked.pose[i].rotation, restBaked.pose[i].scale)));
  const baked = bakeAnimation({ animation: mmd.animations[animIndex]!, index: animIndex, numberOfNodes: n });
  const clip = buildClipSet({ baked, nodeNames: dw1Names, baseName: clipBaseName(animIndex) }).flat;
  const idleClip = buildClipSet({ baked: restBaked, nodeNames: dw1Names, baseName: "idle" }).flat;

  const entry = disc.entries.find((e) => e.code === code)!;
  const loaded = disc.load(entry.index);
  const parents2 = resolveParents(loaded.model.skeleton);
  const dw2Shape: RigShape = { parents: [-1, ...parents2.map((p) => (p >= 0 ? p + 1 : 0))], vertexCounts: [0, ...loaded.model.objects.map((o) => o.vertices.length)] };
  const anim = loaded.anims[0].anim;
  const row = anim.frames[0].rows[0];
  const dw2Rest: RestTransform[] = dw2Shape.parents.map((_, i) => {
    if (i === 0) return IDENTITY_REST;
    const m = anim.keyframes[i - 1][row[i - 1]] ?? anim.keyframes[i - 1][0];
    return m ? restFromMatrix(matrixToThree(m)) : IDENTITY_REST;
  });
  const map = buildNodeMap(dw1Shape, dw2Shape);

  const w1Idle = worldRestRotations(dw1Rest, dw1Shape.parents);
  const w2Rest = worldRestRotations(dw2Rest, dw2Shape.parents);

  console.log(`DW1 ${dw1Index} anim ${animIndex}: world rotation of each part vs the idle POSE, sampled over the clip`);
  const steps = 6;
  map.pairs.slice(0, 6).forEach((p) => {
    const line = [`dw1 ${String(p.dw1).padStart(2)}:`];
    for (let s = 0; s <= steps; s++) {
      const t = (clip.duration * s) / steps;
      const w = worldAt(clip, dw1Names, dw1Rest, dw1Shape.parents, t);
      line.push(axisAngle(w[p.dw1].clone().premultiply(w1Idle[p.dw1].clone().invert())));
    }
    console.log(line.join("\n     "));
  });
  console.log(`\nSame for the idle animation's own clip (first key vs the pose):`);
  map.pairs.slice(0, 3).forEach((p) => {
    const w = worldAt(idleClip, dw1Names, dw1Rest, dw1Shape.parents, 0);
    console.log(`dw1 ${String(p.dw1).padStart(2)}: ${axisAngle(w[p.dw1].clone().premultiply(w1Idle[p.dw1].clone().invert()))}`);
  });
  console.log(`\nRest relation per pair, C = inv(W_dw1_idle) * W_dw2_rest (local-axes difference + any visual pose difference):`);
  map.pairs.forEach((p) => {
    const C = w2Rest[p.dw2].clone().premultiply(w1Idle[p.dw1].clone().invert());
    console.log(`${String(p.dw1).padStart(3)} -> ${String(p.dw2).padStart(3)}  ${axisAngle(C)}`);
  });
}
main().catch((e) => { console.error(e); process.exit(1); });
