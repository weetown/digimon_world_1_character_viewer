// Side-by-side view: a Digimon from the other game standing beside the current one, so a DW1
// model and its DW2 counterpart can be compared in the same artboard.
//
// The companion is built in "companion" mode (no camera, no render loop of its own) and then
// reparented under a group that carries the horizontal offset, an optional scale that matches
// the primary's height, and the drag rotation. Nothing here goes on the Alpine store.

import * as THREE from "three";

import { Artboard } from "./artboard";
import { Digimon } from "./digimon";
import { Dw2Digimon } from "../dw2/viewer";
import { framePair, restoreCamera, saveCamera, SavedCamera } from "./compare";

export type SideBySideGame = "dw1" | "dw2";

export interface Footprint {
  height: number;
  radius: number;
}

export function footprintOf(digimon: Digimon | Dw2Digimon): Footprint {
  const { height, radius } = digimon.info.digimonStruct;
  return { height: Math.max(height, 1), radius: Math.max(radius, 1) };
}

export class SideBySide {
  readonly game: SideBySideGame;
  readonly digimon: Digimon | Dw2Digimon;
  readonly group: THREE.Group;

  matchHeight: boolean;

  private artboard: Artboard;
  private savedCamera: SavedCamera | null = null;
  private primary: Footprint;

  constructor(
    artboard: Artboard,
    game: SideBySideGame,
    digimon: Digimon | Dw2Digimon,
    { primary, matchHeight }: { primary: Footprint; matchHeight: boolean },
  ) {
    this.artboard = artboard;
    this.game = game;
    this.digimon = digimon;
    this.matchHeight = matchHeight;
    this.primary = primary;

    this.group = new THREE.Group();
    this.group.name = `side_by_side_${game}`;
    // Object3D.add() detaches from the scene the constructor put it in
    this.group.add(digimon.rootNode);
    artboard.add(this.group, { shouldRender: false });

    this.layout();
    this.reframe();
  }

  // Scale applied to the companion so the two stand at the same height (1 at native units)
  get scale() {
    if (!this.matchHeight) return 1;
    return this.primary.height / footprintOf(this.digimon).height;
  }

  get offsetX() {
    const companion = footprintOf(this.digimon);
    return Math.max((this.primary.radius + companion.radius * this.scale) * 1.6, 400);
  }

  // The primary changed (new Digimon, or its height/radius): re-place and re-frame
  setPrimary(primary: Footprint) {
    this.primary = primary;
    this.layout();
    this.reframe();
  }

  setMatchHeight(on: boolean) {
    this.matchHeight = on;
    this.layout();
    this.reframe();
  }

  // Drag rotation shared with the primary
  rotate(x: number, y: number) {
    this.group.rotation.x += x;
    this.group.rotation.y += y;
  }

  private layout() {
    const scale = this.scale;
    this.group.scale.setScalar(scale);
    this.group.position.x = this.offsetX;
  }

  // The primary's constructor already framed itself; start from that each time so the
  // back-off does not accumulate across toggles.
  private reframe() {
    if (this.savedCamera) restoreCamera(this.artboard.camera, this.savedCamera);
    this.savedCamera = saveCamera(this.artboard.camera);
    framePair(this.artboard.camera, {
      offsetX: this.offsetX,
      height: Math.max(this.primary.height, footprintOf(this.digimon).height * this.scale),
    });
  }

  // Forget the saved camera without restoring it: the primary is about to set its own
  forgetCamera() {
    this.savedCamera = null;
  }

  remove() {
    if (this.savedCamera) {
      restoreCamera(this.artboard.camera, this.savedCamera);
      this.savedCamera = null;
    }
    this.digimon.remove();
    this.artboard.remove(this.group);
  }
}
