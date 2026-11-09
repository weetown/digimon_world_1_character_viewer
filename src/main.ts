import "./style.css";

import Alpine from "alpinejs";

import { Artboard } from "./models/artboard";
import { Digimon } from "./models/digimon";
import { CompareView } from "./models/compare";
import { MMD_POINTERS } from "./data/mmds";
import { ANIMATIONS } from "./contents/animations";
import { Info } from "./models/info";
import { exportDigimon, DigimonPackage, NodesSidecar } from "./export/exporter";
import { zipPackages, downloadBytes } from "./export/zip";
import { IsoImage } from "./dw2/iso";
import { Dw2Disc, DW2_MODEL_DIR } from "./dw2/disc";
import { isPack, packFiles, PackedFiles } from "./dw2/pack";
import { Dw2Digimon } from "./dw2/viewer";
import { exportDw2Digimon } from "./dw2/export";
import { SideBySide, footprintOf } from "./models/side-by-side";
import { retargetClip } from "./models/retarget";
import { buildNodeMap } from "./models/node-map";
import { saveDisc, loadDisc, listDiscs, forgetDiscs, putHandoff } from "./storage/disc-store";
import {
  GAME_BYTE_LENGTH,
  PSX_SECTOR_FOOTER_SIZE,
  PSX_SECTOR_HEADER_SIZE,
  PSX_SECTOR_SIZE,
} from "./constants";

interface SetupData {
  status: "idle" | "loading" | "error" | "success";
  initListener(): void;
  selectFile(): void;
}

type Game = "dw1" | "dw2";

interface InitialData {
  game: Game;
  INFOS: Array<{ index: number; name: string } | null>;
  ANIMATIONS: string[];

  initialized: boolean;

  digimon: Digimon | Dw2Digimon | null;
  index: number;
  animationIndex: number;

  // Export + compare state
  exportStatus: "idle" | "working" | "done" | "error";
  exportMessage: string;
  exportProgress: { done: number; total: number } | null;
  exportLog: string[];
  nodeNames: Record<string, string> | null;
  compareOn: boolean;
  paused: boolean;

  // Side-by-side state: a Digimon from the other game beside the current one
  sideGame: Game;
  sideStatus: "off" | "loading" | "on" | "error";
  sideMessage: string;
  sideInfos: Array<{ index: number; name: string }>;
  sideIndex: number;
  sideAnimations: string[];
  sideAnimationIndex: number;
  sideMatchHeight: boolean;
  // Cross-game animation: "own" plays each game's animation; "companion" makes the companion
  // play the main Digimon's current animation retargeted; "primary" the other way round
  sideAnimSource: "own" | "companion" | "primary";
  sideRetargetRelative: boolean;

  init(): void;
  syncAnimationNames(): void;
  setIndex(index: number): void;
  setAnimationIndex(index: number): void;

  exportCurrent(): Promise<void>;
  exportAll(): Promise<void>;
  loadNodeNames(file: File): Promise<void>;
  toggleCompare(): Promise<void>;
  togglePause(): void;
  step(): void;

  toggleSide(): Promise<void>;
  loadSideBin(file: File): Promise<void>;
  openSide(): void;
  closeSide(): void;
  setSideIndex(index: number): void;
  setSideAnimationIndex(index: number): void;
  setSideMatchHeight(on: boolean): void;
  setSideAnimSource(mode: "own" | "companion" | "primary"): void;
  setSideRetargetRelative(on: boolean): void;
  applyAnimSource(): void;
  forgetSaved(): Promise<void>;

  // Which discs are in memory (for the Discs panel)
  discs: { dw1: boolean; dw2: boolean };
  syncDiscs(): void;
  // Exports the current Digimon and opens it in the poser page
  openInPoser(): Promise<void>;
}

// The compare view holds three.js objects and must stay out of the Alpine store: Alpine
// wraps store values in deep reactive Proxies, and rendering through a proxied Object3D
// throws (non-configurable properties such as modelViewMatrix break the proxy invariants).
let compare: CompareView | null = null;

