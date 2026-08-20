import type { eventWithTime } from "@rrweb/types";
import { installNetworkCapture } from "./network";
import { ReplayPersistence } from "./persistence";
import { ReplayRingBuffer } from "./ring-buffer";
import type {
  NukeReplayConfiguration,
  ReplayChunkPayload,
  ReplayProject,
  ReplayReportInput,
  ReplaySubmitResult,
  SemanticEvent,
  SessionBootstrap,
  SessionBootstrapRequest,
} from "./types";

const SDK_VERSION = "0.1.3";
const PENDING_KEY = "pending-report";
const MAX_PENDING_AGE = 24 * 60 * 60 * 1_000;

interface EncodedChunk {
  bytes: Uint8Array;
  encoding: "gzip" | null;
  sha256: string;
  startOffsetMs: number;
  endOffsetMs: number;
  eventCount: number;
}

interface PendingSubmission {
  createdAt: number;
  idempotencyKey: string;
  startedAt: number;
  report: ReplayReportInput;
  payload: ReplayChunkPayload;
  bootstrap?: SessionBootstrap;
}

type OpenListener = (open: boolean) => void;

export class NukeReplayClient {
  private readonly ring: ReplayRingBuffer;
  private readonly persistence = new ReplayPersistence();
  private readonly listeners = new Set<OpenListener>();
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

  constructor(readonly configuration: NukeReplayConfiguration) {
    this.ring = new ReplayRingBuffer(
      (configuration.history?.maxMinutes ?? 30) * 60_000,
      configuration.history?.maxBytes ?? 75 * 1_024 * 1_024,
    );
  }

  async start(): Promise<void> {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    const epoch = ++this.lifecycleEpoch;
    const { record } = await import("rrweb");
    if (!this.started || epoch !== this.lifecycleEpoch) return;
    this.stopRecorder = record({
      emit: (event, checkout) => this.ring.addEvent(event, checkout ?? false),
      checkoutEveryNms: 60_000,
      blockClass: "nuke-replay-block",
      maskTextClass: "nuke-replay-mask",
      ignoreClass: "nuke-replay-ignore",
      recordCanvas: false,
    }) ?? undefined;
    this.cleanupNetwork = installNetworkCapture(this.configuration, (event) => this.ring.addSemantic(event));
    this.cleanupEvents = this.installSemanticEvents();
    this.onlineListener = () => void this.retryPending();
    window.addEventListener("online", this.onlineListener);
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
    this.listeners.clear();
    this.ring.clear();
  }

  openReporter(): void {
    for (const listener of this.listeners) listener(true);
  }

  closeReporter(): void {
    for (const listener of this.listeners) listener(false);
  }

  subscribe(listener: OpenListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    const bootstrap = await this.configuration.createSession(this.bootstrapRequest(idempotencyKey, startedAt));
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
    const selected = this.ring.select(report.historyMinutes);
    const pending: PendingSubmission = {
      createdAt: Date.now(),
      idempotencyKey: this.prepared?.idempotencyKey ?? randomKey(),
      startedAt: selected.startedAt,
      report,
      payload: {
        events: selected.events,
        semantic: selected.semantic.map((event) => ({
          ...event,
          offsetMs: Math.max(0, event.offsetMs - selected.startedAt),
        })),
      },
      bootstrap: this.prepared?.bootstrap,
    };
    this.prepared = undefined;
    await this.persistence.set(PENDING_KEY, pending);
    try {
      return await this.uploadPending(pending);
    } catch (error) {
      this.scheduleRetry();
      throw error;
    }
  }

