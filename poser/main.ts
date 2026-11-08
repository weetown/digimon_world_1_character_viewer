import "../src/style.css";

import Alpine from "alpinejs";
import * as THREE from "three";

import {
  Clip,
  Easing,
  EASINGS,
  FPS,
  History,
  Project,
  cloneProject,
  keyedFrames,
  moveKeys,
  newClip,
  newProject,
  removeFaceEvent,
  removeKeysAt,
  setEasingAt,
  setFaceEvent,
  setPositionKey,
  setRotationKey,
  faceStateAt,
} from "../src/poser/document";
import { applyClipPose } from "../src/poser/sampler";
import { LoadedModel, loadModelFile } from "../src/poser/load";
import { PoserScene, GizmoMode } from "../src/poser/scene";
import { OnionSkin, OnionSettings } from "../src/poser/onion";
import { download, exportProject } from "../src/poser/export";

// ---- non-reactive state (three.js objects must stay out of the Alpine store) ----------
let scene: PoserScene | null = null;
let onion: OnionSkin | null = null;
let model: LoadedModel | null = null;
let project: Project | null = null;
const history = new History();
let frameFloat = 0;
let dragSnapshotTaken = false;
const clock = new THREE.Clock();

interface PoserStore {
  loaded: boolean;
  sourceName: string;
  message: string;
  nodeNames: string[];
  rootName: string;
  selected: string[];
  clips: Array<{ id: string; name: string }>;
  activeClipId: string;
  clipName: string;
  length: number;
  loop: boolean;
  frame: number;
  playing: boolean;
  autokey: boolean;
  gizmoMode: GizmoMode;
  easing: Easing;
  easings: Easing[];
  stateThumbs: string[];
  faceState: number;
  faceEvents: Array<{ frame: number; state: number }>;
  rows: Array<{ node: string; frames: number[] }>;
  rulerFrames: number[];
  keyFramesAll: number[];
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  onion: OnionSettings;

  refresh(): void;
  updateOnion(): void;
  loadModel(file: File): Promise<void>;
  loadProject(file: File): Promise<void>;
  saveProject(): void;
  exportZip(): Promise<void>;

  selectNode(name: string, additive?: boolean): void;
  clearSelection(): void;
  setGizmoMode(mode: GizmoMode): void;
  nudge(axis: "x" | "y" | "z", degrees: number): void;
  resetSelectedToBase(): void;

  setFrame(frame: number): void;
  stepFrame(delta: number): void;
  togglePlay(): void;
  setLength(length: number): void;
  toggleLoop(): void;

  keySelected(): void;
  keyAll(): void;
  deleteKeys(): void;
  setEasing(easing: Easing): void;
  moveKeysAtCursor(delta: number): void;
  hasKey(node: string, frame: number): boolean;

  setFace(state: number): void;
  clearFace(): void;

  addClip(): void;
  duplicateClip(): void;
  removeClip(): void;
  selectClip(id: string): void;
  renameClip(name: string): void;

  undo(): void;
  redo(): void;
}

function activeClip(): Clip | null {
  if (!project) return null;
  const store = Alpine.store("poser") as PoserStore;
  return project.clips.find((c) => c.id === store.activeClipId) ?? project.clips[0] ?? null;
}

function snapshot() {
  if (project) history.push(project);
}

function applyPose() {
  const clip = activeClip();
  if (!model || !clip) return;
  applyClipPose(clip, frameFloat, model.nodes, model.rootName, model.base);
  model.swaps?.setState(faceStateAt(clip, Math.floor(frameFloat)));
  scene?.syncPivot();
  const s = Alpine.store("poser") as PoserStore;
  onion?.update(clip, Math.floor(frameFloat), { ...s.onion }, s.playing);
}

function quatOf(node: THREE.Object3D): [number, number, number, number] {
  return node.quaternion.toArray() as [number, number, number, number];
}

const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

function autosave() {
  if (!project || !model) return;
  try {
    localStorage.setItem(`dw1-poser:${model.sourceName}`, JSON.stringify(project));
  } catch {
    /* storage unavailable; fine */
  }
}