// The side-by-side companion holds three.js objects too; same rule
let side: SideBySide | null = null;

// The main Digimon as constructed, before Alpine wrapped it: mixers and clips built for
// retargeting must see the real three.js objects, not the store's Proxy of them
let primaryRaw: Digimon | Dw2Digimon | null = null;

// Which disc the page was opened with. DW1 data lives in window.value (sector-cleaned); DW2
// is read through an ISO reader over the raw image. Both can be loaded at once for the
// side-by-side view.
let game: Game = "dw1";
let dw1Loaded = false;
let dw2Disc: Dw2Disc | null = null;

function otherGame(of: Game): Game {
  return of === "dw2" ? "dw1" : "dw2";
}

function isLoaded(which: Game) {
  return which === "dw2" ? dw2Disc != null : dw1Loaded;
}

// Cached per game: the DW1 list decodes every Digimon's texture to read its name, which is
// too slow to repeat on each switch
const infosCache: Partial<Record<Game, Array<{ index: number; name: string }>>> = {};

function infosFor(which: Game): Array<{ index: number; name: string }> {
  const cached = infosCache[which];
  if (cached) return cached;
  const infos =
    which === "dw2"
      ? dw2Disc!.entries.map(({ index, name }) => ({ index, name }))
      : MMD_POINTERS.map((mmd, index) => (mmd ? new Info({ index }) : null))
          .filter((info): info is Info => info != null)
          .map((info) => ({ index: info.index, name: info.name }));
  infosCache[which] = infos;
  return infos;
}

// DW2 files are named by a four-letter code (AGUM, GREY...) that is the start of the DW1
// name in most cases; use that to pick the counterpart when one exists.
function fourLetterCode(name: string) {
  return name.replace(/[^A-Za-z]/g, "").slice(0, 4).toUpperCase();
}

function counterpartIndex(primaryGame: Game, primaryIndex: number): number | null {
  const target = otherGame(primaryGame);
  if (primaryGame === "dw1") {
    const info = infosFor("dw1").find((i) => i.index === primaryIndex);
    if (!info) return null;
    const code = fourLetterCode(info.name);
    return dw2Disc!.entries.find((e) => e.code === code)?.index ?? null;
  }
  const entry = dw2Disc!.entries.find((e) => e.index === primaryIndex);
  if (!entry) return null;
  return infosFor(target).find((i) => fourLetterCode(i.name) === entry.code)?.index ?? null;
}

