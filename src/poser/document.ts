// The poser's data model: a project with several clips, each a set of keyed node rotations,
// root positions and face (texture state) events, on a 20 fps frame grid. Pure data; no
// three.js here so it can be tested and serialised directly.

export const FPS = 20;

export type Easing = "linear" | "step" | "easeIn" | "easeOut" | "easeInOut";
export const EASINGS: Easing[] = ["linear", "easeIn", "easeOut", "easeInOut", "step"];

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

export interface RotationKey {
  frame: number;
  rotation: Quat; // node-local quaternion. Quaternions, not Euler: reading Euler back from a
  // node can return an equivalent-but-different triple, which made deltas drift.
  easing: Easing; // applies to the segment leaving this key
}

export interface PositionKey {
  frame: number;
  position: Vec3;
  easing: Easing;
}

export interface FaceEvent {
  frame: number;
  state: number;
}

export interface Clip {
  id: string;
  name: string;
  length: number; // frames, exclusive end (loop wraps at length)
  loop: boolean;
  nodes: Record<string, RotationKey[]>; // node name -> keys sorted by frame
  root: PositionKey[]; // root translation keys
  face: FaceEvent[];
}

export interface Project {
  version: 1;
  source: string; // file the model came from, for the user's reference
  fps: typeof FPS;
  clips: Clip[];
}

export function newId() {
  return Math.random().toString(36).slice(2, 10);
}

export function newClip(name = "clip"): Clip {
  return { id: newId(), name, length: 40, loop: true, nodes: {}, root: [], face: [] };
}

export function newProject(source: string): Project {
  return { version: 1, source, fps: FPS, clips: [newClip("wave")] };
}

export function cloneProject(project: Project): Project {
  return JSON.parse(JSON.stringify(project)) as Project;
}

function sortByFrame<T extends { frame: number }>(list: T[]) {
  list.sort((a, b) => a.frame - b.frame);
}

// Insert or replace a rotation key for a node
export function setRotationKey(
  clip: Clip,
  node: string,
  frame: number,
  rotation: Quat,
  easing: Easing = "linear",
) {
  const keys = (clip.nodes[node] ??= []);
  const existing = keys.find((k) => k.frame === frame);
  if (existing) {
    existing.rotation = [...rotation];
  } else {
    keys.push({ frame, rotation: [...rotation], easing });
    sortByFrame(keys);
  }
}

export function setPositionKey(
  clip: Clip,
  frame: number,
  position: Vec3,
  easing: Easing = "linear",
) {
  const existing = clip.root.find((k) => k.frame === frame);
  if (existing) {
    existing.position = [...position];
  } else {
    clip.root.push({ frame, position: [...position], easing });
    sortByFrame(clip.root);
  }
}

export function removeKeysAt(clip: Clip, frame: number, nodes: string[] | "all") {
  const names = nodes === "all" ? Object.keys(clip.nodes) : nodes;
  names.forEach((node) => {
    const keys = clip.nodes[node];
    if (!keys) return;
    clip.nodes[node] = keys.filter((k) => k.frame !== frame);
    if (!clip.nodes[node].length) delete clip.nodes[node];
  });
  if (nodes === "all" || nodes.includes("__root")) {
    clip.root = clip.root.filter((k) => k.frame !== frame);
  }
}

export function moveKeys(clip: Clip, fromFrame: number, toFrame: number, nodes: string[] | "all") {
  if (fromFrame === toFrame) return;
  const names = nodes === "all" ? Object.keys(clip.nodes) : nodes;
  names.forEach((node) => {
    const keys = clip.nodes[node];
    if (!keys) return;
    const key = keys.find((k) => k.frame === fromFrame);
    if (!key) return;
    clip.nodes[node] = keys.filter((k) => k.frame !== toFrame);
    key.frame = toFrame;
    sortByFrame(clip.nodes[node]);
  });
  if (nodes === "all" || nodes.includes("__root")) {
    const key = clip.root.find((k) => k.frame === fromFrame);
    if (key) {
      clip.root = clip.root.filter((k) => k.frame !== toFrame);
      key.frame = toFrame;
      sortByFrame(clip.root);
    }
  }
}

export function setEasingAt(clip: Clip, frame: number, nodes: string[] | "all", easing: Easing) {
  const names = nodes === "all" ? Object.keys(clip.nodes) : nodes;
  names.forEach((node) => {
    const key = clip.nodes[node]?.find((k) => k.frame === frame);
    if (key) key.easing = easing;
  });
  if (nodes === "all" || nodes.includes("__root")) {
    const key = clip.root.find((k) => k.frame === frame);
    if (key) key.easing = easing;
  }
}

export function setFaceEvent(clip: Clip, frame: number, state: number) {
  const existing = clip.face.find((e) => e.frame === frame);
  if (existing) existing.state = state;
  else {
    clip.face.push({ frame, state });
    sortByFrame(clip.face);
  }
}

export function removeFaceEvent(clip: Clip, frame: number) {
  clip.face = clip.face.filter((e) => e.frame !== frame);
}

// All frames that carry at least one key (for the ruler)
export function keyedFrames(clip: Clip): number[] {
  const frames = new Set<number>();
  Object.values(clip.nodes).forEach((keys) => keys.forEach((k) => frames.add(k.frame)));
  clip.root.forEach((k) => frames.add(k.frame));
  return [...frames].sort((a, b) => a - b);
}

export function faceStateAt(clip: Clip, frame: number): number {
  let state = 0;
  for (const event of clip.face) {
    if (event.frame <= frame) state = event.state;
    else break;
  }
  return state;
}

// Small snapshot-based undo stack. Projects are small, so JSON copies are fine.
export class History {
  private past: string[] = [];
  private future: string[] = [];
  private limit = 200;

  push(project: Project) {
    this.past.push(JSON.stringify(project));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: Project): Project | null {
    const previous = this.past.pop();
    if (previous === undefined) return null;
    this.future.push(JSON.stringify(current));
    return JSON.parse(previous) as Project;
  }

  redo(current: Project): Project | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(JSON.stringify(current));
    return JSON.parse(next) as Project;
  }

  get canUndo() {
    return this.past.length > 0;
  }

  get canRedo() {
    return this.future.length > 0;
  }
}
