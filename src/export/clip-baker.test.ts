import { describe, expect, it } from "vitest";

import { bakeAnimation, INFINITE_REPETITIONS, unrollTime } from "./clip-baker";
import { Animation } from "../structs/mmd/animation";
import { Keyframe } from "../structs/mmd/animation/sequences/keyframe";
import { Sequence } from "../structs/mmd/animation/sequences";

function keyframe(
  nodeIndex: number,
  duration: number,
  partial: Partial<Keyframe> = {},
): Keyframe {
  return {
    nodeIndex,
    hasScaleX: 0,
    hasScaleY: 0,
    hasScaleZ: 0,
    hasRotationX: 0,
    hasRotationY: 0,
    hasRotationZ: 0,
    hasPositionX: 0,
    hasPositionY: 0,
    hasPositionZ: 0,
    duration,
    scaleX: null,
    scaleY: null,
    scaleZ: null,
    rotationX: null,
    rotationY: null,
    rotationZ: null,
    positionX: null,
    positionY: null,
    positionZ: null,
    ...partial,
  };
}

function animation(
  sequences: Sequence[],
  { numberOfSequences = 20, hasScale = false } = {},
): Animation {
  return {
    pose: {
      numberOfSequences,
      hasScale: hasScale ? 128 : 0,
      // Two non-root nodes with a visible pose
      postureStructs: [
        { rotationX: 0, rotationY: 1024, rotationZ: 0, positionX: 10, positionY: 0, positionZ: 0 },
        { rotationX: 0, rotationY: 0, rotationZ: 0, positionX: 0, positionY: 5, positionZ: 0 },
      ] as Animation["pose"]["postureStructs"],
    },
    sequences,
  };
}

