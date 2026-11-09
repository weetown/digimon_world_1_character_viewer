// Minimal ISO 9660 reader over a raw 2352-byte-sector PSX image (Mode 2 Form 1: the 2048
// bytes of user data sit 24 bytes into each sector). Nothing is copied; files are sliced out
// of the image buffer on demand.

import { PSX_SECTOR_HEADER_SIZE, PSX_SECTOR_SIZE } from "../constants";

const USER_DATA = 2048;

export interface IsoEntry {
  path: string; // "/AAA/4.AAA/MODEL/MODEL000/M003AGUM.BIN"
  lba: number;
  size: number;
  isDirectory: boolean;
}

export class IsoImage {
  private bytes: Uint8Array;
  private view: DataView;
  readonly entries = new Map<string, IsoEntry>();
  readonly volumeId: string;

  constructor(buffer: ArrayBuffer) {
    this.bytes = new Uint8Array(buffer);
    this.view = new DataView(buffer);

    if (buffer.byteLength % PSX_SECTOR_SIZE !== 0) {
      throw Error("not a raw 2352-byte-sector image");
    }

    const pvd = this.sector(16);
    const magic = String.fromCharCode(...pvd.subarray(1, 6));
    if (magic !== "CD001") throw Error("no ISO 9660 primary volume descriptor");

    this.volumeId = String.fromCharCode(...pvd.subarray(40, 72)).trim();

    // Walk the directory tree from the root record. The game hides most of its tree from
    // casual listing (the root directory only shows the executable and a dummy), but the
    // path table still names every directory, so walk from there instead.
    const pathTableSize = this.view.getUint32(16 * PSX_SECTOR_SIZE + PSX_SECTOR_HEADER_SIZE + 132, true);
    const pathTableLba = this.view.getUint32(16 * PSX_SECTOR_SIZE + PSX_SECTOR_HEADER_SIZE + 140, true);
    const table = this.read(pathTableLba, pathTableSize);
    const tableView = new DataView(table.buffer, table.byteOffset, table.byteLength);

    const dirs: Array<{ name: string; lba: number; parent: number }> = [];
    let pos = 0;
    while (pos + 8 <= table.length) {
      const nameLength = table[pos];
      if (nameLength === 0) break;
      const lba = tableView.getUint32(pos + 2, true);
      const parent = tableView.getUint16(pos + 6, true);
      const name = String.fromCharCode(...table.subarray(pos + 8, pos + 8 + nameLength));
      dirs.push({ name: name === "\u0000" ? "" : name, lba, parent });
      pos += 8 + nameLength + (nameLength & 1);
    }

    const dirPath = (index: number): string => {
      const dir = dirs[index];
      if (!dir || index === 0) return "";
      return `${dirPath(dir.parent - 1)}/${dir.name}`;
    };

    dirs.forEach((dir, index) => {
      const base = dirPath(index);
      this.listDirectory(dir.lba).forEach((entry) => {
        if (entry.isDirectory) return; // directories come from the path table
        const path = `${base}/${entry.path}`;
        this.entries.set(path, { ...entry, path });
      });
    });
  }

  private sector(lba: number): Uint8Array {
    const start = lba * PSX_SECTOR_SIZE + PSX_SECTOR_HEADER_SIZE;
    return this.bytes.subarray(start, start + USER_DATA);
  }

  // Reads `size` bytes of user data starting at `lba` into a fresh buffer
  read(lba: number, size: number): Uint8Array {
    const out = new Uint8Array(size);
    for (let offset = 0, s = lba; offset < size; offset += USER_DATA, s++) {
      const chunk = this.sector(s);
      out.set(chunk.subarray(0, Math.min(USER_DATA, size - offset)), offset);
    }
    return out;
  }

  readFile(path: string): Uint8Array {
    const entry = this.entries.get(path);
    if (!entry) throw Error(`no such file on disc: ${path}`);
    return this.read(entry.lba, entry.size);
  }

  // Reads one directory extent (records until a zero length byte or end of sector run)
  private listDirectory(lba: number): IsoEntry[] {
    const out: IsoEntry[] = [];
    // The first record describes the directory itself and carries its byte size
    const first = this.sector(lba);
    const size = new DataView(first.buffer, first.byteOffset).getUint32(10, true);
    const sectors = Math.ceil(size / USER_DATA);

    for (let s = 0; s < sectors; s++) {
      const data = this.sector(lba + s);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      let pos = 0;
      while (pos < USER_DATA) {
        const length = data[pos];
        if (length === 0) break;
        const extent = view.getUint32(pos + 2, true);
        const fileSize = view.getUint32(pos + 10, true);
        const flags = data[pos + 25];
        const nameLength = data[pos + 32];
        const rawName = String.fromCharCode(...data.subarray(pos + 33, pos + 33 + nameLength));
        pos += length;
        if (rawName === "\u0000" || rawName === "\u0001") continue;
        out.push({
          path: rawName.split(";")[0],
          lba: extent,
          size: fileSize,
          isDirectory: (flags & 2) !== 0,
        });
      }
    }
    return out;
  }

  list(prefix: string): IsoEntry[] {
    return [...this.entries.values()].filter((e) => e.path.startsWith(prefix));
  }
}