function init() {
  const viewport = document.getElementById("viewport") ?? document.body;
  const artboard = new Artboard(viewport);
  const { digimon, animation } = getUrlParams();

  const INFOS: InitialData["INFOS"] = infosFor(game);

  const startIndex =
    game === "dw2" && !INFOS.some((info) => info?.index === digimon) ? 0 : digimon;

  const initialData: InitialData = {
    game,
    INFOS,
    ANIMATIONS: ANIMATIONS,

    initialized: false,

    digimon: null,
    index: startIndex,
    animationIndex: animation,

    exportStatus: "idle",
    exportMessage: "",
    exportProgress: null,
    exportLog: [],
    nodeNames: null,
    compareOn: false,
    paused: false,

    sideGame: otherGame(game),
    sideStatus: "off",
    sideMessage: "",
    sideInfos: [],
    sideIndex: 0,
    sideAnimations: [],
    sideAnimationIndex: 0,
    sideMatchHeight: true,
    sideAnimSource: "own",
    sideRetargetRelative: true,

    discs: { dw1: false, dw2: false },

    init() {
      primaryRaw = newDigimon(artboard, game, this.index, this.animationIndex);
      this.digimon = primaryRaw;
      this.syncAnimationNames();
      this.syncDiscs();
    },

    syncDiscs() {
      this.discs = { dw1: isLoaded("dw1"), dw2: isLoaded("dw2") };
    },

    async openInPoser() {
      if (!this.digimon || this.exportStatus === "working") return;
      this.exportStatus = "working";
      this.exportMessage = "Exporting for the poser...";
      try {
        const pkg = await exportByGame(this.index, this.nodeNames ?? {});
        const zip = zipPackages([pkg]);
        await putHandoff("poser", `${pkg.folder}.zip`, zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength));
        this.exportLog = pkg.warnings;
        this.exportStatus = "done";
        this.exportMessage = `Opened ${pkg.folder} in the poser`;
        window.open("/poser/?from=viewer", "digimon-poser");
      } catch (error) {
        console.error(error);
        this.exportStatus = "error";
        this.exportMessage = `Could not open the poser: ${(error as Error).message}`;
      }
    },

    // DW1 animation names are a fixed table; DW2's depend on the model's files
    syncAnimationNames() {
      this.ANIMATIONS =
        this.digimon instanceof Dw2Digimon ? this.digimon.animations : ANIMATIONS;
    },

    setIndex(index: number) {
      this.index = index;
      this.animationIndex = 0;

      this.digimon?.remove();
      compare?.remove();
      compare = null;
      this.compareOn = false;
      artboard.paused = false;
      this.paused = false;
      this.nodeNames = null;

      artboard.reset();
      // The new primary frames its own camera; the companion then re-frames the pair
      side?.forgetCamera();
      primaryRaw = newDigimon(artboard, game, this.index, this.animationIndex);
      this.digimon = primaryRaw;
      this.syncAnimationNames();

      if (side) {
        // Follow to the counterpart when the other game has one with the same code
        const match = counterpartIndex(game, this.index);
        if (match != null && match !== this.sideIndex) {
          this.setSideIndex(match);
        } else {
          side.setPrimary(footprintOf(this.digimon));
          this.applyAnimSource();
        }
      }

      setUrlParams();
    },

    setAnimationIndex(index: number) {
      this.animationIndex = index;

      if (this.digimon) {
        this.digimon.setAnimationIndex(this.animationIndex);
      }

      compare?.playAnimationIndex(index);

      // Picking the main Digimon's own animation ends it being driven by the companion
      if (this.sideAnimSource === "primary") this.sideAnimSource = "own";
      this.applyAnimSource();

      setUrlParams();
    },

    async exportCurrent() {
      if (this.exportStatus === "working") return;

      this.exportStatus = "working";
      this.exportMessage = "Exporting...";
      this.exportLog = [];

      try {
        const pkg = await exportByGame(this.index, this.nodeNames ?? {});
        downloadBytes(zipPackages([pkg]), `${pkg.folder}.zip`);

        this.exportLog = pkg.warnings;
        this.exportStatus = "done";
        this.exportMessage = `Exported ${pkg.folder}`;
      } catch (error) {
        console.error(error);
        this.exportStatus = "error";
        this.exportMessage = `Export failed: ${(error as Error).message}`;
      }
    },

    async exportAll() {
      if (this.exportStatus === "working") return;

      const indexes = this.INFOS.map((info) => info?.index ?? -1).filter((index) => index >= 0);

      this.exportStatus = "working";
      this.exportProgress = { done: 0, total: indexes.length };
      this.exportLog = [];

      const packages: DigimonPackage[] = [];
      const failures: string[] = [];

      for (const index of indexes) {
        this.exportMessage = `Exporting ${index}...`;
        try {
          const pkg = await exportByGame(index, {});
          packages.push(pkg);
          pkg.warnings.forEach((w) => this.exportLog.push(`${pkg.folder}: ${w}`));
        } catch (error) {
          console.error(`Export of ${index} failed`, error);
          failures.push(`${index}: ${(error as Error).message}`);
        }
        this.exportProgress = { done: this.exportProgress!.done + 1, total: indexes.length };
        // Give the UI a chance to paint between Digimon
        await new Promise((resolve) => setTimeout(resolve, 0));
      }

      try {
        downloadBytes(
          zipPackages(packages),
          game === "dw2" ? "digimon_world_2_export.zip" : "digimon_world_1_export.zip",
        );
        this.exportStatus = failures.length ? "error" : "done";
        this.exportMessage = failures.length
          ? `Exported ${packages.length}, ${failures.length} failed`
          : `Exported ${packages.length} Digimon`;
        this.exportLog = [...failures.map((f) => `FAILED ${f}`), ...this.exportLog];
      } catch (error) {
        console.error(error);
        this.exportStatus = "error";
        this.exportMessage = `Zip failed: ${(error as Error).message}`;
      }

      this.exportProgress = null;
    },

    async loadNodeNames(file: File) {
      try {
        const sidecar = JSON.parse(await file.text()) as NodesSidecar;
        if (sidecar.version !== 1 || typeof sidecar.names !== "object") {
          throw Error("not a nodes.json (version 1)");
        }
        if (sidecar.digimonIndex !== this.index) {
          this.exportLog = [
            `nodes.json is for Digimon ${sidecar.digimonIndex}, current is ${this.index}; using it anyway`,
          ];
        }
        this.nodeNames = sidecar.names;
        this.exportMessage = `Loaded ${Object.keys(sidecar.names).length} node names`;
      } catch (error) {
        this.exportStatus = "error";
        this.exportMessage = `nodes.json: ${(error as Error).message}`;
      }
    },

    async toggleCompare() {
      if (compare) {
        try {
          compare.remove();
        } finally {
          compare = null;
          this.compareOn = false;
          artboard.paused = false;
          this.paused = false;
          // CompareView.remove() put the camera back where the Digimon set it
          this.exportMessage = "";
        }
        return;
      }

      if (!this.digimon || this.exportStatus === "working") return;

      // The two pair views share the spot to the right of the Digimon
      if (side) this.closeSide();

      this.exportStatus = "working";
      this.exportMessage = "Exporting for compare...";

      try {
        const pkg = await exportByGame(this.index, this.nodeNames ?? {});
        const { radius, height } = this.digimon.info.digimonStruct;

        compare = await CompareView.fromPackage(artboard, pkg, {
          offsetX: Math.max(radius * 3, 400),
          height,
        });
        // The glb side starts now; the viewer side keeps running, so the two are offset
        // by however far the viewer is into its animation. Pick the animation again from
        // the list to line them up.
        compare.playAnimationIndex(this.animationIndex);

        this.compareOn = true;
        this.exportLog = pkg.warnings;
        this.exportStatus = "done";
        this.exportMessage = `Compare: ${pkg.clipNames.length} clips in glb`;
      } catch (error) {
        console.error(error);
        compare?.remove();
        compare = null;
        this.compareOn = false;
        this.exportStatus = "error";
        this.exportMessage = `Compare failed: ${(error as Error).message}`;
      }
    },

    togglePause() {
      artboard.paused = !artboard.paused;
      this.paused = artboard.paused;
    },

    step() {
      if (!artboard.paused) {
        artboard.paused = true;
        this.paused = true;
      }
      artboard.step();
    },

    // Side by side: opens straight away when the other disc is already loaded; otherwise
    // fetches the dev copy, or asks for the file.
    async toggleSide() {
      if (side) {
        this.closeSide();
        return;
      }
      if (isLoaded(this.sideGame)) {
        this.openSide();
        return;
      }

      this.sideStatus = "loading";
      this.sideMessage = `Loading the ${this.sideGame.toUpperCase()} BIN...`;

      // A disc saved from an earlier visit, then (in dev) the copy in the repo root
      try {
        if (await restoreSavedDisc(this.sideGame)) {
          this.openSide();
          return;
        }
      } catch (error) {
        console.warn("Saved BIN load failed", error);
      }

      if (import.meta.env.DEV && !window.location.search.includes("nobin")) {
        try {
          if (await loadDevBin(this.sideGame)) {
            this.openSide();
            return;
          }
        } catch (error) {
          console.warn("Dev BIN load failed", error);
        }
      }

      this.sideStatus = "off";
      this.sideMessage = "";
      (document.getElementById("sideFileInput") as HTMLInputElement | null)?.click();
    },

    async loadSideBin(file: File) {
      this.sideStatus = "loading";
      this.sideMessage = `Reading ${file.name}...`;
      try {
        const loaded = loadBin(await file.arrayBuffer());
        if (loaded?.game !== this.sideGame) {
          throw Error(
            loaded
              ? `that is the ${loaded.game.toUpperCase()} disc; pick the ${this.sideGame.toUpperCase()} (USA) BIN`
              : `not a Digimon World 1 or 2 (USA) BIN`,
          );
        }
        rememberDisc(loaded.game, loaded.store, file.name);
        this.openSide();
      } catch (error) {
        console.error(error);
        this.sideStatus = "error";
        this.sideMessage = `Side by side: ${(error as Error).message}`;
      }
    },

    openSide() {
      if (!this.digimon) return;
      if (compare) {
        compare.remove();
        compare = null;
        this.compareOn = false;
      }
      side?.remove();

      this.syncDiscs();
      this.sideInfos = infosFor(this.sideGame);
      const match = counterpartIndex(game, this.index);
      this.sideIndex = match ?? this.sideInfos[0]?.index ?? 0;
      this.sideAnimationIndex = 0;

      const digimon = newDigimon(artboard, this.sideGame, this.sideIndex, 0, { companion: true });
      side = new SideBySide(artboard, this.sideGame, digimon, {
        primary: footprintOf(this.digimon),
        matchHeight: this.sideMatchHeight,
      });
      this.sideAnimations = digimon instanceof Dw2Digimon ? digimon.animations : ANIMATIONS;
      this.sideStatus = "on";
      this.sideMessage = match == null ? `No ${this.sideGame.toUpperCase()} match by name; pick one` : "";
      this.applyAnimSource();
    },

    closeSide() {
      if (primaryRaw?.foreignClipPlaying) primaryRaw.stopForeignClip();
      side?.remove();
      side = null;
      this.sideStatus = "off";
      this.sideMessage = "";
      artboard.paused = false;
      this.paused = false;
    },

    setSideIndex(index: number) {
      if (!side || !this.digimon) return;
      this.sideIndex = index;
      this.sideAnimationIndex = 0;

      const { matchHeight } = side;
      side.remove();
      const digimon = newDigimon(artboard, this.sideGame, index, 0, { companion: true });
      side = new SideBySide(artboard, this.sideGame, digimon, {
        primary: footprintOf(this.digimon),
        matchHeight,
      });
      this.sideAnimations = digimon instanceof Dw2Digimon ? digimon.animations : ANIMATIONS;
      this.sideMessage = "";
      this.applyAnimSource();
    },

    setSideAnimationIndex(index: number) {
      this.sideAnimationIndex = index;
      side?.digimon.setAnimationIndex(index);
      // Picking the companion's own animation ends it being driven by the main Digimon
      if (this.sideAnimSource === "companion") this.sideAnimSource = "own";
      this.applyAnimSource();
    },

    setSideMatchHeight(on: boolean) {
      this.sideMatchHeight = on;
      side?.setMatchHeight(on);
    },

    setSideAnimSource(mode) {
      this.sideAnimSource = mode;
      this.applyAnimSource();
    },

    setSideRetargetRelative(on: boolean) {
      this.sideRetargetRelative = on;
      this.applyAnimSource();
    },

    // Puts the chosen cross-game animation in place (or takes it away) for the current pair
    applyAnimSource() {
      if (!side || !primaryRaw) return;
      const primary = primaryRaw;
      const companion = side.digimon;
      const mode = this.sideAnimSource;

      if (mode === "own") {
        if (primary.foreignClipPlaying) primary.stopForeignClip();
        if (companion.foreignClipPlaying) companion.stopForeignClip();
        if (this.sideMessage.includes(" plays ")) this.sideMessage = "";
        return;
      }

      const [source, target, sourceIndex] =
        mode === "companion"
          ? [primary, companion, this.animationIndex]
          : [companion, primary, this.sideAnimationIndex];
      const sourceGame = mode === "companion" ? game : this.sideGame;
      const targetGame = mode === "companion" ? this.sideGame : game;

      const clip =
        source instanceof Dw2Digimon ? source.clips[sourceIndex] : source.bakedClip(sourceIndex);
      if (!clip) {
        this.sideMessage = `${sourceGame.toUpperCase()} has no animation ${sourceIndex} to retarget`;
        return;
      }

      if (source.foreignClipPlaying) source.stopForeignClip();

      try {
        // Pair the two rigs' parts by tree shape (DW1 pivots fold into DW2 objects)
        const dw1Rig = sourceGame === "dw1" ? source : target;
        const dw2Rig = sourceGame === "dw1" ? target : source;
        const map = buildNodeMap(dw1Rig.rigShape, dw2Rig.rigShape);

        const result = retargetClip({
          clip,
          sourceNames: source.nodeNames,
          sourceRest: source.restTransforms,
          sourceParents: source.rigShape.parents,
          targetNames: target.nodeNames,
          targetRest: target.restTransforms,
          targetParents: target.rigShape.parents,
          map,
          direction: sourceGame === "dw1" ? "dw1->dw2" : "dw2->dw1",
          correctFrames: this.sideRetargetRelative,
        });
        target.playForeignClip(result.clip);
        // Both start the cycle together, so Pause / Step compare the same frame (the DW1
        // viewer plays its intro once then loops, the retargeted flat clip repeats whole,
        // so they drift apart after the first cycle)
        source.restartAnimation();

        const quality =
          map.quality === "exact"
            ? "parts match one for one"
            : map.quality === "shape"
              ? "parts paired by shape"
              : `parts paired by shape, ${map.unmatchedDw1.length + map.unmatchedDw2.length} left over`;
        const inexact = map.pairs.filter((p) => !p.exact).length;
        this.sideMessage =
          `${targetGame.toUpperCase()} plays ${sourceGame.toUpperCase()}'s ${clip.name}: ` +
          `${result.mapped} of ${target.nodeNames.length - 1} parts driven, ${quality}` +
          `${inexact ? `, ${inexact} remeshed` : ""} (${this.sideRetargetRelative ? "frames corrected" : "rotations copied as they are"})`;
      } catch (error) {
        console.error(error);
        this.sideMessage = `Retarget failed: ${(error as Error).message}`;
      }
    },

    async forgetSaved() {
      try {
        await forgetDiscs();
        this.sideMessage = "Saved BINs forgotten; the file picker shows next time";
      } catch (error) {
        this.sideMessage = `Could not clear saved BINs: ${(error as Error).message}`;
      }
    },
  };

  Alpine.store("data", initialData);

  initPointerListeners(artboard);
}

