import type { eventWithTime } from "@rrweb/types";
import type { CapturedReplayAsset, ReplayAssetCaptureOptions } from "./assets";
import type { ReplayTiming, SemanticEvent } from "./types";
export interface EncodedReplayChunk {
    bytes: Uint8Array;
    encoding: "gzip" | null;
    sha256: string;
    startOffsetMs: number;
    endOffsetMs: number;
    eventCount: number;
}
export interface EncodeResult {
    chunks: Array<EncodedReplayChunk>;
    assets: Array<CapturedReplayAsset>;
    timings: {
        serializationMs: number;
        gzipMs: number;
        hashingMs: number;
    };
}
export declare class ReplaySegmentEncoder {
    private readonly onTiming;
    private worker?;
    private sequence;
    private readonly pending;
    constructor(onTiming: (timing: ReplayTiming) => void);
    encode(events: Array<eventWithTime>, semantic: Array<SemanticEvent>, startedAt: number, maximumCompressedBytes: number, assetOptions: ReplayAssetCaptureOptions): Promise<EncodeResult>;
    destroy(): void;
    private ensureWorker;
}
//# sourceMappingURL=segment-encoder.d.ts.map