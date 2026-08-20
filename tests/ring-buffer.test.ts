import { describe, expect, it } from "vitest";
import { ReplayRingBuffer } from "../src/ring-buffer";
import type { eventWithTime } from "@rrweb/types";

const event = (timestamp: number): eventWithTime => ({ type: 4, data: { href: "https://link.me", width: 100, height: 100 }, timestamp });

describe("ReplayRingBuffer", () => {
  it("keeps a valid checkout boundary when old history is evicted", () => {
    const buffer = new ReplayRingBuffer(1_000, 100_000);
    buffer.addEvent(event(1_000), true);
    buffer.addEvent(event(1_100), false);
    buffer.addEvent(event(2_500), true);
    buffer.addEvent(event(2_600), false);
    const selected = buffer.select(30, 2_600);
    expect(selected.segments.flatMap((segment) => segment.events).map((item) => item.timestamp)).toEqual([2_500, 2_600]);
  });

  it("evicts old semantic and network data within aggregate budgets", () => {
    const now = Date.now();
    const buffer = new ReplayRingBuffer(10_000, 100_000, 100_000, 500, 50);
    buffer.addEvent(event(now), true);
    buffer.addSemantic({ type: "network", offsetMs: now, requestBody: "a".repeat(40) });
    buffer.addSemantic({ type: "network", offsetMs: now + 100, responseBody: "b".repeat(40) });
    expect(buffer.select(30, now + 100).semantic).toHaveLength(1);
  });
});
