// Keeps the discs the user has picked in IndexedDB so the viewer opens straight into them
// next time. Each BIN is stored as a Blob (browsers keep large Blobs as files on disk rather
// than in memory). Everything fails soft: a private window or a refused quota just means
// the file picker shows again.

export type StoredGame = "dw1" | "dw2";

export interface StoredDiscInfo {
  game: StoredGame;
  name: string;
  size: number;
  savedAt: string;
}

interface StoredDisc extends StoredDiscInfo {
  blob: Blob;
}

const DB_NAME = "digimon-character-viewer";
const STORE = "discs";
// One-off parcels between pages: the viewer drops an export here for the poser to pick up
const HANDOFF = "handoff";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "game" });
      if (!db.objectStoreNames.contains(HANDOFF)) db.createObjectStore(HANDOFF, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? Error("IndexedDB open failed"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? Error("IndexedDB request failed"));
  });
}

export async function saveDisc(game: StoredGame, bytes: ArrayBuffer, name: string): Promise<void> {
  // Ask the browser not to evict this origin's storage under pressure (best effort)
  try {
    await navigator.storage?.persist?.();
  } catch {
    // ignore
  }
  const db = await openDb();
  try {
    const record: StoredDisc = {
      game,
      name,
      size: bytes.byteLength,
      savedAt: new Date().toISOString(),
      blob: new Blob([bytes]),
    };
    await requestToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).put(record));
  } finally {
    db.close();
  }
}

export async function loadDisc(game: StoredGame): Promise<ArrayBuffer | null> {
  const db = await openDb();
  try {
    const record = (await requestToPromise(
      db.transaction(STORE, "readonly").objectStore(STORE).get(game),
    )) as StoredDisc | undefined;
    return record ? await record.blob.arrayBuffer() : null;
  } finally {
    db.close();
  }
}

export async function listDiscs(): Promise<StoredDiscInfo[]> {
  const db = await openDb();
  try {
    const records = (await requestToPromise(
      db.transaction(STORE, "readonly").objectStore(STORE).getAll(),
    )) as StoredDisc[];
    return records.map(({ game, name, size, savedAt }) => ({ game, name, size, savedAt }));
  } finally {
    db.close();
  }
}

export interface Handoff {
  name: string;
  bytes: ArrayBuffer;
}

export async function putHandoff(key: string, name: string, bytes: ArrayBuffer): Promise<void> {
  const db = await openDb();
  try {
    await requestToPromise(
      db.transaction(HANDOFF, "readwrite").objectStore(HANDOFF).put({ key, name, blob: new Blob([bytes]) }),
    );
  } finally {
    db.close();
  }
}

// Reads and clears a parcel
export async function takeHandoff(key: string): Promise<Handoff | null> {
  const db = await openDb();
  try {
    const record = (await requestToPromise(db.transaction(HANDOFF, "readonly").objectStore(HANDOFF).get(key))) as
      | { name: string; blob: Blob }
      | undefined;
    if (!record) return null;
    await requestToPromise(db.transaction(HANDOFF, "readwrite").objectStore(HANDOFF).delete(key));
    return { name: record.name, bytes: await record.blob.arrayBuffer() };
  } finally {
    db.close();
  }
}

export async function forgetDiscs(): Promise<void> {
  const db = await openDb();
  try {
    await requestToPromise(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
  } finally {
    db.close();
  }
}
