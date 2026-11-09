// Catalogue of the Digimon World 2 models on a disc image: one entry per M###CODE.BIN with
// its animation files (A..K), parsed lazily.

import { FileSource } from "./pack";
import { parseDw2Model, Dw2Model } from "./model";
import { parseDw2Anim, Dw2Anim } from "./anim";

export const DW2_MODEL_DIR = "/AAA/4.AAA/MODEL/";
export const DW2_ANIM_LETTERS = "ABCDEFGHIJK".split("");

export interface Dw2ModelEntry {
  index: number; // position in the catalogue
  stem: string; // "003AGUM"
  number: number; // 3
  code: string; // "AGUM"
  name: string; // display name
  modelPath: string;
  animPaths: Array<{ letter: string; path: string }>;
}

export interface Dw2LoadedModel {
  entry: Dw2ModelEntry;
  model: Dw2Model;
  modelBytes: Uint8Array;
  anims: Array<{ letter: string; path: string; anim: Dw2Anim; bytes: Uint8Array }>;
}

export class Dw2Disc {
  // The disc image, or a pack of just the MODEL folder (see pack.ts)
  readonly iso: FileSource;
  readonly entries: Dw2ModelEntry[];

  constructor(iso: FileSource) {
    this.iso = iso;
    const files = iso.list(DW2_MODEL_DIR);
    const byStem = new Map<string, Map<string, string>>();

    files.forEach((file) => {
      const base = file.path.slice(file.path.lastIndexOf("/") + 1);
      const match = /^([A-M])(\d{3}[A-Z0-9]{4})\.BIN$/.exec(base);
      if (!match) return;
      const [, letter, stem] = match;
      if (!byStem.has(stem)) byStem.set(stem, new Map());
      byStem.get(stem)!.set(letter, file.path);
    });

    this.entries = [...byStem.entries()]
      .filter(([, letters]) => letters.has("M"))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([stem, letters], index) => ({
        index,
        stem,
        number: parseInt(stem.slice(0, 3), 10),
        code: stem.slice(3),
        name: `${stem.slice(0, 3)} ${stem.slice(3)}`,
        modelPath: letters.get("M")!,
        animPaths: DW2_ANIM_LETTERS.filter((l) => letters.has(l)).map((letter) => ({
          letter,
          path: letters.get(letter)!,
        })),
      }));
  }

  static isDw2(iso: FileSource) {
    return iso.list(DW2_MODEL_DIR).length > 0;
  }

  load(index: number): Dw2LoadedModel {
    const entry = this.entries[index];
    if (!entry) throw Error(`no DW2 model at index ${index}`);
    const modelBytes = this.iso.readFile(entry.modelPath);
    const model = parseDw2Model(modelBytes);
    const anims = entry.animPaths.map(({ letter, path }) => {
      const bytes = this.iso.readFile(path);
      return { letter, path, bytes, anim: parseDw2Anim(bytes, model.objects.length) };
    });
    return { entry, model, modelBytes, anims };
  }
}
