// Digimon World 2 animation file (A###CODE.BIN .. K###CODE.BIN, one letter per animation
// set). Layout after dw2_model_converter:
//
//   u32 zero
//   u32 keyframeOffset[numObjects]        absolute; each object's keyframe matrices
//   u32 frameOffset[]                     absolute, read until a word that is 0 or 1
//                                         (leading zero words are padding)
//   per frame: rows of numObjects bytes (keyframe index per object) until the next byte is
//              0xfe or 0xff; then u8 terminationMask, u16 loopMask
//   keyframe: i16 m[3][3] (3.12 fixed), i16 t[3]  = 24 bytes

export interface Dw2Matrix {
  // 3x3 in stored (row-major) order, 3.12 fixed point already divided out
  m: [number, number, number, number, number, number, number, number, number];
  t: [number, number, number];
}

export interface Dw2Frame {
  rows: number[][]; // row -> keyframe index per object
  terminationMask: number; // 0xfe: loops, 0xff: plays once (per the format doc)
  loopMask: number;
}

export interface Dw2Anim {
  frames: Dw2Frame[];
  // keyframes[object][index]
  keyframes: Dw2Matrix[][];
  keyframeOffsets: number[];
}

export const DW2_FRAME_RATE = 30; // rows per second, as dw2_model_converter assumes

export function parseDw2Anim(bytes: Uint8Array, numObjects: number): Dw2Anim {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 4;
  const keyframeOffsets: number[] = [];
  for (let i = 0; i < numObjects; i++, pos += 4) keyframeOffsets.push(view.getUint32(pos, true));

  // Frame offsets: skip padding zeros, then read until 0/1
  while (pos + 4 <= bytes.length && view.getUint32(pos, true) === 0) pos += 4;
  const frameOffsets: number[] = [];
  while (pos + 4 <= bytes.length) {
    const word = view.getUint32(pos, true);
    pos += 4;
    if (word === 0 || word === 1) break;
    frameOffsets.push(word);
  }

  const maxIndex = new Array<number>(numObjects).fill(0);
  const frames: Dw2Frame[] = frameOffsets.map((offset) => {
    const rows: number[][] = [];
    let p = offset;
    while (p + numObjects <= bytes.length && bytes[p] !== 0xfe && bytes[p] !== 0xff) {
      const row = Array.from(bytes.subarray(p, p + numObjects));
      row.forEach((k, i) => (maxIndex[i] = Math.max(maxIndex[i], k)));
      rows.push(row);
      p += numObjects;
    }
    const terminationMask = bytes[p] ?? 0xff;
    const loopMask = p + 3 <= bytes.length ? view.getUint16(p + 1, true) : 0;
    return { rows, terminationMask, loopMask };
  });

  const keyframes = keyframeOffsets.map((offset, object) => {
    const count = maxIndex[object] + 1;
    const out: Dw2Matrix[] = [];
    for (let k = 0; k < count; k++) {
      const p = offset + k * 24;
      if (p + 24 > bytes.length) break;
      const m = Array.from({ length: 9 }, (_, i) => view.getInt16(p + i * 2, true) / 4096);
      out.push({
        m: m as Dw2Matrix["m"],
        t: [view.getInt16(p + 18, true), view.getInt16(p + 20, true), view.getInt16(p + 22, true)],
      });
    }
    return out;
  });

  return { frames, keyframes, keyframeOffsets };
}
