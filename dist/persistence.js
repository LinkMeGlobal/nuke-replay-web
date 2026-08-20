const DATABASE_NAME = "nuke-replay";
const DATABASE_VERSION = 3;
const PENDING_STORE = "pending";
const CAPTURE_STORE = "capture";
const CHUNK_STORE = "chunks";
const ASSET_STORE = "assets";
export class ReplayPersistence {
    async get(key) {
        return this.getFromStore(PENDING_STORE, key);
    }
    async set(key, value) {
        const database = await this.open();
        if (!database)
            return;
        await new Promise((resolve, reject) => {
            const request = database
                .transaction(PENDING_STORE, "readwrite")
                .objectStore(PENDING_STORE)
                .put({ key, value, updatedAt: Date.now() });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
    async remove(key) {
        const database = await this.open();
        if (!database)
            return;
        await new Promise((resolve, reject) => {
            const request = database.transaction(PENDING_STORE, "readwrite").objectStore(PENDING_STORE).delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
    async getCapture(key) {
        return this.getFromStore(CAPTURE_STORE, key);
    }
    async setCapture(key, value) {
        await this.put(CAPTURE_STORE, key, value);
    }
    async removeCapture(key) {
        await this.delete(CAPTURE_STORE, key);
    }
    async setChunk(chunk) {
        await this.put(CHUNK_STORE, chunk.key, chunk);
    }
    async getChunks(submissionKey) {
        const database = await this.open();
        if (!database)
            return [];
        return new Promise((resolve, reject) => {
            const index = database.transaction(CHUNK_STORE).objectStore(CHUNK_STORE).index("submissionKey");
            const request = index.getAll(submissionKey);
            request.onsuccess = () => resolve(request.result
                .map((record) => record.value)
                .sort((left, right) => left.sequence - right.sequence));
            request.onerror = () => reject(request.error);
        });
    }
    async markChunkUploaded(key) {
        const chunk = await this.getFromStore(CHUNK_STORE, key);
        if (!chunk)
            return;
        await this.setChunk({ ...chunk, uploaded: true });
    }
    async removeChunks(submissionKey) {
        const chunks = await this.getChunks(submissionKey);
        await Promise.all(chunks.map((chunk) => this.delete(CHUNK_STORE, chunk.key)));
    }
    async setAsset(asset) {
        if (await this.getAsset(asset.sha256))
            return;
        await this.put(ASSET_STORE, asset.sha256, asset);
    }
    getAsset(sha256) {
        return this.getFromStore(ASSET_STORE, sha256);
    }
    async getAssets(hashes) {
        const assets = await Promise.all([...new Set(hashes)].map((hash) => this.getAsset(hash)));
        return assets.filter((asset) => asset !== null);
    }
    async pruneAssets(olderThan) {
        const database = await this.open();
        if (!database)
            return;
        const records = await new Promise((resolve, reject) => {
            const request = database.transaction(ASSET_STORE).objectStore(ASSET_STORE).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        await Promise.all(records.filter((record) => record.updatedAt < olderThan).map((record) => this.delete(ASSET_STORE, record.key)));
    }
    async getFromStore(store, key) {
        const database = await this.open();
        if (!database)
            return null;
        return new Promise((resolve, reject) => {
            const request = database.transaction(store).objectStore(store).get(key);
            request.onsuccess = () => resolve(request.result?.value ?? null);
            request.onerror = () => reject(request.error);
        });
    }
    async put(store, key, value) {
        const database = await this.open();
        if (!database)
            return;
        await new Promise((resolve, reject) => {
            const request = database.transaction(store, "readwrite").objectStore(store)
                .put({ key, value, updatedAt: Date.now() });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
    async delete(store, key) {
        const database = await this.open();
        if (!database)
            return;
        await new Promise((resolve, reject) => {
            const request = database.transaction(store, "readwrite").objectStore(store).delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
    async open() {
        if (typeof indexedDB === "undefined")
            return null;
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
//# sourceMappingURL=persistence.js.map