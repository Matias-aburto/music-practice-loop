/**
 * Guarda la última pista cargada en IndexedDB para recuperarla tras recargar
 * la página (p. ej. ir a Ajustes MIDI y volver).
 */

const DB_NAME = "music-practice-last-track-v1";
const DB_VERSION = 1;
const STORE = "snapshots";
const ENTRY_KEY = "last";

/**
 * @returns {Promise<IDBDatabase>}
 */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = (ev) => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

/**
 * @param {ArrayBuffer} arrayBuffer copia del buffer del archivo (p. ej. slice)
 * @param {{ name: string, lastModified: number, type: string }} meta
 */
export async function persistLastLoadedTrack(arrayBuffer, meta) {
  if (!arrayBuffer || !meta || !meta.name) return;
  try {
    const db = await openDb();
    const payload = {
      buffer: arrayBuffer,
      name: meta.name,
      lastModified: meta.lastModified || Date.now(),
      type: meta.type || "",
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).put(payload, ENTRY_KEY);
    });
    db.close();
  } catch (e) {
    console.warn("persistLastLoadedTrack:", e);
  }
}

export async function clearLastLoadedTrack() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE).delete(ENTRY_KEY);
    });
    db.close();
  } catch (e) {
    console.warn("clearLastLoadedTrack:", e);
  }
}

/**
 * @returns {Promise<File|null>}
 */
export async function readLastLoadedTrackAsFile() {
  try {
    const db = await openDb();
    const rec = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      tx.onerror = () => reject(tx.error);
      const r = tx.objectStore(STORE).get(ENTRY_KEY);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    if (!rec || !rec.buffer || !(rec.buffer instanceof ArrayBuffer)) return null;
    if (rec.buffer.byteLength === 0) return null;
    const blob = new Blob([rec.buffer], {
      type: rec.type || "application/octet-stream",
    });
    return new File([blob], rec.name, {
      type: rec.type || "",
      lastModified: rec.lastModified || Date.now(),
    });
  } catch (e) {
    console.warn("readLastLoadedTrackAsFile:", e);
    return null;
  }
}
