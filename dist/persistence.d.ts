export declare class ReplayPersistence {
    get<T>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
    private open;
}
//# sourceMappingURL=persistence.d.ts.map