// Last selection per game, so coming back to the page (the Viewer tab, a plain reload)
// lands on the same Digimon when the URL does not say otherwise
const LAST_KEY = "viewer.last";

function readLast(): Partial<Record<Game, { digimon: number; animation: number }>> {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function getUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const last = readLast()[game];

  const digimonIndex = urlParams.get("digimon");
  const digimon =
    !digimonIndex || Number.isNaN(digimonIndex) ? last?.digimon ?? 3 : parseInt(digimonIndex);

  const animationIndex = urlParams.get("animation");
  const animation =
    !animationIndex || Number.isNaN(animationIndex)
      ? last?.animation ?? 0
      : parseInt(animationIndex);

  return { digimon, animation };
}

function setUrlParams() {
  const data = Alpine.store("data") as InitialData;

  const gameParam = game === "dw2" ? "&game=dw2" : "";
  const queryParams = `?digimon=${data.index}&animation=${data.animationIndex}${gameParam}`;
  window.history.pushState({ path: queryParams }, "", queryParams);

  try {
    localStorage.setItem(
      LAST_KEY,
      JSON.stringify({ ...readLast(), [game]: { digimon: data.index, animation: data.animationIndex } }),
    );
  } catch {
    // storage blocked: the URL still carries it
  }
}

function newDigimon(
  artboard: Artboard,
  which: Game,
  index: number,
  animationIndex: number,
  { companion = false }: { companion?: boolean } = {},
) {
  if (which === "dw2") {
    return new Dw2Digimon({ artboard, disc: dw2Disc!, index, animationIndex, companion });
  }
  return new Digimon({ artboard, index, animationIndex, companion });
}

