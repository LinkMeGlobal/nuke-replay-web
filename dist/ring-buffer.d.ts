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
export declare class ReplayRingBuffer {
    private readonly maximumAgeMs;
    private readonly maximumBytes;
    private readonly maximumImageBytes;
    private readonly maximumSemanticBytes;
    private readonly maximumNetworkBodyBytes;
    private readonly segments;
    private readonly semantic;
    private bytes;
    private imageBytes;
    private semanticBytes;
    private networkBodyBytes;
    private segmentSequence;
    constructor(maximumAgeMs: number, maximumBytes: number, maximumImageBytes?: number, maximumSemanticBytes?: number, maximumNetworkBodyBytes?: number);
    addEvent(event: eventWithTime, checkout: boolean): ReplayBufferMutation;
    addSemantic(event: SemanticEvent): Array<string>;
    select(minutes: number, now?: number): {
        segments: Array<ReplaySegment>;
        semantic: Array<SemanticEvent>;
        startedAt: number;
    };
    clear(): void;
    private evict;
}
//# sourceMappingURL=ring-buffer.d.ts.map