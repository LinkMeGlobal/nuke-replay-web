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
    expect(selected.events.map((item) => item.timestamp)).toEqual([2_500, 2_600]);
  });
});

