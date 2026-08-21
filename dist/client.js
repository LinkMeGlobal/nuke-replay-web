import { installNetworkCapture } from "./network";
import { ReplayPersistence, } from "./persistence";
import { ReplayRingBuffer } from "./ring-buffer";
import { ReplaySegmentEncoder } from "./segment-encoder";
const SDK_VERSION = "0.3.0";
const PENDING_KEY = "pending-report";
const MAX_PENDING_AGE = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_CHUNK_BYTES = Math.floor(1.5 * 1_024 * 1_024);
const UPLOAD_CONCURRENCY = 4;
const DEFAULT_MAX_ASSET_BYTES = 5 * 1_024 * 1_024;
const DEFAULT_MAX_ASSET_TOTAL_BYTES = 24 * 1_024 * 1_024;
const DEFAULT_MAX_ASSET_COUNT = 256;
export class NukeReplayClient {
    configuration;
    ring;
    persistence = new ReplayPersistence();
    encoder;
    listeners = new Set();
    progressListeners = new Set();
    sealedSegmentIds = new Set();
    segmentJobs = new Map();
    recentTimings = [];
    assetCache = new Map();
    activeTimings;
    stopRecorder;
    cleanupNetwork;
    cleanupEvents;
    prepared;
    started = false;
    lifecycleEpoch = 0;
    retryAttempt = 0;
    retryTimer;
    retryInFlight;
    onlineListener;
    submissionActive = false;
    constructor(configuration) {
        this.configuration = configuration;
        const historyBytes = configuration.history?.maxBytes ?? 75 * 1_024 * 1_024;
        this.ring = new ReplayRingBuffer((configuration.history?.maxMinutes ?? 30) * 60_000, configuration.budgets?.domBytes ?? historyBytes, configuration.budgets?.imageBytes ?? 24 * 1_024 * 1_024, configuration.budgets?.semanticBytes ?? 12 * 1_024 * 1_024, configuration.budgets?.networkBodyBytes ?? 8 * 1_024 * 1_024);
        this.encoder = new ReplaySegmentEncoder((timing) => this.telemetry(timing));
    }
    async start() {
        if (this.started || typeof window === "undefined")
            return;
        this.started = true;
        const epoch = ++this.lifecycleEpoch;
        const { record } = await import("rrweb");
        if (!this.started || epoch !== this.lifecycleEpoch)
            return;
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
    stop() {
        this.lifecycleEpoch += 1;
        this.stopRecorder?.();
        this.cleanupNetwork?.();
        this.cleanupEvents?.();
        if (this.onlineListener)
            window.removeEventListener("online", this.onlineListener);
        if (this.retryTimer)
            clearTimeout(this.retryTimer);
        this.stopRecorder = undefined;
        this.cleanupNetwork = undefined;
        this.cleanupEvents = undefined;
        this.onlineListener = undefined;
        this.retryTimer = undefined;
        this.started = false;
    }
    destroy() {
        this.stop();
        this.encoder.destroy();
        this.listeners.clear();
        this.progressListeners.clear();
        this.ring.clear();
    }
    openReporter() {
        if (this.submissionActive)
            return;
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
    subscribeProgress(listener) {
        this.progressListeners.add(listener);
        return () => this.progressListeners.delete(listener);
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
        const bootstrap = await this.timed("session", () => this.configuration.createSession(this.bootstrapRequest(idempotencyKey, startedAt)));
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
        this.progress({ phase: "preparing", completed: 0, total: 0, bytesUploaded: 0, bytesTotal: 0 });
        const prepared = await this.ensurePrepared();
        const selected = this.ring.select(report.historyMinutes);
        const reportResult = await this.createReport(prepared, report, selected.startedAt);
        const segmentIds = [];
        const activeSegments = [];
        for (const segment of selected.segments) {
            if (this.sealedSegmentIds.has(segment.id))
                segmentIds.push(segment.id);
            else
                activeSegments.push(segment);
        }
        const pending = {
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
    async clearForAccountChange() {
        this.prepared = undefined;
        this.submissionActive = false;
        this.ring.clear();
        const pending = await this.persistence.get(PENDING_KEY);
        if (pending)
            await this.persistence.removeChunks(pending.idempotencyKey);
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
    async ensurePrepared() {
        if (this.prepared?.bootstrap.expiresAt && this.prepared.bootstrap.expiresAt > Date.now()) {
            return this.prepared;
        }
        const idempotencyKey = this.prepared?.idempotencyKey ?? randomKey();
        const startedAt = this.prepared?.startedAt ?? Date.now();
        const bootstrap = await this.timed("session", () => this.configuration.createSession(this.bootstrapRequest(idempotencyKey, startedAt)));
        this.prepared = { idempotencyKey, bootstrap, startedAt };
        return this.prepared;
    }
    async createReport(prepared, report, startedAt) {
        const durationMs = Math.min(30 * 60_000, Math.max(0, Date.now() - startedAt));
        const response = await this.timed("report", () => fetch(`${this.endpoint}/v1/sessions/${prepared.bootstrap.sessionId}/report`, {
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
        }));
        if (!response.ok)
            throw await responseError(response, "Report submission failed");
        return response.json();
    }
    async persistAndUpload(pending) {
        try {
            await this.timed("indexeddb", () => this.persistence.set(PENDING_KEY, pending));
            await this.uploadPending(pending);
        }
        catch (cause) {
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
    startBackgroundUpload(pending) {
        const upload = this.persistAndUpload(pending).finally(() => {
            if (this.retryInFlight === upload)
                this.retryInFlight = undefined;
        });
        this.retryInFlight = upload;
    }
    async resumePending() {
        const stored = await this.persistence.get(PENDING_KEY);
        if (!stored)
            return;
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
    async migrateLegacyPending(legacy) {
        let bootstrap = legacy.bootstrap;
        if (!bootstrap || bootstrap.expiresAt <= Date.now()) {
            bootstrap = await this.timed("session", () => this.configuration.createSession(this.bootstrapRequest(legacy.idempotencyKey, legacy.startedAt)));
        }
        const reportResult = await this.createReport({ idempotencyKey: legacy.idempotencyKey, bootstrap }, legacy.report, legacy.startedAt);
        const events = legacy.payload.events;
        const segment = {
            id: `legacy-${legacy.idempotencyKey}`,
            startedAt: events[0]?.timestamp ?? legacy.startedAt,
            endedAt: events.at(-1)?.timestamp ?? legacy.startedAt,
            bytes: events.reduce((sum, event) => sum + JSON.stringify(event).length, 0),
            imageBytes: 0,
            events,
        };
        const pending = {
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
    retryPending() {
        if (this.retryInFlight)
            return this.retryInFlight;
        if (this.retryTimer)
            clearTimeout(this.retryTimer);
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
    scheduleRetry() {
        if (!this.started || this.retryTimer)
            return;
        const delays = [2_000, 5_000, 15_000, 30_000, 60_000, 300_000];
        const delay = delays[Math.min(this.retryAttempt, delays.length - 1)] ?? 300_000;
        this.retryAttempt += 1;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            void this.retryPending();
        }, delay);
    }
    async uploadPending(pending) {
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
        const remaining = [
            ...missingAssets.map((asset) => ({ type: "asset", value: asset })),
            ...chunks.filter((chunk) => !chunk.uploaded).map((chunk) => ({ type: "chunk", value: chunk })),
        ];
        let cursor = 0;
        const uploadNext = async () => {
            while (cursor < remaining.length) {
                const item = remaining[cursor++];
                if (!item)
                    return;
                if (item.type === "asset") {
                    await this.uploadAsset(pending, item.value);
                }
                else {
                    await this.uploadChunk(pending, item.value);
                    await this.timed("indexeddb", () => this.persistence.markChunkUploaded(item.value.key), item.value.bytes.byteLength);
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
        await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, remaining.length) }, () => uploadNext()));
        this.progress({
            phase: "processing",
            completed: totalItems,
            total: totalItems,
            bytesUploaded: totalBytes,
            bytesTotal: totalBytes,
            reference: pending.reportResult.reference,
        });
        const durationMs = Math.min(30 * 60_000, Math.max(0, Date.now() - pending.startedAt));
        const response = await this.timed("completion", () => fetch(`${this.endpoint}/v1/sessions/${pending.bootstrap.sessionId}/complete`, {
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
        }));
        if (!response.ok)
            throw await responseError(response, "Replay completion failed");
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
    async prepareUpload(pending) {
        const existing = await this.timed("indexeddb", () => this.persistence.getChunks(pending.idempotencyKey));
        if (existing.length) {
            return { chunks: existing, assets: await this.resolveAssets(pending.assetHashes ?? []) };
        }
        const maximumChunkBytes = Math.min(DEFAULT_MAX_CHUNK_BYTES, Math.floor(pending.bootstrap.policy.maxChunkBytes * 0.9));
        const captureSegments = [];
        for (const id of pending.segmentIds) {
            const segment = await this.resolveCaptureSegment(id);
            if (segment)
                captureSegments.push(segment);
        }
        for (const segment of pending.activeSegments) {
            captureSegments.push(await this.encodeSegment(segment, maximumChunkBytes));
        }
        const semanticChunks = [];
        for (const group of groupSemantic(pending.semantic)) {
            const encoded = await this.encoder.encode([], group, pending.startedAt, maximumChunkBytes, this.assetOptions(pending.bootstrap));
            semanticChunks.push(...encoded.chunks);
        }
        let assets = await this.resolveAssets(assetHashes(captureSegments));
        const maximumAssetTotal = pending.bootstrap.policy.maxAssetTotalBytes ?? DEFAULT_MAX_ASSET_TOTAL_BYTES;
        const maximumAssetCount = pending.bootstrap.policy.maxAssetCount ?? DEFAULT_MAX_ASSET_COUNT;
        while (captureSegments.length > 1 &&
            (encodedBytes(captureSegments, semanticChunks) + assetBytes(assets) > pending.bootstrap.policy.maxSessionBytes ||
                assetBytes(assets) > maximumAssetTotal || assets.length > maximumAssetCount)) {
            captureSegments.shift();
            assets = await this.resolveAssets(assetHashes(captureSegments));
        }
        if (encodedBytes(captureSegments, semanticChunks) + assetBytes(assets) > pending.bootstrap.policy.maxSessionBytes ||
            assetBytes(assets) > maximumAssetTotal || assets.length > maximumAssetCount) {
            throw new Error("Replay exceeds the server byte budget");
        }
        const chunks = [];
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
            const { chunks: [empty] } = await this.encoder.encode([], [], pending.startedAt, maximumChunkBytes, this.assetOptions(pending.bootstrap));
            if (!empty)
                throw new Error("Replay encoding returned no chunks");
            chunks.push(toPersistedChunk(pending.idempotencyKey, 0, empty, 0));
        }
        pending.assetHashes = assets.map((asset) => asset.sha256);
        await this.timed("indexeddb", () => this.persistence.set(PENDING_KEY, pending));
        await this.timed("indexeddb", () => Promise.all(chunks.map((chunk) => this.persistence.setChunk(chunk))).then(() => undefined), encodedBytesFromChunks(chunks));
        pending.activeSegments = [];
        pending.semantic = [];
        await this.timed("indexeddb", () => this.persistence.set(PENDING_KEY, pending));
        return { chunks, assets };
    }
    async negotiateAssets(pending, assets) {
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
        if (!response.ok)
            throw await responseError(response, "Replay asset negotiation failed");
        const body = await response.json();
        const missing = new Set(body.missing ?? []);
        return assets.filter((asset) => missing.has(asset.sha256));
    }
    async uploadAsset(pending, asset) {
        const started = performance.now();
        const response = await fetch(`${this.endpoint}/v1/sessions/${pending.bootstrap.sessionId}/assets/${asset.sha256}`, {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${pending.bootstrap.capability}`,
                "Content-Type": asset.contentType,
                "X-Replay-SHA256": asset.sha256,
            },
            body: asset.bytes.buffer.slice(asset.bytes.byteOffset, asset.bytes.byteOffset + asset.bytes.byteLength),
            cache: "no-store",
        });
        this.telemetry({
            phase: "network",
            durationMs: performance.now() - started,
            bytes: asset.bytes.byteLength,
        });
        if (!response.ok)
            throw await responseError(response, "Replay asset upload failed");
    }
    async uploadChunk(pending, chunk) {
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
            body: chunk.bytes.buffer.slice(chunk.bytes.byteOffset, chunk.bytes.byteOffset + chunk.bytes.byteLength),
            cache: "no-store",
        });
        this.telemetry({
            phase: "network",
            durationMs: performance.now() - started,
            bytes: chunk.bytes.byteLength,
            chunkSequence: chunk.sequence,
        });
        if (!response.ok)
            throw await responseError(response, "Replay chunk upload failed");
    }
    recordEvent(event, checkout) {
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
    addSemantic(event) {
        this.removeEvictedSegments(this.ring.addSemantic(event));
    }
    removeEvictedSegments(ids) {
        for (const id of ids) {
            this.sealedSegmentIds.delete(id);
            this.segmentJobs.delete(id);
            void this.persistence.removeCapture(id);
        }
    }
    persistCaptureSegment(segment) {
        const existing = this.segmentJobs.get(segment.id);
        if (existing)
            return existing;
        const job = this.encodeSegment(segment, DEFAULT_MAX_CHUNK_BYTES).then(async (encoded) => {
            await this.timed("indexeddb", () => this.persistence.setCapture(segment.id, encoded));
            return encoded;
        });
        this.segmentJobs.set(segment.id, job);
        return job;
    }
    async resolveCaptureSegment(id) {
        const job = this.segmentJobs.get(id);
        if (job)
            return job;
        return this.timed("indexeddb", () => this.persistence.getCapture(id));
    }
    async encodeSegment(segment, maximumChunkBytes) {
        const encoded = await this.encoder.encode(segment.events, [], segment.startedAt, maximumChunkBytes, this.assetOptions());
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
    assetOptions(bootstrap) {
        return {
            baseUrl: typeof window === "undefined" ? "https://invalid.local/" : window.location.href,
            maximumAssetBytes: bootstrap?.policy.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES,
            maximumTotalBytes: bootstrap?.policy.maxAssetTotalBytes ?? DEFAULT_MAX_ASSET_TOTAL_BYTES,
            maximumAssetCount: bootstrap?.policy.maxAssetCount ?? DEFAULT_MAX_ASSET_COUNT,
        };
    }
    async resolveAssets(hashes) {
        const unique = [...new Set(hashes)];
        const persisted = await this.persistence.getAssets(unique.filter((hash) => !this.assetCache.has(hash)));
        for (const asset of persisted)
            this.assetCache.set(asset.sha256, asset);
        const resolved = unique.map((hash) => this.assetCache.get(hash)).filter((asset) => asset !== undefined);
        if (resolved.length !== unique.length)
            throw new Error("Captured replay assets are unavailable");
        return resolved;
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
        if (!this.started)
            return;
        this.addSemantic({ ...event, offsetMs: Date.now() });
    }
    progress(progress) {
        this.configuration.onProgress?.(progress);
        for (const listener of this.progressListeners)
            listener(progress);
    }
    telemetry(timing) {
        this.configuration.onTelemetry?.(timing);
        this.recentTimings.push(timing);
        if (this.recentTimings.length > 100)
            this.recentTimings.splice(0, this.recentTimings.length - 100);
        this.activeTimings?.push(timing);
        if (this.activeTimings && this.activeTimings.length > 100) {
            this.activeTimings.splice(0, this.activeTimings.length - 100);
        }
    }
    async timed(phase, operation, bytes) {
        const started = performance.now();
        try {
            return await operation();
        }
        finally {
            this.telemetry({ phase, durationMs: performance.now() - started, bytes });
        }
    }
}
function randomKey() {
    return crypto.randomUUID().replaceAll("-", "");
}
function groupSemantic(events) {
    const groups = [];
    let current = [];
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
    if (current.length)
        groups.push(current);
    return groups;
}
function encodedBytes(segments, semantic) {
    return segments.reduce((sum, segment) => sum + segment.chunks.reduce((chunkSum, chunk) => chunkSum + chunk.bytes.byteLength, 0), semantic.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0));
}
function assetHashes(segments) {
    return [...new Set(segments.flatMap((segment) => segment.assetHashes ?? []))];
}
function assetBytes(assets) {
    return assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0);
}
function encodedBytesFromChunks(chunks) {
    return chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
}
function toPersistedChunk(submissionKey, sequence, chunk, baseOffset) {
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