import { describe, expect, it } from "vitest";
import * as THREE from "three";

import {
  History,
  faceStateAt,
  keyedFrames,
  moveKeys,
  newClip,
  newProject,
  removeKeysAt,
  setEasingAt,
  setFaceEvent,
  setRotationKey,
} from "./document";
import { ease, sampleRotation } from "./sampler";

const yTurn = (deg: number) =>
  new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180)
    .toArray() as [number, number, number, number];

const angleDeg = (q: THREE.Quaternion) =>
  (q.angleTo(new THREE.Quaternion()) * 180) / Math.PI;

describe("easing", () => {
  it("has the right end points and shapes", () => {
    expect(ease(0, "linear")).toBe(0);
    expect(ease(1, "linear")).toBe(1);
    expect(ease(0.5, "easeInOut")).toBeCloseTo(0.5);
    expect(ease(0.2, "easeInOut")).toBeCloseTo(0.08);
    expect(ease(0.5, "easeIn")).toBeCloseTo(0.25);
    expect(ease(0.5, "easeOut")).toBeCloseTo(0.75);
    expect(ease(0.9, "step")).toBe(0);
  });
});

describe("sampleRotation", () => {
  it("holds before the first and after the last key, eases in between", () => {
    const keys = [
      { frame: 0, rotation: yTurn(30), easing: "easeInOut" as const },
      { frame: 10, rotation: yTurn(-30), easing: "linear" as const },
    ];
    const out = new THREE.Quaternion();

    sampleRotation(keys, -5, out);
    expect(angleDeg(out)).toBeCloseTo(30, 3);
    sampleRotation(keys, 5, out);
    expect(angleDeg(out)).toBeCloseTo(0, 3);
    sampleRotation(keys, 2, out);
    expect(angleDeg(out)).toBeCloseTo(30 - 60 * 0.08, 3);
    sampleRotation(keys, 50, out);
    expect(angleDeg(out)).toBeCloseTo(30, 3);
  });

  it("returns false with no keys", () => {
    expect(sampleRotation([], 0, new THREE.Quaternion())).toBe(false);
  });
});

describe("document operations", () => {
  it("sets, replaces, moves and removes keys", () => {
    const clip = newClip("t");
    setRotationKey(clip, "a", 10, yTurn(10));
    setRotationKey(clip, "a", 0, yTurn(0), "easeIn");
    setRotationKey(clip, "a", 10, yTurn(20)); // replace
    expect(clip.nodes.a.map((k) => k.frame)).toEqual([0, 10]);
    expect(clip.nodes.a[1].rotation).toEqual(yTurn(20));

    moveKeys(clip, 10, 12, ["a"]);
    expect(keyedFrames(clip)).toEqual([0, 12]);

    setEasingAt(clip, 12, "all", "step");
    expect(clip.nodes.a[1].easing).toBe("step");

    removeKeysAt(clip, 0, ["a"]);
    expect(keyedFrames(clip)).toEqual([12]);
    removeKeysAt(clip, 12, "all");
    expect(clip.nodes.a).toBeUndefined();
  });

  it("resolves the face state at a frame", () => {
    const clip = newClip("t");
    setFaceEvent(clip, 10, 1);
    setFaceEvent(clip, 15, 0);
    expect(faceStateAt(clip, 0)).toBe(0);
    expect(faceStateAt(clip, 12)).toBe(1);
    expect(faceStateAt(clip, 15)).toBe(0);
  });

  it("undoes and redoes snapshots", () => {
    const history = new History();
    const project = newProject("x");
    history.push(project);
    project.clips[0].name = "changed";
    const undone = history.undo(project)!;
    expect(undone.clips[0].name).toBe("wave");
    const redone = history.redo(undone)!;
    expect(redone.clips[0].name).toBe("changed");
  });
});
