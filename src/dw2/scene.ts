// three.js side of DW2: builds the node tree, meshes and materials from a parsed model, and
// AnimationClips from the animation files. The same scene serves the viewer and the export
// (FrontSide materials, named nodes, root carrying the half-turn about X that puts the
// PSX's y-down data upright).

import * as THREE from "three";

import { Dw2Model, Dw2Primitive, clutKey, decodeClut, paletteImage, ClutRef } from "./model";
import { Dw2Anim, Dw2Matrix, DW2_FRAME_RATE } from "./anim";
import { defaultNodeName } from "../export/scene-builder";

export const DW2_ROOT_NAME = "root";

export interface Dw2Material {
  name: string;
  material: THREE.MeshStandardMaterial;
  baseImage: ImageData;
  clut: ClutRef;
  semiTransparent: boolean;
  mixtureRate: number;
}

export interface Dw2Scene {
  root: THREE.Object3D;
  // Index 0 is the synthetic root, then one per object
  nodes: THREE.Object3D[];
  nodeNames: string[];
  materials: Dw2Material[];
  // true when triangle winding had to be reversed to agree with the stored normals
  reversedWinding: boolean;
  bounds: THREE.Box3;
}

// The stored 3x3 is the PSX GTE row-major matrix (v' = M v). Checked on Agumon's rest pose:
// read as stored, the spine chain climbs and the leg chain descends; read transposed, the
// spine runs sideways. (dw2_model_converter hands the values to glm column-major and then
// conjugates; whatever it does, this reading is the one the joint positions agree with.)
const TRANSPOSE_STORED = false;

export function matrixToThree(matrix: Dw2Matrix, out = new THREE.Matrix4()) {
  const { m, t } = matrix;
  if (TRANSPOSE_STORED) {
    out.set(m[0], m[3], m[6], t[0], m[1], m[4], m[7], t[1], m[2], m[5], m[8], t[2], 0, 0, 0, 1);
  } else {
    out.set(m[0], m[1], m[2], t[0], m[3], m[4], m[5], t[1], m[6], m[7], m[8], t[2], 0, 0, 0, 1);
  }
  return out;
}

function materialKey(primitive: Dw2Primitive) {
  return `${clutKey(decodeClut(primitive.clut))}:${primitive.semiTransparent ? primitive.mixtureRate : "o"}`;
}

// Majority vote: does the stored winding agree with the stored vertex normals?
function windingAgreesWithNormals(model: Dw2Model) {
  let agree = 0;
  let disagree = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();

  model.objects.forEach((object) => {
    object.primitives.forEach((primitive) => {
      const [i0, i1, i2] = primitive.vertices;
      const v0 = object.vertices[i0];
      const v1 = object.vertices[i1];
      const v2 = object.vertices[i2];
      if (!v0 || !v1 || !v2) return;
      a.set(v0.x, v0.y, v0.z);
      b.set(v1.x, v1.y, v1.z).sub(a);
      c.set(v2.x, v2.y, v2.z).sub(a);
      b.cross(c);
      if (b.lengthSq() === 0) return;
      n.set(0, 0, 0);
      primitive.normals.forEach((ni) => {
        const vn = object.normals[ni];
        if (vn) n.add(new THREE.Vector3(vn.x, vn.y, vn.z));
      });
      const dot = b.dot(n);
      if (dot > 0) agree++;
      else if (dot < 0) disagree++;
    });
  });

  return agree >= disagree;
}

function buildMaterial(model: Dw2Model, primitive: Dw2Primitive, index: number): Dw2Material {
  const clut = decodeClut(primitive.clut);
  const baseImage = paletteImage(model.tim, clut, primitive.semiTransparent);
  const texture = new THREE.DataTexture(baseImage.data, baseImage.width, baseImage.height, THREE.RGBAFormat);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.flipY = false;
  texture.needsUpdate = true;

  const material = new THREE.MeshStandardMaterial({
    name: `mat_${String(index).padStart(2, "0")}`,
    map: texture,
    color: 0xffffff,
    metalness: 0,
    roughness: 1,
    side: THREE.FrontSide,
  });

  if (primitive.semiTransparent) {
    material.transparent = true;
    material.depthWrite = false;
    switch (primitive.mixtureRate) {
      case 1:
        material.blending = THREE.AdditiveBlending;
        break;
      case 2:
        material.blending = THREE.SubtractiveBlending;
        break;
      case 3:
        material.opacity = 0.25;
        break;
      default:
        material.opacity = 0.5;
    }
  } else {
    material.alphaTest = 0.5;
  }

  return {
    name: material.name,
    material,
    baseImage,
    clut,
    semiTransparent: primitive.semiTransparent,
    mixtureRate: primitive.mixtureRate,
  };
}

