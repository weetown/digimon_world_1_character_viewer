import { describe, expect, it } from "vitest";
import * as THREE from "three";

import { resolveParents, decodeClut, clutKey } from "./model";
import { parseBlink, blinkIndices } from "./blink";
import { parseDw2Anim } from "./anim";
import { matrixToThree } from "./scene";

describe("skeleton table", () => {
  it("resolves parents from pre-order depths (Agumon's table)", () => {
    const skeleton = [0, 1, 2, 1, 2, 3, 1, 2, 3, 0, 1, 2, 3, 1, 2, 3];
    expect(resolveParents(skeleton)).toEqual([-1, 0, 1, 0, 3, 4, 0, 6, 7, -1, 9, 10, 11, 9, 13, 14]);
  });
});

describe("clut word", () => {
  it("splits into row and half", () => {
    // y = 252, x = 0 -> (252 << 6)
    expect(decodeClut(252 << 6)).toEqual({ row: 28, half: 0 });
    expect(decodeClut((254 << 6) | 1)).toEqual({ row: 30, half: 1 });
    expect(clutKey({ row: 30, half: 1 })).toBe(61);
  });
});

describe("blink table", () => {
  const agumon = new Uint8Array([14, 40, 8, 24, 0, 0, 8, 0, 6, 40, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 254, 255, 0, 0]);

  it("decodes Agumon's eye rectangle and three sources", () => {
    const blink = parseBlink(agumon)!;
    expect(blink.dest).toEqual({ x: 56, y: 40, width: 32, height: 24 });
    expect(blink.sources).toEqual([
      { x: 0, y: 0 },
      { x: 32, y: 0 },
      { x: 24, y: 40 },
    ]);
  });

  it("rejects an empty table", () => {
    expect(parseBlink(new Uint8Array(24).fill(0xff))).toBeNull();
  });

  it("copies a source rectangle over the destination at the index level", () => {
    const width = 128;
    const height = 256;
    const indices = new Uint8Array(width * height);
    for (let y = 0; y < 24; y++) for (let x = 32; x < 64; x++) indices[y * width + x] = 7;
    const tim = { indices, width, height, clut: new Uint16Array(1024), vramX: 0, vramY: 0 };
    const out = blinkIndices(tim, parseBlink(agumon)!, 1);
    expect(out[40 * width + 56]).toBe(7);
    expect(out[63 * width + 87]).toBe(7);
    expect(out[64 * width + 56]).toBe(0);
    expect(indices[40 * width + 56]).toBe(0); // original untouched
  });
});

describe("animation file", () => {
  it("reads frame rows and keyframes", () => {
    const numObjects = 2;
    const bytes = new Uint8Array(0x80);
    const view = new DataView(bytes.buffer);
    // header: zero, keyframe offsets, padding, frame offsets, terminator 1
    view.setUint32(0, 0, true);
    view.setUint32(4, 0x20, true); // object 0 keys
    view.setUint32(8, 0x50, true); // object 1 keys
    view.setUint32(12, 0, true); // padding
    view.setUint32(16, 0x18, true); // frame 0
    view.setUint32(20, 1, true); // end of frame list
    // frame 0 at 0x18: rows [0,0],[1,0], then 0xfe, loop mask 0x0102
    bytes.set([0, 0, 1, 0, 0xfe, 0x02, 0x01], 0x18);
    // object 0 keyframes at 0x20: two identity-ish matrices
    for (let k = 0; k < 2; k++) {
      const p = 0x20 + k * 24;
      view.setInt16(p, 4096, true);
      view.setInt16(p + 8, 4096, true);
      view.setInt16(p + 16, 4096, true);
      view.setInt16(p + 18, 10 * (k + 1), true);
    }
    view.setInt16(0x50, 4096, true);
    view.setInt16(0x50 + 8, 4096, true);
    view.setInt16(0x50 + 16, 4096, true);

    const anim = parseDw2Anim(bytes, numObjects);
    expect(anim.frames).toHaveLength(1);
    expect(anim.frames[0].rows).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(anim.frames[0].terminationMask).toBe(0xfe);
    expect(anim.frames[0].loopMask).toBe(0x0102);
    expect(anim.keyframes[0]).toHaveLength(2);
    expect(anim.keyframes[1]).toHaveLength(1);
    expect(anim.keyframes[0][1].t).toEqual([20, 0, 0]);
    expect(anim.keyframes[0][1].m[0]).toBe(1);
  });
});

describe("matrix reading", () => {
  it("treats the stored 3x3 as row-major (v' = M v)", () => {
    // 90 degrees about z, row-major: [0 -1 0; 1 0 0; 0 0 1] maps x to y
    const m = matrixToThree({ m: [0, -1, 0, 1, 0, 0, 0, 0, 1], t: [5, 0, 0] });
    const v = new THREE.Vector3(1, 0, 0).applyMatrix4(m);
    expect(v.x).toBeCloseTo(5);
    expect(v.y).toBeCloseTo(1);
    expect(v.z).toBeCloseTo(0);
  });
});
