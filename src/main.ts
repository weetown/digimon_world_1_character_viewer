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

interface InitialData {
  INFOS: Array<Info | null>;
  ANIMATIONS: typeof ANIMATIONS;

  initialized: boolean;

  digimon: Digimon | null;
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

  init(): void;
  setIndex(index: number): void;
  setAnimationIndex(index: number): void;

  exportCurrent(): Promise<void>;
  exportAll(): Promise<void>;
  loadNodeNames(file: File): Promise<void>;
  toggleCompare(): Promise<void>;
  togglePause(): void;
  step(): void;
}

// The compare view holds three.js objects and must stay out of the Alpine store: Alpine
// wraps store values in deep reactive Proxies, and rendering through a proxied Object3D
// throws (non-configurable properties such as modelViewMatrix break the proxy invariants).
let compare: CompareView | null = null;

function init() {
  const artboard = new Artboard();
  const { digimon, animation } = getUrlParams();

  const INFOS = MMD_POINTERS.map((mmd, index) =>
    mmd ? new Info({ index }) : null,
  ).filter((info) => info != null);

  const initialData: InitialData = {
    INFOS,
    ANIMATIONS: ANIMATIONS,

    initialized: false,

    digimon: null,
    index: digimon,
    animationIndex: animation,

    exportStatus: "idle",
    exportMessage: "",
    exportProgress: null,
    exportLog: [],
    nodeNames: null,
    compareOn: false,
    paused: false,

    init() {
      this.digimon = newDigimon(artboard, this.index, this.animationIndex);
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
      this.digimon = newDigimon(artboard, this.index, this.animationIndex);

      setUrlParams();
    },

    setAnimationIndex(index: number) {
      this.animationIndex = index;

      if (this.digimon) {
        this.digimon.setAnimationIndex(this.animationIndex);
      }

      compare?.playAnimationIndex(index);

      setUrlParams();
    },

    async exportCurrent() {
      if (this.exportStatus === "working") return;

      this.exportStatus = "working";
      this.exportMessage = "Exporting...";
      this.exportLog = [];

      try {
        const pkg = await exportDigimon({
          index: this.index,
          nodeNames: this.nodeNames ?? {},
        });
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

      const indexes = MMD_POINTERS.map((mmd, index) => (mmd ? index : -1)).filter(
        (index) => index >= 0,
      );

      this.exportStatus = "working";
      this.exportProgress = { done: 0, total: indexes.length };
      this.exportLog = [];

      const packages: DigimonPackage[] = [];
      const failures: string[] = [];

      for (const index of indexes) {
        this.exportMessage = `Exporting ${index}...`;
        try {
          const pkg = await exportDigimon({ index });
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
        downloadBytes(zipPackages(packages), "digimon_world_1_export.zip");
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
          // Put the camera back where the Digimon set it
          if (this.digimon) {
            artboard.camera.position.x = 0;
            artboard.camera.lookAt(0, this.digimon.info.digimonStruct.height / 2, 0);
          }
          this.exportMessage = "";
        }
        return;
      }

      if (!this.digimon || this.exportStatus === "working") return;

      this.exportStatus = "working";
      this.exportMessage = "Exporting for compare...";

      try {
        const pkg = await exportDigimon({
          index: this.index,
          nodeNames: this.nodeNames ?? {},
        });
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
  };

  Alpine.store("data", initialData);

  initPointerListeners(artboard);
}

function getUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);

  const digimonIndex = urlParams.get("digimon");
  const digimon =
    !digimonIndex || Number.isNaN(digimonIndex) ? 3 : parseInt(digimonIndex);

  const animationIndex = urlParams.get("animation");
  const animation =
    !animationIndex || Number.isNaN(animationIndex)
      ? 0
      : parseInt(animationIndex);

  return { digimon, animation };
}

function setUrlParams() {
  const data = Alpine.store("data") as InitialData;

  const queryParams = `?digimon=${data.index}&animation=${data.animationIndex}`;
  window.history.pushState({ path: queryParams }, "", queryParams);
}

function newDigimon(artboard: Artboard, index: number, animationIndex: number) {
  return new Digimon({
    artboard: artboard,
    index: index,
    animationIndex: animationIndex,
  });
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
const DEV_BIN_PATH = "/Digimon World (USA).bin";

// Strips sector headers/footers and installs the clean image as window.value. Returns false
// when the file is not the USA BIN.
function loadBin(value: ArrayBuffer): boolean {
  // Recognize the correct bin file by the exact byte length
  if (value.byteLength !== GAME_BYTE_LENGTH) {
    return false;
  }

  const numberOfSectors = value.byteLength / PSX_SECTOR_SIZE;
  const cleanSectorByteLength =
    PSX_SECTOR_SIZE - PSX_SECTOR_HEADER_SIZE - PSX_SECTOR_FOOTER_SIZE;

  // Cleanup the whole BIN, by removing all sector headers and footers (used by psx for debugging purposes)
  const uInt8Array = new Uint8Array(numberOfSectors * cleanSectorByteLength);

  for (let index = 0; index <= value.byteLength / PSX_SECTOR_SIZE; index++) {
    const sectorStart = index * PSX_SECTOR_SIZE + PSX_SECTOR_HEADER_SIZE;
    const sectorEnd = (index + 1) * PSX_SECTOR_SIZE - PSX_SECTOR_FOOTER_SIZE;

    const sector = new Uint8Array(value.slice(sectorStart, sectorEnd));

    uInt8Array.set(sector, index * cleanSectorByteLength);
  }

  // Store the cleaned BIN so we consume later to extract the models and so on
  window.value = uInt8Array.buffer;

  return true;
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
          if (!loadBin(value)) {
            this.status = "error";
            return;
          }

          init();

          this.status = "success";
        });
      });
    }

    if (import.meta.env.DEV && !window.location.search.includes("nobin")) {
      this.status = "loading";

      fetch(DEV_BIN_PATH)
        .then((response) => (response.ok ? response.arrayBuffer() : null))
        .then((value) => {
          if (value && loadBin(value)) {
            init();
            this.status = "success";
          } else {
            console.warn(`Dev BIN not found or not the USA image at ${DEV_BIN_PATH}`);
            this.status = "idle";
          }
        })
        .catch((error) => {
          console.warn("Dev BIN load failed", error);
          this.status = "idle";
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
    data: () => Alpine.store("data") as InitialData,
    compare: () => compare,
  };
}
