import type { eventWithTime } from "@rrweb/types";
import type { SemanticEvent } from "./types";

interface Segment {
  startedAt: number;
  endedAt: number;
  bytes: number;
  events: Array<eventWithTime>;
}

export class ReplayRingBuffer {
  private readonly segments: Array<Segment> = [];
  private readonly semantic: Array<SemanticEvent> = [];
  private bytes = 0;

  constructor(
    private readonly maximumAgeMs: number,
    private readonly maximumBytes: number,
  ) {}

  addEvent(event: eventWithTime, checkout: boolean): void {
    const size = JSON.stringify(event).length;
    if (checkout || this.segments.length === 0) {
      this.segments.push({
        startedAt: event.timestamp,
        endedAt: event.timestamp,
        bytes: 0,
        events: [],
      });
    }
    const segment = this.segments.at(-1);
    if (!segment) return;
    segment.events.push(event);
    segment.endedAt = event.timestamp;
    segment.bytes += size;
    this.bytes += size;
    this.evict(event.timestamp);
  }

  addSemantic(event: SemanticEvent): void {
    this.semantic.push(event);
    const cutoff = Date.now() - this.maximumAgeMs;
    while (this.semantic[0] && this.semantic[0].offsetMs < cutoff) this.semantic.shift();
  }

  select(minutes: number, now = Date.now()): {
    events: Array<eventWithTime>;
    semantic: Array<SemanticEvent>;
    startedAt: number;
  } {
    const cutoff = now - minutes * 60_000;
    const first = Math.max(0, this.segments.findIndex((segment) => segment.endedAt >= cutoff));
    const chosen = this.segments.slice(first);
    return {
      events: chosen.flatMap((segment) => segment.events),
      semantic: this.semantic.filter((event) => event.offsetMs >= cutoff),
      startedAt: chosen[0]?.startedAt ?? now,
    };
  }

  clear(): void {
    this.segments.length = 0;
    this.semantic.length = 0;
    this.bytes = 0;
  }

  private evict(now: number): void {
    const cutoff = now - this.maximumAgeMs;
    while (
      this.segments.length > 1 &&
      (this.bytes > this.maximumBytes || (this.segments[0]?.endedAt ?? now) < cutoff)
    ) {
      const removed = this.segments.shift();
      if (removed) this.bytes -= removed.bytes;
    }
  }
}
