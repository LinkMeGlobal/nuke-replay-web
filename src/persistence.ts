interface StoredRecord<T = unknown> {
  key: string;
  value: T;
  updatedAt: number;
}

const DATABASE_NAME = "nuke-replay";
const DATABASE_VERSION = 3;
const PENDING_STORE = "pending";
const CAPTURE_STORE = "capture";
const CHUNK_STORE = "chunks";
const ASSET_STORE = "assets";

export interface PersistedReplayChunk {
  key: string;
  submissionKey: string;
  sequence: number;
  bytes: Uint8Array;
  encoding: "gzip" | null;
  sha256: string;
  startOffsetMs: number;
  endOffsetMs: number;
  eventCount: number;
  uploaded: boolean;
}

export interface PersistedReplayAsset {
  sha256: string;
  bytes: Uint8Array;
  contentType: string;
}

export class ReplayPersistence {
  async get<T>(key: string): Promise<T | null> {
    return this.getFromStore<T>(PENDING_STORE, key);
  }

  async set(key: string, value: unknown): Promise<void> {
    const database = await this.open();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const request = database
        .transaction(PENDING_STORE, "readwrite")
        .objectStore(PENDING_STORE)
        .put({ key, value, updatedAt: Date.now() } satisfies StoredRecord);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async remove(key: string): Promise<void> {
    const database = await this.open();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(PENDING_STORE, "readwrite").objectStore(PENDING_STORE).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getCapture<T>(key: string): Promise<T | null> {
    return this.getFromStore<T>(CAPTURE_STORE, key);
  }

  async setCapture(key: string, value: unknown): Promise<void> {
    await this.put(CAPTURE_STORE, key, value);
  }

  async removeCapture(key: string): Promise<void> {
    await this.delete(CAPTURE_STORE, key);
  }

  async setChunk(chunk: PersistedReplayChunk): Promise<void> {
    await this.put(CHUNK_STORE, chunk.key, chunk);
  }

  async getChunks(submissionKey: string): Promise<Array<PersistedReplayChunk>> {
    const database = await this.open();
    if (!database) return [];
    return new Promise((resolve, reject) => {
      const index = database.transaction(CHUNK_STORE).objectStore(CHUNK_STORE).index("submissionKey");
      const request = index.getAll(submissionKey);
      request.onsuccess = () => resolve(
        (request.result as Array<StoredRecord<PersistedReplayChunk>>)
          .map((record) => record.value)
          .sort((left, right) => left.sequence - right.sequence),
      );
      request.onerror = () => reject(request.error);
    });
  }

  async markChunkUploaded(key: string): Promise<void> {
    const chunk = await this.getFromStore<PersistedReplayChunk>(CHUNK_STORE, key);
    if (!chunk) return;
    await this.setChunk({ ...chunk, uploaded: true });
  }

  async removeChunks(submissionKey: string): Promise<void> {
    const chunks = await this.getChunks(submissionKey);
    await Promise.all(chunks.map((chunk) => this.delete(CHUNK_STORE, chunk.key)));
  }

  async setAsset(asset: PersistedReplayAsset): Promise<void> {
    if (await this.getAsset(asset.sha256)) return;
    await this.put(ASSET_STORE, asset.sha256, asset);
  }

  getAsset(sha256: string): Promise<PersistedReplayAsset | null> {
    return this.getFromStore<PersistedReplayAsset>(ASSET_STORE, sha256);
  }

  async getAssets(hashes: Array<string>): Promise<Array<PersistedReplayAsset>> {
    const assets = await Promise.all([...new Set(hashes)].map((hash) => this.getAsset(hash)));
    return assets.filter((asset): asset is PersistedReplayAsset => asset !== null);
  }

  async pruneAssets(olderThan: number): Promise<void> {
    const database = await this.open();
    if (!database) return;
    const records = await new Promise<Array<StoredRecord<PersistedReplayAsset>>>((resolve, reject) => {
      const request = database.transaction(ASSET_STORE).objectStore(ASSET_STORE).getAll();
      request.onsuccess = () => resolve(request.result as Array<StoredRecord<PersistedReplayAsset>>);
      request.onerror = () => reject(request.error);
    });
    await Promise.all(records.filter((record) => record.updatedAt < olderThan).map((record) =>
      this.delete(ASSET_STORE, record.key),
    ));
  }

  private async getFromStore<T>(store: string, key: string): Promise<T | null> {
    const database = await this.open();
    if (!database) return null;
    return new Promise((resolve, reject) => {
      const request = database.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve((request.result as StoredRecord<T> | undefined)?.value ?? null);
      request.onerror = () => reject(request.error);
    });
  }

  private async put(store: string, key: string, value: unknown): Promise<void> {
    const database = await this.open();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(store, "readwrite").objectStore(store)
        .put({ key, value, updatedAt: Date.now() } satisfies StoredRecord);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private async delete(store: string, key: string): Promise<void> {
    const database = await this.open();
    if (!database) return;
    await new Promise<void>((resolve, reject) => {
      const request = database.transaction(store, "readwrite").objectStore(store).delete(key);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  private async open(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === "undefined") return null;
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        for (const store of [PENDING_STORE, CAPTURE_STORE, ASSET_STORE]) {
          if (!request.result.objectStoreNames.contains(store)) {
            request.result.createObjectStore(store, { keyPath: "key" });
          }
        }
        if (!request.result.objectStoreNames.contains(CHUNK_STORE)) {
          const chunks = request.result.createObjectStore(CHUNK_STORE, { keyPath: "key" });
          chunks.createIndex("submissionKey", "value.submissionKey", { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}
