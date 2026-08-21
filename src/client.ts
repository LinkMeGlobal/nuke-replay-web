import type { eventWithTime } from "@rrweb/types";
import { installNetworkCapture } from "./network";
import {
  ReplayPersistence,
  type PersistedReplayAsset,
  type PersistedReplayChunk,
} from "./persistence";
import { ReplayRingBuffer, type ReplaySegment } from "./ring-buffer";
import { ReplaySegmentEncoder, type EncodedReplayChunk } from "./segment-encoder";
import type {
  NukeReplayConfiguration,
  ReplayProgress,
  ReplayChunkPayload,
  ReplayProject,
  ReplayReportInput,
  ReplaySubmitResult,
  ReplayTiming,
  SemanticEvent,
  SessionBootstrap,
  SessionBootstrapRequest,
} from "./types";

const SDK_VERSION = "0.3.0";
const PENDING_KEY = "pending-report";
const MAX_PENDING_AGE = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_CHUNK_BYTES = Math.floor(1.5 * 1_024 * 1_024);
const UPLOAD_CONCURRENCY = 4;
const DEFAULT_MAX_ASSET_BYTES = 5 * 1_024 * 1_024;
const DEFAULT_MAX_ASSET_TOTAL_BYTES = 24 * 1_024 * 1_024;
const DEFAULT_MAX_ASSET_COUNT = 256;

interface PersistedCaptureSegment {
  id: string;
  startedAt: number;
  endedAt: number;
  chunks: Array<EncodedReplayChunk>;
  assetHashes: Array<string>;
}

interface PendingSubmission {
  createdAt: number;
  idempotencyKey: string;
  startedAt: number;
  report: ReplayReportInput;
  bootstrap: SessionBootstrap;
  reportResult: ReplaySubmitResult;
  segmentIds: Array<string>;
  activeSegments: Array<ReplaySegment>;
  semantic: Array<SemanticEvent>;
  timings: Array<ReplayTiming>;
  assetHashes?: Array<string>;
}

interface LegacyPendingSubmission {
  createdAt: number;
  idempotencyKey: string;
  startedAt: number;
  report: ReplayReportInput;
  payload: ReplayChunkPayload;
  bootstrap?: SessionBootstrap;
}

type OpenListener = (open: boolean) => void;
type ProgressListener = (progress: ReplayProgress | null) => void;

export class NukeReplayClient {
  private readonly ring: ReplayRingBuffer;
  private readonly persistence = new ReplayPersistence();
  private readonly encoder: ReplaySegmentEncoder;
  private readonly listeners = new Set<OpenListener>();
  private readonly progressListeners = new Set<ProgressListener>();
  private readonly sealedSegmentIds = new Set<string>();
  private readonly segmentJobs = new Map<string, Promise<PersistedCaptureSegment>>();
  private readonly recentTimings: Array<ReplayTiming> = [];
  private readonly assetCache = new Map<string, PersistedReplayAsset>();
  private activeTimings?: Array<ReplayTiming>;
  private stopRecorder?: () => void;
  private cleanupNetwork?: () => void;
  private cleanupEvents?: () => void;
  private prepared?: { idempotencyKey: string; bootstrap: SessionBootstrap; startedAt: number };
  private started = false;
  private lifecycleEpoch = 0;
  private retryAttempt = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private retryInFlight?: Promise<void>;
  private onlineListener?: () => void;
  private submissionActive = false;

  constructor(readonly configuration: NukeReplayConfiguration) {
    const historyBytes = configuration.history?.maxBytes ?? 75 * 1_024 * 1_024;
    this.ring = new ReplayRingBuffer(
      (configuration.history?.maxMinutes ?? 30) * 60_000,
      configuration.budgets?.domBytes ?? historyBytes,
      configuration.budgets?.imageBytes ?? 24 * 1_024 * 1_024,
      configuration.budgets?.semanticBytes ?? 12 * 1_024 * 1_024,
      configuration.budgets?.networkBodyBytes ?? 8 * 1_024 * 1_024,
    );
    this.encoder = new ReplaySegmentEncoder((timing) => this.telemetry(timing));
  }

