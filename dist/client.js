import { installNetworkCapture } from "./network";
import { ReplayPersistence } from "./persistence";
import { ReplayRingBuffer } from "./ring-buffer";
const SDK_VERSION = "0.1.0";
const PENDING_KEY = "pending-report";
const MAX_PENDING_AGE = 24 * 60 * 60 * 1_000;
export class NukeReplayClient {
    configuration;
    ring;
    persistence = new ReplayPersistence();
    listeners = new Set();
    stopRecorder;
    cleanupNetwork;
    cleanupEvents;
    prepared;
    started = false;
    constructor(configuration) {
        this.configuration = configuration;
        this.ring = new ReplayRingBuffer((configuration.history?.maxMinutes ?? 30) * 60_000, configuration.history?.maxBytes ?? 75 * 1_024 * 1_024);
    }
    async start() {
        if (this.started || typeof window === "undefined")
            return;
        this.started = true;
        const { record } = await import("rrweb");
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
        await this.resumePending().catch(() => undefined);
    }
    stop() {
        this.stopRecorder?.();
        this.cleanupNetwork?.();
        this.cleanupEvents?.();
        this.started = false;
    }
    destroy() {
        this.stop();
        this.listeners.clear();
        this.ring.clear();
    }
    openReporter() {
        for (const listener of this.listeners)
            listener(true);
    }
    closeReporter() {
        for (const listener of this.listeners)
            listener(false);
    }
    subscribe(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    setContext(input) {
        if (input.route)
            this.semantic({ type: "navigation", name: input.route });
    }
    screen(name) {
        this.semantic({ type: "navigation", name });
    }
    async prepareReporter() {
        if (this.prepared && this.prepared.bootstrap.expiresAt > Date.now()) {
            return this.prepared.bootstrap;
        }
        const idempotencyKey = randomKey();
        const startedAt = Date.now();
        const bootstrap = await this.configuration.createSession(this.bootstrapRequest(idempotencyKey, startedAt));
        this.prepared = { idempotencyKey, bootstrap, startedAt };
        return bootstrap;
    }
    async cancelPrepared() {
        const prepared = this.prepared;
        this.prepared = undefined;
        if (!prepared)
            return;
        await fetch(`${this.endpoint}/v1/sessions/${prepared.bootstrap.sessionId}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${prepared.bootstrap.capability}` },
            cache: "no-store",
        }).catch(() => undefined);
    }
    async submit(report, includeReplay = true) {
        if (!includeReplay) {
            if (!this.configuration.submitDiagnostics) {
                throw new Error("Diagnostics-only reporting is not configured");
            }
            await this.cancelPrepared();
            return this.configuration.submitDiagnostics(report);
        }
        const selected = this.ring.select(report.historyMinutes);
        const pending = {
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
        return this.uploadPending(pending);
    }
    async clearForAccountChange() {
        this.prepared = undefined;
        this.ring.clear();
        await this.persistence.remove(PENDING_KEY);
    }
    get fallbackProjects() {
        return this.configuration.projectFallbacks ?? [];
    }
    get defaultProjectId() {
        return this.configuration.defaultProjectId ?? "all-in-challenge";
    }
    get endpoint() {
        return this.configuration.endpoint.replace(/\/+$/, "");
    }
    bootstrapRequest(idempotencyKey, startedAt) {
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
    async resumePending() {
        const pending = await this.persistence.get(PENDING_KEY);
        if (!pending)
            return;
        if (pending.createdAt + MAX_PENDING_AGE <= Date.now()) {
            await this.persistence.remove(PENDING_KEY);
            return;
        }
        await this.uploadPending(pending);
    }
    async uploadPending(pending) {
        this.progress("preparing", 0, 1);
        if (!pending.bootstrap || pending.bootstrap.expiresAt <= Date.now()) {
            pending.bootstrap = await this.configuration.createSession(this.bootstrapRequest(pending.idempotencyKey, pending.startedAt));
            await this.persistence.set(PENDING_KEY, pending);
        }
        const chunks = await encodeChunks(pending.payload, pending.startedAt);
        const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
        if (totalBytes > pending.bootstrap.policy.maxSessionBytes)
            throw new Error("Replay exceeds the server byte budget");
        for (let index = 0; index < chunks.length; index += 1) {
            const chunk = chunks[index];
            if (!chunk)
                continue;
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
                body: chunk.bytes.buffer.slice(chunk.bytes.byteOffset, chunk.bytes.byteOffset + chunk.bytes.byteLength),
                cache: "no-store",
            });
            if (!response.ok)
                throw await responseError(response, "Replay chunk upload failed");
        }
        this.progress("submitting", chunks.length, chunks.length);
        const durationMs = Math.min(30 * 60_000, Math.max(0, Date.now() - pending.startedAt));
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
        if (!response.ok)
            throw await responseError(response, "Report submission failed");
        const result = (await response.json());
        await this.persistence.remove(PENDING_KEY);
        this.progress("complete", chunks.length, chunks.length);
        return result;
    }
    installSemanticEvents() {
        const click = (event) => {
            const element = event.target instanceof Element ? event.target : null;
            this.semantic({
                type: "interaction",
                action: "click",
                target: element?.getAttribute("data-testid") ?? element?.id ?? element?.tagName.toLowerCase() ?? "unknown",
                x: Math.round(event.clientX),
                y: Math.round(event.clientY),
            });
        };
        const input = (event) => {
            const element = event.target instanceof Element ? event.target : null;
            this.semantic({
                type: "input",
                change: event.type,
                target: element?.getAttribute("name") ?? element?.id ?? element?.tagName.toLowerCase() ?? "unknown",
            });
        };
        const error = (event) => this.semantic({
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
    semantic(event) {
        this.ring.addSemantic({ ...event, offsetMs: Date.now() });
    }
    progress(phase, completed, total) {
        this.configuration.onProgress?.({ phase, completed, total });
    }
}
function randomKey() {
    return crypto.randomUUID().replaceAll("-", "");
}
async function encodeChunks(payload, startedAt) {
    const groups = [];
    let current = [];
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
    if (current.length || !groups.length)
        groups.push(current);
    return Promise.all(groups.map(async (events, index) => {
        const firstTimestamp = events[0]?.timestamp ?? startedAt;
        const lastTimestamp = events.at(-1)?.timestamp ?? firstTimestamp;
        const semantic = payload.semantic.filter((event) => {
            const absolute = startedAt + event.offsetMs;
            return absolute >= firstTimestamp && absolute <= lastTimestamp;
        });
        const raw = new TextEncoder().encode(JSON.stringify({ events, semantic }));
        const compressed = await compress(raw);
        return {
            bytes: compressed.bytes,
            encoding: compressed.encoding,
            sha256: await sha256(compressed.bytes),
            startOffsetMs: Math.max(0, firstTimestamp - startedAt),
            endOffsetMs: Math.max(0, lastTimestamp - startedAt),
            eventCount: events.length + semantic.length + (index === 0 ? 0 : 0),
        };
    }));
}
async function compress(bytes) {
    if (typeof CompressionStream === "undefined")
        return { bytes, encoding: null };
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
    return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), encoding: "gzip" };
}
async function sha256(bytes) {
    const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const digest = await crypto.subtle.digest("SHA-256", input);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function responseError(response, fallback) {
    try {
        const body = await response.json();
        return new Error(body.error?.message || fallback);
    }
    catch {
        return new Error(fallback);
    }
}
export function createNukeReplay(configuration) {
    return new NukeReplayClient(configuration);
}
//# sourceMappingURL=client.js.map