  async clearForAccountChange(): Promise<void> {
    this.prepared = undefined;
    this.ring.clear();
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

  private async resumePending(): Promise<void> {
    const pending = await this.persistence.get<PendingSubmission>(PENDING_KEY);
    if (!pending) return;
    if (pending.createdAt + MAX_PENDING_AGE <= Date.now()) {
      await this.persistence.remove(PENDING_KEY);
      return;
    }
    await this.uploadPending(pending);
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

  private async uploadPending(pending: PendingSubmission): Promise<ReplaySubmitResult> {
    this.progress("preparing", 0, 1);
    if (!pending.bootstrap || pending.bootstrap.expiresAt <= Date.now()) {
      pending.bootstrap = await this.configuration.createSession(
        this.bootstrapRequest(pending.idempotencyKey, pending.startedAt),
      );
      await this.persistence.set(PENDING_KEY, pending);
    }
    const chunks = await encodeChunks(pending.payload, pending.startedAt);
    const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
    if (totalBytes > pending.bootstrap.policy.maxSessionBytes) throw new Error("Replay exceeds the server byte budget");
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) continue;
      this.progress("uploading", index, chunks.length);
      const response = await fetch(`${this.endpoint}/v1/sessions/${pending.bootstrap.sessionId}/chunks/${index}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${pending.bootstrap.capability}`,
          "Content-Type": "application/json",
          ...(chunk.encoding ? { "Content-Encoding": chunk.encoding } : {}),
          "Idempotency-Key": `${pending.idempotencyKey}-${index}`,
          "X-Replay-SHA256": chunk.sha256,
          "X-Replay-Kind": "events",
          "X-Replay-Sequence": String(index),
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
      if (!response.ok) throw await responseError(response, "Replay chunk upload failed");
    }
    this.progress("submitting", chunks.length, chunks.length);
    const durationMs = Math.min(
      30 * 60_000,
      Math.max(0, Date.now() - pending.startedAt),
    );
    const response = await fetch(`${this.endpoint}/v1/sessions/${pending.bootstrap.sessionId}/report`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pending.bootstrap.capability}`,
        "Content-Type": "application/json",
        "Idempotency-Key": pending.idempotencyKey,
      },
      body: JSON.stringify({
        ...pending.report,
        priority: pending.report.priority ?? "medium",
        pageUrl: pending.report.pageUrl ?? window.location.href,
        durationMs,
        finalChunkCount: chunks.length,
      }),
      cache: "no-store",
    });
    if (!response.ok) throw await responseError(response, "Report submission failed");
    const result = (await response.json()) as ReplaySubmitResult;
    await this.persistence.remove(PENDING_KEY);
    this.progress("complete", chunks.length, chunks.length);
    return result;
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

  private semantic(
    event: Omit<SemanticEvent, "offsetMs"> & { type: SemanticEvent["type"] },
  ): void {
    if (!this.started) return;
    this.ring.addSemantic({ ...event, offsetMs: Date.now() });
  }

  private progress(phase: "preparing" | "uploading" | "submitting" | "complete", completed: number, total: number): void {
    this.configuration.onProgress?.({ phase, completed, total });
  }
}

function randomKey(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

async function encodeChunks(payload: ReplayChunkPayload, startedAt: number): Promise<Array<EncodedChunk>> {
  const groups: Array<Array<eventWithTime>> = [];
  let current: Array<eventWithTime> = [];
  let bytes = 0;
  for (const event of payload.events) {
    const eventBytes = JSON.stringify(event).length;
    if (current.length && bytes + eventBytes > 350 * 1_024) {
      groups.push(current);
      current = [];
      bytes = 0;
    }
    current.push(event);
    bytes += eventBytes;
  }
  if (current.length || !groups.length) groups.push(current);

  return Promise.all(groups.map(async (events, index) => {
    const firstTimestamp = events[0]?.timestamp ?? startedAt;
    const lastTimestamp = events.at(-1)?.timestamp ?? firstTimestamp;
    const nextTimestamp = groups[index + 1]?.[0]?.timestamp ?? Number.POSITIVE_INFINITY;
    const semantic = payload.semantic.filter((event) => {
      const absolute = startedAt + event.offsetMs;
      return (index === 0 || absolute >= firstTimestamp) && absolute < nextTimestamp;
    });
    const semanticTimestamps = semantic.map((event) => startedAt + event.offsetMs);
    const chunkStartedAt = Math.min(firstTimestamp, ...semanticTimestamps);
    const chunkEndedAt = Math.max(lastTimestamp, ...semanticTimestamps);
    const raw = new TextEncoder().encode(JSON.stringify({ events, semantic } satisfies ReplayChunkPayload));
    const compressed = await compress(raw);
    return {
      bytes: compressed.bytes,
      encoding: compressed.encoding,
      sha256: await sha256(compressed.bytes),
      startOffsetMs: Math.max(0, chunkStartedAt - startedAt),
      endOffsetMs: Math.max(0, chunkEndedAt - startedAt),
      eventCount: events.length + semantic.length,
    };
  }));
}

async function compress(bytes: Uint8Array): Promise<{ bytes: Uint8Array; encoding: "gzip" | null }> {
  if (typeof CompressionStream === "undefined") return { bytes, encoding: null };
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), encoding: "gzip" };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