function exportByGame(index: number, nodeNames: Record<string, string>) {
  if (game === "dw2") return exportDw2Digimon({ disc: dw2Disc!, index, nodeNames });
  return exportDigimon({ index, nodeNames });
}

function initPointerListeners(artboard: Artboard) {
  const data = Alpine.store("data") as InitialData;

  let [x, y] = [-1, -1];

  window.addEventListener("pointerdown", (event) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.tagName === "CANVAS"
    ) {
      x = event.offsetX;
      y = event.offsetY;
    }
  });

  window.addEventListener("pointermove", (event) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.tagName === "CANVAS"
    ) {
      if (data.digimon?.rootNode) {
        if (x > 0 || y > 0) {
          const parsedX = (event.offsetY - y) / 100;
          const parsedY = (event.offsetX - x) / 100;

          data.digimon.rootNode.rotation.x += parsedX;
          data.digimon.rootNode.rotation.y += parsedY;

          if (compare) {
            compare.root.rotation.x += parsedX;
            compare.root.rotation.y += parsedY;
          }
          side?.rotate(parsedX, parsedY);

          artboard.floorObject.rotation.x += parsedX;
          artboard.floorObject.rotation.z += parsedY; // Using Z to rotate the plane correctly

          x = event.offsetX;
          y = event.offsetY;

          artboard.render();
        }
      }
    }
  });

  window.addEventListener("pointerup", (event) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.tagName === "CANVAS"
    ) {
      x = -1;
      y = -1;
    }
  });
}

