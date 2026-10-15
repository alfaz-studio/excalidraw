import { describe, expect, it, vi } from "vitest";

import { addSceneFlushHandler, flushSceneArchive } from "../data/storage";

describe("flushSceneArchive", () => {
  it("flushes every mounted board, and only the ones still mounted", async () => {
    const flushed: string[] = [];
    const removePage1 = addSceneFlushHandler(async () => {
      flushed.push("page-1");
    });
    const removePage2 = addSceneFlushHandler(async () => {
      flushed.push("page-2");
    });

    // A board unmounting must not unregister the others.
    removePage1();
    await flushSceneArchive();
    removePage2();

    expect(flushed).toEqual(["page-2"]);
  });

  it("settles when a board's save throws, after the others have flushed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const flushed: string[] = [];
    const removeBroken = addSceneFlushHandler(async () => {
      throw new Error("upload failed");
    });
    const removeHealthy = addSceneFlushHandler(async () => {
      flushed.push("healthy");
    });

    await expect(flushSceneArchive()).resolves.toBeUndefined();
    removeBroken();
    removeHealthy();
    vi.restoreAllMocks();

    expect(flushed).toEqual(["healthy"]);
  });
});
