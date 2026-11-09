// Tests the rule "DW2 object k = k-th DW1 node that carries a mesh" over every DW1 Digimon
// whose first four letters are a DW2 file code: vertex counts in sequence and parent links.
//   npx vite-node scripts/node-rule-check.ts
import { readFileSync } from "node:fs";
import { IsoImage } from "../src/dw2/iso";
import { Dw2Disc } from "../src/dw2/disc";
import { resolveParents } from "../src/dw2/model";
import { GAME_BYTE_LENGTH, PSX_SECTOR_FOOTER_SIZE, PSX_SECTOR_HEADER_SIZE, PSX_SECTOR_SIZE } from "../src/constants";

function clean(buffer: ArrayBuffer): ArrayBuffer {
  const sectors = buffer.byteLength / PSX_SECTOR_SIZE;
  const size = PSX_SECTOR_SIZE - PSX_SECTOR_HEADER_SIZE - PSX_SECTOR_FOOTER_SIZE;
  const out = new Uint8Array(sectors * size);
  for (let i = 0; i < sectors; i++) out.set(new Uint8Array(buffer, i * PSX_SECTOR_SIZE + PSX_SECTOR_HEADER_SIZE, size), i * size);
  return out.buffer;
}
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

async function main() {
  const dw1Raw = ab(readFileSync("Digimon World (USA).bin"));
  if (dw1Raw.byteLength !== GAME_BYTE_LENGTH) throw Error("DW1 size");
  (globalThis as any).window = { value: clean(dw1Raw) };
  const disc = new Dw2Disc(new IsoImage(ab(readFileSync("Digimon World 2 (USA).bin"))));

  const { MMD_POINTERS } = await import("../src/data/mmds");
  const { newDigimonStruct } = await import("../src/structs/digimon_struct");
  const { newSkeletonPointer, FIRST_SKELETON_POINTER } = await import("../src/structs/skeleton_pointer");
  const { newNodeStructs } = await import("../src/structs/node_struct");
  const { newMmd } = await import("../src/structs/mmd");
  const { PSX_MEMORY_SPACE_POINTER } = await import("../src/constants");
  const { Info } = await import("../src/models/info");

  let pairs = 0, exact = 0, countsOnly = 0, mismatch = 0;
  const lines: string[] = [];
  for (let index = 0; index < MMD_POINTERS.length; index++) {
    if (!MMD_POINTERS[index]) continue;
    let name = "";
    try { name = new Info({ index }).name; } catch { continue; }
    const code = name.replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase();
    const entry = disc.entries.find((e) => e.code === code);
    if (!entry) continue;
    pairs++;
    const n = newDigimonStruct(index).numberOfNodes;
    const ns = newNodeStructs(newSkeletonPointer(index) - PSX_MEMORY_SPACE_POINTER - FIRST_SKELETON_POINTER, n);
    const mmd = newMmd(index, n);
    const meshNodes = ns.map((s, i) => ({ i, s })).filter(({ s }) => s.objectIndex > -1);
    const dw1Counts = meshNodes.map(({ s }) => mmd.tmd.objects[s.objectIndex].vertices.length);
    // DW1 parent in "mesh space": nearest ancestor that carries a mesh (-1 = root)
    const meshIndexOf = new Map(meshNodes.map(({ i }, k) => [i, k]));
    const dw1Parents = meshNodes.map(({ i }) => {
      let p = ns[i].nodeIndex;
      while (p > 0 && !meshIndexOf.has(p)) p = ns[p].nodeIndex;
      return p > 0 ? meshIndexOf.get(p)! : -1;
    });
    const loaded = disc.load(entry.index);
    const dw2Counts = loaded.model.objects.map((o) => o.vertices.length);
    const dw2Parents = resolveParents(loaded.model.skeleton);
    const sameCounts = dw1Counts.length === dw2Counts.length && dw1Counts.every((c, k) => c === dw2Counts[k]);
    const sameParents = sameCounts && dw1Parents.every((p, k) => p === dw2Parents[k]);
    const tag = sameParents ? "exact" : sameCounts ? "counts-only" : "MISMATCH";
    if (sameParents) exact++; else if (sameCounts) countsOnly++; else mismatch++;
    lines.push(`${String(index).padStart(3)} ${name.padEnd(14)} ${entry.name.padEnd(9)} dw1 ${String(n).padStart(2)} nodes/${String(dw1Counts.length).padStart(2)} meshes  dw2 ${String(dw2Counts.length).padStart(2)} objects  ${tag}${tag !== "exact" ? `  dw1=${dw1Counts.join(",")} dw2=${dw2Counts.join(",")}` : ""}`);
  }
  console.log(lines.join("\n"));
  console.log(`\npairs by code: ${pairs}; exact (counts + parents): ${exact}; counts only: ${countsOnly}; mismatch: ${mismatch}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