  async start(): Promise<void> {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    const epoch = ++this.lifecycleEpoch;
    const { record } = await import("rrweb");
    if (!this.started || epoch !== this.lifecycleEpoch) return;
    this.stopRecorder = record({
      emit: (event, checkout) => this.recordEvent(event, checkout ?? false),
      checkoutEveryNms: 45_000,
      blockClass: "nuke-replay-block",
      maskTextClass: "nuke-replay-mask",
      ignoreClass: "nuke-replay-ignore",
      inlineStylesheet: true,
      // rrweb's inline-image path mutates live cross-origin <img> elements by
      // toggling `crossOrigin` after load. That can reload or blank the image
      // when a CDN does not allow the current app origin. Replay assets are
      // captured separately by the segment encoder, so DOM mutation is both
      // unnecessary and unsafe here.
      inlineImages: false,
      collectFonts: true,
      dataURLOptions: { type: "image/webp", quality: 0.82 },
      recordCanvas: false,
    }) ?? undefined;
    this.cleanupNetwork = installNetworkCapture(this.configuration, (event) => this.addSemantic(event));
    this.cleanupEvents = this.installSemanticEvents();
    this.onlineListener = () => void this.retryPending();
    window.addEventListener("online", this.onlineListener);
    void this.persistence.pruneAssets(Date.now() - MAX_PENDING_AGE);
    void this.retryPending();
  }

  stop(): void {
    this.lifecycleEpoch += 1;
    this.stopRecorder?.();
    this.cleanupNetwork?.();
    this.cleanupEvents?.();
    if (this.onlineListener) window.removeEventListener("online", this.onlineListener);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopRecorder = undefined;
    this.cleanupNetwork = undefined;
    this.cleanupEvents = undefined;
    this.onlineListener = undefined;
    this.retryTimer = undefined;
    this.started = false;
  }

  destroy(): void {
    this.stop();
    this.encoder.destroy();
    this.listeners.clear();
    this.progressListeners.clear();
    this.ring.clear();
  }

  openReporter(): void {
    if (this.submissionActive) return;
    for (const listener of this.listeners) listener(true);
  }

  closeReporter(): void {
    for (const listener of this.listeners) listener(false);
  }

