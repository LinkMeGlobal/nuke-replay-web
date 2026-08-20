export class ReplayRingBuffer {
    maximumAgeMs;
    maximumBytes;
    maximumImageBytes;
    maximumSemanticBytes;
    maximumNetworkBodyBytes;
    segments = [];
    semantic = [];
    bytes = 0;
    imageBytes = 0;
    semanticBytes = 0;
    networkBodyBytes = 0;
    segmentSequence = 0;
    constructor(maximumAgeMs, maximumBytes, maximumImageBytes = Math.floor(maximumBytes * 0.35), maximumSemanticBytes = Math.floor(maximumBytes * 0.2), maximumNetworkBodyBytes = Math.floor(maximumBytes * 0.15)) {
        this.maximumAgeMs = maximumAgeMs;
        this.maximumBytes = maximumBytes;
        this.maximumImageBytes = maximumImageBytes;
        this.maximumSemanticBytes = maximumSemanticBytes;
        this.maximumNetworkBodyBytes = maximumNetworkBodyBytes;
    }
    addEvent(event, checkout) {
        const serialized = JSON.stringify(event);
        const size = serialized.length;
        const imageSize = estimateInlineImageBytes(serialized);
        let sealed;
        if (checkout || this.segments.length === 0) {
            sealed = this.segments.at(-1);
            this.segments.push({
                id: `${event.timestamp}-${this.segmentSequence++}`,
                startedAt: event.timestamp,
                endedAt: event.timestamp,
                bytes: 0,
                imageBytes: 0,
                events: [],
            });
        }
        const segment = this.segments.at(-1);
        if (!segment)
            return { evictedIds: [] };
        segment.events.push(event);
        segment.endedAt = event.timestamp;
        segment.bytes += size;
        segment.imageBytes += imageSize;
        this.bytes += size;
        this.imageBytes += imageSize;
        return { sealed, evictedIds: this.evict(event.timestamp) };
    }
    addSemantic(event) {
        const serialized = JSON.stringify(event);
        this.semantic.push(event);
        this.semanticBytes += serialized.length;
        this.networkBodyBytes += estimateNetworkBodyBytes(event);
        const cutoff = Date.now() - this.maximumAgeMs;
        while (this.semantic[0] &&
            (this.semantic[0].offsetMs < cutoff ||
                this.semanticBytes > this.maximumSemanticBytes ||
                this.networkBodyBytes > this.maximumNetworkBodyBytes)) {
            const removed = this.semantic.shift();
            if (removed) {
                this.semanticBytes -= JSON.stringify(removed).length;
                this.networkBodyBytes -= estimateNetworkBodyBytes(removed);
            }
        }
        return this.evict(Date.now());
    }
    select(minutes, now = Date.now()) {
        const cutoff = now - minutes * 60_000;
        const first = Math.max(0, this.segments.findIndex((segment) => segment.endedAt >= cutoff));
        const chosen = this.segments.slice(first);
        return {
            segments: chosen.map(copySegment),
            semantic: this.semantic.filter((event) => event.offsetMs >= cutoff),
            startedAt: chosen[0]?.startedAt ?? now,
        };
    }
    clear() {
        this.segments.length = 0;
        this.semantic.length = 0;
        this.bytes = 0;
        this.imageBytes = 0;
        this.semanticBytes = 0;
        this.networkBodyBytes = 0;
    }
    evict(now) {
        const evictedIds = [];
        const cutoff = now - this.maximumAgeMs;
        while (this.segments.length > 1 &&
            (this.bytes + this.semanticBytes > this.maximumBytes ||
                this.imageBytes > this.maximumImageBytes ||
                (this.segments[0]?.endedAt ?? now) < cutoff)) {
            const removed = this.segments.shift();
            if (removed) {
                this.bytes -= removed.bytes;
                this.imageBytes -= removed.imageBytes;
                evictedIds.push(removed.id);
            }
        }
        return evictedIds;
    }
}
function copySegment(segment) {
    return { ...segment, events: [...segment.events] };
}
function estimateInlineImageBytes(serialized) {
    let total = 0;
    const pattern = /data:image\/[^;,]+(?:;[^,]*)?,([A-Za-z0-9+/=_-]+)/g;
    for (const match of serialized.matchAll(pattern))
        total += match[1]?.length ?? 0;
    return total;
}
function estimateNetworkBodyBytes(event) {
    if (event.type !== "network")
        return 0;
    return (typeof event.requestBody === "string" ? event.requestBody.length : 0) +
        (typeof event.responseBody === "string" ? event.responseBody.length : 0);
}
//# sourceMappingURL=ring-buffer.js.map