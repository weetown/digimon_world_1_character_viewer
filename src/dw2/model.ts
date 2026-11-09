// Digimon World 2 model file (M###CODE.BIN). Layout after jype's dw2_model_converter
// (https://gitlab.com/jype/dw2_model_converter, dw2_model_format.md), checked against the
// NTSC-U disc:
//
//   u32 timStart, u32 timEnd, u32 numObjects
//   u32 vertexOffset[n], u32 normalOffset[n], u32 primitiveOffset[n], u32 skeleton[n]
//   u8  blink[24]
//   per object: u32 count, u16 pad, i16 xyz[count]      (vertices; normals same, 3.12 fixed)
//   per object: 4 groups, each u32 count then primitives in this order:
//               semi-transparent quads, opaque quads, semi-transparent tris, opaque tris
//   TIM at timStart: 4bpp, 32 halfwords (128 texels) x 256 rows, CLUTs in the last 32 rows

export interface Dw2Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Dw2Primitive {
  vertices: number[]; // 3 or 4 indices
  normals: number[];
  uvs: Array<[number, number]>; // texel coords, 0..127 x 0..255
  clut: number; // raw halfword
  mixtureRate: number; // PSX semi-transparency mode 0..3
  semiTransparent: boolean;
}

export interface Dw2Object {
  vertices: Dw2Vec3[]; // raw int16
  normals: Dw2Vec3[]; // 3.12 fixed point, normalised here
  primitives: Dw2Primitive[];
}

export interface Dw2Model {
  objects: Dw2Object[];
  // Parent object index per object, -1 for roots
  parents: number[];
  // Raw skeleton words (1-based depth-ish values, 0 = root), kept for the raw dump
  skeleton: number[];
  blink: Uint8Array; // 24 bytes, meaning not fully known (see blink.ts)
  tim: Dw2Tim;
  timStart: number;
  timEnd: number;
}

export interface Dw2Tim {
  // 4bpp indices, 128 x 256
  indices: Uint8Array;
  width: number;
  height: number;
  // 32 CLUT rows x 32 colours of raw 15-bit words (rows 224..255 of the image)
  clut: Uint16Array;
  // Pixel block VRAM position
  vramX: number;
  vramY: number;
}

export const DW2_TEXTURE_WIDTH = 128;
export const DW2_TEXTURE_HEIGHT = 256;
export const DW2_CLUT_ROW_BASE = 224;
export const DW2_CLUT_ROWS = 32;
export const DW2_CLUT_COLUMNS = 32;

function readVectors(view: DataView, offset: number): Dw2Vec3[] {
  const count = view.getUint32(offset, true);
  const out: Dw2Vec3[] = [];
  let pos = offset + 6; // u32 count + u16 pad
  for (let i = 0; i < count; i++, pos += 6) {
    out.push({
      x: view.getInt16(pos, true),
      y: view.getInt16(pos + 2, true),
      z: view.getInt16(pos + 4, true),
    });
  }
  return out;
}

function readPrimitives(view: DataView, offset: number): Dw2Primitive[] {
  const out: Dw2Primitive[] = [];
  let pos = offset;
  const groups: Array<{ corners: 3 | 4; semiTransparent: boolean }> = [
    { corners: 4, semiTransparent: true },
    { corners: 4, semiTransparent: false },
    { corners: 3, semiTransparent: true },
    { corners: 3, semiTransparent: false },
  ];

  groups.forEach(({ corners, semiTransparent }) => {
    const count = view.getUint32(pos, true);
    pos += 4;
    for (let i = 0; i < count; i++) {
      const vertices: number[] = [];
      const normals: number[] = [];
      const uvs: Array<[number, number]> = [];
      for (let c = 0; c < corners; c++) vertices.push(view.getUint8(pos + c));
      for (let c = 0; c < corners; c++) normals.push(view.getUint8(pos + corners + c));
      for (let c = 0; c < corners; c++) {
        const u = pos + corners * 2 + c * 2;
        uvs.push([view.getUint8(u), view.getUint8(u + 1)]);
      }
      const tail = pos + corners * 4;
      out.push({
        vertices,
        normals,
        uvs,
        clut: view.getUint16(tail, true),
        mixtureRate: view.getUint16(tail + 2, true),
        semiTransparent,
      });
      pos += corners * 4 + 4;
    }
  });

  return out;
}

// skeleton[i] is 0 for a root; otherwise the parent is the most recent earlier object whose
// value is skeleton[i] - 1 (the values are depths, written in pre-order).
export function resolveParents(skeleton: number[]): number[] {
  return skeleton.map((value, index) => {
    if (value === 0) return -1;
    for (let j = index - 1; j >= 0; j--) {
      if (skeleton[j] === value - 1) return j;
    }
    return -1;
  });
}

