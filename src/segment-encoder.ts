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
  timings: { serializationMs: number; gzipMs: number; hashingMs: number };
}

interface PendingRequest {
  resolve: (result: EncodeResult) => void;
  reject: (error: Error) => void;
}

export class ReplaySegmentEncoder {
  private worker?: Worker;
  private sequence = 0;
  private readonly pending = new Map<number, PendingRequest>();

  constructor(private readonly onTiming: (timing: ReplayTiming) => void) {}

  encode(
    events: Array<eventWithTime>,
    semantic: Array<SemanticEvent>,
    startedAt: number,
    maximumCompressedBytes: number,
    assetOptions: ReplayAssetCaptureOptions,
  ): Promise<EncodeResult> {
    const worker = this.ensureWorker();
    const id = this.sequence++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (result) => {
          const bytes = result.chunks.reduce((sum, chunk) => sum + chunk.bytes.byteLength, 0);
          this.onTiming({ phase: "serialization", durationMs: result.timings.serializationMs, bytes });
          this.onTiming({ phase: "gzip", durationMs: result.timings.gzipMs, bytes });
          this.onTiming({ phase: "hashing", durationMs: result.timings.hashingMs, bytes });
          resolve(result);
        },
        reject,
      });
      worker.postMessage({
        id,
        events,
        semantic,
        startedAt,
        targetRawBytes: 4 * 1_024 * 1_024,
        maximumCompressedBytes,
        assetBaseUrl: assetOptions.baseUrl,
        maximumAssetBytes: assetOptions.maximumAssetBytes,
        maximumAssetTotalBytes: assetOptions.maximumTotalBytes,
        maximumAssetCount: assetOptions.maximumAssetCount,
      });
    });
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const request of this.pending.values()) request.reject(new Error("Replay encoder stopped"));
    this.pending.clear();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./segment-worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (message: MessageEvent<{ id: number; result?: EncodeResult; error?: string }>) => {
      const request = this.pending.get(message.data.id);
      if (!request) return;
      this.pending.delete(message.data.id);
      if (message.data.result) request.resolve(message.data.result);
      else request.reject(new Error(message.data.error ?? "Replay encoding failed"));
    };
    worker.onerror = () => {
      for (const request of this.pending.values()) request.reject(new Error("Replay encoding worker failed"));
      this.pending.clear();
    };
    this.worker = worker;
    return worker;
  }
}
