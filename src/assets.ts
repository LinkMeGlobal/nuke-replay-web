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

const ASSET_REFERENCE_PREFIX = "nuke-replay-asset:";
const URL_FUNCTION = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
const DATA_URL = /data:[^\s"')]+/gi;
const NETWORK_URL = /(?:https?:\/\/|blob:)[^\s"'),]+/gi;
const ALLOWED_TYPES = new Set([
  "application/font-woff", "application/font-woff2", "application/octet-stream",
  "application/vnd.ms-fontobject", "font/otf", "font/ttf", "font/woff", "font/woff2",
  "image/avif", "image/gif", "image/jpeg", "image/png", "image/svg+xml", "image/webp",
  "image/x-icon",
]);

export async function captureReplayAssets(
  events: Array<eventWithTime>,
  options: ReplayAssetCaptureOptions,
  fetchAsset: typeof fetch = fetch,
): Promise<{ events: Array<eventWithTime>; assets: Array<CapturedReplayAsset> }> {
  normalizeBufferedFonts(events);
  const candidates = collectAssetCandidates(events);
  const replacements = new Map<string, string>();
  const assets = new Map<string, CapturedReplayAsset>();
  let totalBytes = 0;
  let cursor = 0;

  const captureNext = async (): Promise<void> => {
    while (cursor < candidates.length && assets.size < options.maximumAssetCount) {
      const source = candidates[cursor++];
      if (!source || replacements.has(source)) continue;
      const captured = await captureAsset(source, options, fetchAsset).catch(() => null);
      if (!captured || totalBytes + captured.bytes.byteLength > options.maximumTotalBytes) {
        replacements.set(source, safeFallback(source, options.baseUrl));
        continue;
      }
      if (!assets.has(captured.sha256) && assets.size >= options.maximumAssetCount) {
        replacements.set(source, safeFallback(source, options.baseUrl));
        continue;
      }
      if (!assets.has(captured.sha256)) {
        assets.set(captured.sha256, captured);
        totalBytes += captured.bytes.byteLength;
      }
      replacements.set(source, `${ASSET_REFERENCE_PREFIX}${captured.sha256}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => captureNext()));
  replaceStrings(events, replacements);
  return { events, assets: [...assets.values()] };
}

function normalizeBufferedFonts(value: unknown): void {
  visitObjects(value, (object) => {
    if (object.source !== 10 || object.buffer !== true || typeof object.fontSource !== "string") return;
    try {
      const bytes = JSON.parse(object.fontSource) as unknown;
      if (!Array.isArray(bytes) || bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return;
      object.fontSource = `url("data:application/octet-stream;base64,${bytesToBase64(new Uint8Array(bytes))}")`;
      object.buffer = false;
    } catch {
      // Preserve an unexpected rrweb font payload unchanged.
    }
  });
}

function collectAssetCandidates(value: unknown): Array<string> {
  const candidates = new Set<string>();
  const collectString = (text: string, assetAttribute: boolean, css: boolean) => {
    for (const match of text.matchAll(DATA_URL)) if (match[0]) candidates.add(match[0]);
    if (css) {
      for (const match of text.matchAll(URL_FUNCTION)) {
        const source = match[2]?.trim();
        if (source && isCaptureCandidate(source)) candidates.add(source);
      }
    }
    if (assetAttribute) {
      for (const match of text.matchAll(NETWORK_URL)) if (match[0]) candidates.add(match[0]);
    }
  };
  visitObjects(value, (object) => {
    const attributes = isRecord(object.attributes) ? object.attributes : null;
    if (attributes) {
      for (const [key, child] of Object.entries(attributes)) {
        if (typeof child !== "string") continue;
        collectString(
          child,
          ["src", "srcset", "poster"].includes(key),
          key === "_cssText" || key === "style",
        );
      }
    }
    for (const [key, child] of Object.entries(object)) {
      if (typeof child !== "string") continue;
      collectString(child, key === "fontSource", key === "cssText" || key === "rule" || key === "fontSource");
    }
  });
  return [...candidates];
}

async function captureAsset(
  source: string,
  options: ReplayAssetCaptureOptions,
  fetchAsset: typeof fetch,
): Promise<CapturedReplayAsset | null> {
  const resolved = new URL(source, options.baseUrl);
  if (!["data:", "blob:", "http:", "https:"].includes(resolved.protocol)) return null;
  const response = await fetchAsset(resolved.href, {
    credentials: resolved.origin === new URL(options.baseUrl).origin ? "include" : "omit",
    redirect: "follow",
  });
  if (!response.ok) return null;
  const declaredBytes = Number(response.headers.get("Content-Length") ?? 0);
  if (declaredBytes > options.maximumAssetBytes) return null;
  const contentType = normalizedContentType(response.headers.get("Content-Type"), resolved.pathname);
  if (!contentType || !ALLOWED_TYPES.has(contentType)) return null;
  const bytes = await readCappedBody(response, options.maximumAssetBytes);
  if (!bytes?.byteLength) return null;
  return { sha256: await digest(bytes), bytes, contentType };
}

async function readCappedBody(response: Response, maximumBytes: number): Promise<Uint8Array | null> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength <= maximumBytes ? bytes : null;
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function replaceStrings(value: unknown, replacements: Map<string, string>): void {
  visitObjects(value, (object) => {
    for (const [key, child] of Object.entries(object)) {
      if (typeof child !== "string") continue;
      let next = child;
      for (const [source, replacement] of replacements) next = next.split(source).join(replacement);
      object[key] = next;
    }
  });
}

function visitObjects(value: unknown, visitor: (value: Record<string, unknown>) => void): void {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object" || seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child);
      return;
    }
    const object = candidate as Record<string, unknown>;
    visitor(object);
    for (const child of Object.values(object)) visit(child);
  };
  visit(value);
}

function normalizedContentType(header: string | null, pathname: string): string | null {
  const fromHeader = header?.split(";", 1)[0]?.trim().toLowerCase();
  if (fromHeader && fromHeader !== "application/octet-stream") return fromHeader;
  const extension = pathname.toLowerCase().split(".").at(-1);
  return ({
    avif: "image/avif", gif: "image/gif", ico: "image/x-icon", jpeg: "image/jpeg", jpg: "image/jpeg",
    otf: "font/otf", png: "image/png", svg: "image/svg+xml", ttf: "font/ttf", webp: "image/webp",
    woff: "font/woff", woff2: "font/woff2",
  } as Record<string, string>)[extension ?? ""] ?? fromHeader ?? null;
}

function safeFallback(source: string, baseUrl: string): string {
  try {
    const url = new URL(source, baseUrl);
    if (url.protocol === "https:" && !isPrivateHost(url.hostname)) return source;
  } catch {
    // Invalid asset references are replaced below.
  }
  return "data:,";
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (/^(?:fc|fd)[a-f0-9]{2}:/.test(host) || /^fe[89ab][a-f0-9]:/.test(host)) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 100 && (parts[1] ?? 0) >= 64 && (parts[1] ?? 0) <= 127) ||
    (parts[0] === 169 && parts[1] === 254) || (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31);
}

function isCaptureCandidate(source: string): boolean {
  return /^(?:data:|blob:|https?:\/\/)/i.test(source);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
  }
  return btoa(binary);
}

async function digest(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const value = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
