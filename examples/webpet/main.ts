// Webpet smoke test: load an exported Digimon, pick a clip, watch it loop with its texture
// swaps. Under 30 lines of actual logic once you strip the file-handling and UI glue.

import * as THREE from "three";
import { GLTFLoader, GLTF } from "three/examples/jsm/loaders/GLTFLoader";
import { unzipSync } from "fflate";

import { DigimonSwaps, SwapsFile } from "../../src/runtime/digimon-swaps";

const status = document.getElementById("status")!;
const drop = document.getElementById("drop")!;
const panel = document.getElementById("panel")!;
const clipSelect = document.getElementById("clips") as HTMLSelectElement;
const loopButton = document.getElementById("loop") as HTMLButtonElement;
const motionButton = document.getElementById("motion") as HTMLButtonElement;
const fileInput = document.getElementById("file") as HTMLInputElement;

// --- scene ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, window.innerWidth / window.innerHeight, 1, 10000);
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 0.8);
sun.position.set(1, 2, 3);
scene.add(sun);

window.addEventListener("resize", () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

let mixer: THREE.AnimationMixer | null = null;
let swaps: DigimonSwaps | null = null;
let action: THREE.AnimationAction | null = null;
let clips: THREE.AnimationClip[] = [];
let looping = true;
let reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  // Reduced motion: hold the pose instead of animating
  mixer?.update(reduceMotion ? 0 : delta);
  swaps?.update();
  renderer.render(scene, camera);
});

// --- loading --------------------------------------------------------------------------
async function loadFile(file: File) {
  status.textContent = `Loading ${file.name}...`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const loader = new GLTFLoader();

  let gltf: GLTF;
  let loadedSwaps: DigimonSwaps | null = null;

  if (file.name.toLowerCase().endsWith(".zip")) {
    const entries = unzipSync(bytes);
    const glbPath = Object.keys(entries).find((p) => p.endsWith(".glb"));
    const swapsPath = Object.keys(entries).find((p) => p.endsWith(".swaps.json"));
    if (!glbPath) throw Error("zip has no .glb");

    gltf = await loader.parseAsync(entries[glbPath].buffer.slice(
      entries[glbPath].byteOffset,
      entries[glbPath].byteOffset + entries[glbPath].byteLength,
    ), "");

    if (swapsPath) {
      const swapsFile = JSON.parse(new TextDecoder().decode(entries[swapsPath])) as SwapsFile;
      const folder = swapsPath.slice(0, swapsPath.lastIndexOf("/") + 1);
      const textures = new Map<string, THREE.Texture[]>();

      for (const material of swapsFile.materials) {
        const states = await Promise.all(
          material.states.map(async (path) => {
            const png = entries[folder + path];
            const blob = new Blob([png], { type: "image/png" });
            const bitmap = await createImageBitmap(blob);
            const texture = new THREE.Texture(bitmap);
            texture.needsUpdate = true;
            return texture;
          }),
        );
        textures.set(material.name, states);
      }

      loadedSwaps = DigimonSwaps.fromTextures(gltf.scene, swapsFile, textures);
    }
  } else {
    gltf = await loader.parseAsync(bytes.buffer, "");
    // DW1ModelConverter / DW2 converter glTF: swaps live in animation extras
    loadedSwaps = await DigimonSwaps.fromGltf(gltf);
  }

  show(gltf, loadedSwaps);
  status.textContent = `${file.name}: ${gltf.animations.length} clips`;
}

function show(gltf: GLTF, loadedSwaps: DigimonSwaps | null) {
  // Clear previous
  scene.children.filter((c) => c.userData.webpet).forEach((c) => scene.remove(c));
  swaps?.dispose();
  mixer?.stopAllAction();

  gltf.scene.userData.webpet = true;
  scene.add(gltf.scene);

  // Frame it
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const distance = Math.max(size.x, size.y, size.z) * 2.2;
  camera.position.set(center.x, center.y + size.y * 0.3, center.z + distance);
  camera.lookAt(center);

  mixer = new THREE.AnimationMixer(gltf.scene);
  swaps = loadedSwaps;
  swaps?.bind(mixer);
  clips = gltf.animations;

  clipSelect.replaceChildren();
  clips.forEach((clip, i) => {
    const option = document.createElement("option");
    option.value = String(i);
    option.textContent = clip.name;
    clipSelect.appendChild(option);
  });

  // Prefer a __loop clip (clean looping body) for the webpet feel
  const preferred = clips.findIndex((c) => c.name.endsWith("__loop"));
  clipSelect.value = String(preferred >= 0 ? preferred : 0);
  play(Number(clipSelect.value));

  drop.classList.add("hidden");
  panel.hidden = false;
}

function play(index: number) {
  if (!mixer) return;
  action?.fadeOut(0.2);
  action = mixer.clipAction(clips[index]);
  action.loop = looping ? THREE.LoopRepeat : THREE.LoopOnce;
  action.clampWhenFinished = true;
  action.reset().fadeIn(0.2).play();
}

// --- UI glue --------------------------------------------------------------------------
clipSelect.addEventListener("change", () => play(Number(clipSelect.value)));

loopButton.addEventListener("click", () => {
  looping = !looping;
  loopButton.textContent = `Loop: ${looping ? "on" : "off"}`;
  play(Number(clipSelect.value));
});

motionButton.textContent = `Reduce motion: ${reduceMotion ? "on" : "off"}`;
motionButton.addEventListener("click", () => {
  reduceMotion = !reduceMotion;
  motionButton.textContent = `Reduce motion: ${reduceMotion ? "on" : "off"}`;
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file).catch(fail);
});

window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files[0];
  if (file) loadFile(file).catch(fail);
});

function fail(error: Error) {
  console.error(error);
  status.textContent = `Failed: ${error.message}`;
}
