// Compares a DW1 rig with its DW2 counterpart node by node: rest-pose joint positions and
// mesh centroids, normalised by model height, matched spatially. Prints the matching and
// where it disagrees with the index-for-index mapping the retargeter assumes.
//
//   npx vite-node scripts/node-correspondence.ts [dw1Index=dw2Code ...]
//   e.g. npx vite-node scripts/node-correspondence.ts 3=AGUM 5=GREY 22=GARU

import { readFileSync } from "node:fs";
import * as THREE from "three";

import { IsoImage } from "../src/dw2/iso";
import { Dw2Disc } from "../src/dw2/disc";
import { matrixToThree } from "../src/dw2/scene";
import { resolveParents } from "../src/dw2/model";
import {
  GAME_BYTE_LENGTH,
  PSX_SECTOR_FOOTER_SIZE,
  PSX_SECTOR_HEADER_SIZE,
  PSX_SECTOR_SIZE,
} from "../src/constants";

interface NodeInfo {
  index: number;
  parent: number;
  depth: number;
  vertexCount: number;
  joint: THREE.Vector3; // world rest position of the node origin
  centroid: THREE.Vector3 | null; // world rest centroid of its mesh
}

function clean(buffer: ArrayBuffer): ArrayBuffer {
  const sectors = buffer.byteLength / PSX_SECTOR_SIZE;
  const size = PSX_SECTOR_SIZE - PSX_SECTOR_HEADER_SIZE - PSX_SECTOR_FOOTER_SIZE;
  const out = new Uint8Array(sectors * size);
  for (let i = 0; i < sectors; i++) {
    out.set(new Uint8Array(buffer, i * PSX_SECTOR_SIZE + PSX_SECTOR_HEADER_SIZE, size), i * size);
  }
  return out.buffer;
}

function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

async function dw1Nodes(index: number): Promise<{ name: string; nodes: NodeInfo[] }> {
  // The DW1 data modules read window.value; load them after it exists
  const { newDigimonStruct } = await import("../src/structs/digimon_struct");
  const { newSkeletonPointer, FIRST_SKELETON_POINTER } = await import("../src/structs/skeleton_pointer");
  const { newNodeStructs } = await import("../src/structs/node_struct");
  const { newMmd } = await import("../src/structs/mmd");
  const { bakeAnimation } = await import("../src/export/clip-baker");
  const { PSX_MEMORY_SPACE_POINTER } = await import("../src/constants");
  const { Info } = await import("../src/models/info");

  const digimonStruct = newDigimonStruct(index);
  const n = digimonStruct.numberOfNodes;
  const nodeStructs = newNodeStructs(newSkeletonPointer(index) - PSX_MEMORY_SPACE_POINTER - FIRST_SKELETON_POINTER, n);
  const mmd = newMmd(index, n);
  let name = `dw1_${index}`;
  try {
    name = new Info({ index }).name;
  } catch {
    // TIM decoding may need browser APIs; the name is cosmetic here
  }
  const first = mmd.animations.findIndex((a) => a !== null);
  const pose = bakeAnimation({ animation: mmd.animations[first]!, index: first, numberOfNodes: n }).pose;

  const world: THREE.Matrix4[] = [];
  const nodes: NodeInfo[] = [];
  nodeStructs.forEach((ns, i) => {
    const parent = i === 0 ? -1 : ns.nodeIndex;
    const local = new THREE.Matrix4();
    if (i > 0) {
      const p = pose[i];
      local.compose(
        new THREE.Vector3(...p.position),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...p.rotation, "XYZ")),
        new THREE.Vector3(...p.scale),
      );
    }
    world[i] = parent >= 0 ? world[parent].clone().multiply(local) : local;
    const object = ns.objectIndex > -1 ? mmd.tmd.objects[ns.objectIndex] : null;
    let centroid: THREE.Vector3 | null = null;
    if (object && object.vertices.length) {
      centroid = new THREE.Vector3();
      object.vertices.forEach((v) => centroid!.add(new THREE.Vector3(v.x, v.y, v.z)));
      centroid.divideScalar(object.vertices.length).applyMatrix4(world[i]);
    }
    const depth = parent >= 0 ? nodes[parent].depth + 1 : 0;
    nodes.push({
      index: i,
      parent,
      depth,
      vertexCount: object?.vertices.length ?? 0,
      joint: new THREE.Vector3().setFromMatrixPosition(world[i]),
      centroid,
    });
  });
  return { name, nodes };
}

function dw2Nodes(disc: Dw2Disc, code: string): { name: string; nodes: NodeInfo[] } {
  const entry = disc.entries.find((e) => e.code === code);
  if (!entry) throw Error(`no DW2 model with code ${code}`);
  const loaded = disc.load(entry.index);
  const parents = resolveParents(loaded.model.skeleton);
  const anim = loaded.anims[0].anim;
  const row = anim.frames[0].rows[0];

  // Node 0 is the synthetic root; objects follow at 1..n
  const world: THREE.Matrix4[] = [new THREE.Matrix4()];
  const nodes: NodeInfo[] = [{ index: 0, parent: -1, depth: 0, vertexCount: 0, joint: new THREE.Vector3(), centroid: null }];
  loaded.model.objects.forEach((object, o) => {
    const parent = parents[o] >= 0 ? parents[o] + 1 : 0;
    const matrix = anim.keyframes[o][row[o]] ?? anim.keyframes[o][0];
    const local = matrix ? matrixToThree(matrix) : new THREE.Matrix4();
    const w = world[parent].clone().multiply(local);
    world.push(w);
    let centroid: THREE.Vector3 | null = null;
    if (object.vertices.length) {
      centroid = new THREE.Vector3();
      object.vertices.forEach((v) => centroid!.add(new THREE.Vector3(v.x, v.y, v.z)));
      centroid.divideScalar(object.vertices.length).applyMatrix4(w);
    }
    nodes.push({
      index: o + 1,
      parent,
      depth: nodes[parent].depth + 1,
      vertexCount: object.vertices.length,
      joint: new THREE.Vector3().setFromMatrixPosition(w),
      centroid,
    });
  });
  return { name: entry.name, nodes };
}

