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
export declare class ReplayPersistence {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    getCapture<T>(key: string): Promise<T | null>;
    setCapture(key: string, value: unknown): Promise<void>;
    removeCapture(key: string): Promise<void>;
    setChunk(chunk: PersistedReplayChunk): Promise<void>;
    getChunks(submissionKey: string): Promise<Array<PersistedReplayChunk>>;
    markChunkUploaded(key: string): Promise<void>;
    removeChunks(submissionKey: string): Promise<void>;
    setAsset(asset: PersistedReplayAsset): Promise<void>;
    getAsset(sha256: string): Promise<PersistedReplayAsset | null>;
    getAssets(hashes: Array<string>): Promise<Array<PersistedReplayAsset>>;
    pruneAssets(olderThan: number): Promise<void>;
    private getFromStore;
    private put;
    private delete;
    private open;
}
//# sourceMappingURL=persistence.d.ts.map