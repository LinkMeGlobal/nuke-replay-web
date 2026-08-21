// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { NukeReplayClient } from "../src/client";
import { NukeReplayProvider } from "../src/react";

interface FakeClient {
  client: NukeReplayClient;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function createFakeClient(): FakeClient {
  const start = vi.fn(() => Promise.resolve());
  const stop = vi.fn();
  const client = {
    start,
    stop,
    subscribe: vi.fn(() => () => undefined),
    subscribeProgress: vi.fn(() => () => undefined),
    openReporter: vi.fn(),
    closeReporter: vi.fn(),
    fallbackProjects: [],
    defaultProjectId: "all-in-challenge",
  } as unknown as NukeReplayClient;
  return { client, start, stop };
}

describe("NukeReplayProvider", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  test("does not start capture until enabled", async () => {
    const { client, start, stop } = createFakeClient();
    const renderProvider = async (enabled: boolean) => {
      await act(async () => {
        root.render(createElement(NukeReplayProvider, {
          client,
          enabled,
          launcher: false,
          shortcut: false,
          children: null,
        }));
      });
    };

    await renderProvider(false);
    expect(start).not.toHaveBeenCalled();

    await renderProvider(true);
    expect(start).toHaveBeenCalledTimes(1);

    await renderProvider(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
