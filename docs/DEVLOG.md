# DEVLOG

Newest first. One entry per chunk of work: what changed and why.

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
