# DEVLOG

Newest first. One entry per chunk of work: what changed and why.

## 2026-11-08 (evening) — Poser: in-browser posing and animation on top of the glb

Aspen: "I'd like to be able to pose these and switch faces and stuff in the ui", then: "map
keyframes to have animations that can play back and loop, swapping textures recorded as
well ... select multiple parts at once to move with a gizmo ... a simple bone system ...
idle as the base pose, but editing with easing would be so helpful." Built without a
design doc at Aspen's request ("i don't want all the prep").

**What it is.** A second Vite page, `poser/` (`yarn dev:poser`, port 5174), that loads an
export zip (or a bare glb from this viewer, DW1ModelConverter or dw2_model_converter) and
gives a posing + keyframing UI. Nothing here touches the raw game data.

- Rig: the game's node tree *is* the bone hierarchy; each part rotates about its own node
  origin (the joint). The UI only lets children rotate (root may translate), so nothing
  detaches. No new rig was built.
- Base pose: first frame of the first clip (`a00_*` / `anim-0`).
- Selection by raycast, shift-click to add; selected parts get a yellow wireframe overlay
  (shape, not just colour). `TransformControls` in rotate mode drives a pivot at the last
  selected joint; the world-space delta is applied to every selected node in its own local
  space (Blender's "individual origins" feel).
- Timeline: 20 fps frame grid (game time), per-node rows with diamonds, face row, ruler.
  Keys store **quaternions** (first version stored Euler read back from the node, and
  three.js returned equivalent-but-different triples, so deltas drifted; caught by the
  scripted check: -90° where -30° was expected). Per-key easing: linear, easeIn, easeOut,
  easeInOut, step; eased curves bake to one key per frame on export so the glb stays LINEAR.
- Auto-key on by default; K / Shift+K / Delete / Shift+arrows / Space / Ctrl+Z; nudge
  buttons ±5° per axis; "reset to idle".
- Face track: click a texture-state thumbnail at the cursor; events drive `DigimonSwaps`.
- Clips: add / duplicate / remove / rename, length, loop. Undo/redo via JSON snapshots.
  Autosave to localStorage per source file; Save/Load project JSON.
- Export: `<name>_custom.zip` with a glb holding the original clips plus `c_<name>` clips,
  `swaps.json` extended with the face tracks, the PNG states, raw/ files, README and the
  project JSON. Export goes through a temporary `THREE.Scene` so the metadata lands in
  scene extras (a `Group` would have made it node extras). Empty clips are skipped.

**Verified** (scripted, Agumon): multi-select nudge keys both parts symmetrically; eased
midpoint samples to 0° and frame 2 to 25.2° (easeInOut(0.2) = 0.08) in-app and in the
baked glb track; face events drive the swap state; undo/redo restores; playback advances
and wraps; export reimports with 95 clips, custom clip metadata present, live model intact.
Also fixed on first run: a black viewport (canvas sized while `x-cloak` hid the body; now a
`ResizeObserver`), aside sections overlapping (flex shrink), clip dropdown not following
the active clip.

**Onion skinning** (Aspen: "i def need onion skinning before I cn really try it").
`src/poser/onion.ts`: ghost clones of the model posed at the neighbouring *keyed* frames,
1–3 each side, opacity falling off with distance. Earlier keys are red wireframes, later
keys blue translucent shells (shape as well as colour). Only the parts whose world
transform differs from the current frame are drawn; a full-body ghost painted over the
live model and buried the silhouette. Hidden while playing, never pickable. Verified scripted: correct frames and poses per side, falloff, toggle, hide on
play. Multi-select fix the same evening: when a parent and a descendant were both selected
the descendant received the delta twice (world matrices read after the parent moved); world
orientations are now snapshotted before any node is written.

**Not covered yet / open.** Dragging the gizmo itself was exercised only by calling the
same delta code the drag uses, not by a pointer drag. Keys can be moved only with
Shift+arrows, not dragged. Easing has no curve editor. Root translation keys bake as a
position track inside the custom clip (not split out as `__root`).

## 2026-11-08 (later) — Compare view: stopped animations, stuck after close

Aspen: "the compare function is broken; the animations stop, and then the ui kinda glitches
after I try to close it, and now I can't compare at all without refreshing."

Two root causes, found by scripting the click flow and reading mixer state:

1. `toggleCompare` tried to restart the viewer's animation (switch to another index and
   back) so both sides would start together. The switch-away fades the axis actions to
   weight 0, three.js then disables them, and the switch-back only calls `play()` (no
   `reset()`), so they stayed disabled. Removed the restart; the two sides are simply
   offset by however far the viewer was in, and re-picking the animation lines them up.
2. The `CompareView` was stored on the Alpine store, so Alpine wrapped it and its three.js
   objects in a deep reactive Proxy. Rendering through the proxied `Object3D` threw
   (`'get' on proxy: property 'modelViewMatrix' is read-only and non-configurable`), which
   left `compareOn` true and the view attached, so every later click failed the same way.
   The view now lives in a module variable; the store keeps only plain flags. `remove()`
   runs in a `finally` so state resets even if teardown throws.

Also: flat clips for animations the game loops forever now `LoopRepeat` on the compare
side (clip metadata `infiniteLoop`), instead of playing once and clamping.

