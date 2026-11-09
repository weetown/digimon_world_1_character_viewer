# Digimon World 1 - Character Viewer

### Important

Please, before you use this code or the running web application, make sure you read the instructions and acknowledge the terms regarding the copyright holders and the usage of the game's \*.BIN file (USA).

### Export (glTF + texture swaps)

With a BIN loaded, the toolbar at the bottom (desktop widths) offers:

- **Export this Digimon** / **Export all**: a zip per Digimon with a `.glb` (node tree, texture,
  every animation as a clip, loop bodies as separate `__loop` clips), a `.swaps.json` plus PNG
  states for the texture-swap animations, a `nodes.json` naming sidecar, and byte-exact raw
  dumps. Details in the `README.txt` inside each zip.
- **Compare with glb**: re-imports the export next to the original, with pause and
  frame-step, to check fidelity.
- **Load nodes.json**: give nodes real names before exporting.

`src/runtime/digimon-swaps.ts` applies the texture swaps on top of a normal three.js
`AnimationMixer`; it also reads glTF from
[DW1ModelConverter](https://github.com/Operation-Decoded/DW1ModelConverter) and
[dw2_model_converter](https://gitlab.com/jype/dw2_model_converter). `yarn build:runtime`
emits it standalone. `yarn dev:example` runs a drag-and-drop webpet smoke test
(`examples/webpet/`, no game assets included).

### Digimon World 2

The same page reads a Digimon World 2 (USA) BIN: pick it with the same button, or in dev put
`Digimon World 2 (USA).bin` in the repo root and open `/?game=dw2`. Its 395 models list by
file stem (`003 AGUM`), animate from their A..K files, and export the same zip layout, with
the model's spare eye images as texture states for the poser. Format notes in
`src/dw2/*.ts` and the DEVLOG.

**Side by side.** "Side by side: DW2" (or DW1, when a DW2 disc is open) stands a Digimon from
the other game next to the current one. The first time it asks for that game's BIN; it then
picks the counterpart by the four-letter code (Agumon ↔ AGUM) and follows when the main
Digimon changes, when a match exists. The toolbar gets its own Digimon and animation pickers,
Pause / Step, and a "Match height" toggle (on: scaled to the main Digimon's height; off: the
games' native units, DW2's being several times larger).

**Cross-game animation (experimental).** With side by side open, the "Animation source"
picker makes one Digimon play the other game's current animation, retargeted part by part
(rotations only, positions stay the target's own). DW1 rigs have empty pivot nodes that DW2
folds into its parts, so parts are paired by tree shape with the pivots composed in
(`src/models/node-map.ts`; the analysis behind it is in `scripts/`). "Correct part frames"
converts each rotation between the two games' local axes using the parts' rest orientations,
so the driven part follows the source part's world motion; off, the rotations copy as they
are (and the model folds up). Both start the cycle together, so Pause / Step compare the
same frame. The status line says how the parts were paired. Picking a driven Digimon's own
animation ends it.

**Saved BINs.** Any BIN picked with the file button is kept in the browser's IndexedDB and
loads on the next visit without the picker, both the main disc and the side-by-side one. It
is kept compact: DW1 already sector-cleaned, DW2 as just its MODEL folder (about 49 MB), so
the DW2 side opens in well under a second. "Forget saved BINs" in the toolbar clears them;
`?nobin` skips the automatic load.

### Poser (pose, keyframe, face swaps)

The **Poser** tab in the top bar (`/poser/`, same server as the viewer; `yarn dev` serves
both). "Pose this Digimon" on the viewer page exports the current Digimon and opens it there
in a new tab; a zip or glb can also be dropped in. Click parts to
select (shift-click adds), rotate them with the gizmo about their joints, set keys on a
20 fps timeline with per-key easing, drop face states on the face row, loop, and export a
`_custom.zip` whose glb carries your clips alongside the game's. Keyboard: Space play,
←/→ frame, Shift+←/→ move keys, K key selected, Shift+K key all, Delete remove, Ctrl+Z/Y.

Design notes: [docs/superpowers/specs/2026-11-08-rigged-export-design.md](docs/superpowers/specs/2026-11-08-rigged-export-design.md).
Running log: [docs/DEVLOG.md](docs/DEVLOG.md).

### TODO

- Apply a smooth transition between animations on all digimons (currently only supported by Agumon)
- Make sure the textures with opacity are fully working with all digimons
- Continue the cleanup of TMD/TIM reader
- Improve error handling to display better messages to the user
- Improve names of animations for special characters
