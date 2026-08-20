import type { NukeReplayConfiguration, ReplayProject, ReplayReportInput, ReplaySubmitResult } from "./types";
type OpenListener = (open: boolean) => void;
export declare class NukeReplayClient {
    readonly configuration: NukeReplayConfiguration;
    private readonly ring;
    private readonly persistence;
    private readonly listeners;
    private stopRecorder?;
    private cleanupNetwork?;
    private cleanupEvents?;
    private prepared?;
    private started;
    constructor(configuration: NukeReplayConfiguration);
    start(): Promise<void>;
    stop(): void;
    destroy(): void;
    openReporter(): void;
    closeReporter(): void;
    subscribe(listener: OpenListener): () => void;
    setContext(input: {
        route?: string;
    }): void;
    screen(name: string): void;
    prepareReporter(): Promise<{
        projects: Array<ReplayProject>;
        defaultProjectId: string;
    }>;
    cancelPrepared(): Promise<void>;
    submit(report: ReplayReportInput, includeReplay?: boolean): Promise<ReplaySubmitResult>;
    clearForAccountChange(): Promise<void>;
    get fallbackProjects(): Array<ReplayProject>;
    get defaultProjectId(): string;
    private get endpoint();
    private bootstrapRequest;
    private resumePending;
    private uploadPending;
    private installSemanticEvents;
    private semantic;
    private progress;
}
export declare function createNukeReplay(configuration: NukeReplayConfiguration): NukeReplayClient;
export {};
//# sourceMappingURL=client.d.ts.map