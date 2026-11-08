# Rigged model export for three.js (glTF + texture-swap runtime)

**Status: SHIPPED (code complete 2026-11-08, awaiting first run against a real BIN).**
Written 2026-11-08 from a brainstorm with Aspen; built the same day. See
[docs/DEVLOG.md](../../DEVLOG.md) for what landed and what is still open. Where this body
says "would" or "should", the code in `src/export`, `src/runtime` and `src/models/compare.ts`
is the current truth.

## Intent

Aspen wants to take the Digimon World 1 character models out of this viewer and play with them
in their own three.js projects and in Blender: pose them, play the game's animations, and
build new animations (their example: a little webpet with a custom waving animation). The
export also serves as an archive of the game's character data, so raw bytes go out alongside
the converted assets.

In Aspen's words: "I just want to be able to play with these models and have them properly
rigged up for me to move around and pose." And on texture swaps: "something I definitely want
to build a helper for because right now I can't do much with them." Authoring must be visual
("I'm a visual artist"); Blender or an in-browser tool are both acceptable to them.

## Decisions made in the brainstorm

- **Blender-first.** An in-browser poser/animator is a separate, later project (see
  "Parked"). This project makes the export good enough that Blender is the authoring tool.
- **Format: glTF binary (.glb)** per Digimon, loadable with stock three.js `GLTFLoader`.
  Chosen by Claude because it is read by three.js, Blender, and archival tooling alike.
- **Texture swaps get a runtime helper**, not just a data dump.
- **Raw byte dumps** ship alongside, so the archive does not depend on this tool's
  interpretation of the formats.
- **A compare view** in this app, original next to re-imported glb, so fidelity is visible
  before trusting the export in Blender.

## What exists today (read from the code, 2026-11-08)

- The bin is loaded in the browser and cleaned of sector headers; everything reads from
  `window.value` ([src/main.ts](../../../src/main.ts)).
