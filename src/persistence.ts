interface PendingRecord {
  key: string;
  value: unknown;
}

const DATABASE_NAME = "nuke-replay";
const STORE_NAME = "pending";

export class ReplayPersistence {
  async get<T>(key: string): Promise<T | null> {
    const database = await this.open();
    if (!database) return null;
    return new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve((request.result as PendingRecord | undefined)?.value as T ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  async set(key: string, value: unknown): Promise<void> {
    const database = await this.open();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const request = database
        .transaction(STORE_NAME, "readwrite")
        .objectStore(STORE_NAME)
        .put({ key, value } satisfies PendingRecord);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async remove(key: string): Promise<void> {
    const database = await this.open();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private async open(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === "undefined") return null;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}

