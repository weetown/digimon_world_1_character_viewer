# DEVLOG

Newest first. One entry per chunk of work: what changed and why.

## 2026-11-09 — Cross-game retarget: DW1 pivots are what differ, not the names

Aspen, looking at Garurumon with DW2 playing DW1's idle: "it seems like the nodes aren't
quite named the same things... the movement for the tail is being assigned to the nodes
that have the feet for the most part. can we compare the names and make a list of the
discrepancies?"

The names are `node_XX` by tree order on both sides, so the question was whether the orders
match. `scripts/node-correspondence.ts` builds both rest skeletons, normalises them by
height and matches joints spatially; the table made the rule obvious: DW1 skeletons have
empty pivot nodes (no mesh: Greymon's 1, 5, 9, 14, 18, 22, the hips, shoulders and the
root-of-body) that DW2 does not have. Drop them and the DW1 mesh nodes are the DW2 objects,
one for one, with identical vertex counts in sequence (Agumon 14, 51, 21, 24, 14, 35...). The
index-for-index mapping was therefore off by the number of pivots above each part, which is
exactly tail data landing on feet.

`scripts/node-rule-check.ts` tests that rule over the 97 DW1 Digimon whose first four
letters are a DW2 code: 60 exact (counts and parents), 11 counts-only, 26 mismatches. The
mismatches are mostly the same subtrees listed in a different order (Betamon, Mamemon,
Monzaemon: lower body before upper in DW2), a few remeshed parts (Flarerizamon's third part
40 vs 41 vertices), and one false pair from the four-letter rule (WaruSeadramon → WARU is
WaruMonzaemon).

`src/models/node-map.ts` now pairs the two trees of mesh-bearing nodes: exact when the
sequence and parents agree, otherwise children of paired parents by subtree signature (own
vertex count plus the sorted signatures below), leftovers by order and flagged. Each pair
records the DW1 pivots above the mesh node; `retargetClip` composes those pivots' rotations
onto the DW2 object (DW1 → DW2), sampling each chain member at the union of their key times,
and drives the DW1 mesh node from the DW2 object with the pivots held at rest (DW2 → DW1).
Both rig classes expose `rigShape` (parents, vertex counts). The status line now reports
how the parts were paired and how many are remeshed.

**Frames.** With the mapping right, walking still looked pitched. The first "relative to
rest" maths applied each delta in the part's own local frame, and the two games author a
part's local axes differently even when it sits in the same place (the vertices are in that
frame, so anything goes). The correct form uses world rest orientations: with
`C_i = inv(W_src_i) * W_tgt_i`, `L_tgt(t) = inv(C_parent) * L_src(t) * C_i`, which makes the
target part follow the source part's world motion whatever the axes; DW2 → DW1 is the
inverse with the pivots' rest taken off the front. `scripts/retarget-check.ts` measures
`inv(W_dw1(t)) * W_dw2(t)` over a clip: 0.00° drift on every Garurumon part. The remaining
"pitch" in screenshots turned out to be phase: the retargeted clip starts at frame 0 when
applied while the DW1 model is mid-cycle, so the two were never the same frame.
`applyAnimSource` now restarts the source too (`restartAnimation` on both rig classes), and
Pause / Step then compare like for like: running and happy match part for part. The DW1
viewer scatters parts for a moment at its own frame 0 after a restart (its pose fade); that
is the old DW1 playback, not the retarget. The DW1 viewer plays intro-then-loop while the
flat clip repeats whole, so the two drift apart after the first cycle.

Scripts (`scripts/`, run with `npx vite-node`, both BINs in the repo root):
`node-correspondence.ts` (spatial joint matching table), `node-rule-check.ts` (the rule over
all code-matched pairs), `retarget-check.ts` and `retarget-check2.ts` (drift and rest
relations per part).

## 2026-11-09 — One app: top bar with Viewer / Poser tabs, tool panels, poser handoff

Aspen: "where is the animation tool btw? none of this is super visible, there's lots of
different screens... can you overhaul the ui to mke it all available?"

The poser was a second Vite app on its own port with no link from the viewer, so it did not
exist as far as the page showed. Now `vite.config.js` builds both `index.html` and
`poser/index.html` from one root, so `yarn dev` serves `/` and `/poser/` and the Vercel build
ships both. Both pages share a top bar (title, Viewer / Poser tabs, status line) and the
poser's flat dark panel style; the viewer's game-themed green/blue boxes and the bottom
toolbar that was hidden on narrow screens are gone.

