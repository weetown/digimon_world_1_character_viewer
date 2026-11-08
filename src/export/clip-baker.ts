// Pure conversion from the game's animation data to absolute per-node keyframes.
//
// Nothing in here touches three.js or the DOM, so it can be unit tested with synthetic
// data. The viewer (src/models/digimon.ts) builds additive clips chained through mixer
// events; this file reproduces the *result* of that chaining as plain numbers:
//
//   value(node, t) = pose(node) + Σ net delta of earlier segments + cumulative delta in this segment
//
// A "segment" is what the viewer calls an axisAnimation: the stretch before a loop, the loop
// body, and the stretch after. Loop bodies wrap (snap back to their start values each
// repetition); finished segments hold their end value (the viewer's clampWhenFinished).

import { Animation } from "../structs/mmd/animation";
import { Keyframe } from "../structs/mmd/animation/sequences/keyframe";
import { PostureStructData } from "../structs/mmd/animation/posture_struct";
import { TextureSequence } from "../structs/mmd/animation/sequences";

export const INFINITE_REPETITIONS = 255;

export type Vec3 = [number, number, number];

export interface TransformValue {
  position: Vec3;
  rotation: Vec3; // Euler XYZ, radians
  scale: Vec3;
}

export interface NodeTrack {
  // Times in duration units (not seconds), relative to the start of the segment or clip
  times: number[];
  values: TransformValue[];
}

export type SegmentKind = "body" | "intro" | "loop" | "outro";

export interface BakedSegment {
  kind: SegmentKind;
  // null when the segment is not a loop; INFINITE_REPETITIONS means forever
  repetitions: number | null;
  lengthUnits: number;
  // Every node's value when this segment starts (pose + net deltas of earlier segments).
  // Nodes without keys in the segment hold this value throughout.
  baseAtStart: TransformValue[];
  // nodeIndex -> track. Includes node 0 (root) when the data has root keys.
  nodes: Map<number, NodeTrack>;
}

export interface TextureEvent {
  timeUnits: number;
  op: Omit<TextureSequence, "opcode" | "sequenceIndex">;
}

export interface SoundEvent {
  timeUnits: number;
  value: number;
}

export interface BakedAnimation {
  index: number;
  numberOfNodes: number;
  // Per-node pose (index 0 is the root and always identity)
  pose: TransformValue[];
  segments: BakedSegment[];
  // Everything in one timeline, loops unrolled (infinite loops once)
  flat: { lengthUnits: number; nodes: Map<number, NodeTrack> };
  textureEvents: TextureEvent[];
  textureLoop: { startUnits: number; endUnits: number; repetitions: number } | null;
  soundEvents: SoundEvent[];
  hasLoop: boolean;
  infiniteLoop: boolean;
  // true when a loop body's end values differ from its start values (visible snap on wrap)
  loopPops: boolean;
  hasRootMotion: boolean;
}

export type KeyframeFix = Partial<
  Pick<
    Keyframe,
    | "scaleX"
    | "scaleY"
    | "scaleZ"
    | "rotationX"
    | "rotationY"
    | "rotationZ"
    | "positionX"
    | "positionY"
    | "positionZ"
  >
>;

// sequenceIndex -> keyframeIndex -> overrides (same shape as ANIMATION_SEQUENCE_FIXES[d][a])
export type AnimationFixes = Record<number, Record<number, KeyframeFix>>;

export function scaleFromUnits(value?: number | null) {
  if (value === undefined || value === null) return 1;
  return value / 4096;
}

export function rotationFromUnits(value?: number | null) {
  if (value === undefined || value === null) return 0;
  return (value * Math.PI) / 2048;
}

export function positionFromUnits(value?: number | null) {
  if (value === undefined || value === null) return 0;
  return value;
}

function identity(): TransformValue {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}

function cloneValue(value: TransformValue): TransformValue {
  return {
    position: [...value.position],
    rotation: [...value.rotation],
    scale: [...value.scale],
  };
}

function addDelta(value: TransformValue, delta: TransformValue): TransformValue {
  return {
    position: [
      value.position[0] + delta.position[0],
      value.position[1] + delta.position[1],
      value.position[2] + delta.position[2],
    ],
    rotation: [
      value.rotation[0] + delta.rotation[0],
      value.rotation[1] + delta.rotation[1],
      value.rotation[2] + delta.rotation[2],
    ],
    scale: [
      value.scale[0] + delta.scale[0],
      value.scale[1] + delta.scale[1],
      value.scale[2] + delta.scale[2],
    ],
  };
}

function valuesEqual(a: TransformValue, b: TransformValue, epsilon = 1e-9) {
  const channels: Array<keyof TransformValue> = ["position", "rotation", "scale"];
  return channels.every((channel) =>
    a[channel].every((v, i) => Math.abs(v - b[channel][i]) <= epsilon),
  );
}

