// Node correspondence between a DW1 rig and a DW2 rig (found by comparing the data, see
// scripts/node-rule-check.ts): DW1 skeletons carry empty pivot nodes (no mesh) that DW2 does
// not have; take those out and the DW1 mesh nodes are the DW2 objects, usually in the same
// order, sometimes with whole subtrees (upper / lower body, limbs) listed in a different
// order. So: compare the two trees of mesh-bearing nodes and pair subtrees by shape.
//
// Both rigs are described the same way: index 0 is the root, `parents[i]` the parent index
// (-1 for the root), `vertexCounts[i]` the mesh size (0 for a pivot / the root).

export interface RigShape {
  parents: number[];
  vertexCounts: number[];
}

export interface NodePair {
  dw1: number; // DW1 mesh node
  dw2: number; // DW2 object node
  // DW1 pivot nodes between the DW1 mesh node's nearest mesh ancestor and itself, top-down.
  // Their rotations are baked into the DW2 object, so they ride along when retargeting.
  dw1Pivots: number[];
  exact: boolean; // same vertex count on both sides
}

export interface NodeMap {
  pairs: NodePair[];
  unmatchedDw1: number[]; // DW1 mesh nodes with no DW2 object
  unmatchedDw2: number[];
  // "exact": same sequence and parents; "shape": paired by subtree shape; "partial": some
  // nodes had to be paired by order or left out
  quality: "exact" | "shape" | "partial";
}

interface MeshTree {
  nodes: number[]; // rig indices of mesh-bearing nodes, in tree order
  parent: Map<number, number>; // mesh node -> nearest mesh ancestor (or -1)
  children: Map<number, number[]>; // mesh ancestor (or -1) -> mesh children in order
  pivots: Map<number, number[]>; // mesh node -> pivot ancestors below its mesh parent
  signature: Map<number, string>;
}

function meshTree(shape: RigShape): MeshTree {
  const isMesh = (i: number) => i > 0 && shape.vertexCounts[i] > 0;
  const nodes = shape.parents.map((_, i) => i).filter(isMesh);
  const parent = new Map<number, number>();
  const pivots = new Map<number, number[]>();
  const children = new Map<number, number[]>();
  nodes.forEach((i) => {
    const chain: number[] = [];
    let p = shape.parents[i];
    while (p > 0 && !isMesh(p)) {
      chain.unshift(p);
      p = shape.parents[p];
    }
    const meshParent = p > 0 ? p : -1;
    parent.set(i, meshParent);
    pivots.set(i, chain);
    if (!children.has(meshParent)) children.set(meshParent, []);
    children.get(meshParent)!.push(i);
  });

  // Subtree signature: own vertex count, then children's signatures sorted, so the same
  // limb reads the same wherever it sits in the list
  const signature = new Map<number, string>();
  const sign = (i: number): string => {
    const kids = (children.get(i) ?? []).map(sign).sort();
    const s = `${shape.vertexCounts[i]}[${kids.join(",")}]`;
    signature.set(i, s);
    return s;
  };
  (children.get(-1) ?? []).forEach(sign);
  return { nodes, parent, children, pivots, signature };
}

export function buildNodeMap(dw1: RigShape, dw2: RigShape): NodeMap {
  const a = meshTree(dw1);
  const b = meshTree(dw2);
  const pairs: NodePair[] = [];
  let partial = false;

  // Exact case: same counts in sequence and same mesh-parents
  const sameSequence =
    a.nodes.length === b.nodes.length &&
    a.nodes.every((i, k) => dw1.vertexCounts[i] === dw2.vertexCounts[b.nodes[k]]) &&
    a.nodes.every((i, k) => {
      const pa = a.parent.get(i)!;
      const pb = b.parent.get(b.nodes[k])!;
      return pa === -1 ? pb === -1 : a.nodes.indexOf(pa) === b.nodes.indexOf(pb);
    });
  if (sameSequence) {
    a.nodes.forEach((i, k) =>
      pairs.push({ dw1: i, dw2: b.nodes[k], dw1Pivots: a.pivots.get(i) ?? [], exact: true }),
    );
    return { pairs, unmatchedDw1: [], unmatchedDw2: [], quality: "exact" };
  }

  // Otherwise pair children of paired parents by subtree signature, in order among equals;
  // leftovers on both sides are paired by order (a remeshed part keeps its place)
  const unmatchedDw1: number[] = [];
  const unmatchedDw2: number[] = [];
  const pairChildren = (pa: number, pb: number) => {
    const ka = [...(a.children.get(pa) ?? [])];
    const kb = [...(b.children.get(pb) ?? [])];
    const matched: Array<[number, number]> = [];
    ka.slice().forEach((i) => {
      const j = kb.find((cand) => a.signature.get(i) === b.signature.get(cand));
      if (j === undefined) return;
      matched.push([i, j]);
      ka.splice(ka.indexOf(i), 1);
      kb.splice(kb.indexOf(j), 1);
    });
    // Same own count but different subtree, then anything left, in order
    ka.slice().forEach((i) => {
      const j = kb.find((cand) => dw1.vertexCounts[i] === dw2.vertexCounts[cand]) ?? kb[0];
      if (j === undefined) return;
      partial = true;
      matched.push([i, j]);
      ka.splice(ka.indexOf(i), 1);
      kb.splice(kb.indexOf(j), 1);
    });
    unmatchedDw1.push(...ka);
    unmatchedDw2.push(...kb);
    if (ka.length || kb.length) partial = true;
    matched.forEach(([i, j]) => {
      pairs.push({
        dw1: i,
        dw2: j,
        dw1Pivots: a.pivots.get(i) ?? [],
        exact: dw1.vertexCounts[i] === dw2.vertexCounts[j],
      });
      pairChildren(i, j);
    });
  };
  pairChildren(-1, -1);
  pairs.sort((x, y) => x.dw2 - y.dw2);

  return { pairs, unmatchedDw1, unmatchedDw2, quality: partial ? "partial" : "shape" };
}