describe("bakeAnimation", () => {
  it("converts pose units and starts every node at its pose", () => {
    const baked = bakeAnimation({
      animation: animation([]),
      index: 0,
      numberOfNodes: 3,
    });

    expect(baked.pose[0]).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
    expect(baked.pose[1].rotation[1]).toBeCloseTo(Math.PI / 2);
    expect(baked.pose[1].position).toEqual([10, 0, 0]);
    expect(baked.pose[2].position).toEqual([0, 5, 0]);
    expect(baked.segments).toHaveLength(1);
    expect(baked.flat.nodes.size).toBe(0);
  });

  it("accumulates deltas on top of the pose with cumulative times", () => {
    const baked = bakeAnimation({
      animation: animation([
        {
          opcode: 0,
          sequenceIndex: 0,
          keyframes: [
            keyframe(1, 4, { hasRotationY: 1, rotationY: 512 }),
            keyframe(1, 6, { hasRotationY: 1, rotationY: 512 }),
          ],
        },
      ]),
      index: 0,
      numberOfNodes: 3,
    });

    const track = baked.flat.nodes.get(1)!;
    expect(track.times).toEqual([0, 4, 10]);
    expect(track.values.map((v) => v.rotation[1])).toEqual([
      Math.PI / 2,
      Math.PI / 2 + Math.PI / 4,
      Math.PI / 2 + Math.PI / 2,
    ]);
    expect(baked.hasLoop).toBe(false);
    expect(baked.hasRootMotion).toBe(false);
  });

  it("applies keyframe fixes by sequence and keyframe index", () => {
    const baked = bakeAnimation({
      animation: animation([
        {
          opcode: 0,
          sequenceIndex: 0,
          keyframes: [keyframe(1, 4, { hasRotationZ: 1, rotationZ: 100 })],
        },
      ]),
      index: 0,
      numberOfNodes: 3,
      fixes: { 0: { 0: { rotationZ: 2048 } } },
    });

    expect(baked.flat.nodes.get(1)!.values[1].rotation[2]).toBeCloseTo(Math.PI);
  });

  it("splits intro / loop / outro, unrolls finite loops and flags pops", () => {
    const baked = bakeAnimation({
      animation: animation(
        [
          {
            opcode: 0,
            sequenceIndex: 0,
            keyframes: [keyframe(1, 5, { hasPositionX: 1, positionX: 1 })],
          },
          { opcode: 1, repetitions: 3 },
          {
            opcode: 0,
            sequenceIndex: 6,
            keyframes: [keyframe(1, 4, { hasPositionX: 1, positionX: 2 })],
          },
          { opcode: 2, sequenceIndex: 10, startSequenceIndex: 6 },
          {
            opcode: 0,
            sequenceIndex: 10,
            keyframes: [keyframe(1, 10, { hasPositionX: 1, positionX: -1 })],
          },
        ],
        { numberOfSequences: 20 },
      ),
      index: 0,
      numberOfNodes: 3,
    });

    expect(baked.segments.map((s) => s.kind)).toEqual(["intro", "loop", "outro"]);
    expect(baked.segments.map((s) => s.lengthUnits)).toEqual([5, 4, 10]);
    expect(baked.hasLoop).toBe(true);
    expect(baked.infiniteLoop).toBe(false);
    expect(baked.loopPops).toBe(true);

    // intro: pose 10 -> 11; loop base 11 -> 13 (wraps 3 times); outro base 13 -> 12
    const loop = baked.segments[1].nodes.get(1)!;
    expect(loop.values.map((v) => v.position[0])).toEqual([11, 13]);

    const flat = baked.flat.nodes.get(1)!;
    expect(baked.flat.lengthUnits).toBe(5 + 4 * 3 + 10);
    // Each repetition snaps back to 11 at its start, nudged past the previous end key
    const xs = flat.values.map((v) => v.position[0]);
    expect(xs).toEqual([10, 11, 13, 11, 13, 11, 13, 12]);
    const times = flat.times;
    expect(times[0]).toBe(0);
    expect(times[1]).toBe(5);
    expect(times[2]).toBe(9);
    expect(times[3]).toBeGreaterThan(9);
    expect(times[3]).toBeLessThan(9.01);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  });

  it("plays infinite loops once in the flat clip and marks them", () => {
    const baked = bakeAnimation({
      animation: animation([
        { opcode: 1, repetitions: INFINITE_REPETITIONS },
        {
          opcode: 0,
          sequenceIndex: 1,
          keyframes: [keyframe(2, 8, { hasPositionY: 1, positionY: 3 })],
        },
        { opcode: 2, sequenceIndex: 9, startSequenceIndex: 1 },
      ]),
      index: 0,
      numberOfNodes: 3,
    });

    expect(baked.infiniteLoop).toBe(true);
    expect(baked.segments.map((s) => s.kind)).toEqual(["loop"]);
    expect(baked.flat.lengthUnits).toBe(8);
  });

  it("keeps root keyframes and reports root motion", () => {
    const baked = bakeAnimation({
      animation: animation([
        {
          opcode: 0,
          sequenceIndex: 0,
          keyframes: [keyframe(0, 4, { hasPositionZ: 1, positionZ: 40 })],
        },
      ]),
      index: 0,
      numberOfNodes: 3,
    });

    expect(baked.hasRootMotion).toBe(true);
    expect(baked.flat.nodes.get(0)!.values[1].position[2]).toBe(40);
  });

  it("collects texture and sound events and unrolls their times", () => {
    const baked = bakeAnimation({
      animation: animation([
        { opcode: 3, sequenceIndex: 2, width: 8, height: 8, srcX: 0, srcY: 0, destX: 8, destY: 0 },
        { opcode: 1, repetitions: 2 },
        { opcode: 0, sequenceIndex: 5, keyframes: [keyframe(1, 5)] },
        { opcode: 3, sequenceIndex: 6, width: 8, height: 8, srcX: 8, srcY: 0, destX: 0, destY: 0 },
        { opcode: 4, sequenceIndex: 7, value: 12 },
        { opcode: 2, sequenceIndex: 10, startSequenceIndex: 5 },
        { opcode: 3, sequenceIndex: 12, width: 8, height: 8, srcX: 0, srcY: 0, destX: 8, destY: 0 },
      ]),
      index: 0,
      numberOfNodes: 3,
    });

    expect(baked.textureEvents.map((e) => e.timeUnits)).toEqual([2, 6, 12]);
    expect(baked.textureLoop).toEqual({ startUnits: 5, endUnits: 10, repetitions: 2 });
    expect(baked.soundEvents).toEqual([{ timeUnits: 7, value: 12 }]);

    expect(unrollTime(2, baked)).toEqual([2]);
    expect(unrollTime(6, baked)).toEqual([6, 11]);
    expect(unrollTime(12, baked)).toEqual([17]);
  });
});
