// Builds a fresh three.js scene graph for export: the same node tree the viewer shows, but
// with FrontSide materials, reversed winding, named nodes and a rotated (not scaled) root.

import * as THREE from "three";

import { TMDToThreeJS } from "../roblouie_tmd/src/threejs-converters/tmd-to-threejs";
import { Mmd } from "../structs/mmd";
import { Tim } from "../structs/tim";
import { NodeStructData } from "../structs/node_struct";
import { TransformValue } from "./clip-baker";

export interface ExportMaterial {
  name: string;
  material: THREE.MeshStandardMaterial | THREE.MeshBasicMaterial;
  // Present for textured materials: the untouched texture pixels
  baseImage: ImageData | null;
}

export interface ExportScene {
  root: THREE.Object3D;
  // Index = nodeStruct index; names are unique
  nodes: THREE.Object3D[];
  materials: ExportMaterial[];
  // Set when the TMD has primitives the viewer draws without a texture
  hasUntexturedPrimitives: boolean;
}

export function defaultNodeName(index: number) {
  return `node_${String(index).padStart(2, "0")}`;
}

const NAME_PATTERN = /^[A-Za-z0-9_]+$/;

// Resolves user-supplied names against the defaults. Returns the final list and any
// warnings (invalid or duplicate names fall back to the default).
export function resolveNodeNames(
  numberOfNodes: number,
  custom: Record<string, string> = {},
): { names: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const names: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < numberOfNodes; i++) {
    const fallback = defaultNodeName(i);
    let name = custom[String(i)] ?? fallback;

    if (!NAME_PATTERN.test(name)) {
      warnings.push(`node ${i}: "${name}" is not [A-Za-z0-9_]+, using ${fallback}`);
      name = fallback;
    }
    if (seen.has(name)) {
      warnings.push(`node ${i}: "${name}" is already used, using ${fallback}`);
      name = fallback;
    }

    seen.add(name);
    names.push(name);
  }

  return { names, warnings };
}

// Swaps vertices 1 and 2 of every triangle in a non-indexed geometry so FrontSide shows
// the faces the viewer shows with BackSide, and flips the normals: three's BackSide
// renders with FLIP_SIDED (normals negated in the shader), which cancels the TMD
// converter's own negation. FrontSide has no such flip, so undo it here.
function reverseWinding(geometry: THREE.BufferGeometry) {
  if (geometry.index) {
    throw Error("reverseWinding expects non-indexed geometry");
  }

  Object.entries(geometry.attributes).forEach(([name, attribute]) => {
    const { itemSize, count } = attribute as THREE.BufferAttribute;
    const array = (attribute as THREE.BufferAttribute).array as Float32Array;

    for (let tri = 0; tri + 2 < count; tri += 3) {
      const a = (tri + 1) * itemSize;
      const b = (tri + 2) * itemSize;

      for (let k = 0; k < itemSize; k++) {
        const tmp = array[a + k];
        array[a + k] = array[b + k];
        array[b + k] = tmp;
      }
    }

    if (name === "normal") {
      for (let i = 0; i < array.length; i++) array[i] = -array[i];
    }

    (attribute as THREE.BufferAttribute).needsUpdate = true;
  });
}

// GLTFExporter only respects material groups through an index buffer: for non-indexed
// geometry it writes every group as a primitive covering the whole mesh. The viewer's
// geometry is non-indexed with one group per TMD primitive (often 15+ per part). Build an
// index that gathers all triangles of each material together, and replace the groups with
// one per material, so the glb gets one primitive per material and no overdraw.
function indexByMaterial(geometry: THREE.BufferGeometry) {
  const vertexCount = geometry.attributes.position.count;
  const groups = geometry.groups.length
    ? geometry.groups
    : [{ start: 0, count: vertexCount, materialIndex: 0 }];

  const byMaterial = new Map<number, number[]>();
  groups.forEach((group) => {
    const materialIndex = group.materialIndex ?? 0;
    if (!byMaterial.has(materialIndex)) byMaterial.set(materialIndex, []);
    const indices = byMaterial.get(materialIndex)!;
    const end = Math.min(group.start + group.count, vertexCount);
    for (let i = group.start; i < end; i++) indices.push(i);
  });

  const index: number[] = [];
  geometry.clearGroups();
  [...byMaterial.entries()]
    .sort(([a], [b]) => a - b)
    .forEach(([materialIndex, indices]) => {
      geometry.addGroup(index.length, indices.length, materialIndex);
      index.push(...indices);
    });

  geometry.setIndex(index);
}