function readTim(bytes: Uint8Array, start: number): Dw2Tim {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(start, true) !== 0x10) throw Error("TIM magic missing");
  const flag = view.getUint32(start + 4, true);
  let pos = start + 8;
  if (flag & 8) {
    // CLUT block present (the game writes a bogus 1x1 one); skip it by its size
    pos += view.getUint32(pos, true);
  }
  const blockSize = view.getUint32(pos, true);
  const vramX = view.getUint16(pos + 4, true);
  const vramY = view.getUint16(pos + 6, true);
  const halfwords = view.getUint16(pos + 8, true);
  const height = view.getUint16(pos + 10, true);
  const width = halfwords * 4; // 4bpp
  const dataStart = pos + 12;
  const dataLength = blockSize - 12;
  if (width !== DW2_TEXTURE_WIDTH || height !== DW2_TEXTURE_HEIGHT) {
    throw Error(`unexpected TIM size ${width}x${height}`);
  }

  const indices = new Uint8Array(width * height);
  const rowBytes = halfwords * 2;
  for (let y = 0; y < height; y++) {
    for (let b = 0; b < rowBytes; b++) {
      const byte = bytes[dataStart + y * rowBytes + b];
      indices[y * width + b * 2] = byte & 0xf;
      indices[y * width + b * 2 + 1] = byte >> 4;
    }
  }

  // The CLUTs are the last 32 rows of the same pixel block: 32 rows x 32 halfwords
  const clutStart = dataStart + DW2_CLUT_ROW_BASE * rowBytes;
  const clut = new Uint16Array(DW2_CLUT_ROWS * DW2_CLUT_COLUMNS);
  for (let i = 0; i < clut.length; i++) clut[i] = view.getUint16(clutStart + i * 2, true);

  if (dataStart + dataLength > bytes.length) throw Error("TIM runs past end of file");

  return { indices, width, height, clut, vramX, vramY };
}

export function parseDw2Model(bytes: Uint8Array): Dw2Model {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const timStart = view.getUint32(0, true);
  const timEnd = view.getUint32(4, true);
  const numObjects = view.getUint32(8, true);
  if (numObjects === 0 || numObjects > 128) throw Error(`implausible object count ${numObjects}`);

  const table = (k: number) =>
    Array.from({ length: numObjects }, (_, i) => view.getUint32(12 + (k * numObjects + i) * 4, true));
  const vertexOffsets = table(0);
  const normalOffsets = table(1);
  const primitiveOffsets = table(2);
  const skeleton = table(3);
  const blinkStart = 12 + numObjects * 16;
  const blink = bytes.slice(blinkStart, blinkStart + 24);

  const objects: Dw2Object[] = [];
  for (let i = 0; i < numObjects; i++) {
    const normals = readVectors(view, normalOffsets[i]).map((n) => {
      const x = n.x / 4096;
      const y = n.y / 4096;
      const z = n.z / 4096;
      const length = Math.hypot(x, y, z) || 1;
      return { x: x / length, y: y / length, z: z / length };
    });
    objects.push({
      vertices: readVectors(view, vertexOffsets[i]),
      normals,
      primitives: readPrimitives(view, primitiveOffsets[i]),
    });
  }

  return {
    objects,
    parents: resolveParents(skeleton),
    skeleton,
    blink,
    tim: readTim(bytes, timStart),
    timStart,
    timEnd,
  };
}

// ---- CLUT helpers ----

export interface ClutRef {
  row: number; // 0..31 within the CLUT block
  half: 0 | 1; // which 16-colour half of the 32-colour row
}

export function decodeClut(clut: number): ClutRef {
  const x = (clut & 0x3f) << 4; // in CLUT entries: 0 or 16
  const y = (clut >> 6) & 0x3ff;
  return { row: y - DW2_CLUT_ROW_BASE, half: x >= 16 ? 1 : 0 };
}

export function clutKey(ref: ClutRef) {
  return ref.row * 2 + ref.half;
}

// Renders the full 4bpp image through one 16-colour palette into RGBA.
// PSX rule: colour word 0 (black, no STP) is fully transparent.
export function paletteImage(tim: Dw2Tim, ref: ClutRef, semiTransparent: boolean): ImageData {
  const image = new ImageData(tim.width, tim.height);
  const palette = new Uint8ClampedArray(16 * 4);
  for (let i = 0; i < 16; i++) {
    const word = tim.clut[ref.row * DW2_CLUT_COLUMNS + ref.half * 16 + i] ?? 0;
    const r = (word & 0x1f) << 3;
    const g = ((word >> 5) & 0x1f) << 3;
    const b = ((word >> 10) & 0x1f) << 3;
    const stp = (word >> 15) & 1;
    let alpha: number;
    if (r === 0 && g === 0 && b === 0) alpha = stp ? 255 : 0;
    else alpha = semiTransparent && stp ? 128 : 255;
    palette.set([r | (r >> 5), g | (g >> 5), b | (b >> 5), alpha], i * 4);
  }
  for (let p = 0; p < tim.indices.length; p++) {
    const c = tim.indices[p] * 4;
    image.data[p * 4] = palette[c];
    image.data[p * 4 + 1] = palette[c + 1];
    image.data[p * 4 + 2] = palette[c + 2];
    image.data[p * 4 + 3] = palette[c + 3];
  }
  return image;
}
