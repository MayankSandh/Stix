// Thin promise wrapper around IndexedDB for sticker groups and stickers.
const DB_NAME = 'sticker-maker';
const DB_VERSION = 1;

let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('groups')) {
          db.createObjectStore('groups', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('stickers')) {
          const stickers = db.createObjectStore('stickers', { keyPath: 'id' });
          stickers.createIndex('groupId', 'groupId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function complete(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
  });
}

async function store(name, mode = 'readonly') {
  const db = await openDb();
  return db.transaction(name, mode).objectStore(name);
}

const byCreated = (a, b) => a.createdAt - b.createdAt;

export async function listGroups() {
  const groups = await done((await store('groups')).getAll());
  return groups.sort(byCreated);
}

export async function createGroup(name) {
  const group = { id: crypto.randomUUID(), name, createdAt: Date.now() };
  await done((await store('groups', 'readwrite')).add(group));
  return group;
}

export async function renameGroup(id, name) {
  const s = await store('groups', 'readwrite');
  const group = await done(s.get(id));
  if (!group) return;
  group.name = name;
  await done(s.put(group));
}

export async function deleteGroup(id) {
  const db = await openDb();
  const tx = db.transaction(['groups', 'stickers'], 'readwrite');
  tx.objectStore('groups').delete(id);
  const index = tx.objectStore('stickers').index('groupId');
  const keys = await done(index.getAllKeys(id));
  for (const key of keys) tx.objectStore('stickers').delete(key);
  await complete(tx);
}

export async function listStickers() {
  const stickers = await done((await store('stickers')).getAll());
  return stickers.sort(byCreated);
}

export async function getSticker(id) {
  return done((await store('stickers')).get(id));
}

/** `png` is the lossless 512x512 master; WebP is generated when sharing. */
export async function addSticker(groupId, png) {
  const sticker = { id: crypto.randomUUID(), groupId, png, createdAt: Date.now() };
  await done((await store('stickers', 'readwrite')).add(sticker));
  return sticker;
}

export async function moveSticker(id, groupId) {
  const s = await store('stickers', 'readwrite');
  const sticker = await done(s.get(id));
  if (!sticker) return;
  sticker.groupId = groupId;
  await done(s.put(sticker));
}

export async function deleteSticker(id) {
  await done((await store('stickers', 'readwrite')).delete(id));
}