**Third bug, found while checking the above**: the glb face had dark eyes in walking
shots. Every primitive under a node reported the full vertex count (60 for a 60-vertex
part). `GLTFExporter` only applies material-group ranges through an index buffer; the
viewer's geometry is non-indexed with one group per TMD primitive, so each group became a
primitive covering the whole part, drawn once per group with that group's palette. Fix in
`scene-builder.ts` (`indexByMaterial`): build an index that gathers triangles per material
and collapse groups to one per material. Agumon now round-trips with identical
triangle-vertex totals (2070), one primitive per material, 35 objects instead of 435.

Lesson for this codebase: never put three.js objects on the Alpine store. `Digimon` already
lives there and only survives because the viewer touches a single `rotation` through it.

## 2026-11-08 — Rigged glTF export, texture-swap runtime, compare view

Spec: [superpowers/specs/2026-11-08-rigged-export-design.md](superpowers/specs/2026-11-08-rigged-export-design.md).

**Why.** Aspen wants to pose and animate the models in their own three.js projects and in
Blender (webpet with a hand-made wave, for example), with the texture-swap animations
(blinks, mouth flaps) usable rather than lost.

**What landed** (not yet verified against a real BIN in this session; see "Open"):

- `src/export/clip-baker.ts`: pure conversion of an MMD animation to absolute per-node keys.
  Mirrors the viewer's segment/loop logic (pose + additive deltas, loop bodies wrap, finished
  segments hold). Unit tested with synthetic data (`clip-baker.test.ts`, vitest).
- `src/export/scene-builder.ts`: fresh node tree for export, FrontSide materials, reversed
  winding, root exported as a half-turn about X instead of scale(1,-1,-1), `node_NN` names
  with an optional `nodes.json` override.
- `src/export/clips.ts`: AnimationClips with quaternion tracks (Euler steps over 90° are
  subdivided first). Per animation: flat clip, plus `__intro/__loop/__outro` when there is
  a loop, plus `__root` when the data moves node 0.
- `src/export/swaps.ts` + `png.ts`: replays opcode-3 rect copies per textured material,
  dedupes states by pixel hash, writes `<name>.swaps.json` and one PNG per state.
- `src/export/raw.ts`: byte-exact MMD/TMD/TIM/node/struct slices and a parsed
  `animations.json`.
- `src/export/exporter.ts` + `zip.ts`: per-Digimon folder as a zip (fflate), "export all".
- `src/runtime/digimon-swaps.ts`: standalone helper (three as peer). Reads this exporter's
  `swaps.json`, and also DW1ModelConverter / dw2_model_converter glTF (swap ops in animation
  `extras`, states rebuilt from the glb's texture). `yarn build:runtime` emits it to
  `dist/runtime/`.
- `src/models/compare.ts` + UI in `index.html`: loads the just-exported glb next to the
  original with pause / step 1/60. Export toolbar is desktop-only (`md:` breakpoint).
- `examples/webpet/`: drag-and-drop smoke test, no game assets committed.
- Parser: opcode 4 (sound) is now recorded instead of skipped (`sequences.ts`).

**Decisions.** Time unit switched to 1/20 s per DW1ModelConverter (the viewer uses 0.06 s;
Aspen: "close enough"). Loop clips stay viewer-faithful (snap, flagged via
`extras.animations[clip].loopPops`). Vertex colours not exported (viewer never extracts
them). See the spec's "Resolved questions" and "Prior art" sections.

**Verified against the USA BIN (same day, scripted browser, results read as data):**

- Agumon: 94 clips, 3 palette materials × 4 swap states, 22 files, 6.8 MB, 1.3 s. Round
  trip through GLTFLoader gives 94 clips, node names intact, metadata on the scene.
- Compare view: upright, textured, same facing and pose. First run was lit darker: three's
  `BackSide` renders with `FLIP_SIDED` (normals negated in the shader), which cancelled the
  TMD converter's own negation; `FrontSide` export has no such flip. Fixed by negating the
  normal attribute in `reverseWinding`. Now matches.
- All 178 Digimon: 0 failures, 10,179 clips, 289 MB of glb in 4.7 min. One warning
  (119 ShogunGekomon has untextured primitives). Digitamamon has 79 swap states; material
  counts run 1–15 per Digimon (one per CLUT row), so the per-material swap schema earned
  its keep.

**Dev convenience.** With the BIN in the repo root (gitignored, both cases now) the dev
server auto-loads it; `?nobin` restores the file picker. `window.__dw1` exposes
`exportDigimon` and the Alpine store in dev builds.

**Open.**
- Blender import not yet checked by a human.
- "Export all" zips everything in memory (`zipSync`); at ~290 MB of glb plus PNGs that may
  exceed what a tab will allocate. If it does, switch to streaming `fflate.Zip` or per-Digimon
  downloads.
- Compare view: the two sides start a few frames apart (the viewer's pose step runs through
  a timeout), so frame-stepping shows a small phase offset. Not a data problem.
- The viewer's own `undefined.texture` PropertyBinding error predates this work.

**Parked.** In-browser poser/animator (project two). Importing new models into DW1 as a mod
(project three). Both in the spec.
