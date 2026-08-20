import type { eventWithTime } from "@rrweb/types";
export interface CapturedReplayAsset {
    sha256: string;
    bytes: Uint8Array;
    contentType: string;
}
export interface ReplayAssetCaptureOptions {
    baseUrl: string;
    maximumAssetBytes: number;
    maximumTotalBytes: number;
    maximumAssetCount: number;
}
export declare function captureReplayAssets(events: Array<eventWithTime>, options: ReplayAssetCaptureOptions, fetchAsset?: typeof fetch): Promise<{
    events: Array<eventWithTime>;
    assets: Array<CapturedReplayAsset>;
}>;
//# sourceMappingURL=assets.d.ts.map