// Dev convenience: with the BIN sitting in the repo root (gitignored), the dev server serves
// it and we load it on start. Never active in a production build. Add `?nobin` to the URL
// to get the file picker instead.
const DEV_BIN_PATHS: Record<Game, string> = {
  dw1: "/Digimon World (USA).bin",
  dw2: "/Digimon World 2 (USA).bin",
};

function devGame(): Game {
  return new URLSearchParams(window.location.search).get("game") === "dw2" ? "dw2" : "dw1";
}

// Persist a disc in its compact form so the next visit opens without the picker (best
// effort): DW1 already sector-cleaned, DW2 as a pack of its MODEL folder.
function rememberDisc(which: Game, bytes: ArrayBuffer, name: string) {
  saveDisc(which, bytes, name).catch((error) => console.warn("Could not save the BIN", error));
}

// Installs the given game from a disc saved on an earlier visit, if there is one
async function restoreSavedDisc(which: Game): Promise<boolean> {
  const bytes = await loadDisc(which);
  return bytes != null && loadBin(bytes)?.game === which;
}

async function restoreAnySavedDisc(): Promise<Game | null> {
  const saved = await listDiscs();
  for (const disc of saved) {
    if (await restoreSavedDisc(disc.game)) return disc.game;
  }
  return null;
}

