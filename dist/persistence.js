const DATABASE_NAME = "nuke-replay";
const STORE_NAME = "pending";
export class ReplayPersistence {
    async get(key) {
        const database = await this.open();
        if (!database)
            return null;
        return new Promise((resolve, reject) => {
            const request = database.transaction(STORE_NAME).objectStore(STORE_NAME).get(key);
            request.onsuccess = () => resolve(request.result?.value ?? null);
            request.onerror = () => reject(request.error);
        });
    }
    async set(key, value) {
        const database = await this.open();
        if (!database)
            return;
        await new Promise((resolve, reject) => {
            const request = database
                .transaction(STORE_NAME, "readwrite")
                .objectStore(STORE_NAME)
                .put({ key, value });
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
    async remove(key) {
        const database = await this.open();
        if (!database)
            return;
        await new Promise((resolve, reject) => {
            const request = database.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(key);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
    async open() {
        if (typeof indexedDB === "undefined")
            return null;
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
//# sourceMappingURL=persistence.js.map