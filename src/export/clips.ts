// Turns baked animation data into self-contained three.js AnimationClips with quaternion
// rotation tracks, ready for GLTFExporter.

import * as THREE from "three";

import {
  BakedAnimation,
  BakedSegment,
  NodeTrack,
  TransformValue,
} from "./clip-baker";
import { unitsToSeconds } from "./time";

// Linear Euler interpolation and quaternion slerp diverge on big steps, and a full turn on
// one axis collapses to "no rotation" in quaternion space. Keys further apart than this on
// any axis are subdivided before conversion.
const MAX_EULER_STEP = Math.PI / 2;

export interface ClipSet {
  flat: THREE.AnimationClip;
  intro: THREE.AnimationClip | null;
  loop: THREE.AnimationClip | null;
  outro: THREE.AnimationClip | null;
  root: THREE.AnimationClip | null;
}

export interface ClipMeta {
  animationIndex: number;
  kind: "flat" | "intro" | "loop" | "outro" | "root";
  hasLoop: boolean;
  infiniteLoop: boolean;
  loopPops: boolean;
  hasRootMotion: boolean;
  hasTextureSwaps: boolean;
  hasSound: boolean;
  clampPose: boolean;
  returnToIdle: boolean;
}

export function sanitizeName(name: string, fallback = "anim") {
  const cleaned = name.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length ? cleaned : fallback;
}

export function clipBaseName(index: number, friendlyName?: string) {
  return `a${String(index).padStart(2, "0")}_${sanitizeName(friendlyName ?? "")}`;
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function lerpValue(a: TransformValue, b: TransformValue, t: number): TransformValue {
  return {
    position: [0, 1, 2].map((i) => lerp(a.position[i], b.position[i], t)) as TransformValue["position"],
    rotation: [0, 1, 2].map((i) => lerp(a.rotation[i], b.rotation[i], t)) as TransformValue["rotation"],
    scale: [0, 1, 2].map((i) => lerp(a.scale[i], b.scale[i], t)) as TransformValue["scale"],
  };
}

// Inserts intermediate keys so that no rotation axis steps more than MAX_EULER_STEP
function subdivide(track: NodeTrack): NodeTrack {
  const times: number[] = [];
  const values: TransformValue[] = [];

  for (let i = 0; i < track.times.length; i++) {
    if (i > 0) {
      const a = track.values[i - 1];
      const b = track.values[i];
      const step = Math.max(
        ...[0, 1, 2].map((k) => Math.abs(b.rotation[k] - a.rotation[k])),
      );
      const pieces = Math.ceil(step / MAX_EULER_STEP);

      for (let p = 1; p < pieces; p++) {
        const t = p / pieces;
        times.push(lerp(track.times[i - 1], track.times[i], t));
        values.push(lerpValue(a, b, t));
      }
    }

    times.push(track.times[i]);
    values.push(track.values[i]);
  }

  return { times, values };
}

function tracksFor(
  nodeName: string,
  track: NodeTrack,
): THREE.KeyframeTrack[] {
  const refined = subdivide(track);
  const times = refined.times.map(unitsToSeconds);

  const position: number[] = [];
  const quaternion: number[] = [];
  const scale: number[] = [];

  const euler = new THREE.Euler();
  const quat = new THREE.Quaternion();

  refined.values.forEach((value) => {
    position.push(...value.position);
    scale.push(...value.scale);

    euler.set(value.rotation[0], value.rotation[1], value.rotation[2], "XYZ");
    quat.setFromEuler(euler);
    quaternion.push(quat.x, quat.y, quat.z, quat.w);
  });

  return [
    new THREE.VectorKeyframeTrack(`${nodeName}.position`, times, position),
    new THREE.QuaternionKeyframeTrack(`${nodeName}.quaternion`, times, quaternion),
    new THREE.VectorKeyframeTrack(`${nodeName}.scale`, times, scale),
  ];
}

function buildClip({
  name,
  nodeNames,
  tracks,
  holds,
  lengthUnits,
  includeRoot,
}: {
  name: string;
  nodeNames: string[];
  tracks: Map<number, NodeTrack>;
  // Value for nodes with no keys (pose, or the segment's base)
  holds: TransformValue[];
  lengthUnits: number;
  includeRoot: boolean;
}) {
  const keyframeTracks: THREE.KeyframeTrack[] = [];

  nodeNames.forEach((nodeName, nodeIndex) => {
    if (nodeIndex === 0 && !includeRoot) return;

    const track = tracks.get(nodeIndex);
    if (track && track.times.length) {
      keyframeTracks.push(...tracksFor(nodeName, track));
    } else if (nodeIndex > 0) {
      keyframeTracks.push(
        ...tracksFor(nodeName, { times: [0], values: [holds[nodeIndex]] }),
      );
    }
  });

  const duration = Math.max(unitsToSeconds(lengthUnits), 0);
  const clip = new THREE.AnimationClip(name, duration, keyframeTracks);
  // A single-key clip has duration 0; give it the segment length so mixers can hold it
  if (clip.duration <= 0) clip.duration = Math.max(duration, unitsToSeconds(1));

  return clip;
}

function segmentClip(
  name: string,
  segment: BakedSegment,
  nodeNames: string[],
) {
  return buildClip({
    name,
    nodeNames,
    tracks: segment.nodes,
    holds: segment.baseAtStart,
    lengthUnits: segment.lengthUnits,
    includeRoot: false,
  });
}

export function buildClipSet({
  baked,
  nodeNames,
  baseName,
}: {
  baked: BakedAnimation;
  nodeNames: string[];
  baseName: string;
}): ClipSet {
  const flat = buildClip({
    name: baseName,
    nodeNames,
    tracks: baked.flat.nodes,
    holds: baked.pose,
    lengthUnits: baked.flat.lengthUnits,
    includeRoot: false,
  });

  let intro: THREE.AnimationClip | null = null;
  let loop: THREE.AnimationClip | null = null;
  let outro: THREE.AnimationClip | null = null;

  if (baked.hasLoop) {
    baked.segments.forEach((segment) => {
      if (segment.kind === "intro") intro = segmentClip(`${baseName}__intro`, segment, nodeNames);
      if (segment.kind === "loop") loop = segmentClip(`${baseName}__loop`, segment, nodeNames);
      if (segment.kind === "outro") outro = segmentClip(`${baseName}__outro`, segment, nodeNames);
    });
  }

  let root: THREE.AnimationClip | null = null;
  const rootTrack = baked.flat.nodes.get(0);
  if (baked.hasRootMotion && rootTrack) {
    root = new THREE.AnimationClip(
      `${baseName}__root`,
      unitsToSeconds(baked.flat.lengthUnits),
      tracksFor(nodeNames[0], rootTrack),
    );
  }

  return { flat, intro, loop, outro, root };
}