// Dev only: the copy in the repo root, served by Vite
async function loadDevBin(which: Game): Promise<boolean> {
  if (!import.meta.env.DEV) return false;
  const path = DEV_BIN_PATHS[which];
  const response = await fetch(path);
  const loaded = response.ok ? loadBin(await response.arrayBuffer()) : null;
  if (loaded?.game !== which) {
    console.warn(`Dev BIN not found or not the ${which} image at ${path}`);
    return false;
  }
  return true;
}

const CLEAN_SECTOR_SIZE = PSX_SECTOR_SIZE - PSX_SECTOR_HEADER_SIZE - PSX_SECTOR_FOOTER_SIZE;
const CLEAN_GAME_BYTE_LENGTH = (GAME_BYTE_LENGTH / PSX_SECTOR_SIZE) * CLEAN_SECTOR_SIZE;

interface LoadedBin {
  game: Game;
  // The compact form worth keeping between visits
  store: ArrayBuffer;
}

// Recognises a disc (or a saved compact form) and installs it; the other game's disc, if
// loaded, stays. DW1 (USA) by exact byte length, raw or already sector-cleaned, into
// window.value. DW2: a saved pack, or any raw image whose ISO tree holds the MODEL folder,
// which is then packed so the 462 MB image can be dropped. Null for anything else.
function loadBin(value: ArrayBuffer): LoadedBin | null {
  if (isPack(value)) {
    dw2Disc = new Dw2Disc(new PackedFiles(value));
    return { game: "dw2", store: value };
  }

  if (value.byteLength === CLEAN_GAME_BYTE_LENGTH) {
    window.value = value;
    dw1Loaded = true;
    return { game: "dw1", store: value };
  }

  if (value.byteLength !== GAME_BYTE_LENGTH) {
    try {
      const iso = new IsoImage(value);
      if (!Dw2Disc.isDw2(iso)) return null;
      const pack = packFiles(iso, DW2_MODEL_DIR);
      dw2Disc = new Dw2Disc(new PackedFiles(pack));
      return { game: "dw2", store: pack };
    } catch (error) {
      console.warn("not a DW1 (USA) image and not readable as a DW2 disc", error);
      return null;
    }
  }

  // Strip every sector's header and footer (PSX housekeeping) so pointers in the data match
  // plain file offsets; views into the source, no per-sector copies
  const numberOfSectors = value.byteLength / PSX_SECTOR_SIZE;
  const cleaned = new Uint8Array(numberOfSectors * CLEAN_SECTOR_SIZE);
  for (let index = 0; index < numberOfSectors; index++) {
    const sector = new Uint8Array(
      value,
      index * PSX_SECTOR_SIZE + PSX_SECTOR_HEADER_SIZE,
      CLEAN_SECTOR_SIZE,
    );
    cleaned.set(sector, index * CLEAN_SECTOR_SIZE);
  }

  window.value = cleaned.buffer;
  dw1Loaded = true;

  return { game: "dw1", store: cleaned.buffer };
}

