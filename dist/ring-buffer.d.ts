import type { eventWithTime } from "@rrweb/types";
import type { SemanticEvent } from "./types";
export declare class ReplayRingBuffer {
    private readonly maximumAgeMs;
    private readonly maximumBytes;
    private readonly segments;
    private readonly semantic;
    private bytes;
    constructor(maximumAgeMs: number, maximumBytes: number);
    addEvent(event: eventWithTime, checkout: boolean): void;
    addSemantic(event: SemanticEvent): void;
    select(minutes: number, now?: number): {
        events: Array<eventWithTime>;
        semantic: Array<SemanticEvent>;
        startedAt: number;
    };
    clear(): void;
    private evict;
}
//# sourceMappingURL=ring-buffer.d.ts.map