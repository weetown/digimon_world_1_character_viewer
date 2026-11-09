import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { retargetClip, RestTransform, IDENTITY_REST, worldRestRotations } from "./retarget";
import { buildNodeMap, RigShape } from "./node-map";

function quat(axis: THREE.Vector3, angle: number) {
  return new THREE.Quaternion().setFromAxisAngle(axis, angle);
}

function rest(q: THREE.Quaternion, position: [number, number, number] = [0, 0, 0]): RestTransform {
  return { position, quaternion: [q.x, q.y, q.z, q.w], scale: [1, 1, 1] };
}

function qTrack(name: string, times: number[], qs: THREE.Quaternion[]) {
  return new THREE.QuaternionKeyframeTrack(
    `${name}.quaternion`,
    times,
    qs.flatMap((q) => [q.x, q.y, q.z, q.w]),
  );
}

function sameRotation(a: THREE.Quaternion, b: THREE.Quaternion) {
  expect(Math.abs(a.dot(b))).toBeCloseTo(1, 5);
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

describe("buildNodeMap", () => {
  // DW1: root, pivot(1) -> body(2, 20 verts) -> pivot(3) -> leg(4, 8) ; body -> arm(5, 6)
  const dw1: RigShape = {
    parents: [-1, 0, 1, 2, 3, 2],
    vertexCounts: [0, 0, 20, 0, 8, 6],
  };

  it("pairs mesh nodes in sequence and records the pivots above each", () => {
    const dw2: RigShape = { parents: [-1, 0, 1, 1], vertexCounts: [0, 20, 8, 6] };
    const map = buildNodeMap(dw1, dw2);
    expect(map.quality).toBe("exact");
    expect(map.pairs).toEqual([
      { dw1: 2, dw2: 1, dw1Pivots: [1], exact: true },
      { dw1: 4, dw2: 2, dw1Pivots: [3], exact: true },
      { dw1: 5, dw2: 3, dw1Pivots: [], exact: true },
    ]);
  });

  it("pairs subtrees by shape when DW2 lists them in another order", () => {
    const dw2: RigShape = { parents: [-1, 0, 1, 1], vertexCounts: [0, 20, 6, 8] };
    const map = buildNodeMap(dw1, dw2);
    expect(map.quality).toBe("shape");
    expect(map.pairs.map((p) => [p.dw1, p.dw2])).toEqual([
      [2, 1],
      [5, 2],
      [4, 3],
    ]);
  });

  it("falls back to order for a remeshed part and reports partial", () => {
    const dw2: RigShape = { parents: [-1, 0, 1, 1], vertexCounts: [0, 20, 9, 6] };
    const map = buildNodeMap(dw1, dw2);
    expect(map.quality).toBe("partial");
    expect(map.pairs.find((p) => p.dw1 === 4)).toEqual({ dw1: 4, dw2: 2, dw1Pivots: [3], exact: false });
  });
});

describe("retargetClip", () => {
  // DW1 source: root(0) -> pivot(1) -> body(2) -> leg(3). DW2 target: root(0) -> body(1) -> leg(2).
  // The DW2 parts rest in the same world orientation as the DW1 parts but with their own
  // local axes (a different twist per part).
  const dw1: RigShape = { parents: [-1, 0, 1, 2], vertexCounts: [0, 0, 10, 4] };
  const dw2: RigShape = { parents: [-1, 0, 1], vertexCounts: [0, 10, 4] };
  const map = buildNodeMap(dw1, dw2);
  const dw1Names = ["node_00", "node_01", "node_02", "node_03"];
  const dw2Names = ["root", "node_00", "node_01"];

  const pivotRest = quat(X, Math.PI / 6);
  const bodyRest = quat(Z, Math.PI / 8);
  const legRest = quat(Y, Math.PI / 5);
  const dw1Rest: RestTransform[] = [IDENTITY_REST, rest(pivotRest), rest(bodyRest), rest(legRest)];
  const dw1World = worldRestRotations(dw1Rest, dw1.parents);

  // DW2 local frames differ by a twist T per part, but the world rest is the same
  const twistBody = quat(Y, 0.7);
  const twistLeg = quat(X, -1.1);
  const dw2BodyWorld = dw1World[2].clone().multiply(twistBody);
  const dw2LegWorld = dw1World[3].clone().multiply(twistLeg);
  const dw2BodyRest = dw2BodyWorld.clone();
  const dw2LegRest = dw2BodyWorld.clone().invert().multiply(dw2LegWorld);
  const dw2Rest: RestTransform[] = [IDENTITY_REST, rest(dw2BodyRest, [1, 2, 3]), rest(dw2LegRest)];

  // DW1 motion: the pivot swings about Y, the leg swings about Z
  const pivotT = pivotRest.clone().multiply(quat(Y, Math.PI / 2));
  const legT = legRest.clone().multiply(quat(Z, Math.PI / 3));
  const clip = new THREE.AnimationClip("src", 1, [
    qTrack("node_01", [0, 1], [pivotRest, pivotT]),
    qTrack("node_02", [0], [bodyRest]),
    qTrack("node_03", [0, 1], [legRest, legT]),
  ]);

  function dw1WorldAt(t: 0 | 1) {
    const p = t ? pivotT : pivotRest;
    const l = t ? legT : legRest;
    const body = p.clone().multiply(bodyRest);
    const leg = body.clone().multiply(l);
    return { body, leg };
  }

  it("DW1 -> DW2: the DW2 parts follow the DW1 parts' world motion with their own axes", () => {
    const { clip: out, mapped, held } = retargetClip({
      clip,
      sourceNames: dw1Names,
      sourceRest: dw1Rest,
      sourceParents: dw1.parents,
      targetNames: dw2Names,
      targetRest: dw2Rest,
      targetParents: dw2.parents,
      map,
      direction: "dw1->dw2",
      correctFrames: true,
    });
    expect(mapped).toBe(2);
    expect(held).toBe(0);
    const body = out.tracks.find((t) => t.name === "node_00.quaternion")!;
    const leg = out.tracks.find((t) => t.name === "node_01.quaternion")!;
    expect(Array.from(body.times)).toEqual([0, 1]);

    [0, 1].forEach((k) => {
      const bodyLocal = new THREE.Quaternion().fromArray(body.values, k * 4);
      const legLocal = new THREE.Quaternion().fromArray(leg.values, k * 4);
      const expected = dw1WorldAt(k as 0 | 1);
      // DW2 world = DW1 world * twist (the part's own axes stay attached to it)
      sameRotation(bodyLocal, expected.body.clone().multiply(twistBody));
      sameRotation(bodyLocal.clone().multiply(legLocal), expected.leg.clone().multiply(twistLeg));
    });
    // At rest the target is at its own rest
    sameRotation(new THREE.Quaternion().fromArray(body.values, 0), dw2BodyRest);
    // Positions are the target's own
    const position = out.tracks.find((t) => t.name === "node_00.position")!;
    expect(Array.from(position.values)).toEqual([1, 2, 3]);
  });

  it("DW2 -> DW1: the DW1 mesh nodes follow, pivots held at rest", () => {
    // Give DW2 the motion that the DW1 clip would produce, then send it back
    const forward = retargetClip({
      clip,
      sourceNames: dw1Names,
      sourceRest: dw1Rest,
      sourceParents: dw1.parents,
      targetNames: dw2Names,
      targetRest: dw2Rest,
      targetParents: dw2.parents,
      map,
      direction: "dw1->dw2",
      correctFrames: true,
    }).clip;
    const { clip: back, mapped, held } = retargetClip({
      clip: forward,
      sourceNames: dw2Names,
      sourceRest: dw2Rest,
      sourceParents: dw2.parents,
      targetNames: dw1Names,
      targetRest: dw1Rest,
      targetParents: dw1.parents,
      map,
      direction: "dw2->dw1",
      correctFrames: true,
    });
    expect(mapped).toBe(2);
    expect(held).toBe(1);
    const pivot = back.tracks.find((t) => t.name === "node_01.quaternion")!;
    const bodyTrack = back.tracks.find((t) => t.name === "node_02.quaternion")!;
    const legTrack = back.tracks.find((t) => t.name === "node_03.quaternion")!;
    sameRotation(new THREE.Quaternion().fromArray(pivot.values, 0), pivotRest);
    [0, 1].forEach((k) => {
      const body = new THREE.Quaternion().fromArray(bodyTrack.values, k * 4);
      const leg = new THREE.Quaternion().fromArray(legTrack.values, k * 4);
      const expected = dw1WorldAt(k as 0 | 1);
      // World of DW1 body = pivotRest * body local (the pivot's swing now lives on the body)
      const bodyWorld = pivotRest.clone().multiply(body);
      sameRotation(bodyWorld, expected.body);
      sameRotation(bodyWorld.clone().multiply(leg), expected.leg);
    });
  });

  it("absolute mode copies the composed chain as it is", () => {
    const { clip: out } = retargetClip({
      clip,
      sourceNames: dw1Names,
      sourceRest: dw1Rest,
      sourceParents: dw1.parents,
      targetNames: dw2Names,
      targetRest: dw2Rest,
      targetParents: dw2.parents,
      map,
      direction: "dw1->dw2",
      correctFrames: false,
    });
    const body = out.tracks.find((t) => t.name === "node_00.quaternion")!;
    sameRotation(new THREE.Quaternion().fromArray(body.values, 4), pivotT.clone().multiply(bodyRest));
  });
});
