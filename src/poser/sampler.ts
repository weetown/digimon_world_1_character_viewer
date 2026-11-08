// Samples a clip at a (fractional) frame: eased interpolation between keys, slerp for
// rotations, hold at the ends, base pose for anything unkeyed.

import * as THREE from "three";

import { Clip, Easing, PositionKey, RotationKey, Vec3 } from "./document";

export interface BasePose {
  // node name -> local transform at the rest/idle pose
  [node: string]: { position: Vec3; rotation: Vec3; scale: Vec3 };
}

export function ease(t: number, easing: Easing) {
  switch (easing) {
    case "step":
      return 0;
    case "easeIn":
      return t * t;
    case "easeOut":
      return 1 - (1 - t) * (1 - t);
    case "easeInOut":
      return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    default:
      return t;
  }
}

// Finds the keys bracketing `frame` and the eased blend factor
function bracket<T extends { frame: number; easing: Easing }>(
  keys: T[],
  frame: number,
): { a: T; b: T; t: number } | null {
  if (!keys.length) return null;
  if (frame <= keys[0].frame) return { a: keys[0], b: keys[0], t: 0 };
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return { a: last, b: last, t: 0 };

  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (frame >= a.frame && frame < b.frame) {
      const raw = (frame - a.frame) / (b.frame - a.frame);
      return { a, b, t: ease(raw, a.easing) };
    }
  }
  return null;
}

const quatA = new THREE.Quaternion();
const quatB = new THREE.Quaternion();

export function sampleRotation(keys: RotationKey[], frame: number, out: THREE.Quaternion) {
  const br = bracket(keys, frame);
  if (!br) return false;

  quatA.fromArray(br.a.rotation);

  if (br.a === br.b || br.t === 0) {
    out.copy(quatA);
    return true;
  }

  quatB.fromArray(br.b.rotation);
  out.copy(quatA).slerp(quatB, br.t);
  return true;
}

export function samplePosition(keys: PositionKey[], frame: number, out: THREE.Vector3) {
  const br = bracket(keys, frame);
  if (!br) return false;
  out.set(br.a.position[0], br.a.position[1], br.a.position[2]);
  if (br.a !== br.b && br.t > 0) {
    out.lerp(new THREE.Vector3(...br.b.position), br.t);
  }
  return true;
}

// Writes the sampled pose onto the live nodes
export function applyClipPose(
  clip: Clip,
  frame: number,
  nodes: Map<string, THREE.Object3D>,
  rootName: string,
  base: BasePose,
) {
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();

  nodes.forEach((node, name) => {
    const rest = base[name];
    if (!rest) return;

    const keys = clip.nodes[name];
    if (keys && sampleRotation(keys, frame, quat)) {
      node.quaternion.copy(quat);
    } else {
      node.rotation.set(rest.rotation[0], rest.rotation[1], rest.rotation[2]);
    }

    if (name === rootName) {
      if (clip.root.length && samplePosition(clip.root, frame, pos)) {
        node.position.copy(pos);
      } else {
        node.position.set(...rest.position);
      }
    } else {
      node.position.set(...rest.position);
    }
    node.scale.set(...rest.scale);
  });
}