const setupData: SetupData = {
  status: "idle",

  // Set the listener up so the user can selects the file
  initListener() {
    const fileInput = document.getElementById(
      "fileInput",
    ) as HTMLInputElement | null;

    if (fileInput) {
      fileInput.addEventListener("change", async () => {
        this.status = "loading";

        const currentFile = fileInput.files?.[0];

        currentFile?.arrayBuffer().then((value) => {
          const loaded = loadBin(value);
          if (!loaded) {
            this.status = "error";
            return;
          }
          game = loaded.game;
          rememberDisc(loaded.game, loaded.store, currentFile.name);

          init();

          this.status = "success";
        });
      });
    }

    // Skip the picker when a BIN is already at hand. For the game the URL asks for (DW1
    // unless `?game=dw2`): one saved from an earlier visit, then (dev only) the copy in the
    // repo root; failing that, whichever game is saved. `?nobin` forces the picker.
    if (!window.location.search.includes("nobin")) {
      this.status = "loading";
      const wanted = devGame();

      const autoLoad = async (): Promise<Game | null> => {
        const attempts: Array<() => Promise<boolean>> = [
          () => restoreSavedDisc(wanted),
          () => loadDevBin(wanted),
        ];
        for (const attempt of attempts) {
          try {
            if (await attempt()) return wanted;
          } catch (error) {
            console.warn("Automatic BIN load failed", error);
          }
        }
        try {
          return await restoreAnySavedDisc();
        } catch (error) {
          console.warn("Saved BIN load failed", error);
          return null;
        }
      };

      autoLoad().then((loaded) => {
        if (loaded) {
          game = loaded;
          init();
          this.status = "success";
        } else {
          this.status = "idle";
        }
      });
    }
  },

  // The method that runs when user clicks the btn to select the file
  selectFile() {
    if (this.status === "idle" || this.status === "error") {
      const fileInput = document.getElementById("fileInput");
      if (fileInput) fileInput.click();
    }
  },
};

Alpine.store("setup", setupData);
Alpine.start();

// Dev hook so the export can be driven from the console / scripted checks
if (import.meta.env.DEV) {
  (window as unknown as { __dw1: unknown }).__dw1 = {
    exportDigimon,
    exportDw2Digimon,
    zipPackages,
    data: () => Alpine.store("data") as InitialData,
    compare: () => compare,
    side: () => side,
    game: () => game,
    dw2: () => dw2Disc,
  };
}
