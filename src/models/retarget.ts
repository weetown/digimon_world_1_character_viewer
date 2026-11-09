// Cross-game animation retargeting: plays a DW1 clip on a DW2 rig or the other way round.
//
// Which node drives which comes from `buildNodeMap` (node-map.ts): DW1 mesh nodes pair with
// DW2 objects by subtree shape, and the DW1 pivot nodes that DW2 folds into its objects are
// composed onto the mesh node they sit above. Only rotations cross; positions and scales are
// the target's own rest values (the games' units differ several times over).
//
// Frames. The two rigs place the same part in the same spot at rest, but each game chooses
// the part's local axes differently (the vertices are authored in that frame, so anything
// goes). A rotation copied as it is ("absolute") therefore lands in the wrong frame. The
// corrected form uses each part's world rest orientation on both sides: with
// C_i = inv(W_src_i) * W_tgt_i (world rest, source to target), a source local rotation
// L_src(t) becomes L_tgt(t) = inv(C_parent) * L_src(t) * C_i, which makes the target part
// follow the source part's world motion exactly, whatever the local axes.

import * as THREE from "three";

import { NodeMap } from "./node-map";

export interface RestTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

export const IDENTITY_REST: RestTransform = {
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

export interface RetargetResult {
  clip: THREE.AnimationClip;
  mapped: number; // target nodes that got a source rotation track
  held: number; // target nodes left at rest (no counterpart or no track)
}

// Samples a quaternion track at time t (slerp between keys, clamped at the ends)
function sampleQuaternion(track: THREE.KeyframeTrack, t: number, out: THREE.Quaternion) {
  const times = track.times;
  const values = track.values;
  if (!times.length) return out.identity();
  if (t <= times[0]) return out.fromArray(values, 0);
  const last = times.length - 1;
  if (t >= times[last]) return out.fromArray(values, last * 4);
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const a = new THREE.Quaternion().fromArray(values, lo * 4);
  const b = new THREE.Quaternion().fromArray(values, hi * 4);
  const f = (t - times[lo]) / (times[hi] - times[lo]);
  return out.copy(a).slerp(b, f);
}

// World rest rotation per node from local rests and parents (root = identity)
export function worldRestRotations(rest: RestTransform[], parents: number[]): THREE.Quaternion[] {
  const world: THREE.Quaternion[] = [];
  for (let i = 0; i < parents.length; i++) {
    const local = new THREE.Quaternion().fromArray((rest[i] ?? IDENTITY_REST).quaternion);
    const p = parents[i];
    world[i] = p >= 0 && world[p] ? world[p].clone().multiply(local) : local;
  }
  return world;
}

interface Drive {
  target: number;
  // Source nodes composed top-down to make the target's local rotation
  sources: number[];
  // Frame corrections: target local = inv(parentCorrection) * composed * ownCorrection
  parentCorrection: THREE.Quaternion;
  ownCorrection: THREE.Quaternion;
  // Rotation to take off the front (DW2 -> DW1: the held pivots above the mesh node)
  prefixInverse: THREE.Quaternion;
}

function drivesFor({
  map,
  direction,
  sourceRest,
  sourceParents,
  targetRest,
  targetParents,
}: {
  map: NodeMap;
  direction: "dw1->dw2" | "dw2->dw1";
  sourceRest: RestTransform[];
  sourceParents: number[];
  targetRest: RestTransform[];
  targetParents: number[];
}): Drive[] {
  const sourceWorld = worldRestRotations(sourceRest, sourceParents);
  const targetWorld = worldRestRotations(targetRest, targetParents);
  const dw1World = direction === "dw1->dw2" ? sourceWorld : targetWorld;
  const dw2World = direction === "dw1->dw2" ? targetWorld : sourceWorld;

  // C per pair: inv(W_dw1) * W_dw2 (DW1 frame to DW2 frame)
  const correction = new Map<number, THREE.Quaternion>(); // keyed by the DW2 object
  map.pairs.forEach((p) => {
    correction.set(p.dw2, dw1World[p.dw1].clone().invert().multiply(dw2World[p.dw2]));
  });
  const byDw1 = new Map(map.pairs.map((p) => [p.dw1, p]));
  const byDw2 = new Map(map.pairs.map((p) => [p.dw2, p]));
  const dw1Parents = direction === "dw1->dw2" ? sourceParents : targetParents;
  const dw2Parents = direction === "dw1->dw2" ? targetParents : sourceParents;

  // The paired parent of a DW1 mesh node: nearest ancestor that is in a pair
  const dw1ParentPair = (m: number) => {
    let p = dw1Parents[m];
    while (p > 0 && !byDw1.has(p)) p = dw1Parents[p];
    return p > 0 ? byDw1.get(p)! : null;
  };

  const identity = new THREE.Quaternion();

  if (direction === "dw1->dw2") {
    return map.pairs.map((p) => {
      const parentObject = dw2Parents[p.dw2];
      const parentPair = parentObject > 0 ? byDw2.get(parentObject) : undefined;
      return {
        target: p.dw2,
        sources: [...p.dw1Pivots, p.dw1],
        parentCorrection: parentPair ? correction.get(parentPair.dw2)!.clone() : identity.clone(),
        ownCorrection: correction.get(p.dw2)!.clone(),
        prefixInverse: identity.clone(),
      };
    });
  }

  // DW2 object onto the DW1 mesh node, pivots above it held at rest: with C' = inv(C),
  // L_dw1 = inv(C'_parent) * L_dw2 * C'_own = C_parent * L_dw2 * inv(C_own), and the
  // pivots' rest comes off the front
  return map.pairs.map((p) => {
    const parentPair = dw1ParentPair(p.dw1);
    const pivotsRest = new THREE.Quaternion();
    p.dw1Pivots.forEach((piv) => {
      pivotsRest.multiply(new THREE.Quaternion().fromArray((targetRest[piv] ?? IDENTITY_REST).quaternion));
    });
    return {
      target: p.dw1,
      sources: [p.dw2],
      parentCorrection: parentPair ? correction.get(parentPair.dw2)!.clone().invert() : identity.clone(),
      ownCorrection: correction.get(p.dw2)!.clone().invert(),
      prefixInverse: pivotsRest.invert(),
    };
  });
}

export function retargetClip({
  clip,
  sourceNames,
  sourceRest,
  sourceParents,
  targetNames,
  targetRest,
  targetParents,
  map,
  direction,
  correctFrames,
  name = `retarget_${clip.name}`,
}: {
  clip: THREE.AnimationClip;
  sourceNames: string[];
  sourceRest: RestTransform[];
  sourceParents: number[];
  targetNames: string[];
  targetRest: RestTransform[];
  targetParents: number[];
  map: NodeMap;
  direction: "dw1->dw2" | "dw2->dw1";
  // true: convert between the parts' local frames (see the header); false: copy rotations as they are
  correctFrames: boolean;
  name?: string;
}): RetargetResult {
  const tracks: THREE.KeyframeTrack[] = [];
  let mapped = 0;
  let held = 0;

  const drives = new Map(
    drivesFor({ map, direction, sourceRest, sourceParents, targetRest, targetParents }).map((d) => [d.target, d]),
  );
  const trackFor = (index: number) =>
    clip.tracks.find((t) => t.name === `${sourceNames[index]}.quaternion`);

  const q = new THREE.Quaternion();
  const sample = new THREE.Quaternion();
  const previous = new THREE.Quaternion();

  // Node 0 is the root on both sides and is never animated here
  for (let i = 1; i < targetNames.length; i++) {
    const targetName = targetNames[i];
    const rest = targetRest[i] ?? IDENTITY_REST;
    tracks.push(new THREE.VectorKeyframeTrack(`${targetName}.position`, [0], [...rest.position]));
    tracks.push(new THREE.VectorKeyframeTrack(`${targetName}.scale`, [0], [...rest.scale]));

    const drive = drives.get(i);
    const sourceTracks = drive?.sources.map(trackFor) ?? [];
    if (!drive || !sourceTracks.some(Boolean)) {
      tracks.push(new THREE.QuaternionKeyframeTrack(`${targetName}.quaternion`, [0], [...rest.quaternion]));
      held++;
      continue;
    }

    // Times: the union of every chain member's keys
    const timeSet = new Set<number>();
    sourceTracks.forEach((t) => t && Array.from(t.times).forEach((x) => timeSet.add(x)));
    const times = [...timeSet].sort((x, y) => x - y);

    const values: number[] = [];
    times.forEach((t, k) => {
      q.identity();
      drive.sources.forEach((s, n) => {
        const track = sourceTracks[n];
        if (track) sampleQuaternion(track, t, sample);
        else sample.fromArray((sourceRest[s] ?? IDENTITY_REST).quaternion);
        q.multiply(sample);
      });
      if (correctFrames) {
        q.premultiply(drive.parentCorrection.clone().invert()).multiply(drive.ownCorrection);
        q.premultiply(drive.prefixInverse);
      }
      if (k > 0 && q.dot(previous) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      previous.copy(q);
      values.push(q.x, q.y, q.z, q.w);
    });

    tracks.push(new THREE.QuaternionKeyframeTrack(`${targetName}.quaternion`, times, values));
    mapped++;
  }

  const out = new THREE.AnimationClip(name, clip.duration, tracks);
  return { clip: out, mapped, held };
}

// Helper for rigs that know their rest as position / Euler XYZ / scale
export function restFromEuler(
  position: [number, number, number],
  rotation: [number, number, number],
  scale: [number, number, number],
): RestTransform {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation, "XYZ"));
  return { position, quaternion: [q.x, q.y, q.z, q.w], scale };
}

export function restFromMatrix(matrix: THREE.Matrix4): RestTransform {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  matrix.decompose(p, q, s);
  return { position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w], scale: [s.x, s.y, s.z] };
}
