import type { eventWithTime } from "@rrweb/types";
import { describe, expect, test } from "vitest";
import { captureReplayAssets } from "../src/assets";

const options = {
  baseUrl: "http://localhost:3002/profile",
  maximumAssetBytes: 1_024,
  maximumTotalBytes: 4_096,
  maximumAssetCount: 8,
};

describe("captureReplayAssets", () => {
  test("extracts duplicate data images once and rewrites every reference", async () => {
    const data = "data:image/png;base64,aGVsbG8=";
    const events = [{
      type: 2,
      timestamp: 1,
      data: {
        node: {
          type: 2,
          tagName: "img",
          attributes: { src: data, style: `background-image:url(${data})` },
        },
      },
    }] as unknown as Array<eventWithTime>;

    const result = await captureReplayAssets(events, options);

    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]?.contentType).toBe("image/png");
    expect(JSON.stringify(result.events)).not.toContain("data:image/png;base64");
    expect(JSON.stringify(result.events)).toContain(`nuke-replay-asset:${result.assets[0]?.sha256}`);
  });

  test("captures same-origin assets and removes failed localhost dependencies", async () => {
    const events = [{
      type: 2,
      timestamp: 1,
      data: {
        node: {
          type: 2,
          tagName: "div",
          attributes: {
            _cssText: ".ok{background:url(http://localhost:3002/ok.webp)} .gone{background:url(http://localhost:3002/gone.webp)}",
          },
        },
      },
    }] as unknown as Array<eventWithTime>;
    const fetchAsset = async (input: string | URL | Request) => {
      if (String(input).endsWith("/ok.webp")) {
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "image/webp" } });
      }
      return new Response(null, { status: 404 });
    };

    const result = await captureReplayAssets(events, options, fetchAsset as typeof fetch);
    const serialized = JSON.stringify(result.events);

    expect(result.assets).toHaveLength(1);
    expect(serialized).toContain("nuke-replay-asset:");
    expect(serialized).toContain("url(data:,)");
    expect(serialized).not.toContain("localhost");
  });
});
