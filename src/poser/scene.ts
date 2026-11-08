// three.js side of the poser: renderer, orbit camera, picking, selection outlines, and a
// rotate gizmo that drives every selected node about its own joint.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { TransformControls } from "three/examples/jsm/controls/TransformControls";

import { LoadedModel } from "./load";

export type GizmoMode = "rotate" | "translate";

export class PoserScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly orbit: OrbitControls;
  readonly gizmo: TransformControls;

  private container: HTMLElement;
  private model: LoadedModel | null = null;
  private pivot = new THREE.Object3D();
  private pivotPrevQuat = new THREE.Quaternion();
  private pivotPrevPos = new THREE.Vector3();
  private selected: string[] = [];
  private outlines: THREE.Object3D[] = [];
  private outlineMaterial = new THREE.MeshBasicMaterial({
    color: 0xfacc15,
    wireframe: true,
    depthTest: false,
    transparent: true,
    opacity: 0.9,
  });
  private raycaster = new THREE.Raycaster();
  private pointerDown: { x: number; y: number } | null = null;

  // Callbacks wired by the controller
  onSelectionChange: (names: string[]) => void = () => {};
  onPoseEdited: (names: string[]) => void = () => {};
  onGizmoDragEnd: () => void = () => {};

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(30, 1, 1, 20000);
    this.camera.position.set(0, 300, 1200);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(1, 2, 3);
    this.scene.add(sun);

    const grid = new THREE.GridHelper(2000, 20, 0x52525b, 0x3f3f46);
    grid.position.y = -1;
    this.scene.add(grid);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.orbit.enableDamping = false;

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setMode("rotate");
    this.gizmo.setSpace("local");
    this.gizmo.setSize(0.8);
    this.scene.add(this.pivot);
    this.scene.add(this.gizmo);

    this.gizmo.addEventListener("dragging-changed", (event) => {
      this.orbit.enabled = !(event as unknown as { value: boolean }).value;
      if (!(event as unknown as { value: boolean }).value) this.onGizmoDragEnd();
    });
    this.gizmo.addEventListener("objectChange", () => this.applyGizmoDelta());

    this.renderer.domElement.addEventListener("pointerdown", (e) => {
      this.pointerDown = { x: e.clientX, y: e.clientY };
    });
    this.renderer.domElement.addEventListener("pointerup", (e) => {
      if (!this.pointerDown) return;
      const moved = Math.hypot(e.clientX - this.pointerDown.x, e.clientY - this.pointerDown.y);
      this.pointerDown = null;
      if (moved > 4 || this.gizmo.dragging) return;
      this.pick(e);
    });

    // The container can be 0x0 at construction (Alpine's x-cloak hides the page until it
    // starts), so track its size rather than relying on window resize events.
    new ResizeObserver(() => this.resize()).observe(container);
    window.addEventListener("resize", () => this.resize());
    this.resize();
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  setModel(model: LoadedModel | null) {
    if (this.model) this.scene.remove(this.model.root);
    this.setSelection([]);
    this.model = model;
    if (!model) return;

    this.scene.add(model.root);

    const box = new THREE.Box3().setFromObject(model.root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const distance = Math.max(size.x, size.y, size.z) * 2.4;
    this.camera.position.set(center.x + distance * 0.3, center.y + size.y * 0.4, center.z + distance);
    this.orbit.target.copy(center);
    this.orbit.update();
  }

  get selection() {
    return [...this.selected];
  }

  setSelection(names: string[]) {
    this.selected = names.filter((n) => this.model?.nodes.has(n));
    this.refreshOutlines();
    this.attachGizmo();
    this.onSelectionChange(this.selection);
  }

  setGizmoMode(mode: GizmoMode) {
    this.gizmo.setMode(mode);
  }

  // Re-seat the pivot after the pose changed from outside (timeline scrub, undo)
  syncPivot() {
    if (!this.model || !this.selected.length) return;
    const primary = this.model.nodes.get(this.selected[this.selected.length - 1])!;
    primary.updateWorldMatrix(true, false);
    primary.getWorldPosition(this.pivot.position);
    primary.getWorldQuaternion(this.pivot.quaternion);
    this.pivotPrevQuat.copy(this.pivot.quaternion);
    this.pivotPrevPos.copy(this.pivot.position);
  }

  private attachGizmo() {
    if (!this.model || !this.selected.length) {
      this.gizmo.detach();
      return;
    }
    this.syncPivot();
    this.gizmo.attach(this.pivot);
  }

  private applyGizmoDelta() {
    if (!this.model || !this.selected.length) return;

    if (this.gizmo.mode === "rotate") {
      // World-space delta the user applied to the pivot
      const delta = this.pivot.quaternion.clone().multiply(this.pivotPrevQuat.clone().invert());
      this.pivotPrevQuat.copy(this.pivot.quaternion);

      // Snapshot every selected node's world orientation first: if a parent and its child
      // are both selected, applying the parent first would otherwise feed the child a
      // doubled delta through the updated world matrix.
      const targets = this.selected.map((name) => {
        const node = this.model!.nodes.get(name)!;
        return { node, worldQ: node.getWorldQuaternion(new THREE.Quaternion()).premultiply(delta) };
      });

      const parentQ = new THREE.Quaternion();
      targets.forEach(({ node, worldQ }) => {
        if (node.parent) node.parent.getWorldQuaternion(parentQ);
        else parentQ.identity();
        node.quaternion.copy(parentQ.invert().multiply(worldQ));
      });
    } else {
      // Translate: only ever offered for the root, moves it by the world delta
      const delta = this.pivot.position.clone().sub(this.pivotPrevPos);
      this.pivotPrevPos.copy(this.pivot.position);
      this.selected.forEach((name) => {
        const node = this.model!.nodes.get(name)!;
        const parentQ = new THREE.Quaternion();
        if (node.parent) node.parent.getWorldQuaternion(parentQ);
        node.position.add(delta.clone().applyQuaternion(parentQ.invert()));
      });
    }

    this.refreshOutlineTransforms();
    this.onPoseEdited(this.selection);
  }

  private pick(event: PointerEvent) {
    if (!this.model) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.model.meshOwner.keys()];
    const hit = this.raycaster.intersectObjects(meshes, false)[0];

    const additive = event.shiftKey || event.ctrlKey || event.metaKey;

    if (!hit) {
      if (!additive) this.setSelection([]);
      return;
    }

    const name = this.model.meshOwner.get(hit.object)!;
    if (additive) {
      const next = this.selected.includes(name)
        ? this.selected.filter((n) => n !== name)
        : [...this.selected, name];
      this.setSelection(next);
    } else {
      this.setSelection([name]);
    }
  }

  private refreshOutlines() {
    this.outlines.forEach((o) => o.parent?.remove(o));
    this.outlines = [];
    if (!this.model) return;

    this.selected.forEach((name) => {
      this.model!.meshOwner.forEach((owner, mesh) => {
        if (owner !== name) return;
        const outline = new THREE.Mesh((mesh as THREE.Mesh).geometry, this.outlineMaterial);
        outline.renderOrder = 999;
        mesh.add(outline);
        this.outlines.push(outline);
      });
    });
  }

  private refreshOutlineTransforms() {
    // Outlines are children of their meshes, so they follow automatically
  }

  dispose() {
    this.gizmo.dispose();
    this.orbit.dispose();
    this.renderer.dispose();
  }
}
