import type { eventWithTime } from "@rrweb/types";
export type ReplayProject = {
    id: string;
    name: string;
};
export interface SessionBootstrapRequest {
    idempotencyKey: string;
    appId: string;
    platform: "web";
    captureFormat: "rrweb@2";
    release: string;
    environment: string;
    sdkVersion: string;
    startedAt: number;
}
export interface SessionBootstrap {
    sessionId: string;
    capability: string;
    expiresAt: number;
    serverTime: number;
    projects: Array<ReplayProject>;
    defaultProjectId: string;
    policy: {
        maxChunkBytes: number;
        maxSessionBytes: number;
        maxDurationMs: number;
        retentionDays: number;
    };
}
export interface ReplayReportInput {
    title: string;
    whatDidYouDo: string;
    whatHappened: string;
    whatShouldHaveHappened: string;
    projectId: string;
    priority?: "critical" | "high" | "medium" | "low";
    platforms: Array<"web_desktop" | "web_mobile" | "ios" | "android">;
    pageUrl?: string;
    historyMinutes: 5 | 15 | 30;
}
export interface ReplaySubmitResult {
    reportId: string;
    reference: string;
    replayStatus: string;
}
export interface SemanticEvent {
    type: "navigation" | "interaction" | "input" | "network" | "error" | "lifecycle";
    offsetMs: number;
    [key: string]: string | number | boolean | null | undefined;
}
export interface ReplayChunkPayload {
    events: Array<eventWithTime>;
    semantic: Array<SemanticEvent>;
}
export interface NukeReplayConfiguration {
    appId: string;
    endpoint: string;
    environment: string;
    release: string;
    sdkVersion?: string;
    defaultProjectId?: string;
    projectFallbacks?: Array<ReplayProject>;
    createSession: (request: SessionBootstrapRequest) => Promise<SessionBootstrap>;
    submitDiagnostics?: (report: ReplayReportInput) => Promise<ReplaySubmitResult>;
    history?: {
        maxMinutes?: number;
        maxBytes?: number;
    };
    network?: {
        captureTextBodies?: boolean;
        requestBodyBytes?: number;
        responseBodyBytes?: number;
        excludedUrlPatterns?: Array<RegExp>;
    };
    triggers?: {
        edgeLauncher?: boolean;
        keyboardShortcut?: boolean;
    };
    onProgress?: (progress: ReplayProgress) => void;
}
export interface ReplayProgress {
    phase: "preparing" | "uploading" | "submitting" | "pending" | "complete";
    completed: number;
    total: number;
}
//# sourceMappingURL=types.d.ts.map