function cloneImageData(image: ImageData) {
  return new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
}

function convertMaterial(
  source: THREE.Material,
  index: number,
): ExportMaterial {
  const name = `mat_${String(index).padStart(2, "0")}`;

  const isStandard = source instanceof THREE.MeshStandardMaterial;
  const isBasic = source instanceof THREE.MeshBasicMaterial;

  if (!isStandard && !isBasic) {
    throw Error(`Unexpected material type ${source.type}`);
  }

  const map = source.map as THREE.DataTexture | null;
  const image = map?.image as ImageData | undefined;

  let texture: THREE.DataTexture | null = null;
  let baseImage: ImageData | null = null;

  if (image && image.data) {
    baseImage = cloneImageData(image);
    texture = new THREE.DataTexture(
      baseImage.data,
      baseImage.width,
      baseImage.height,
      THREE.RGBAFormat,
    );
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.flipY = false;
    texture.needsUpdate = true;
  }

  const translucent = source.opacity < 1;

  const params = {
    name,
    map: texture,
    color: 0xffffff,
    // glTF alphaMode: BLEND when transparent, MASK when alphaTest > 0
    transparent: translucent,
    alphaTest: translucent ? 0 : texture ? 0.3 : 0,
    opacity: translucent ? source.opacity : 1,
    side: THREE.FrontSide,
    vertexColors: false,
  };

  const material = isStandard
    ? new THREE.MeshStandardMaterial({ ...params, metalness: 0, roughness: 1 })
    : new THREE.MeshBasicMaterial(params);

  return { name, material, baseImage };
}

export function buildExportScene({
  mmd,
  tim,
  nodeStructs,
  nodeNames,
  restPose,
}: {
  mmd: Mmd;
  tim: Tim;
  nodeStructs: NodeStructData[];
  nodeNames: string[];
  // Transform applied to each node (usually animation 0's pose); index 0 is the root
  restPose: TransformValue[];
}): ExportScene {
  const meshes = new TMDToThreeJS().convertWithTMDAndTIM(mmd.tmd, [tim]);

  // All meshes of one TMD share the same materials array; convert each material once
  const converted = new Map<THREE.Material, ExportMaterial>();
  const materials: ExportMaterial[] = [];
  let hasUntexturedPrimitives = false;

  const materialFor = (source: THREE.Material) => {
    if (!converted.has(source)) {
      const result = convertMaterial(source, materials.length);
      converted.set(source, result);
      materials.push(result);
      if (!result.baseImage) hasUntexturedPrimitives = true;
    }
    return converted.get(source)!.material;
  };

  const exportMeshes = meshes.map((mesh) => {
    const geometry = mesh.geometry.clone();
    reverseWinding(geometry);
    indexByMaterial(geometry);

    const sourceMaterials = [mesh.material].flat();
    const exportMaterials = sourceMaterials.map(materialFor);

    return new THREE.Mesh(geometry, exportMaterials);
  });

  // Dispose the viewer-style originals; the export scene has its own copies
  meshes.forEach((mesh) => {
    [mesh.material].flat().forEach((material) => {
      material.dispose();
      const map = (material as THREE.MeshStandardMaterial).map;
      map?.dispose();
    });
  });

  const nodes: THREE.Object3D[] = [];

  nodeStructs.forEach((nodeStruct, index) => {
    const object =
      nodeStruct.objectIndex > -1
        ? exportMeshes[nodeStruct.objectIndex]
        : new THREE.Group();

    object.name = nodeNames[index];
    nodes.push(object);

    if (index > 0) {
      nodes[nodeStruct.nodeIndex]?.add(object);
    }
  });

  applyPose(nodes, restPose);

  // The viewer uses scale(1,-1,-1), which is a half-turn about X. Export it as a rotation.
  const root = nodes[0];
  root.quaternion.set(1, 0, 0, 0);
  root.scale.set(1, 1, 1);
  root.position.set(0, 0, 0);

  return { root, nodes, materials, hasUntexturedPrimitives };
}

export function applyPose(nodes: THREE.Object3D[], pose: TransformValue[]) {
  nodes.forEach((node, index) => {
    if (index === 0) return;
    const value = pose[index];
    if (!value) return;

    node.position.set(...value.position);
    node.rotation.set(...value.rotation);
    node.scale.set(...value.scale);
  });
}
