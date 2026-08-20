import type { eventWithTime } from "@rrweb/types";
import { captureReplayAssets, type CapturedReplayAsset } from "./assets";
import type { ReplayChunkPayload, SemanticEvent } from "./types";

interface EncodeRequest {
  id: number;
  events: Array<eventWithTime>;
  semantic: Array<SemanticEvent>;
  startedAt: number;
  targetRawBytes: number;
  maximumCompressedBytes: number;
  assetBaseUrl: string;
  maximumAssetBytes: number;
  maximumAssetTotalBytes: number;
  maximumAssetCount: number;
}

interface WorkerChunk {
  bytes: Uint8Array;
  encoding: "gzip" | null;
  sha256: string;
  startOffsetMs: number;
  endOffsetMs: number;
  eventCount: number;
}

const encoder = new TextEncoder();

self.onmessage = (message: MessageEvent<EncodeRequest>) => {
  void encode(message.data).then(
    (result) => {
      const transfers = [...result.chunks.map((chunk) => chunk.bytes.buffer),
        ...result.assets.map((asset) => asset.bytes.buffer)]
        .filter((buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer);
      (self as unknown as { postMessage(value: unknown, transfer: Array<Transferable>): void })
        .postMessage({ id: message.data.id, result }, transfers);
    },
    (cause) => self.postMessage({
      id: message.data.id,
      error: cause instanceof Error ? cause.message : "Replay encoding failed",
    }),
  );
};

async function encode(request: EncodeRequest): Promise<{
  chunks: Array<WorkerChunk>;
  assets: Array<CapturedReplayAsset>;
  timings: { serializationMs: number; gzipMs: number; hashingMs: number };
}> {
  const captured = await captureReplayAssets(request.events, {
    baseUrl: request.assetBaseUrl,
    maximumAssetBytes: request.maximumAssetBytes,
    maximumTotalBytes: request.maximumAssetTotalBytes,
    maximumAssetCount: request.maximumAssetCount,
  });
  const groups = groupEvents(captured.events, request.targetRawBytes);
  if (!groups.length) groups.push([]);
  const chunks: Array<WorkerChunk> = [];
  let serializationMs = 0;
  let gzipMs = 0;
  let hashingMs = 0;

  for (let index = 0; index < groups.length; index += 1) {
    const events = groups[index] ?? [];
    const firstTimestamp = events[0]?.timestamp ?? request.startedAt;
    const nextTimestamp = groups[index + 1]?.[0]?.timestamp ?? Number.POSITIVE_INFINITY;
    const semantic = request.semantic.filter((event) => {
      const absolute = request.startedAt + event.offsetMs;
      return (index === 0 || absolute >= firstTimestamp) && absolute < nextTimestamp;
    });
    const encoded = await encodeGroup(events, semantic, request.startedAt);
    serializationMs += encoded.serializationMs;
    gzipMs += encoded.gzipMs;
    hashingMs += encoded.hashingMs;
    if (encoded.chunk.bytes.byteLength > request.maximumCompressedBytes && events.length > 1) {
      const middle = Math.ceil(events.length / 2);
      groups.splice(index, 1, events.slice(0, middle), events.slice(middle));
      index -= 1;
      continue;
    }
    if (encoded.chunk.bytes.byteLength > request.maximumCompressedBytes) {
      throw new Error("A replay snapshot exceeds the per-chunk byte budget");
    }
    chunks.push(encoded.chunk);
  }

  return { chunks, assets: captured.assets, timings: { serializationMs, gzipMs, hashingMs } };
}

function groupEvents(events: Array<eventWithTime>, targetBytes: number): Array<Array<eventWithTime>> {
  const groups: Array<Array<eventWithTime>> = [];
  let current: Array<eventWithTime> = [];
  let currentBytes = 0;
  for (const event of events) {
    const bytes = JSON.stringify(event).length;
    if (current.length && currentBytes + bytes > targetBytes) {
      groups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(event);
    currentBytes += bytes;
  }
  if (current.length) groups.push(current);
  return groups;
}

async function encodeGroup(
  events: Array<eventWithTime>,
  semantic: Array<SemanticEvent>,
  startedAt: number,
): Promise<{ chunk: WorkerChunk; serializationMs: number; gzipMs: number; hashingMs: number }> {
  const serializationStarted = performance.now();
  const raw = encoder.encode(JSON.stringify({ events, semantic } satisfies ReplayChunkPayload));
  const serializationMs = performance.now() - serializationStarted;
  const gzipStarted = performance.now();
  const compressed = await compress(raw);
  const gzipMs = performance.now() - gzipStarted;
  const hashingStarted = performance.now();
  const sha256 = await digest(compressed.bytes);
  const hashingMs = performance.now() - hashingStarted;
  const absoluteSemantic = semantic.map((event) => startedAt + event.offsetMs);
  const firstTimestamp = events[0]?.timestamp ?? absoluteSemantic[0] ?? startedAt;
  const lastTimestamp = events.at(-1)?.timestamp ?? absoluteSemantic.at(-1) ?? firstTimestamp;
  return {
    chunk: {
      bytes: compressed.bytes,
      encoding: compressed.encoding,
      sha256,
      startOffsetMs: Math.max(0, Math.min(firstTimestamp, ...absoluteSemantic) - startedAt),
      endOffsetMs: Math.max(0, Math.max(lastTimestamp, ...absoluteSemantic) - startedAt),
      eventCount: events.length + semantic.length,
    },
    serializationMs,
    gzipMs,
    hashingMs,
  };
}

async function compress(bytes: Uint8Array): Promise<{ bytes: Uint8Array; encoding: "gzip" | null }> {
  if (typeof CompressionStream === "undefined") return { bytes, encoding: null };
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), encoding: "gzip" };
}

async function digest(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const value = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export {};