function poseFromPosture(
  posture: PostureStructData | undefined,
  hasScale: boolean,
): TransformValue {
  if (!posture) return identity();

  const value = identity();

  if (hasScale && "scaleX" in posture) {
    value.scale = [
      scaleFromUnits(posture.scaleX),
      scaleFromUnits(posture.scaleY),
      scaleFromUnits(posture.scaleZ),
    ];
  }

  value.rotation = [
    rotationFromUnits(posture.rotationX),
    rotationFromUnits(posture.rotationY),
    rotationFromUnits(posture.rotationZ),
  ];

  value.position = [
    positionFromUnits(posture.positionX),
    positionFromUnits(posture.positionY),
    positionFromUnits(posture.positionZ),
  ];

  return value;
}

// The viewer's delta semantics: scale delta is 0 when the axis flag is off (it is additive),
// rotation/position fall back to 0 through the unit converters. Fixes override raw values.
function deltaFromKeyframe(keyframe: Keyframe, fix: KeyframeFix): TransformValue {
  const pick = <K extends keyof KeyframeFix>(key: K) =>
    fix[key] === undefined ? keyframe[key] : fix[key];

  return {
    scale: [
      keyframe.hasScaleX ? scaleFromUnits(pick("scaleX")) : 0,
      keyframe.hasScaleY ? scaleFromUnits(pick("scaleY")) : 0,
      keyframe.hasScaleZ ? scaleFromUnits(pick("scaleZ")) : 0,
    ],
    rotation: [
      rotationFromUnits(pick("rotationX")),
      rotationFromUnits(pick("rotationY")),
      rotationFromUnits(pick("rotationZ")),
    ],
    position: [
      positionFromUnits(pick("positionX")),
      positionFromUnits(pick("positionY")),
      positionFromUnits(pick("positionZ")),
    ],
  };
}

interface RawSegment {
  repetitions: number | null;
  lengthUnits: number;
  // In order of appearance; each carries its sequence/keyframe index for fixes lookup
  keyframes: Array<{ keyframe: Keyframe; sequenceIndex: number; keyframeIndex: number }>;
}

// Mirrors Digimon.newAxisAnimations' segment bookkeeping exactly.
function splitSegments(animation: Animation): RawSegment[] {
  const total = animation.pose.numberOfSequences;
  const segments: RawSegment[] = [
    { repetitions: null, lengthUnits: total, keyframes: [] },
  ];

  animation.sequences.forEach((sequence, index) => {
    const current = segments[segments.length - 1];

    if (sequence.opcode === 0) {
      sequence.keyframes.forEach((keyframe, keyframeIndex) => {
        current.keyframes.push({ keyframe, sequenceIndex: index, keyframeIndex });
      });
    } else if (sequence.opcode === 1) {
      const next = animation.sequences[index + 1];
      current.lengthUnits =
        next && next.opcode === 0 ? next.sequenceIndex - 1 : total;

      segments.push({
        repetitions: sequence.repetitions,
        lengthUnits: 0,
        keyframes: [],
      });
    } else if (sequence.opcode === 2) {
      current.lengthUnits = sequence.sequenceIndex - sequence.startSequenceIndex;

      segments.push({
        repetitions: null,
        lengthUnits: total - sequence.sequenceIndex,
        keyframes: [],
      });
    }
  });

  return segments;
}

