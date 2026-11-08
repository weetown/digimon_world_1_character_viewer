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

### Poser (pose, keyframe, face swaps)

`yarn dev:poser` opens a second page (port 5174). Drop an export zip in: click parts to
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