// Scale + shift so the mesh centroids' bounding box has height 1 and sits at the origin
function normalise(nodes: NodeInfo[]) {
  const box = new THREE.Box3();
  nodes.forEach((n) => n.centroid && box.expandByPoint(n.centroid));
  const centre = box.getCenter(new THREE.Vector3());
  const height = Math.max(box.max.y - box.min.y, 1);
  nodes.forEach((n) => {
    n.joint.sub(centre).divideScalar(height);
    n.centroid?.sub(centre).divideScalar(height);
  });
}

function cost(a: NodeInfo, b: NodeInfo) {
  let c = a.joint.distanceTo(b.joint);
  if (a.centroid && b.centroid) c += a.centroid.distanceTo(b.centroid);
  else if (!!a.centroid !== !!b.centroid) c += 0.5;
  c += 0.1 * Math.abs(a.depth - b.depth);
  return c;
}

function match(a: NodeInfo[], b: NodeInfo[]) {
  const pairs: Array<{ i: number; j: number; c: number }> = [];
  for (let i = 1; i < a.length; i++) for (let j = 1; j < b.length; j++) pairs.push({ i, j, c: cost(a[i], b[j]) });
  pairs.sort((x, y) => x.c - y.c);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const map = new Map<number, { j: number; c: number }>();
  pairs.forEach(({ i, j, c }) => {
    if (usedA.has(i) || usedB.has(j)) return;
    usedA.add(i);
    usedB.add(j);
    map.set(i, { j, c });
  });
  return map;
}

function fmt(v: THREE.Vector3 | null) {
  return v ? `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})` : "   (no mesh)   ";
}

async function main() {
  const args = process.argv.slice(2);
  const pairsWanted = (args.length ? args : ["3=AGUM", "5=GREY", "22=GARU"]).map((s) => {
    const [a, b] = s.split("=");
    return { dw1: parseInt(a, 10), dw2: b };
  });

  const dw1Raw = toArrayBuffer(readFileSync("Digimon World (USA).bin"));
  if (dw1Raw.byteLength !== GAME_BYTE_LENGTH) throw Error("DW1 image has an unexpected size");
  (globalThis as unknown as { window: { value: ArrayBuffer } }).window = { value: clean(dw1Raw) };

  const disc = new Dw2Disc(new IsoImage(toArrayBuffer(readFileSync("Digimon World 2 (USA).bin"))));

  for (const { dw1, dw2 } of pairsWanted) {
    const a = await dw1Nodes(dw1);
    const b = dw2Nodes(disc, dw2);
    normalise(a.nodes);
    normalise(b.nodes);
    const m = match(a.nodes, b.nodes);

    console.log(`\n=== DW1 ${dw1} ${a.name} (${a.nodes.length - 1} nodes)  vs  DW2 ${b.name} (${b.nodes.length - 1} objects) ===`);
    console.log("dw1  par dep verts  joint               centroid              -> dw2  par dep verts  joint               centroid              cost   same-index?");
    let same = 0;
    let hierarchyOk = 0;
    for (let i = 1; i < a.nodes.length; i++) {
      const an = a.nodes[i];
      const hit = m.get(i);
      if (!hit) {
        console.log(`${String(i).padStart(3)}  ${String(an.parent).padStart(3)} ${String(an.depth).padStart(3)} ${String(an.vertexCount).padStart(5)}  ${fmt(an.joint)} ${fmt(an.centroid)} -> (unmatched)`);
        continue;
      }
      const bn = b.nodes[hit.j];
      const sameIndex = hit.j === i;
      if (sameIndex) same++;
      const parentMatch = an.parent === 0 ? bn.parent === 0 : m.get(an.parent)?.j === bn.parent;
      if (parentMatch) hierarchyOk++;
      console.log(
        `${String(i).padStart(3)}  ${String(an.parent).padStart(3)} ${String(an.depth).padStart(3)} ${String(an.vertexCount).padStart(5)}  ${fmt(an.joint)} ${fmt(an.centroid)} -> ${String(hit.j).padStart(3)}  ${String(bn.parent).padStart(3)} ${String(bn.depth).padStart(3)} ${String(bn.vertexCount).padStart(5)}  ${fmt(bn.joint)} ${fmt(bn.centroid)} ${hit.c.toFixed(2).padStart(5)}  ${sameIndex ? "yes" : "NO "}${parentMatch ? "" : "  (parent differs)"}`,
      );
    }
    const unmatchedB = [...Array(b.nodes.length).keys()].slice(1).filter((j) => ![...m.values()].some((v) => v.j === j));
    console.log(`same index: ${same}/${a.nodes.length - 1}; hierarchy-consistent matches: ${hierarchyOk}/${m.size}; DW2 objects left over: ${unmatchedB.join(", ") || "none"}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