  subscribe(listener: OpenListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener);
    return () => this.progressListeners.delete(listener);
  }

  setContext(input: { route?: string }): void {
    if (input.route) this.semantic({ type: "navigation", name: input.route });
  }

  screen(name: string): void {
    this.semantic({ type: "navigation", name });
  }

  async prepareReporter(): Promise<{ projects: Array<ReplayProject>; defaultProjectId: string }> {
    if (this.prepared && this.prepared.bootstrap.expiresAt > Date.now()) {
      return this.prepared.bootstrap;
    }
    const idempotencyKey = randomKey();
    const startedAt = Date.now();
    const bootstrap = await this.timed("session", () =>
      this.configuration.createSession(this.bootstrapRequest(idempotencyKey, startedAt)),
    );
    this.prepared = { idempotencyKey, bootstrap, startedAt };
    return bootstrap;
  }

  async cancelPrepared(): Promise<void> {
    const prepared = this.prepared;
    this.prepared = undefined;
    if (!prepared) return;
    await fetch(`${this.endpoint}/v1/sessions/${prepared.bootstrap.sessionId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${prepared.bootstrap.capability}` },
      cache: "no-store",
    }).catch(() => undefined);
  }

  async submit(report: ReplayReportInput, includeReplay = true): Promise<ReplaySubmitResult> {
    if (!includeReplay) {
      if (!this.configuration.submitDiagnostics) {
        throw new Error("Diagnostics-only reporting is not configured");
      }
      await this.cancelPrepared();
      return this.configuration.submitDiagnostics(report);
    }

    this.progress({ phase: "preparing", completed: 0, total: 0, bytesUploaded: 0, bytesTotal: 0 });
    const prepared = await this.ensurePrepared();
    const selected = this.ring.select(report.historyMinutes);
    const reportResult = await this.createReport(prepared, report, selected.startedAt);
    const segmentIds: Array<string> = [];
    const activeSegments: Array<ReplaySegment> = [];
    for (const segment of selected.segments) {
      if (this.sealedSegmentIds.has(segment.id)) segmentIds.push(segment.id);
      else activeSegments.push(segment);
    }
    const pending: PendingSubmission = {
      createdAt: Date.now(),
      idempotencyKey: prepared.idempotencyKey,
      startedAt: selected.startedAt,
      report,
      bootstrap: prepared.bootstrap,
      reportResult,
      segmentIds,
      activeSegments,
      semantic: selected.semantic.map((event) => ({
        ...event,
        offsetMs: Math.max(0, event.offsetMs - selected.startedAt),
      })),
      timings: [...this.recentTimings],
    };
    this.submissionActive = true;
    this.prepared = undefined;
    this.progress({
      phase: "preparing",
      completed: 0,
      total: 0,
      bytesUploaded: 0,
      bytesTotal: 0,
      reference: reportResult.reference,
      message: "Preparing replay",
    });
    this.startBackgroundUpload(pending);
    return reportResult;
  }

  async clearForAccountChange(): Promise<void> {
    this.prepared = undefined;
    this.submissionActive = false;
    this.ring.clear();
    const pending = await this.persistence.get<PendingSubmission>(PENDING_KEY);
    if (pending) await this.persistence.removeChunks(pending.idempotencyKey);
    await this.persistence.remove(PENDING_KEY);
  }

  get fallbackProjects(): Array<ReplayProject> {
    return this.configuration.projectFallbacks ?? [];
  }

  get defaultProjectId(): string {
    return this.configuration.defaultProjectId ?? "all-in-challenge";
  }

  private get endpoint(): string {
    return this.configuration.endpoint.replace(/\/+$/, "");
  }

  private bootstrapRequest(idempotencyKey: string, startedAt: number): SessionBootstrapRequest {
    return {
      idempotencyKey,
      appId: this.configuration.appId,
      platform: "web",
      captureFormat: "rrweb@2",
      release: this.configuration.release,
      environment: this.configuration.environment,
      sdkVersion: this.configuration.sdkVersion ?? SDK_VERSION,
      startedAt,
    };
  }

  private async ensurePrepared(): Promise<{
    idempotencyKey: string;
    bootstrap: SessionBootstrap;
    startedAt: number;
  }> {
    if (this.prepared?.bootstrap.expiresAt && this.prepared.bootstrap.expiresAt > Date.now()) {
      return this.prepared;
    }
    const idempotencyKey = this.prepared?.idempotencyKey ?? randomKey();
    const startedAt = this.prepared?.startedAt ?? Date.now();
    const bootstrap = await this.timed("session", () =>
      this.configuration.createSession(this.bootstrapRequest(idempotencyKey, startedAt)),
    );
    this.prepared = { idempotencyKey, bootstrap, startedAt };
    return this.prepared;
  }

  private async createReport(
    prepared: { idempotencyKey: string; bootstrap: SessionBootstrap },
    report: ReplayReportInput,
    startedAt: number,
  ): Promise<ReplaySubmitResult> {
    const durationMs = Math.min(30 * 60_000, Math.max(0, Date.now() - startedAt));
    const response = await this.timed("report", () => fetch(
      `${this.endpoint}/v1/sessions/${prepared.bootstrap.sessionId}/report`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${prepared.bootstrap.capability}`,
          "Content-Type": "application/json",
          "Idempotency-Key": prepared.idempotencyKey,
        },
        body: JSON.stringify({
          ...report,
          priority: report.priority ?? "medium",
          pageUrl: report.pageUrl ?? window.location.href,
          durationMs,
          finalChunkCount: 0,
          deferredReplayUpload: true,
        }),
        cache: "no-store",
      },
    ));
    if (!response.ok) throw await responseError(response, "Report submission failed");
    return response.json() as Promise<ReplaySubmitResult>;
  }

  private async persistAndUpload(pending: PendingSubmission): Promise<void> {
    try {
      await this.timed("indexeddb", () => this.persistence.set(PENDING_KEY, pending));
      await this.uploadPending(pending);
    } catch (cause) {
      this.progress({
        phase: "failed",
        completed: 0,
        total: 0,
        bytesUploaded: 0,
        bytesTotal: 0,
        reference: pending.reportResult.reference,
        message: cause instanceof Error ? cause.message : "Replay upload will retry",
      });
      this.scheduleRetry();
    }
  }

  private startBackgroundUpload(pending: PendingSubmission): void {
    const upload = this.persistAndUpload(pending).finally(() => {
      if (this.retryInFlight === upload) this.retryInFlight = undefined;
    });
    this.retryInFlight = upload;
  }

  private async resumePending(): Promise<void> {
    const stored = await this.persistence.get<PendingSubmission | LegacyPendingSubmission>(PENDING_KEY);
    if (!stored) return;
    this.submissionActive = true;
    const pending = "reportResult" in stored ? stored : await this.migrateLegacyPending(stored);
    if (pending.createdAt + MAX_PENDING_AGE <= Date.now()) {
      await this.persistence.removeChunks(pending.idempotencyKey);
      await this.persistence.remove(PENDING_KEY);
      this.submissionActive = false;
      return;
    }
    await this.uploadPending(pending);
  }

  private async migrateLegacyPending(legacy: LegacyPendingSubmission): Promise<PendingSubmission> {
    let bootstrap = legacy.bootstrap;
    if (!bootstrap || bootstrap.expiresAt <= Date.now()) {
      bootstrap = await this.timed("session", () => this.configuration.createSession(
        this.bootstrapRequest(legacy.idempotencyKey, legacy.startedAt),
      ));
    }
    const reportResult = await this.createReport(
      { idempotencyKey: legacy.idempotencyKey, bootstrap },
      legacy.report,
      legacy.startedAt,
    );
    const events = legacy.payload.events;
    const segment: ReplaySegment = {
      id: `legacy-${legacy.idempotencyKey}`,
      startedAt: events[0]?.timestamp ?? legacy.startedAt,
      endedAt: events.at(-1)?.timestamp ?? legacy.startedAt,
      bytes: events.reduce((sum, event) => sum + JSON.stringify(event).length, 0),
      imageBytes: 0,
      events,
    };
    const pending: PendingSubmission = {
      createdAt: legacy.createdAt,
      idempotencyKey: legacy.idempotencyKey,
      startedAt: legacy.startedAt,
      report: legacy.report,
      bootstrap,
      reportResult,
      segmentIds: [],
      activeSegments: [segment],
      semantic: legacy.payload.semantic,
      timings: [...this.recentTimings],
    };
    await this.persistence.set(PENDING_KEY, pending);
    return pending;
  }

  private retryPending(): Promise<void> {
    if (this.retryInFlight) return this.retryInFlight;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryInFlight = this.resumePending()
      .then(() => {
        this.retryAttempt = 0;
      })
      .catch(() => {
        this.scheduleRetry();
      })
      .finally(() => {
        this.retryInFlight = undefined;
      });
    return this.retryInFlight;
  }

  private scheduleRetry(): void {
    if (!this.started || this.retryTimer) return;
    const delays = [2_000, 5_000, 15_000, 30_000, 60_000, 300_000];
    const delay = delays[Math.min(this.retryAttempt, delays.length - 1)] ?? 300_000;
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.retryPending();
    }, delay);
  }

  private async uploadPending(pending: PendingSubmission): Promise<void> {
    this.activeTimings = pending.timings;
    const { chunks, assets } = await this.prepareUpload(pending);
    const missingAssets = await this.negotiateAssets(pending, assets);
    const totalBytes = encodedBytesFromChunks(chunks) +
      missingAssets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0);
    let uploadedBytes = chunks.filter((chunk) => chunk.uploaded)
      .reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
    let uploadedItems = chunks.filter((chunk) => chunk.uploaded).length;
    const totalItems = chunks.length + missingAssets.length;
    this.progress({
      phase: "uploading",
      completed: uploadedItems,
      total: totalItems,
      bytesUploaded: uploadedBytes,
      bytesTotal: totalBytes,
      reference: pending.reportResult.reference,
    });

    const remaining: Array<
      { type: "chunk"; value: PersistedReplayChunk } | { type: "asset"; value: PersistedReplayAsset }
    > = [
      ...missingAssets.map((asset) => ({ type: "asset" as const, value: asset })),
      ...chunks.filter((chunk) => !chunk.uploaded).map((chunk) => ({ type: "chunk" as const, value: chunk })),
    ];
    let cursor = 0;
    const uploadNext = async (): Promise<void> => {
      while (cursor < remaining.length) {
        const item = remaining[cursor++];
        if (!item) return;
        if (item.type === "asset") {
          await this.uploadAsset(pending, item.value);
        } else {
          await this.uploadChunk(pending, item.value);
          await this.timed(
            "indexeddb",
            () => this.persistence.markChunkUploaded(item.value.key),
            item.value.bytes.byteLength,
          );
        }
        uploadedBytes += item.value.bytes.byteLength;
        uploadedItems += 1;
        this.progress({
          phase: "uploading",
          completed: uploadedItems,
          total: totalItems,
          bytesUploaded: uploadedBytes,
          bytesTotal: totalBytes,
          reference: pending.reportResult.reference,
        });
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(UPLOAD_CONCURRENCY, remaining.length) },
      () => uploadNext(),
    ));

    this.progress({
      phase: "processing",
      completed: totalItems,
      total: totalItems,
      bytesUploaded: totalBytes,
      bytesTotal: totalBytes,
      reference: pending.reportResult.reference,
    });
    const durationMs = Math.min(30 * 60_000, Math.max(0, Date.now() - pending.startedAt));
    const response = await this.timed("completion", () => fetch(
      `${this.endpoint}/v1/sessions/${pending.bootstrap.sessionId}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pending.bootstrap.capability}`,
          "Content-Type": "application/json",
          "Idempotency-Key": pending.idempotencyKey,
        },
        body: JSON.stringify({
          durationMs,
          finalChunkCount: chunks.length,
          clientTimings: pending.timings.slice(-100),
        }),
        cache: "no-store",
      },
    ));
    if (!response.ok) throw await responseError(response, "Replay completion failed");
    await this.timed("indexeddb", async () => {
      await this.persistence.removeChunks(pending.idempotencyKey);
      await this.persistence.remove(PENDING_KEY);
    });
    this.progress({
      phase: "complete",
      completed: totalItems,
      total: totalItems,
      bytesUploaded: totalBytes,
      bytesTotal: totalBytes,
      reference: pending.reportResult.reference,
    });
    this.submissionActive = false;
    this.activeTimings = undefined;
  }

  private async prepareUpload(pending: PendingSubmission): Promise<{
    chunks: Array<PersistedReplayChunk>;
    assets: Array<PersistedReplayAsset>;
  }> {
    const existing = await this.timed("indexeddb", () => this.persistence.getChunks(pending.idempotencyKey));
    if (existing.length) {
      return { chunks: existing, assets: await this.resolveAssets(pending.assetHashes ?? []) };
    }
    const maximumChunkBytes = Math.min(
      DEFAULT_MAX_CHUNK_BYTES,
      Math.floor(pending.bootstrap.policy.maxChunkBytes * 0.9),
    );
    const captureSegments: Array<PersistedCaptureSegment> = [];
    for (const id of pending.segmentIds) {
      const segment = await this.resolveCaptureSegment(id);
      if (segment) captureSegments.push(segment);
    }
    for (const segment of pending.activeSegments) {
      captureSegments.push(await this.encodeSegment(segment, maximumChunkBytes));
    }
    const semanticChunks: Array<EncodedReplayChunk> = [];
    for (const group of groupSemantic(pending.semantic)) {
      const encoded = await this.encoder.encode(
        [], group, pending.startedAt, maximumChunkBytes, this.assetOptions(pending.bootstrap),
      );
      semanticChunks.push(...encoded.chunks);
    }
    let assets = await this.resolveAssets(assetHashes(captureSegments));
    const maximumAssetTotal = pending.bootstrap.policy.maxAssetTotalBytes ?? DEFAULT_MAX_ASSET_TOTAL_BYTES;
    const maximumAssetCount = pending.bootstrap.policy.maxAssetCount ?? DEFAULT_MAX_ASSET_COUNT;
    while (
      captureSegments.length > 1 &&
      (encodedBytes(captureSegments, semanticChunks) + assetBytes(assets) > pending.bootstrap.policy.maxSessionBytes ||
        assetBytes(assets) > maximumAssetTotal || assets.length > maximumAssetCount)
    ) {
      captureSegments.shift();
      assets = await this.resolveAssets(assetHashes(captureSegments));
    }
    if (encodedBytes(captureSegments, semanticChunks) + assetBytes(assets) > pending.bootstrap.policy.maxSessionBytes ||
      assetBytes(assets) > maximumAssetTotal || assets.length > maximumAssetCount) {
      throw new Error("Replay exceeds the server byte budget");
    }

    const chunks: Array<PersistedReplayChunk> = [];
    for (const segment of captureSegments) {
      const baseOffset = Math.max(0, segment.startedAt - pending.startedAt);
      for (const encoded of segment.chunks) {
        chunks.push(toPersistedChunk(pending.idempotencyKey, chunks.length, encoded, baseOffset));
      }
    }
    for (const encoded of semanticChunks) {
      chunks.push(toPersistedChunk(pending.idempotencyKey, chunks.length, encoded, 0));
    }
    if (!chunks.length) {
      const { chunks: [empty] } = await this.encoder.encode(
        [], [], pending.startedAt, maximumChunkBytes, this.assetOptions(pending.bootstrap),
      );
      if (!empty) throw new Error("Replay encoding returned no chunks");
      chunks.push(toPersistedChunk(pending.idempotencyKey, 0, empty, 0));
    }
    pending.assetHashes = assets.map((asset) => asset.sha256);
    await this.timed("indexeddb", () => this.persistence.set(PENDING_KEY, pending));
    await this.timed(
      "indexeddb",
      () => Promise.all(chunks.map((chunk) => this.persistence.setChunk(chunk))).then(() => undefined),
      encodedBytesFromChunks(chunks),
    );
    pending.activeSegments = [];
    pending.semantic = [];
    await this.timed("indexeddb", () => this.persistence.set(PENDING_KEY, pending));
    return { chunks, assets };
  }

  private async negotiateAssets(
    pending: PendingSubmission,
    assets: Array<PersistedReplayAsset>,
  ): Promise<Array<PersistedReplayAsset>> {
    const response = await fetch(`${this.endpoint}/v1/sessions/${pending.bootstrap.sessionId}/assets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pending.bootstrap.capability}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ assets: assets.map((asset) => ({
        sha256: asset.sha256,
        bytes: asset.bytes.byteLength,
        contentType: asset.contentType,
      })) }),
      cache: "no-store",
    });
    if (!response.ok) throw await responseError(response, "Replay asset negotiation failed");
    const body = await response.json() as { missing?: Array<string> };
    const missing = new Set(body.missing ?? []);
    return assets.filter((asset) => missing.has(asset.sha256));
  }

  private async uploadAsset(pending: PendingSubmission, asset: PersistedReplayAsset): Promise<void> {
    const started = performance.now();
    const response = await fetch(
      `${this.endpoint}/v1/sessions/${pending.bootstrap.sessionId}/assets/${asset.sha256}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${pending.bootstrap.capability}`,
          "Content-Type": asset.contentType,
          "X-Replay-SHA256": asset.sha256,
        },
        body: asset.bytes.buffer.slice(
          asset.bytes.byteOffset,
          asset.bytes.byteOffset + asset.bytes.byteLength,
        ) as ArrayBuffer,
        cache: "no-store",
      },
    );
    this.telemetry({
      phase: "network",
      durationMs: performance.now() - started,
      bytes: asset.bytes.byteLength,
    });
    if (!response.ok) throw await responseError(response, "Replay asset upload failed");
  }

  private async uploadChunk(pending: PendingSubmission, chunk: PersistedReplayChunk): Promise<void> {
    const started = performance.now();
    const response = await fetch(`${this.endpoint}/v1/sessions/${pending.bootstrap.sessionId}/chunks/${chunk.sequence}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${pending.bootstrap.capability}`,
        "Content-Type": "application/json",
        ...(chunk.encoding ? { "Content-Encoding": chunk.encoding } : {}),
        "Idempotency-Key": `${pending.idempotencyKey}-${chunk.sequence}`,
        "X-Replay-SHA256": chunk.sha256,
        "X-Replay-Kind": "events",
        "X-Replay-Sequence": String(chunk.sequence),
        "X-Replay-Start-Ms": String(chunk.startOffsetMs),
        "X-Replay-End-Ms": String(chunk.endOffsetMs),
        "X-Replay-Event-Count": String(chunk.eventCount),
      },
      body: chunk.bytes.buffer.slice(
        chunk.bytes.byteOffset,
        chunk.bytes.byteOffset + chunk.bytes.byteLength,
      ) as ArrayBuffer,
      cache: "no-store",
    });
    this.telemetry({
      phase: "network",
      durationMs: performance.now() - started,
      bytes: chunk.bytes.byteLength,
      chunkSequence: chunk.sequence,
    });
    if (!response.ok) throw await responseError(response, "Replay chunk upload failed");
  }

  private recordEvent(event: eventWithTime, checkout: boolean): void {
    const mutation = this.ring.addEvent(event, checkout);
    if (mutation.sealed) {
      this.sealedSegmentIds.add(mutation.sealed.id);
      void this.persistCaptureSegment(mutation.sealed).catch(() => {
        this.sealedSegmentIds.delete(mutation.sealed?.id ?? "");
        this.segmentJobs.delete(mutation.sealed?.id ?? "");
      });
    }
    this.removeEvictedSegments(mutation.evictedIds);
  }

  private addSemantic(event: SemanticEvent): void {
    this.removeEvictedSegments(this.ring.addSemantic(event));
  }

  private removeEvictedSegments(ids: Array<string>): void {
    for (const id of ids) {
      this.sealedSegmentIds.delete(id);
      this.segmentJobs.delete(id);
      void this.persistence.removeCapture(id);
    }
  }

  private persistCaptureSegment(segment: ReplaySegment): Promise<PersistedCaptureSegment> {
    const existing = this.segmentJobs.get(segment.id);
    if (existing) return existing;
    const job = this.encodeSegment(segment, DEFAULT_MAX_CHUNK_BYTES).then(async (encoded) => {
      await this.timed("indexeddb", () => this.persistence.setCapture(segment.id, encoded));
      return encoded;
    });
    this.segmentJobs.set(segment.id, job);
    return job;
  }

  private async resolveCaptureSegment(id: string): Promise<PersistedCaptureSegment | null> {
    const job = this.segmentJobs.get(id);
    if (job) return job;
    return this.timed("indexeddb", () => this.persistence.getCapture<PersistedCaptureSegment>(id));
  }

  private async encodeSegment(segment: ReplaySegment, maximumChunkBytes: number): Promise<PersistedCaptureSegment> {
    const encoded = await this.encoder.encode(
      segment.events,
      [],
      segment.startedAt,
      maximumChunkBytes,
      this.assetOptions(),
    );
    await Promise.all(encoded.assets.map(async (asset) => {
      const persisted = { sha256: asset.sha256, bytes: asset.bytes, contentType: asset.contentType };
      this.assetCache.set(asset.sha256, persisted);
      await this.persistence.setAsset(persisted);
    }));
    return {
      id: segment.id,
      startedAt: segment.startedAt,
      endedAt: segment.endedAt,
      chunks: encoded.chunks,
      assetHashes: encoded.assets.map((asset) => asset.sha256),
    };
  }

  private assetOptions(bootstrap?: SessionBootstrap) {
    return {
      baseUrl: typeof window === "undefined" ? "https://invalid.local/" : window.location.href,
      maximumAssetBytes: bootstrap?.policy.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES,
      maximumTotalBytes: bootstrap?.policy.maxAssetTotalBytes ?? DEFAULT_MAX_ASSET_TOTAL_BYTES,
      maximumAssetCount: bootstrap?.policy.maxAssetCount ?? DEFAULT_MAX_ASSET_COUNT,
    };
  }

  private async resolveAssets(hashes: Array<string>): Promise<Array<PersistedReplayAsset>> {
    const unique = [...new Set(hashes)];
    const persisted = await this.persistence.getAssets(unique.filter((hash) => !this.assetCache.has(hash)));
    for (const asset of persisted) this.assetCache.set(asset.sha256, asset);
    const resolved = unique.map((hash) => this.assetCache.get(hash)).filter(
      (asset): asset is PersistedReplayAsset => asset !== undefined,
    );
    if (resolved.length !== unique.length) throw new Error("Captured replay assets are unavailable");
    return resolved;
  }

  private installSemanticEvents(): () => void {
    const click = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target : null;
      this.semantic({
        type: "interaction",
        action: "click",
        target: element?.getAttribute("data-testid") ?? element?.id ?? element?.tagName.toLowerCase() ?? "unknown",
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
      });
    };
    const input = (event: Event) => {
      const element = event.target instanceof Element ? event.target : null;
      this.semantic({
        type: "input",
        change: event.type,
        target: element?.getAttribute("name") ?? element?.id ?? element?.tagName.toLowerCase() ?? "unknown",
      });
    };
    const error = (event: ErrorEvent) => this.semantic({
      type: "error",
      name: event.error instanceof Error ? event.error.name : "Error",
      message: String(event.message).slice(0, 2_000),
    });
    const visibility = () => this.semantic({ type: "lifecycle", state: document.visibilityState });
    window.addEventListener("click", click, true);
    window.addEventListener("focusin", input, true);
    window.addEventListener("change", input, true);
    window.addEventListener("focusout", input, true);
    window.addEventListener("error", error);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("click", click, true);
      window.removeEventListener("focusin", input, true);
      window.removeEventListener("change", input, true);
      window.removeEventListener("focusout", input, true);
      window.removeEventListener("error", error);
      document.removeEventListener("visibilitychange", visibility);
    };
  }

  private semantic(event: Omit<SemanticEvent, "offsetMs"> & { type: SemanticEvent["type"] }): void {
    if (!this.started) return;
    this.addSemantic({ ...event, offsetMs: Date.now() });
  }

  private progress(progress: ReplayProgress): void {
    this.configuration.onProgress?.(progress);
    for (const listener of this.progressListeners) listener(progress);
  }

  private telemetry(timing: ReplayTiming): void {
    this.configuration.onTelemetry?.(timing);
    this.recentTimings.push(timing);
    if (this.recentTimings.length > 100) this.recentTimings.splice(0, this.recentTimings.length - 100);
    this.activeTimings?.push(timing);
    if (this.activeTimings && this.activeTimings.length > 100) {
      this.activeTimings.splice(0, this.activeTimings.length - 100);
    }
  }

  private async timed<T>(phase: ReplayTiming["phase"], operation: () => Promise<T>, bytes?: number): Promise<T> {
    const started = performance.now();
    try {
      return await operation();
    } finally {
      this.telemetry({ phase, durationMs: performance.now() - started, bytes });
    }
  }
}