Viewer layout: left column is the Digimon list (with a filter box and a DW1/DW2 badge) over
the animation list with Pause / Step; centre is the model, which the `Artboard` now mounts
into a `#viewport` pane and sizes with a ResizeObserver instead of the window; right column
is the tools in named panels: Side by side (with its pickers, match height and the
cross-game animation source), Export check (compare with glb), Export (this / all /
nodes.json, warnings), Poser, Discs (what is loaded, forget saved BINs). Under `md` the
columns stack. The viewport pane stays in the page from the start, because `init()` runs
before the setup store flips to success and the panels render.

"Pose this Digimon" exports the current Digimon, drops the zip in a `handoff` object store
(same IndexedDB, version 2) and opens `/poser/?from=viewer` in a new tab; the poser takes
the parcel on boot and loads it like a dropped file. `yarn dev:poser` now just opens
`/poser/` on the one server.

## 2026-11-08 (late) — DW1 and DW2 side by side; BINs kept in the browser

Aspen: "can we have it load dw1 and dw2 models side by side to compare?" and, while that was
being checked, "since this is just a tool for me to use locally, can we set it up so that it
saves the data it loads and keeps it there so I dn't have to keep reloading every time?"

**Side by side** (`src/models/side-by-side.ts`). Both model classes gained a `companion`
option: no camera, no render loop of their own, mixers advanced from the artboard's frame
hooks (the same hook set the compare view uses). The companion's root is reparented under a
group that carries the x offset, the drag rotation, and an optional scale matching the main
Digimon's height; the camera framing is the compare view's, pulled out into `framePair` and
shared. Both discs can be loaded at once now: `loadBin` returns which game it recognised and
no longer clears the other. The counterpart is picked by DW2's four-letter file code against
the first four letters of the DW1 name (AGUM, GREY...), on open and when the main Digimon
changes; a message says when there is no match. Compare-with-glb and side-by-side are
exclusive (same spot to the right). The companion object lives in a module variable; only
indexes, names and status go on the Alpine store (see the proxy notes below).

**Saved BINs** (`src/storage/disc-store.ts`). A picked BIN is stored as a Blob in IndexedDB
keyed by game, with `navigator.storage.persist()` requested. Start-up order: saved disc for
the URL's game (or whichever is saved), then the dev copy in the repo root, then the picker;
the side-by-side button checks the saved copy before asking. Dev copies are not saved
(they are already at hand). "Forget saved BINs" clears the store; `?nobin` skips the
automatic load. Everything fails soft to the picker.