- A Digimon is a **node tree of rigid parts, not a skinned mesh**. `newNodeStructs` yields
  `{objectIndex, nodeIndex}` pairs; each node is a `THREE.Mesh` (if `objectIndex > -1`) or an
  empty `THREE.Group`, parented to `skeleton[nodeIndex]`
  ([digimon.ts:120](../../../src/models/digimon.ts#L120)). Node 0 is the root and carries
  `scale.y = -1, scale.z = -1` to fix handedness. Materials are `side: BackSide` to
  compensate for that flip ([material-tracker.ts](../../../src/roblouie_tmd/src/threejs-converters/material-tracker.ts)).
- Meshes come from `TMDToThreeJS.convertWithTMDAndTIM`: non-indexed `BufferGeometry` with
  position/normal/uv and material groups; textures are `DataTexture` from TIM `ImageData`.
  Some primitive types throw "Not implemented".
- Animations (`Mmd.animations[]`, nullable) each have a `pose` (one posture per non-root
  node: rotation/position, optional scale, int16) and `sequences` (opcodes: 0 axis keyframes,
  1 loop start with repetitions, 2 loop end, 3 texture rect copy, 4 sound, skipped).
  Axis keyframes are **deltas added onto the pose**, per node, per axis, with a `duration`.
  Units: rotation `value * PI / 2048`, scale `value / 4096`, position raw. Time: the viewer
  runs clips at `timeScale = 1000/60`, so one duration unit is `60/1000` s.
- Loops: `repetitions === 255` means infinite. Viewer splits each animation into segments
  (pre-loop, loop, post-loop) and chains them through mixer `finished` events.
- Texture sequences (opcode 3) copy a `width x height` rect from `src` to `dest` inside the
  texture; the viewer builds a new `ImageData` + material per change and swaps all mesh
  materials at the right time ([digimon.ts:568](../../../src/models/digimon.ts#L568)).
- Per-Digimon hand fixes live in [src/data/fixes.ts](../../../src/data/fixes.ts):
  keyframe value overrides, clamp-pose, return-to-idle lists.
- Friendly animation names: [src/contents/animations.ts](../../../src/contents/animations.ts)
  (developer-authored, shared index across Digimon, "special characters" differ).
- Digimon name comes from `DigimonStruct` (20 ASCII bytes). Nodes have no names in the data.

## Goals

1. Export any Digimon from the loaded bin as a `.glb` that, loaded with `GLTFLoader`, gives
   a node hierarchy identical in structure to the viewer's, with the part meshes attached,
   textures embedded, and one `AnimationClip` per game animation playable with a plain
   `AnimationMixer`.
2. Posing = setting `node.rotation/position/scale` on named nodes. New animations = new
   clips against those node names, authored in Blender or code.
3. Texture-swap animations are preserved as data and made usable at runtime via a small
   helper module, including an API for authoring new swap sequences.
4. Raw archive dumps per Digimon.
5. A compare view in this app proving fidelity.
6. Batch export of every Digimon in the bin as one zip.

## Non-goals

- An in-browser poser/animator (parked, project two).
- Skinning / weighted bones. The game has rigid parts; faking a skin would be invention.
- Sound opcodes (opcode 4). Record them in the sidecar as "present at time t", nothing more.
- Reproducing the viewer's cross-fade between animations. That is a viewer nicety, not data.
- Fixing the "Not implemented" primitive types unless one shows up in a character model
  during export. If one does, fail loudly for that Digimon and log it.

## Anti-goals (would make this a failure even if it technically works)

- A glb that is upside down, mirrored, or inside-out in Blender. The export must bake the
  root flip into geometry and fix winding so materials can be `FrontSide`.
- Animations that only play right with this repo's custom chaining code. Every clip must be
  self-contained for a stock mixer.
- Node names that change between exports of the same Digimon. Stable names are what new
  animations are authored against.
- Dropping the texture-swap data because glTF has no slot for it.

## Constraints

- Runs in the browser; the bin never leaves the user's machine. Export = download.
- Must not break the existing viewer. Export code lives beside it, reusing the parsers
  (`newMmd`, `newNodeStructs`, `newTim`, `TMDToThreeJS`) rather than re-reading bytes.
- Stay on the repo's stack: TypeScript, Vite, three r151 (`GLTFExporter` from
  `three/examples/jsm`). One new dependency allowed for zipping (builder picks; `fflate` is
  the usual choice and is already a three.js transitive dep).
- Licence is AGPL-3.0; the helper module ships under the same licence inside this repo.

## Output layout (per Digimon, inside the zip, folder `NNN_Name/`)

```
NNN_Name/
  NNN_Name.glb              meshes, node tree, texture(s), game animation clips
  NNN_Name.swaps.json       texture-swap timing + the rect ops, per animation
  swaps/mat_NN/             PNG of each material's texture after each distinct swap state
    state_00.png            (state_00 = untouched texture)
    state_01.png ...
  nodes.json                node naming sidecar (see below)
  raw/
    mmd.bin                 the MMD slice exactly as in the bin
    tmd.bin                 TMD slice (offset from MMD header)
    tim.bin                 the 0x4800-byte TIM slice
    nodes.bin               the node struct bytes for this Digimon
    digimon_struct.bin      the DigimonStruct record
    animations.json         parsed animations (pose + sequences, raw int values) for
                            anyone who wants the data without the glb interpretation
  README.txt                what each file is, units, coordinate notes, licence pointer
```

`NNN` is the zero-padded Digimon index as used by `MMD_POINTERS`; `Name` is from
`DigimonStruct`, sanitised to `[A-Za-z0-9_]`.

## The glb

**Nodes.** One glTF node per `nodeStruct`, same parent/child relations. Names from
`nodes.json` if present, else `node_00`, `node_01`, ... (two digits, zero-padded, index =
position in `nodeStructs`). Node 0 is the root; it carries no mesh in any Digimon seen so
far (builder: assert this and handle the mesh case if it is false).

**Coordinates.** The viewer's root has `scale(1,-1,-1)`. That matrix has determinant +1, so
it is a 180° rotation about X, not a mirror; baking it into vertices alone would leave child
node positions and rotation axes in the wrong frame. Export the root node with quaternion
`(1,0,0,0)` (π about X), identity scale and position, and reverse triangle winding so
materials can be `FrontSide`. (Claude's call: exact and simple; a rotated root does not get
in the way of posing parts. Pre-multiplying the rotation into the root's direct children is
the alternative if a clean identity root turns out to matter in Blender.) Keep units as the
game's (Agumon is a few hundred units tall); do not rescale. Document the unit in README.txt.
Y is up after the rotation; verify in Blender import.

**Root motion.** The viewer discards keyframes whose `nodeIndex` is 0. The data may carry
root translation for walking/running. Claude's call: the main clips exclude root keys (so a
webpet does not walk off-screen); when root keys exist for an animation, emit an extra clip
`a{ii}_{name}__root` holding only the root's tracks, and set `extras.hasRootMotion`. Root
keys are always preserved in `raw/animations.json`.

**Meshes.** From the viewer's `BufferGeometry`, with material groups preserved as glTF
primitives. Materials export as `MeshStandardMaterial` with `baseColorTexture`, `alphaMode:
MASK`, `alphaCutoff: 0.3`, `doubleSided: false`, `metallicFactor: 0`, `roughnessFactor: 1`.
Translucent primitives (`isTranslucent`) use `alphaMode: BLEND` with `baseColorFactor` alpha
0.5. Unlit primitives (viewer uses `MeshBasicMaterial`) use `KHR_materials_unlit`.
Non-textured primitives: the viewer never extracts vertex colours (it sets
`vertexColors: true` with no colour attribute), so there is no `COLOR_0` to export. Claude's
call: export what the viewer shows, and have "export all" log any Digimon whose TMD contains a
non-textured primitive type so we know whether colour extraction is worth adding later.

**Textures.** The TIM `ImageData` written as PNG, nearest-neighbour sampler (`magFilter:
NEAREST, minFilter: NEAREST`) so pixel art stays crisp. The untouched texture is the one
embedded in the glb (= `swaps/state_00.png`).

**Animation clips.** One clip per non-null `Mmd.animations[i]`, named
`a{ii}_{friendlyName}` where `ii` is the zero-padded animation index and `friendlyName` is
from `ANIMATIONS[i]` sanitised (fallback `anim`). Each clip holds absolute (not additive)
tracks, per node, for `.position`, `.quaternion`, `.scale`:

- Base value is the pose. Axis deltas accumulate from there exactly as
  `newAxisAnimations` does today, including `ANIMATION_SEQUENCE_FIXES`.
- Rotation: the viewer animates Euler components separately (default XYZ order). Convert
  each keyframe's Euler to a quaternion for export; keep a `.rotation[x|y|z]`-free clip,
  since glTF only carries quaternions. Verify visually in the compare view that the
  conversion matches.
- Time in seconds: `durationUnits * TIME_UNIT_SECONDS`, a single constant shared by the
  viewer, the clip baker, and `swaps.json`, and recorded in root `extras.timeUnitSeconds`.
  Current viewer value is `60/1000` (from `ANIMATION_TIME_SCALE = 1000/60`). Whether that
  matches the real game is an open question for Aspen (below); the constant is isolated so
  it can change in one place.
- Loops are **unrolled** into the flat clip: a loop body with `repetitions = n` is repeated
  `n` times; `255` (infinite) is repeated **once** and the clip is tagged in `extras` so
  consumers know to loop it. Additionally, when an animation contains a loop, emit two more
  clips: `a{ii}_{name}__intro` (everything before the loop start) and
  `a{ii}_{name}__loop` (one loop body). Post-loop content, if any, becomes `__outro`. These
  let a webpet loop the body with `LoopRepeat`. The viewer wraps (snaps back to loop-start
  values each repetition) rather than accumulating, so the `__loop` clip is viewer-faithful:
  no closing key is invented. If a loop body has a nonzero net delta, set
  `extras.loopPops = true` so the author knows to smooth it in Blender. (Claude's call.)
- Pose-only animations (no axis sequences) export as a single-keyframe clip.
- `ANIMATION_CLAMP_POSE` / `ANIMATION_CLAMP_IDLE` are viewer playback behaviour; record them
  in `extras` per clip (`{clampPose: bool, returnToIdle: bool}`), do not act on them.

**extras.** On the scene root: `{game: "Digimon World (PSX, USA)", digimonIndex, name,
height, radius, type, level, exporter: {tool, version, commit}}`. On each clip: `{animationIndex,
hasLoop, infiniteLoop, clampPose, returnToIdle, hasTextureSwaps, hasSound}`.

## Texture swaps: data + runtime helper

### `NNN_Name.swaps.json`

`MaterialTracker` makes one textured material per (texture page, CLUT row), so a Digimon can
have more than one base texture over the same pixel indices. The schema is per material from
the start (Claude's call, to avoid a v2):

```jsonc
{
  "version": 1,
  "materials": [
    { "name": "mat_00", "width": 256, "height": 256,
      "states": ["swaps/mat_00/state_00.png", "swaps/mat_00/state_01.png"] },
    ...
  ],
  "animations": {
    "a05_happy": {
      "events": [
        { "time": 0.0, "state": 0 },
        { "time": 0.48, "state": 1, "op": {"srcX":..,"srcY":..,"destX":..,"destY":..,"width":..,"height":..} },
        ...
      ],
      "loop": { "start": 0.48, "end": 1.2, "repetitions": 255 } // or null
    }
  }
}
```

A `state` index applies to every material in `materials[]` (the same rect op is applied to
each map, as the viewer does). glTF material names in the glb match `materials[].name`, which
is how the helper finds them. States are deduplicated by pixel content. `op` is the raw rect
copy that produced the state,
kept so an archivist can reproduce it. Times follow the same conversion as the clips, so
`events[].time` lines up with the clip's time axis. The `__intro`/`__loop`/`__outro` clips
get their own entries with re-based times.

### Runtime helper: `src/runtime/digimon-swaps.ts`

Exported from this repo as a standalone ES module (built with a second Vite lib entry to
`dist/runtime/`), peer dep on three. Single class, roughly:

```ts
const swaps = await DigimonSwaps.load(gltfScene, "NNN_Name.swaps.json");
swaps.bind(mixer);                 // listens to the mixer's clock; applies states as clips play
swaps.setState(2);                 // manual: show state 2 now
swaps.sequence("wave", [           // author a new swap track for a custom clip
  { time: 0,   state: 0 },
  { time: 0.3, state: 1 },
  { time: 0.6, state: 0 },
]);
swaps.unbind();
```

Behaviour: it owns one `CanvasTexture`/`DataTexture` per state (preloaded from the PNGs),
finds every material in the scene that uses the base texture, and swaps `material.map` on
the right frame. For `bind`, it reads the mixer's running actions each `update(delta)` call
(the consumer calls `swaps.update()` after `mixer.update()`), matches clip names to entries
in the JSON, and applies the latest event at or before the action's current time, honouring
the loop block. No dependency on this app.

## Raw dumps

Byte-exact slices as listed in the layout. `animations.json` is the parsed `Mmd.animations`
with the raw int16 values and opcodes, plus the `nodeStructs`, `digimonStruct` fields, and
the `FIXES` that were applied (so the archive records the interpretation separately from the
data).

## nodes.json (naming sidecar)

```json
{ "version": 1, "digimonIndex": 3, "names": { "0": "root", "7": "right_upper_arm" } }
```

Shipped in the zip with every node listed and all names set to the default `node_NN`, ready
to edit. On export, the app accepts an optional `nodes.json` upload (per Digimon) and uses
those names in the glb. Names must be unique and match `[A-Za-z0-9_]+`; invalid entries fall
back to the default with a warning in the UI. Node names are **never** derived from anything
that could vary between exports.

## UI in this app

- Export button on the current Digimon's panel: downloads `NNN_Name.zip`.
- "Export all" button: iterates `MMD_POINTERS`, skipping nulls, builds one zip of folders,
  shows progress and a per-Digimon pass/fail list at the end (fails do not abort the batch).
- Optional `nodes.json` upload input next to the export button.
- **Compare view**: a toggle that loads the just-exported glb back through `GLTFLoader` into
  the same scene, offset to the side of the original, driven by its own mixer playing the
  clip with the same index as the viewer's current animation, with the swaps helper bound.
  Frame-stepping (pause, step forward one frame) so both can be eyeballed at the same time.
  Does not need to be pretty; it is a verification tool.

## Acceptance

- Agumon (index 3) exports; glb opens in Blender 4.x upright, facing the same way as in the
  viewer, textured, parts in the right places, with every animation listed and playable.
- In the compare view, idle, walking, and one looping animation with a texture swap (builder:
  find one on Agumon by scanning for opcode 3) look the same on both sides at matched times.
- A consumer page of under 30 lines of logic (GLTFLoader + AnimationMixer + DigimonSwaps)
  plays a looping animation with its swaps. Check it in under `examples/webpet/` as the
  smoke test. **No game assets are committed**: the example takes the exported zip (or
  glb + swaps folder) by drag-and-drop / file picker, same policy as the viewer. It imports
  the helper by relative path from `src/runtime/`; no npm publish is part of this project.
- "Export all" completes on the USA bin with a report; any failures are listed by name.
- Raw dumps round-trip: re-parsing `raw/mmd.bin` with `newMmd` yields the same animations.

## Left to the builder

- Zip library choice, PNG encoding path (canvas `toBlob` vs a pure-JS encoder).
- Exact deduplication strategy for swap states (hash of pixel data is fine).
- Euler-to-quaternion keyframe density: whether to sample additional keys to avoid
  interpolation drift on large per-axis rotations. Start without; add if the compare view
  shows drift.
- How to restructure `Digimon` so clip-building is reusable without a renderer (a pure
  function from `Mmd + nodeStructs + fixes` to clip data is the obvious shape; the viewer can
  keep its current chaining on top).
- Whether `GLTFExporter` in r151 handles `DataTexture` → PNG directly or needs a canvas
  round-trip first.

## Prior art found mid-build (2026-11-08)

- **DW1ModelConverter** (SydMontague, MIT, C++20, github.com/Operation-Decoded/DW1ModelConverter):
  extracted ISO → `.gltf` per model with node tree, one PNG, all animations as clips. Texture
  swaps, sounds and endless-loop bounds go to glTF `extras` as raw data; nothing applies
  them. Nodes `node-N`, animations `anim-N`. Uses **1/20 s per time unit**; this project
  adopted that value (see time.ts) over the viewer's 0.06 s.
- **dw2_model_converter** (jype, MIT, gitlab.com/jype/dw2_model_converter): Digimon World 2
  equivalent, exporter copied from the above, so the same `extras` shape.
- Decision (Aspen, "finish yours please"): keep the browser exporter; make the runtime swaps
  helper also read DW1ModelConverter-style `extras` so one helper covers this viewer's glb,
  DW1ModelConverter output and DW2 output.

## Parked

**Project two: in-browser poser/animator.** Per-node gizmos, timeline, keyframe editing,
saving clips back into the glb, swap-track editing. Builds on everything above.

**Project three: importing models into DW1 as a mod** (Aspen, 2026-11-08: "what if I wanted
to try and convert these models to be compatible with dw1's engine as a mod? Like putting
terriermon in the game with handposed animations?"). Needs the mirror of this repo's
parsers: TMD/TIM/MMD encoders plus skeleton-table and DigimonStruct writers, and a disc
rebuild (mkpsxiso). Interchange format would be this exporter's glb with the DW1 node
structure; the baker runs in reverse (absolute keys → pose + deltas). Constraints are the
game's: fixed MMD byte slots and pointers, int16 vertices, one 256-wide texture page with a
4/8-bit palette, and code assumptions about node roles (item hand, mouth, hitbox from
radius/height). Brainstorm separately once the exporter is proven.

## Resolved questions

1. **Playback speed.** Asked 2026-11-08 whether the viewer's `1000/60` time scale matches
   the real game. Aspen: "the viewer's speed is close enough, from my memory. It reads
   fine." Keep `TIME_UNIT_SECONDS = 60/1000`. The constant stays isolated and recorded in
   `extras.timeUnitSeconds` in case it is ever revisited.