export function bakeAnimation({
  animation,
  index,
  numberOfNodes,
  fixes = {},
}: {
  animation: Animation;
  index: number;
  numberOfNodes: number;
  fixes?: AnimationFixes;
}): BakedAnimation {
  const hasScale = animation.pose.hasScale === 128;

  const pose: TransformValue[] = [identity()];
  for (let node = 1; node < numberOfNodes; node++) {
    pose.push(poseFromPosture(animation.pose.postureStructs[node - 1], hasScale));
  }

  const rawSegments = splitSegments(animation).filter(
    (segment, _i, all) => segment.keyframes.length > 0 || all.length === 1,
  );

  // Running base per node: pose + net delta of every finished segment so far
  const base = pose.map(cloneValue);

  let hasRootMotion = false;
  let loopPops = false;

  const segments: BakedSegment[] = rawSegments.map((raw) => {
    const baseAtStart = base.map(cloneValue);
    const nodes = new Map<number, NodeTrack>();
    const cursor = new Map<number, { time: number; value: TransformValue }>();

    raw.keyframes.forEach(({ keyframe, sequenceIndex, keyframeIndex }) => {
      const node = keyframe.nodeIndex;
      if (node >= numberOfNodes) return;

      if (!nodes.has(node)) {
        const start = cloneValue(base[node]);
        nodes.set(node, { times: [0], values: [start] });
        cursor.set(node, { time: 0, value: start });
      }

      const track = nodes.get(node)!;
      const state = cursor.get(node)!;
      const delta = deltaFromKeyframe(
        keyframe,
        fixes[sequenceIndex]?.[keyframeIndex] ?? {},
      );

      state.time += keyframe.duration;
      state.value = addDelta(state.value, delta);

      track.times.push(state.time);
      track.values.push(cloneValue(state.value));

      if (
        node === 0 &&
        (delta.position.some((v) => v !== 0) ||
          delta.rotation.some((v) => v !== 0) ||
          delta.scale.some((v) => v !== 0))
      ) {
        hasRootMotion = true;
      }
    });

    // Finished segments hold their end value; that becomes the next segment's base
    nodes.forEach((track, node) => {
      const end = track.values[track.values.length - 1];
      if (raw.repetitions !== null && !valuesEqual(track.values[0], end)) {
        loopPops = true;
      }
      base[node] = cloneValue(end);
    });

    return {
      kind: "body",
      repetitions: raw.repetitions,
      lengthUnits: raw.lengthUnits,
      baseAtStart,
      nodes,
    };
  });

  // Name the segments: intro / loop / outro when a loop exists
  const loopIndex = segments.findIndex((segment) => segment.repetitions !== null);
  const hasLoop = loopIndex !== -1;
  if (hasLoop) {
    segments.forEach((segment, i) => {
      segment.kind = i < loopIndex ? "intro" : i === loopIndex ? "loop" : "outro";
    });
  }

  const infiniteLoop =
    hasLoop && segments[loopIndex].repetitions === INFINITE_REPETITIONS;

  const flat = flatten(segments);

  // Texture + sound events, in game time (sequenceIndex units)
  const textureEvents: TextureEvent[] = [];
  const soundEvents: SoundEvent[] = [];
  let textureLoop: BakedAnimation["textureLoop"] = null;
  let pendingRepetitions: number | null = null;

  animation.sequences.forEach((sequence) => {
    if (sequence.opcode === 3) {
      const { opcode: _o, sequenceIndex, ...op } = sequence;
      textureEvents.push({ timeUnits: sequenceIndex, op });
    } else if (sequence.opcode === 1) {
      pendingRepetitions = sequence.repetitions;
    } else if (sequence.opcode === 2) {
      textureLoop = {
        startUnits: sequence.startSequenceIndex,
        endUnits: sequence.sequenceIndex,
        repetitions: pendingRepetitions ?? INFINITE_REPETITIONS,
      };
    } else if (sequence.opcode === 4) {
      soundEvents.push({ timeUnits: sequence.sequenceIndex, value: sequence.value });
    }
  });

  return {
    index,
    numberOfNodes,
    pose,
    segments,
    flat,
    textureEvents,
    textureLoop,
    soundEvents,
    hasLoop,
    infiniteLoop,
    loopPops,
    hasRootMotion,
  };
}

// Keys from two neighbouring repetitions can land on the same time with different values
// (the loop snap). three.js cannot interpolate a zero-length interval, so the later key is
// nudged forward by this much, in units (1e-3 units = 0.06 ms at the current time scale).
const COLLISION_NUDGE_UNITS = 1e-3;

function flatten(segments: BakedSegment[]): BakedAnimation["flat"] {
  const nodes = new Map<number, NodeTrack>();
  let offset = 0;

  const append = (node: number, time: number, value: TransformValue) => {
    if (!nodes.has(node)) nodes.set(node, { times: [], values: [] });
    const track = nodes.get(node)!;
    const lastTime = track.times[track.times.length - 1];
    const lastValue = track.values[track.values.length - 1];

    if (lastTime !== undefined && time <= lastTime) {
      if (lastValue && valuesEqual(lastValue, value)) return;
      time = lastTime + COLLISION_NUDGE_UNITS;
    }

    track.times.push(time);
    track.values.push(cloneValue(value));
  };

  segments.forEach((segment) => {
    const repetitions =
      segment.repetitions === null
        ? 1
        : segment.repetitions === INFINITE_REPETITIONS
        ? 1
        : Math.max(1, segment.repetitions);

    for (let rep = 0; rep < repetitions; rep++) {
      segment.nodes.forEach((track, node) => {
        track.times.forEach((time, i) => {
          append(node, offset + time, track.values[i]);
        });
      });
      offset += segment.lengthUnits;
    }
  });

  // A pose-only animation has no keyframes at all; callers use `pose` for that case
  return { lengthUnits: offset, nodes };
}

// Maps a game-time (sequenceIndex) value onto the flat, unrolled timeline. Used for texture
// and sound events so they line up with the axis tracks.
export function unrollTime(
  timeUnits: number,
  baked: BakedAnimation,
): number[] {
  const loop = baked.textureLoop;
  if (!loop) return [timeUnits];

  const bodyLength = loop.endUnits - loop.startUnits;
  const repetitions =
    loop.repetitions === INFINITE_REPETITIONS ? 1 : Math.max(1, loop.repetitions);

  if (timeUnits < loop.startUnits) return [timeUnits];

  if (timeUnits < loop.endUnits) {
    return Array.from(
      { length: repetitions },
      (_, rep) => timeUnits + rep * bodyLength,
    );
  }

  return [timeUnits + (repetitions - 1) * bodyLength];
}