function restoreAutosave(sourceName: string): Project | null {
  try {
    const raw = localStorage.getItem(`dw1-poser:${sourceName}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Project;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

const store: PoserStore = {
  loaded: false,
  sourceName: "",
  message: "Drop an export zip (or a glb) to start.",
  nodeNames: [],
  rootName: "",
  selected: [],
  clips: [],
  activeClipId: "",
  clipName: "",
  length: 40,
  loop: true,
  frame: 0,
  playing: false,
  autokey: true,
  gizmoMode: "rotate",
  easing: "linear",
  easings: EASINGS,
  stateThumbs: [],
  faceState: 0,
  faceEvents: [],
  rows: [],
  rulerFrames: [],
  keyFramesAll: [],
  canUndo: false,
  canRedo: false,
  busy: false,
  onion: { enabled: true, keysEachSide: 1, opacity: 0.35 },

  updateOnion() {
    onion?.update(activeClip(), this.frame, { ...this.onion }, this.playing);
  },

  // Rebuild the plain view-model from the project
  refresh() {
    const clip = activeClip();
    this.clips = project ? project.clips.map((c) => ({ id: c.id, name: c.name })) : [];
    if (clip) {
      this.activeClipId = clip.id;
      this.clipName = clip.name;
      this.length = clip.length;
      this.loop = clip.loop;
      this.faceEvents = clip.face.map((e) => ({ ...e }));
      this.faceState = faceStateAt(clip, this.frame);
      this.keyFramesAll = keyedFrames(clip);
      const shown = new Set<string>([...Object.keys(clip.nodes), ...this.selected]);
      if (clip.root.length) shown.add(model?.rootName ?? "");
      this.rows = [...shown]
        .filter((n) => n && model?.nodes.has(n))
        .sort((a, b) => this.nodeNames.indexOf(a) - this.nodeNames.indexOf(b))
        .map((node) => ({
          node,
          frames: [
            ...(clip.nodes[node]?.map((k) => k.frame) ?? []),
            ...(node === model?.rootName ? clip.root.map((k) => k.frame) : []),
          ],
        }));
      this.rulerFrames = Array.from({ length: clip.length }, (_, i) => i);
      const easingAtCursor =
        this.selected.map((n) => clip.nodes[n]?.find((k) => k.frame === this.frame)?.easing).find(Boolean) ??
        null;
      if (easingAtCursor) this.easing = easingAtCursor;
    }
    this.canUndo = history.canUndo;
    this.canRedo = history.canRedo;
    autosave();
    this.updateOnion();
  },

  async loadModel(file: File) {
    this.busy = true;
    this.message = `Loading ${file.name}...`;
    try {
      const loaded = await loadModelFile(file);
      scene?.setModel(null);
      onion?.setModel(null);
      model = loaded;
      scene?.setModel(loaded);
      onion?.setModel(loaded);

      this.loaded = true;
      this.sourceName = loaded.sourceName;
      this.nodeNames = [...loaded.nodes.keys()];
      this.rootName = loaded.rootName;
      this.stateThumbs = loaded.stateThumbs;
      this.selected = [];

      const saved = restoreAutosave(loaded.sourceName);
      project = saved ?? newProject(loaded.sourceName);
      this.activeClipId = project.clips[0]?.id ?? "";
      frameFloat = 0;
      this.frame = 0;
      this.playing = false;
      this.message = saved
        ? `${loaded.sourceName}: ${loaded.nodes.size} parts, restored your last session`
        : `${loaded.sourceName}: ${loaded.nodes.size} parts, ${loaded.stateThumbs.length} face states`;
      this.refresh();
      applyPose();
    } catch (error) {
      console.error(error);
      this.message = `Load failed: ${(error as Error).message}`;
    } finally {
      this.busy = false;
    }
  },

  async loadProject(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as Project;
      if (parsed.version !== 1 || !Array.isArray(parsed.clips)) throw Error("not a poser project (v1)");
      snapshot();
      project = parsed;
      this.activeClipId = project.clips[0]?.id ?? "";
      this.message = `Loaded project with ${project.clips.length} clip(s)`;
      this.refresh();
      applyPose();
    } catch (error) {
      this.message = `Project load failed: ${(error as Error).message}`;
    }
  },

  saveProject() {
    if (!project) return;
    download(JSON.stringify(project, null, 2), `${this.sourceName.replace(/\.(zip|glb|gltf)$/i, "")}.poser.json`, "application/json");
  },

  async exportZip() {
    if (!model || !project) return;
    this.busy = true;
    this.playing = false;
    this.message = "Exporting...";
    try {
      const { bytes, filename } = await exportProject(model, project, () => {
        frameFloat = 0;
        this.frame = 0;
        // Rest pose = base, no clip applied
        model!.nodes.forEach((node, name) => {
          const rest = model!.base[name];
          node.position.set(...rest.position);
          node.rotation.set(...rest.rotation);
          node.scale.set(...rest.scale);
        });
        model!.swaps?.setState(0);
      });
      download(bytes, filename);
      this.message = `Exported ${filename}`;
      applyPose();
    } catch (error) {
      console.error(error);
      this.message = `Export failed: ${(error as Error).message}`;
    } finally {
      this.busy = false;
    }
  },

  selectNode(name, additive = false) {
    if (!scene) return;
    const next = additive
      ? this.selected.includes(name)
        ? this.selected.filter((n) => n !== name)
        : [...this.selected, name]
      : [name];
    scene.setSelection(next);
  },

  clearSelection() {
    scene?.setSelection([]);
  },

  setGizmoMode(mode) {
    // Translation is only for the root; children rotate so parts stay attached
    const onlyRoot = this.selected.length === 1 && this.selected[0] === this.rootName;
    if (mode === "translate" && !onlyRoot) {
      this.message = "Only the root node can be moved; other parts rotate about their joint";
      return;
    }
    this.gizmoMode = mode;
    scene?.setGizmoMode(mode);
  },

  nudge(axis, degrees) {
    if (!model || !this.selected.length) return;
    snapshot();
    const rad = (degrees * Math.PI) / 180;
    const turn = new THREE.Quaternion().setFromAxisAngle(AXES[axis], rad);
    this.selected.forEach((name) => {
      const node = model!.nodes.get(name)!;
      node.quaternion.multiply(turn); // local-axis turn
    });
    scene?.syncPivot();
    onPoseEdited(this.selected);
    this.refresh();
  },

  resetSelectedToBase() {
    if (!model || !this.selected.length) return;
    snapshot();
    this.selected.forEach((name) => {
      const node = model!.nodes.get(name)!;
      const rest = model!.base[name];
      node.rotation.set(...rest.rotation);
      node.position.set(...rest.position);
    });
    scene?.syncPivot();
    onPoseEdited(this.selected);
    this.refresh();
  },

  setFrame(frame) {
    const clip = activeClip();
    const max = Math.max(0, (clip?.length ?? 1) - 1);
    frameFloat = Math.min(max, Math.max(0, Math.round(frame)));
    this.frame = frameFloat;
    applyPose();
    this.refresh();
  },

  stepFrame(delta) {
    this.setFrame(this.frame + delta);
  },

  togglePlay() {
    this.playing = !this.playing;
    if (this.playing) clock.getDelta();
    this.updateOnion();
  },

  setLength(length) {
    const clip = activeClip();
    if (!clip) return;
    snapshot();
    clip.length = Math.min(600, Math.max(1, Math.round(Number(length) || 1)));
    if (this.frame >= clip.length) this.setFrame(clip.length - 1);
    this.refresh();
  },

  toggleLoop() {
    const clip = activeClip();
    if (!clip) return;
    snapshot();
    clip.loop = !clip.loop;
    this.refresh();
  },

  keySelected() {
    const clip = activeClip();
    if (!model || !clip || !this.selected.length) return;
    snapshot();
    this.selected.forEach((name) => {
      const node = model!.nodes.get(name)!;
      setRotationKey(clip, name, this.frame, quatOf(node), this.easing);
      if (name === model!.rootName) {
        setPositionKey(clip, this.frame, node.position.toArray() as [number, number, number], this.easing);
      }
    });
    this.refresh();
  },

  keyAll() {
    const clip = activeClip();
    if (!model || !clip) return;
    snapshot();
    model.nodes.forEach((node, name) => {
      setRotationKey(clip, name, this.frame, quatOf(node), this.easing);
    });
    this.refresh();
  },

  deleteKeys() {
    const clip = activeClip();
    if (!clip) return;
    snapshot();
    const targets = this.selected.length
      ? [...this.selected, ...(this.selected.includes(this.rootName) ? ["__root"] : [])]
      : "all";
    removeKeysAt(clip, this.frame, targets);
    this.refresh();
    applyPose();
  },

  setEasing(easing) {
    const clip = activeClip();
    this.easing = easing;
    if (!clip) return;
    snapshot();
    const targets = this.selected.length
      ? [...this.selected, ...(this.selected.includes(this.rootName) ? ["__root"] : [])]
      : "all";
    setEasingAt(clip, this.frame, targets, easing);
    this.refresh();
  },

  moveKeysAtCursor(delta) {
    const clip = activeClip();
    if (!clip) return;
    const to = this.frame + delta;
    if (to < 0 || to >= clip.length) return;
    snapshot();
    const targets = this.selected.length
      ? [...this.selected, ...(this.selected.includes(this.rootName) ? ["__root"] : [])]
      : "all";
    moveKeys(clip, this.frame, to, targets);
    this.setFrame(to);
  },

  hasKey(node, frame) {
    const clip = activeClip();
    if (!clip) return false;
    if (clip.nodes[node]?.some((k) => k.frame === frame)) return true;
    return node === this.rootName && clip.root.some((k) => k.frame === frame);
  },

  setFace(state) {
    const clip = activeClip();
    if (!clip) return;
    snapshot();
    setFaceEvent(clip, this.frame, state);
    this.refresh();
    applyPose();
  },

  clearFace() {
    const clip = activeClip();
    if (!clip) return;
    snapshot();
    removeFaceEvent(clip, this.frame);
    this.refresh();
    applyPose();
  },

  addClip() {
    if (!project) return;
    snapshot();
    const clip = newClip(`clip ${project.clips.length + 1}`);
    project.clips.push(clip);
    this.activeClipId = clip.id;
    this.setFrame(0);
  },

  duplicateClip() {
    const clip = activeClip();
    if (!project || !clip) return;
    snapshot();
    const copy = cloneProject({ version: 1, source: "", fps: FPS, clips: [clip] }).clips[0];
    copy.id = newClip().id;
    copy.name = `${clip.name} copy`;
    project.clips.push(copy);
    this.activeClipId = copy.id;
    this.setFrame(this.frame);
  },

  removeClip() {
    const clip = activeClip();
    if (!project || !clip || project.clips.length <= 1) return;
    snapshot();
    project.clips = project.clips.filter((c) => c.id !== clip.id);
    this.activeClipId = project.clips[0].id;
    this.setFrame(0);
  },

  selectClip(id) {
    this.activeClipId = id;
    this.playing = false;
    this.setFrame(0);
  },

  renameClip(name) {
    const clip = activeClip();
    if (!clip) return;
    snapshot();
    clip.name = name.trim() || clip.name;
    this.refresh();
  },

  undo() {
    if (!project) return;
    const previous = history.undo(project);
    if (!previous) return;
    project = previous;
    if (!project.clips.some((c) => c.id === this.activeClipId)) this.activeClipId = project.clips[0]?.id ?? "";
    this.refresh();
    applyPose();
  },

  redo() {
    if (!project) return;
    const next = history.redo(project);
    if (!next) return;
    project = next;
    if (!project.clips.some((c) => c.id === this.activeClipId)) this.activeClipId = project.clips[0]?.id ?? "";
    this.refresh();
    applyPose();
  },
};

// Gizmo / nudge edits: with autokey on, write keys for the edited nodes at the cursor
function onPoseEdited(names: string[]) {
  const s = Alpine.store("poser") as PoserStore;
  const clip = activeClip();
  if (!model || !clip || s.playing) return;
  if (!s.autokey) return;

  if (!dragSnapshotTaken) {
    snapshot();
    dragSnapshotTaken = true;
  }

  names.forEach((name) => {
    const node = model!.nodes.get(name)!;
    setRotationKey(clip, name, s.frame, quatOf(node), s.easing);
    if (name === model!.rootName && s.gizmoMode === "translate") {
      setPositionKey(clip, s.frame, node.position.toArray() as [number, number, number], s.easing);
    }
  });
  s.refresh();
}

Alpine.store("poser", store);
Alpine.start();

if (import.meta.env.DEV) {
  (window as unknown as { __poser: unknown }).__poser = {
    store: () => Alpine.store("poser") as PoserStore,
    scene: () => scene,
    model: () => model,
    project: () => project,
    exportProject,
    applyPose,
    onion: () => onion,
    // for scripted checks of the export
    unzipSync: (bytes: Uint8Array) => import("fflate").then((m) => m.unzipSync(bytes)),
    GLTFLoader: () => import("three/examples/jsm/loaders/GLTFLoader").then((m) => m.GLTFLoader),
  };
}

// ---- boot --------------------------------------------------------------------------------
const container = document.getElementById("viewport")!;
scene = new PoserScene(container);
onion = new OnionSkin(scene.scene);

scene.onSelectionChange = (names) => {
  const s = Alpine.store("poser") as PoserStore;
  s.selected = names;
  if (s.gizmoMode === "translate" && !(names.length === 1 && names[0] === s.rootName)) {
    s.gizmoMode = "rotate";
    scene!.setGizmoMode("rotate");
  }
  s.refresh();
};
scene.onPoseEdited = (names) => onPoseEdited(names);
scene.onGizmoDragEnd = () => {
  dragSnapshotTaken = false;
};

function tick() {
  const s = Alpine.store("poser") as PoserStore;
  const delta = clock.getDelta();
  const clip = activeClip();

  if (s.playing && clip && model) {
    frameFloat += delta * FPS;
    if (frameFloat >= clip.length) {
      if (clip.loop) frameFloat = frameFloat % clip.length;
      else {
        frameFloat = clip.length - 1;
        s.playing = false;
        s.updateOnion();
      }
    }
    const whole = Math.floor(frameFloat);
    if (whole !== s.frame) {
      s.frame = whole;
      s.faceState = faceStateAt(clip, whole);
    }
    applyPose();
  }

  scene!.render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Files: inputs + drag and drop
const modelInput = document.getElementById("modelFile") as HTMLInputElement;
const projectInput = document.getElementById("projectFile") as HTMLInputElement;
modelInput.addEventListener("change", () => {
  const file = modelInput.files?.[0];
  if (file) (Alpine.store("poser") as PoserStore).loadModel(file);
  modelInput.value = "";
});
projectInput.addEventListener("change", () => {
  const file = projectInput.files?.[0];
  if (file) (Alpine.store("poser") as PoserStore).loadProject(file);
  projectInput.value = "";
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files[0];
  if (!file) return;
  const s = Alpine.store("poser") as PoserStore;
  if (file.name.endsWith(".json")) s.loadProject(file);
  else s.loadModel(file);
});

// Keyboard
window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement;
  if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
  const s = Alpine.store("poser") as PoserStore;
  if (!s.loaded) return;
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) return (e.preventDefault(), s.undo());
  if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) return (e.preventDefault(), s.redo());

  switch (e.key) {
    case " ":
      e.preventDefault();
      return s.togglePlay();
    case "ArrowLeft":
      e.preventDefault();
      return e.shiftKey ? s.moveKeysAtCursor(-1) : s.stepFrame(-1);
    case "ArrowRight":
      e.preventDefault();
      return e.shiftKey ? s.moveKeysAtCursor(1) : s.stepFrame(1);
    case "Home":
      return s.setFrame(0);
    case "End":
      return s.setFrame(s.length - 1);
    case "k":
      return s.keySelected();
    case "K":
      return s.keyAll();
    case "Delete":
    case "Backspace":
      return s.deleteKeys();
    case "g":
      return s.setGizmoMode("rotate");
    case "t":
      return s.setGizmoMode("translate");
    case "Escape":
      return s.clearSelection();
  }
});
