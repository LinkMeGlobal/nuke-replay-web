import type { eventWithTime } from "@rrweb/types";

export type ReplayProject = { id: string; name: string };

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
    maxAssetBytes?: number;
    maxAssetTotalBytes?: number;
    maxAssetCount?: number;
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
  history?: { maxMinutes?: number; maxBytes?: number };
  budgets?: {
    domBytes?: number;
    imageBytes?: number;
    semanticBytes?: number;
    networkBodyBytes?: number;
  };
  network?: {
    captureTextBodies?: boolean;
    requestBodyBytes?: number;
    responseBodyBytes?: number;
    excludedUrlPatterns?: Array<RegExp>;
  };
  triggers?: { edgeLauncher?: boolean; keyboardShortcut?: boolean };
  onProgress?: (progress: ReplayProgress) => void;
  onTelemetry?: (timing: ReplayTiming) => void;
}

export interface ReplayProgress {
  phase: "preparing" | "uploading" | "processing" | "complete" | "failed";
  completed: number;
  total: number;
  bytesUploaded: number;
  bytesTotal: number;
  reference?: string;
  message?: string;
}

export interface ReplayTiming {
  phase:
    | "indexeddb"
    | "serialization"
    | "gzip"
    | "hashing"
    | "session"
    | "report"
    | "network"
    | "completion";
  durationMs: number;
  bytes?: number;
  chunkSequence?: number;
}
