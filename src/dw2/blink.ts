// The 24 "blink" bytes in a DW2 model header. Read off Agumon, Gabumon and Tyrannomon's
// data against their textures:
//
//   u8 destX, destY, width, height     eye rectangle in the texture, x/width in VRAM
//                                       halfwords (4 texels each for 4bpp), y/height in rows
//   u8 srcX, srcY  x up to 8            alternative eye images to copy over it, 0xff ends
//   u8 ff ... fe ff 00 00               tail; meaning unknown (timing?), kept raw
//
// Agumon: dest (14,40,8,24) -> texels (56,40) 32x24, which is the big eye on the face;
// sources (0,0), (8,0), (6,40) -> the three spare eyes drawn around it.

import { Dw2Tim, DW2_TEXTURE_HEIGHT, DW2_TEXTURE_WIDTH } from "./model";

export interface BlinkRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BlinkData {
  dest: BlinkRect; // texels
  sources: Array<{ x: number; y: number }>; // texels
  raw: number[];
}

const TEXELS_PER_UNIT = 4;

export function parseBlink(bytes: Uint8Array): BlinkData | null {
  if (bytes.length < 24) return null;
  const [dx, dy, w, h] = bytes;
  if (dx === 0xff || w === 0 || h === 0) return null;
  const dest = { x: dx * TEXELS_PER_UNIT, y: dy, width: w * TEXELS_PER_UNIT, height: h };
  if (dest.x + dest.width > DW2_TEXTURE_WIDTH || dest.y + dest.height > DW2_TEXTURE_HEIGHT) return null;

  const sources: BlinkData["sources"] = [];
  for (let i = 4; i + 1 < 20; i += 2) {
    const sx = bytes[i];
    const sy = bytes[i + 1];
    if (sx === 0xff || sy === 0xff) break;
    const x = sx * TEXELS_PER_UNIT;
    if (x + dest.width > DW2_TEXTURE_WIDTH || sy + dest.height > DW2_TEXTURE_HEIGHT) break;
    sources.push({ x, y: sy });
  }
  if (!sources.length) return null;
  return { dest, sources, raw: Array.from(bytes) };
}

// Copies one source rectangle over the eye rectangle at the palette-index level, so every
// material's palette renders the result consistently.
export function blinkIndices(tim: Dw2Tim, blink: BlinkData, source: number): Uint8Array {
  const out = new Uint8Array(tim.indices);
  const src = blink.sources[source];
  const { dest } = blink;
  for (let row = 0; row < dest.height; row++) {
    const from = (src.y + row) * tim.width + src.x;
    const to = (dest.y + row) * tim.width + dest.x;
    out.set(tim.indices.subarray(from, from + dest.width), to);
  }
  return out;
}
