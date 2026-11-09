// Texture-swap data: replays every opcode-3 rect copy on each textured material, dedupes the
// resulting texture states, and writes the timing file the runtime helper consumes.

import { BakedAnimation, INFINITE_REPETITIONS, TextureEvent, unrollTime } from "./clip-baker";
import { hashPixels } from "./png";
import { unitsToSeconds } from "./time";

// ---- File format (version 1). Shared with src/runtime/digimon-swaps.ts ----

export interface SwapOp {
  srcX: number;
  srcY: number;
  destX: number;
  destY: number;
  width: number;
  height: number;
}

export interface SwapEvent {
  time: number; // seconds, on the clip's own time axis
  state: number; // index into materials[].states
  op?: SwapOp; // the rect copy that produced the state (absent for state 0 resets)
}

export interface SwapClipEntry {
  events: SwapEvent[];
  loop: { start: number; end: number; repetitions: number } | null;
}

export interface SwapsFile {
  version: 1;
  timeUnitSeconds: number;
  materials: Array<{
    name: string;
    width: number;
    height: number;
    states: string[]; // relative PNG paths, index = state
  }>;
  // keyed by glTF animation (clip) name
  animations: Record<string, SwapClipEntry>;
  // Game-specific notes (DW2: the decoded blink rectangle and sources behind the states)
  extras?: Record<string, unknown>;
}

// ---- Building ----

export interface SwapsBuildResult {
  file: SwapsFile;
  // state index -> per material ImageData (same order as file.materials)
  states: ImageData[][];
}

function applyOp(image: ImageData, op: SwapOp): ImageData {
  const next = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);

  for (let h = 0; h < op.height; h++) {
    for (let w = 0; w < op.width; w++) {
      const sx = op.srcX + w;
      const sy = op.srcY + h;
      const dx = op.destX + w;
      const dy = op.destY + h;

      if (sx >= image.width || sy >= image.height || dx >= image.width || dy >= image.height) {
        continue;
      }

      const src = (sy * image.width + sx) * 4;
      const dest = (dy * image.width + dx) * 4;

      next.data[dest] = image.data[src];
      next.data[dest + 1] = image.data[src + 1];
      next.data[dest + 2] = image.data[src + 2];
      next.data[dest + 3] = image.data[src + 3];
    }
  }

  return next;
}

export function buildSwaps({
  materials,
  animations,
}: {
  materials: Array<{ name: string; baseImage: ImageData }>;
  animations: Array<{ baked: BakedAnimation; baseName: string }>;
}): SwapsBuildResult {
  const states: ImageData[][] = [materials.map((m) => m.baseImage)];
  const stateIndexByHash = new Map<string, number>();

  const hashState = (images: ImageData[]) => images.map(hashPixels).join("|");
  stateIndexByHash.set(hashState(states[0]), 0);

  const internState = (images: ImageData[]) => {
    const hash = hashState(images);
    const existing = stateIndexByHash.get(hash);
    if (existing !== undefined) return existing;

    states.push(images);
    stateIndexByHash.set(hash, states.length - 1);
    return states.length - 1;
  };

  const file: SwapsFile = {
    version: 1,
    timeUnitSeconds: unitsToSeconds(1),
    materials: materials.map((m) => ({
      name: m.name,
      width: m.baseImage.width,
      height: m.baseImage.height,
      states: [],
    })),
    animations: {},
  };

  animations.forEach(({ baked, baseName }) => {
    if (!baked.textureEvents.length) return;

    // Replay the ops in game time to learn the state after each event
    let current = states[0];
    const timeline: Array<{ timeUnits: number; state: number; op: SwapOp }> = [];

    [...baked.textureEvents]
      .sort((a, b) => a.timeUnits - b.timeUnits)
      .forEach((event: TextureEvent) => {
        current = current.map((image) => applyOp(image, event.op));
        timeline.push({
          timeUnits: event.timeUnits,
          state: internState(current),
          op: event.op,
        });
      });

    const loop = baked.textureLoop;

    // Flat clip: events unrolled over finite loops; infinite loops keep a loop block
    const flatEvents: SwapEvent[] = [{ time: 0, state: 0 }];
    timeline.forEach((entry) => {
      unrollTime(entry.timeUnits, baked).forEach((t) => {
        flatEvents.push({ time: unitsToSeconds(t), state: entry.state, op: entry.op });
      });
    });
    flatEvents.sort((a, b) => a.time - b.time);

    file.animations[baseName] = {
      events: flatEvents,
      loop:
        loop && loop.repetitions === INFINITE_REPETITIONS
          ? {
              start: unitsToSeconds(loop.startUnits),
              end: unitsToSeconds(loop.endUnits),
              repetitions: INFINITE_REPETITIONS,
            }
          : null,
    };

    // Segment clips: rebased times
    if (loop && baked.hasLoop) {
      const inRange = (t: number, from: number, to: number) => t >= from && t < to;

      const intro = timeline.filter((e) => e.timeUnits < loop.startUnits);
      const body = timeline.filter((e) => inRange(e.timeUnits, loop.startUnits, loop.endUnits));
      const outro = timeline.filter((e) => e.timeUnits >= loop.endUnits);

      const stateBefore = (list: typeof timeline) =>
        list.length ? list[list.length - 1].state : 0;

      file.animations[`${baseName}__intro`] = {
        events: [
          { time: 0, state: 0 },
          ...intro.map((e) => ({ time: unitsToSeconds(e.timeUnits), state: e.state, op: e.op })),
        ],
        loop: null,
      };

      file.animations[`${baseName}__loop`] = {
        events: [
          { time: 0, state: stateBefore(intro) },
          ...body.map((e) => ({
            time: unitsToSeconds(e.timeUnits - loop.startUnits),
            state: e.state,
            op: e.op,
          })),
        ],
        loop: null,
      };

      file.animations[`${baseName}__outro`] = {
        events: [
          { time: 0, state: stateBefore([...intro, ...body]) },
          ...outro.map((e) => ({
            time: unitsToSeconds(e.timeUnits - loop.endUnits),
            state: e.state,
            op: e.op,
          })),
        ],
        loop: null,
      };
    }
  });

  file.materials.forEach((material, m) => {
    material.states = states.map(
      (_, s) => `swaps/${material.name}/state_${String(s).padStart(2, "0")}.png`,
    );
    void m;
  });

  return { file, states };
}