**Streamlining** (Aspen: "It runs super slow because of my setup, so I need to streamline it
as best as possible"). What was slow on the load path: the DW1 Digimon list decodes a TIM per
Digimon to read its name and was rebuilt on every switch (now cached per game); the DW1
sector-clean made one `slice` copy per sector, 162k of them (now views into the source); and
the saved DW2 disc was the whole 462 MB image. Saved forms are now compact: DW1 goes in
already sector-cleaned (332 MB, installed as-is), DW2 as a pack of just the MODEL folder
(`src/dw2/pack.ts`: JSON index + bytes, 48.7 MB, opens in about 25 ms), built on first load
so the image buffer can be collected. `loadBin` recognises the pack by magic and the cleaned
DW1 by length. Start-up for the URL's game: saved, then dev copy, then any saved game.

**Cross-game animation** (Aspen: "it looks like dw2 models are very close to the dw1 models. Is
it possible for us to use the animation data on either or without it breaking? let's try").
`src/models/retarget.ts` maps node i to node i (both rigs: synthetic root at 0 with the same
half-turn, then the game's nodes in tree order; DW2's object order follows DW1's node order
on the carried-over models). Only rotations cross; positions and scales are the target's
rest. Two modes: relative (the source's change from its rest, re-applied on the target's
rest) and absolute (source rotations as they are). DW1 clips come from the exporter's baker
(absolute local transforms per node, so one flat clip), DW2 clips are the viewer's own. Both
rig classes got `nodeNames`, `restTransforms`, `playForeignClip` / `stopForeignClip`; the DW1
one runs the foreign clip on a separate mixer after stopping its own actions, and names its
skeleton nodes like the exporter so the clip binds. Picking a driven side's own animation
drops back to "own". Retargeting runs on the raw instances (`primaryRaw`), not the store's
Proxy of them: a mixer created through the Proxy would hit the renderer-proxy failure from
the DW2 work.

**Open.** Side-by-side state is not in the URL. Match height uses DW1's `digimonStruct.height`
against DW2's mesh bounds, so the two are not measured the same way; it is a viewing aid,
not a unit ratio. Retargeting is an experiment: node counts differ on some pairs (extra
nodes hold at rest), and whether the local axes line up is per model; see the screenshots in
the verification notes for what Agumon looks like.

## 2026-11-08 (night) — Digimon World 2: load the disc, view, export, pose

Aspen: "can you make it so that I can import and export dw2 models the same way? the bin
for it is in my downloads, I'd like for it to be able to be loaded..."

**Disc.** DW2 (NTSC-U) is a plain ISO 9660 image, but the root directory only lists the
executable and a dummy; the real tree is reachable through the path table. `src/dw2/iso.ts`
walks the path table over the raw 2352-byte sectors and slices files out of the buffer on
demand (no sector-cleaned copy; the 462 MB image stays as loaded). Models live in
`/AAA/4.AAA/MODEL/MODELnnn/`: `M###CODE.BIN` (mesh + TIM + skeleton + blink table) and
`A..K###CODE.BIN` (one animation file per letter). 395 models; 202 have the full A..K set,
the rest only D or E (NPC / battle-only models, by the look of it).

**Format** (`src/dw2/model.ts`, `anim.ts`), after jype's dw2_model_converter with two
corrections found against the data:

- Keyframes are a 3x3 3.12 matrix + int16 translation per object. The converter hands the
  nine values to glm column-major, i.e. transposed. Read that way, Agumon's spine ran
  sideways; read as stored (GTE row-major), the spine chain climbs (y -465 to -855, up in
  PSX terms) and the legs descend to the floor. Row-major as stored it is.
- The 24 "blink" bytes the converter keeps as opaque extras decode as: dest rect (x, w in
  VRAM halfwords = 4 texels; y, h in rows), then up to eight (x, y) source positions ended by
  0xff, then a `fe ff 00 00` tail that is still unknown (timing, probably). Checked on
  Agumon's texture: the three sources are the open, half-closed and closed eyes drawn next
  to the face. `src/dw2/blink.ts`.

Skeleton values are depths in pre-order; most models have two roots (upper and lower body),
parented under a synthetic `root` that carries the half-turn about X. Primitives come in
four groups (semi-transparent/opaque x quad/tri) with a CLUT word each; one material per
(CLUT row, half, blend mode), image rendered through that palette, same scheme as DW1. The
winding is checked against the stored normals per model and reversed when they disagree.

**Viewer.** `loadBin` now recognises either disc: DW1 by exact size, otherwise any raw image
whose ISO tree has the DW2 MODEL folder. `?game=dw2` auto-loads
`Digimon World 2 (USA).bin` from the repo root in dev. `Dw2Digimon` presents the same surface
as the DW1 `Digimon` so the page, compare view and export toolbar are unchanged. The heavy
state (three.js graph, disc data, mixer) lives in a module map keyed by a numeric id on the
instance. Three attempts to get there: plain fields overflowed Alpine's recursive store walk
on the parsed disc; a WeakMap keyed by the instance missed, because methods run with `this`
as Alpine's Proxy; a property holding the object came back wrapped in a reactive Proxy that
three's renderer rejects (`modelViewMatrix` read-only). A primitive id passes through the
proxy untouched. Camera framing is by bounds; DW2 units are several times DW1's.

**Export.** Same package shape (glb, swaps.json, PNG states, nodes.json, raw/, README) so
the poser loads a DW2 zip unchanged and can key its blink states on the face row. Clips are
`aNN_<letter>` (one per animation file and frame block), rows sampled at 30 fps per the
converter's assumption; `terminationMask` 0xfe marks a looping clip. No swap events are
written since the timing is not decoded. `swaps.json` gained an optional `extras` field
(both schema copies) that carries the decoded blink table.

**Verified** (scripted, browser driven by a Haiku subagent, screenshots read here):
Agumon upright, textured, facing the camera; export round-trips through GLTFLoader with 14
clips, 17 named nodes and the metadata; blink states checked against the texture; the
poser loads the DW2 zip (17 nodes, 4 face thumbnails, 14 clips). Full sweep: 395/395 models
export, 2804 clips, 0 failures, largest glb 1.8 MB (254LBSA); 177 models have no decodable
blink table (first byte 0xff, no eyes to blink). Model switching, pointer rotation and the
compare view run clean on DW2; DW1 Agumon still loads with only its pre-existing
`undefined.texture` error. Two framing bugs found by screenshot: a wide flyer (024 HOEE,
3200 units across) sat beyond the artboard's 7500 far plane and drew nothing, so the DW2
viewer now extends the far plane; and the compare view only shifted the camera sideways,
which cut both DW2 models off, so it now saves the camera, backs off until the pair fits
the middle 45% of the viewport (the side panels cover the rest) and restores on close.

**Open.** Blink timing (the `fe ff` tail). Model names are the file stems ("003 AGUM"); no
name table found yet. 30 fps is inherited, not measured. Semi-transparent primitives
(mixture rate) map to opacity/additive/subtractive blending untested on a model that has
them. Animation file letters A..K are not named (A looks like idle for Agumon).

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