export function buildDw2Scene({
  model,
  anims,
  nodeNames,
}: {
  model: Dw2Model;
  anims: Dw2Anim[];
  // Optional override, index 0 = root, then objects
  nodeNames?: string[];
}): Dw2Scene {
  const names =
    nodeNames ?? [DW2_ROOT_NAME, ...model.objects.map((_, i) => defaultNodeName(i))];

  const reversedWinding = !windingAgreesWithNormals(model);

  // Materials, in first-use order
  const materialsByKey = new Map<string, number>();
  const materials: Dw2Material[] = [];
  const materialIndexFor = (primitive: Dw2Primitive) => {
    const key = materialKey(primitive);
    if (!materialsByKey.has(key)) {
      materialsByKey.set(key, materials.length);
      materials.push(buildMaterial(model, primitive, materials.length));
    }
    return materialsByKey.get(key)!;
  };

  const meshes = model.objects.map((object) => {
    // Triangulate, tag each triangle with its material, sort by material, emit groups
    type Tri = { v: number[]; n: number[]; uv: Array<[number, number]>; material: number };
    const tris: Tri[] = [];
    object.primitives.forEach((primitive) => {
      const material = materialIndexFor(primitive);
      const emit = (order: number[]) => {
        const corners = reversedWinding ? [order[0], order[2], order[1]] : order;
        tris.push({
          v: corners.map((c) => primitive.vertices[c]),
          n: corners.map((c) => primitive.normals[c]),
          uv: corners.map((c) => primitive.uvs[c]),
          material,
        });
      };
      emit([0, 1, 2]);
      if (primitive.vertices.length === 4) emit([3, 2, 1]);
    });
    tris.sort((a, b) => a.material - b.material);

    const positions = new Float32Array(tris.length * 9);
    const normals = new Float32Array(tris.length * 9);
    const uvs = new Float32Array(tris.length * 6);
    tris.forEach((tri, t) => {
      for (let c = 0; c < 3; c++) {
        const v = object.vertices[tri.v[c]] ?? { x: 0, y: 0, z: 0 };
        const n = object.normals[tri.n[c]] ?? { x: 0, y: 1, z: 0 };
        const [u, vv] = tri.uv[c];
        positions.set([v.x, v.y, v.z], t * 9 + c * 3);
        normals.set([n.x, n.y, n.z], t * 9 + c * 3);
        uvs.set([(u + 0.5) / model.tim.width, (vv + 0.5) / model.tim.height], t * 6 + c * 2);
      }
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    // An explicit index makes GLTFExporter honour the groups as separate primitives
    geometry.setIndex(Array.from({ length: tris.length * 3 }, (_, i) => i));

    let start = 0;
    const usedMaterials: THREE.Material[] = [];
    for (let t = 0; t <= tris.length; t++) {
      if (t === tris.length || (t > start && tris[t].material !== tris[start].material)) {
        if (t > start) {
          geometry.addGroup(start * 3, (t - start) * 3, usedMaterials.length);
          usedMaterials.push(materials[tris[start].material].material);
        }
        start = t;
      }
    }

    return new THREE.Mesh(geometry, usedMaterials);
  });

  // Node tree
  const root = new THREE.Group();
  root.name = names[0];
  root.quaternion.set(1, 0, 0, 0); // half-turn about X: PSX y-down -> y-up
  const nodes: THREE.Object3D[] = [root];
  model.objects.forEach((_, i) => {
    const mesh = meshes[i];
    mesh.name = names[i + 1];
    nodes.push(mesh);
  });
  model.parents.forEach((parent, i) => {
    (parent >= 0 ? nodes[parent + 1] : root).add(nodes[i + 1]);
  });

  // Rest pose: first row of the first frame of the first animation
  const first = anims[0];
  if (first && first.frames[0]?.rows[0]) {
    applyRow(nodes, first, first.frames[0].rows[0]);
  }

  root.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(root);

  return { root, nodes, nodeNames: names, materials, reversedWinding, bounds };
}

const scratchMatrix = new THREE.Matrix4();

export function applyRow(nodes: THREE.Object3D[], anim: Dw2Anim, row: number[]) {
  row.forEach((keyIndex, object) => {
    const matrix = anim.keyframes[object]?.[keyIndex];
    const node = nodes[object + 1];
    if (!matrix || !node) return;
    matrixToThree(matrix, scratchMatrix).decompose(node.position, node.quaternion, node.scale);
  });
}

export interface Dw2ClipMeta {
  animationIndex: number;
  kind: "flat";
  hasLoop: boolean;
  infiniteLoop: boolean;
  loopPops: boolean;
  hasRootMotion: boolean;
  hasTextureSwaps: boolean;
  hasSound: boolean;
  clampPose: boolean;
  returnToIdle: boolean;
  // DW2 specifics
  letter: string;
  frameIndex: number;
  terminationMask: number;
  loopMask: number;
  rows: number;
}

export function dw2ClipName(index: number, letter: string, frameIndex: number, frameCount: number) {
  const base = `a${String(index).padStart(2, "0")}_${letter}`;
  return frameCount > 1 ? `${base}${frameIndex}` : base;
}

// One clip per (animation file, frame): rows become samples at DW2_FRAME_RATE
export function buildDw2Clips({
  anims,
  nodeNames,
}: {
  anims: Array<{ letter: string; anim: Dw2Anim }>;
  nodeNames: string[];
}): { clips: THREE.AnimationClip[]; meta: Record<string, Dw2ClipMeta> } {
  const clips: THREE.AnimationClip[] = [];
  const meta: Record<string, Dw2ClipMeta> = {};
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const previous = new THREE.Quaternion();

  anims.forEach(({ letter, anim }) => {
    anim.frames.forEach((frame, frameIndex) => {
      const index = clips.length;
      const name = dw2ClipName(index, letter, frameIndex, anim.frames.length);
      const tracks: THREE.KeyframeTrack[] = [];
      const times = frame.rows.map((_, j) => j / DW2_FRAME_RATE);
      let hasRootMotion = false;

      anim.keyframes.forEach((keys, object) => {
        const nodeName = nodeNames[object + 1];
        const positions: number[] = [];
        const quaternions: number[] = [];
        const scales: number[] = [];
        let scaleVaries = false;

        frame.rows.forEach((row, j) => {
          const matrix = keys[row[object]] ?? keys[0];
          if (!matrix) return;
          matrixToThree(matrix, scratchMatrix).decompose(position, quaternion, scale);
          // Keep quaternions on the same hemisphere as the previous sample so slerp takes
          // the short way round
          if (j > 0 && quaternion.dot(previous) < 0) {
            quaternion.set(-quaternion.x, -quaternion.y, -quaternion.z, -quaternion.w);
          }
          previous.copy(quaternion);
          positions.push(position.x, position.y, position.z);
          quaternions.push(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
          scales.push(scale.x, scale.y, scale.z);
          if (Math.abs(scale.x - 1) > 1e-3 || Math.abs(scale.y - 1) > 1e-3 || Math.abs(scale.z - 1) > 1e-3) {
            scaleVaries = true;
          }
        });

        if (!positions.length) return;
        tracks.push(new THREE.QuaternionKeyframeTrack(`${nodeName}.quaternion`, times, quaternions));
        tracks.push(new THREE.VectorKeyframeTrack(`${nodeName}.position`, times, positions));
        if (scaleVaries) tracks.push(new THREE.VectorKeyframeTrack(`${nodeName}.scale`, times, scales));
        if (object === 0) {
          const [x0, y0, z0] = positions;
          for (let i = 3; i < positions.length; i += 3) {
            if (positions[i] !== x0 || positions[i + 1] !== y0 || positions[i + 2] !== z0) hasRootMotion = true;
          }
        }
      });

      const duration = Math.max(frame.rows.length - 1, 0) / DW2_FRAME_RATE;
      const clip = new THREE.AnimationClip(name, duration, tracks);
      clips.push(clip);
      meta[name] = {
        animationIndex: index,
        kind: "flat",
        hasLoop: frame.terminationMask === 0xfe,
        infiniteLoop: frame.terminationMask === 0xfe,
        loopPops: false,
        hasRootMotion,
        hasTextureSwaps: false,
        hasSound: false,
        clampPose: false,
        returnToIdle: false,
        letter,
        frameIndex,
        terminationMask: frame.terminationMask,
        loopMask: frame.loopMask,
        rows: frame.rows.length,
      };
    });
  });

  return { clips, meta };
}