function randomKey(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function groupSemantic(events: Array<SemanticEvent>): Array<Array<SemanticEvent>> {
  const groups: Array<Array<SemanticEvent>> = [];
  let current: Array<SemanticEvent> = [];
  let bytes = 0;
  for (const event of events) {
    const size = JSON.stringify(event).length;
    if (current.length && bytes + size > 2 * 1_024 * 1_024) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += size;
  }
  if (current.length) groups.push(current);
  return groups;
}

function encodedBytes(segments: Array<PersistedCaptureSegment>, semantic: Array<EncodedReplayChunk>): number {
  return segments.reduce(
    (sum, segment) => sum + segment.chunks.reduce((chunkSum, chunk) => chunkSum + chunk.bytes.byteLength, 0),
    semantic.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0),
  );
}

function assetHashes(segments: Array<PersistedCaptureSegment>): Array<string> {
  return [...new Set(segments.flatMap((segment) => segment.assetHashes ?? []))];
}

function assetBytes(assets: Array<PersistedReplayAsset>): number {
  return assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0);
}

function encodedBytesFromChunks(chunks: Array<PersistedReplayChunk>): number {
  return chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
}

function toPersistedChunk(
  submissionKey: string,
  sequence: number,
  chunk: EncodedReplayChunk,
  baseOffset: number,
): PersistedReplayChunk {
  return {
    key: `${submissionKey}:${sequence}`,
    submissionKey,
    sequence,
    bytes: chunk.bytes,
    encoding: chunk.encoding,
    sha256: chunk.sha256,
    startOffsetMs: baseOffset + chunk.startOffsetMs,
    endOffsetMs: baseOffset + chunk.endOffsetMs,
    eventCount: chunk.eventCount,
    uploaded: false,
  };
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return new Error(body.error?.message || fallback);
  } catch {
    return new Error(fallback);
  }
}

export function createNukeReplay(configuration: NukeReplayConfiguration): NukeReplayClient {
  return new NukeReplayClient(configuration);
}
