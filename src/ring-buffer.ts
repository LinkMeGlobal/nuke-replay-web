import type { eventWithTime } from "@rrweb/types";
import type { SemanticEvent } from "./types";

export interface ReplaySegment {
  id: string;
  startedAt: number;
  endedAt: number;
  bytes: number;
  imageBytes: number;
  events: Array<eventWithTime>;
}

export interface ReplayBufferMutation {
  sealed?: ReplaySegment;
  evictedIds: Array<string>;
}

export class ReplayRingBuffer {
  private readonly segments: Array<ReplaySegment> = [];
  private readonly semantic: Array<SemanticEvent> = [];
  private bytes = 0;
  private imageBytes = 0;
  private semanticBytes = 0;
  private networkBodyBytes = 0;
  private segmentSequence = 0;

  constructor(
    private readonly maximumAgeMs: number,
    private readonly maximumBytes: number,
    private readonly maximumImageBytes = Math.floor(maximumBytes * 0.35),
    private readonly maximumSemanticBytes = Math.floor(maximumBytes * 0.2),
    private readonly maximumNetworkBodyBytes = Math.floor(maximumBytes * 0.15),
  ) {}

  addEvent(event: eventWithTime, checkout: boolean): ReplayBufferMutation {
    const serialized = JSON.stringify(event);
    const size = serialized.length;
    const imageSize = estimateInlineImageBytes(serialized);
    let sealed: ReplaySegment | undefined;
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
    if (!segment) return { evictedIds: [] };
    segment.events.push(event);
    segment.endedAt = event.timestamp;
    segment.bytes += size;
    segment.imageBytes += imageSize;
    this.bytes += size;
    this.imageBytes += imageSize;
    return { sealed, evictedIds: this.evict(event.timestamp) };
  }

  addSemantic(event: SemanticEvent): Array<string> {
    const serialized = JSON.stringify(event);
    this.semantic.push(event);
    this.semanticBytes += serialized.length;
    this.networkBodyBytes += estimateNetworkBodyBytes(event);
    const cutoff = Date.now() - this.maximumAgeMs;
    while (
      this.semantic[0] &&
      (this.semantic[0].offsetMs < cutoff ||
        this.semanticBytes > this.maximumSemanticBytes ||
        this.networkBodyBytes > this.maximumNetworkBodyBytes)
    ) {
      const removed = this.semantic.shift();
      if (removed) {
        this.semanticBytes -= JSON.stringify(removed).length;
        this.networkBodyBytes -= estimateNetworkBodyBytes(removed);
      }
    }
    return this.evict(Date.now());
  }

  select(minutes: number, now = Date.now()): {
    segments: Array<ReplaySegment>;
    semantic: Array<SemanticEvent>;
    startedAt: number;
  } {
    const cutoff = now - minutes * 60_000;
    const first = Math.max(0, this.segments.findIndex((segment) => segment.endedAt >= cutoff));
    const chosen = this.segments.slice(first);
    return {
      segments: chosen.map(copySegment),
      semantic: this.semantic.filter((event) => event.offsetMs >= cutoff),
      startedAt: chosen[0]?.startedAt ?? now,
    };
  }

  clear(): void {
    this.segments.length = 0;
    this.semantic.length = 0;
    this.bytes = 0;
    this.imageBytes = 0;
    this.semanticBytes = 0;
    this.networkBodyBytes = 0;
  }

  private evict(now: number): Array<string> {
    const evictedIds: Array<string> = [];
    const cutoff = now - this.maximumAgeMs;
    while (
      this.segments.length > 1 &&
      (this.bytes + this.semanticBytes > this.maximumBytes ||
        this.imageBytes > this.maximumImageBytes ||
        (this.segments[0]?.endedAt ?? now) < cutoff)
    ) {
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

function copySegment(segment: ReplaySegment): ReplaySegment {
  return { ...segment, events: [...segment.events] };
}

function estimateInlineImageBytes(serialized: string): number {
  let total = 0;
  const pattern = /data:image\/[^;,]+(?:;[^,]*)?,([A-Za-z0-9+/=_-]+)/g;
  for (const match of serialized.matchAll(pattern)) total += match[1]?.length ?? 0;
  return total;
}

function estimateNetworkBodyBytes(event: SemanticEvent): number {
  if (event.type !== "network") return 0;
  return (typeof event.requestBody === "string" ? event.requestBody.length : 0) +
    (typeof event.responseBody === "string" ? event.responseBody.length : 0);
}
