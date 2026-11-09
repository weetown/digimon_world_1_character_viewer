// A pack is the DW2 MODEL folder pulled out of the disc into one small buffer: a JSON index
// then the file bytes back to back. It is what gets kept in the browser between visits, so
// the companion loads from tens of MB rather than the 462 MB image, and the image itself can
// be dropped once packed.

const MAGIC = "DW2PACK1";

export interface FileSource {
  list(prefix: string): Array<{ path: string }>;
  readFile(path: string): Uint8Array;
}

interface PackIndexEntry {
  path: string;
  offset: number;
  size: number;
}

export function isPack(buffer: ArrayBuffer) {
  if (buffer.byteLength < MAGIC.length + 4) return false;
  const head = new Uint8Array(buffer, 0, MAGIC.length);
  return String.fromCharCode(...head) === MAGIC;
}

export function packFiles(source: FileSource, prefix: string): ArrayBuffer {
  const files = source.list(prefix).map((f) => f.path).sort();
  const index: PackIndexEntry[] = [];
  const blobs: Uint8Array[] = [];
  let offset = 0;
  files.forEach((path) => {
    const bytes = source.readFile(path);
    index.push({ path, offset, size: bytes.byteLength });
    blobs.push(bytes);
    offset += bytes.byteLength;
  });

  const json = new TextEncoder().encode(JSON.stringify(index));
  const header = MAGIC.length + 4;
  const out = new Uint8Array(header + json.byteLength + offset);
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(MAGIC.length, json.byteLength, true);
  out.set(json, header);
  let pos = header + json.byteLength;
  blobs.forEach((bytes) => {
    out.set(bytes, pos);
    pos += bytes.byteLength;
  });
  return out.buffer;
}

export class PackedFiles implements FileSource {
  private bytes: Uint8Array;
  private entries = new Map<string, PackIndexEntry>();
  private dataStart: number;

  constructor(buffer: ArrayBuffer) {
    if (!isPack(buffer)) throw Error("not a DW2 pack");
    this.bytes = new Uint8Array(buffer);
    const jsonLength = new DataView(buffer).getUint32(MAGIC.length, true);
    const header = MAGIC.length + 4;
    const index = JSON.parse(
      new TextDecoder().decode(this.bytes.subarray(header, header + jsonLength)),
    ) as PackIndexEntry[];
    index.forEach((entry) => this.entries.set(entry.path, entry));
    this.dataStart = header + jsonLength;
  }

  list(prefix: string) {
    return [...this.entries.values()].filter((e) => e.path.startsWith(prefix));
  }

  readFile(path: string): Uint8Array {
    const entry = this.entries.get(path);
    if (!entry) throw Error(`no such file in pack: ${path}`);
    const start = this.dataStart + entry.offset;
    // A copy, so callers may keep it after the pack is gone
    return this.bytes.slice(start, start + entry.size);
  }
}
