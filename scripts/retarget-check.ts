// Numerical check of the cross-game retarget: for a DW1 Digimon and animation, build the
// baked DW1 clip, retarget it to the DW2 counterpart, and measure per part how much
// inv(W_dw1(t)) * W_dw2(t) drifts from its rest value over the clip (0 = the DW2 part
// follows the DW1 part's world motion exactly).
//   npx vite-node scripts/retarget-check.ts 22 GARU 2
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { IsoImage } from "../src/dw2/iso";
import { Dw2Disc } from "../src/dw2/disc";
import { matrixToThree } from "../src/dw2/scene";
import { resolveParents } from "../src/dw2/model";
import { buildNodeMap, RigShape } from "../src/models/node-map";
import { retargetClip, restFromEuler, restFromMatrix, RestTransform, IDENTITY_REST } from "../src/models/retarget";
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
  const { ANIMATION_SEQUENCE_FIXES } = await import("../src/data/fixes");

  // DW1 rig
  const n = newDigimonStruct(dw1Index).numberOfNodes;
  const ns = newNodeStructs(newSkeletonPointer(dw1Index) - PSX_MEMORY_SPACE_POINTER - FIRST_SKELETON_POINTER, n);
  const mmd = newMmd(dw1Index, n);
  const dw1Shape: RigShape = {
    parents: ns.map((s, i) => (i === 0 ? -1 : s.nodeIndex)),
    vertexCounts: ns.map((s) => (s.objectIndex > -1 ? mmd.tmd.objects[s.objectIndex].vertices.length : 0)),
  };
  const dw1Names = ns.map((_, i) => defaultNodeName(i));
  const first = mmd.animations.findIndex((a) => a !== null);
  const restBaked = bakeAnimation({ animation: mmd.animations[first]!, index: first, numberOfNodes: n });
  const dw1Rest: RestTransform[] = ns.map((_, i) => (i === 0 ? IDENTITY_REST : restFromEuler(restBaked.pose[i].position, restBaked.pose[i].rotation, restBaked.pose[i].scale)));
  const baked = bakeAnimation({ animation: mmd.animations[animIndex]!, index: animIndex, numberOfNodes: n, fixes: (ANIMATION_SEQUENCE_FIXES as any)[dw1Index]?.[animIndex] ?? {} });
  const dw1Clip = buildClipSet({ baked, nodeNames: dw1Names, baseName: clipBaseName(animIndex) }).flat;

  // DW2 rig
  const entry = disc.entries.find((e) => e.code === code)!;
  const loaded = disc.load(entry.index);
  const parents2 = resolveParents(loaded.model.skeleton);
  const dw2Shape: RigShape = { parents: [-1, ...parents2.map((p) => (p >= 0 ? p + 1 : 0))], vertexCounts: [0, ...loaded.model.objects.map((o) => o.vertices.length)] };
  const dw2Names = ["root", ...loaded.model.objects.map((_, i) => defaultNodeName(i))];
  const anim = loaded.anims[0].anim;
  const row = anim.frames[0].rows[0];
  const dw2Rest: RestTransform[] = dw2Names.map((_, i) => {
    if (i === 0) return IDENTITY_REST;
    const m = anim.keyframes[i - 1][row[i - 1]] ?? anim.keyframes[i - 1][0];
    return m ? restFromMatrix(matrixToThree(m)) : IDENTITY_REST;
  });

  const map = buildNodeMap(dw1Shape, dw2Shape);
  const { clip: out } = retargetClip({ clip: dw1Clip, sourceNames: dw1Names, sourceRest: dw1Rest, sourceParents: dw1Shape.parents, targetNames: dw2Names, targetRest: dw2Rest, targetParents: dw2Shape.parents, map, direction: "dw1->dw2", correctFrames: true });

  console.log(`DW1 ${dw1Index} anim ${animIndex} (${dw1Clip.duration.toFixed(2)} s) -> DW2 ${entry.name}; map ${map.quality}`);
  // Rest relation per pair, then drift over time
  const w1Rest = worldAt(dw1Clip, dw1Names, dw1Rest, dw1Shape.parents, -1); // t<0 samples the first key
  const w1Pose = (() => { const c = new THREE.AnimationClip("rest", 0, []); return worldAt(c, dw1Names, dw1Rest, dw1Shape.parents, 0); })();
  const w2Rest = (() => { const c = new THREE.AnimationClip("rest", 0, []); return worldAt(c, dw2Names, dw2Rest, dw2Shape.parents, 0); })();
  const steps = 8;
  console.log("pair dw1->dw2  pivots      rest-vs-idle(deg, dw1 first key vs idle pose)   max drift of inv(W1)*W2 over clip (deg)");
  map.pairs.forEach((p) => {
    const C = w2Rest[p.dw2].clone().premultiply(w1Pose[p.dw1].clone().invert());
    let maxDrift = 0;
    for (let s = 0; s <= steps; s++) {
      const t = (dw1Clip.duration * s) / steps;
      const w1 = worldAt(dw1Clip, dw1Names, dw1Rest, dw1Shape.parents, t);
      const w2 = worldAt(out, dw2Names, dw2Rest, dw2Shape.parents, t);
      const rel = w2[p.dw2].clone().premultiply(w1[p.dw1].clone().invert());
      const drift = 2 * Math.acos(Math.min(1, Math.abs(rel.dot(C)))) * (180 / Math.PI);
      maxDrift = Math.max(maxDrift, drift);
    }
    const firstVsIdle = 2 * Math.acos(Math.min(1, Math.abs(w1Rest[p.dw1].dot(w1Pose[p.dw1])))) * (180 / Math.PI);
    console.log(`${String(p.dw1).padStart(3)} -> ${String(p.dw2).padStart(3)}   [${p.dw1Pivots.join(",")}]`.padEnd(28) + `${firstVsIdle.toFixed(1).padStart(8)}` + `${maxDrift.toFixed(2).padStart(40)}`);
  });
}
main().catch((e) => { console.error(e); process.exit(1); });

