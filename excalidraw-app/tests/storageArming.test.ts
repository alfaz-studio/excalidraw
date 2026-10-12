import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FileId } from "@excalidraw/element/types";

import {
  addSceneArchiveListener,
  expectBackend,
  initializeBackend,
  loadFilesFromStorage,
  loadFromStorage,
  releaseBackend,
  saveToStorage,
} from "../data/storage";

import type { SceneArchiveEvent } from "../data/storage";

const ROOM = "room-1";
const FILE = "file-1" as FileId;

describe("a room whose token arrives after its first loads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    releaseBackend(ROOM);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports the missed load only once the room has stayed unarmed", async () => {
    const onFileError = vi.fn();

    expectBackend(ROOM, onFileError);
    await loadFilesFromStorage(`files/rooms/${ROOM}`, "key", [FILE], ROOM);

    expect(onFileError).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(onFileError).toHaveBeenCalledWith(
      expect.objectContaining({ op: "download", fileId: FILE }),
    );
  });

  it("stays silent and asks for the loads again when the token arrives in time", async () => {
    const onFileError = vi.fn();

    expectBackend(ROOM, onFileError);
    await loadFilesFromStorage(`files/rooms/${ROOM}`, "key", [FILE], ROOM);

    expect(
      initializeBackend(ROOM, "https://api.example", {
        sessionId: "s",
        roomJid: "r",
        token: "t",
      } as never)?.files,
    ).toEqual(new Set([FILE]));
    vi.advanceTimersByTime(10_000);
    expect(onFileError).not.toHaveBeenCalled();
  });

  it("reports a missed scene load under the surface's own scene", async () => {
    const events: SceneArchiveEvent[] = [];
    const unsubscribe = addSceneArchiveListener((e) => events.push(e));

    expectBackend(ROOM, undefined, "pdfdoc-x.excalidraw");
    await loadFromStorage(ROOM, "key", null);
    vi.advanceTimersByTime(10_000);
    unsubscribe();

    expect(events).toEqual([
      expect.objectContaining({
        status: "failed",
        sceneFileId: "pdfdoc-x.excalidraw",
      }),
    ]);
  });
});

describe("a writer whose archive saves keep failing", () => {
  const save = (sceneFileId: string, flushed?: boolean) => {
    const roomId = `room-${sceneFileId}`;

    initializeBackend(roomId, "https://api.example", {
      sessionId: "s",
      roomJid: "r",
      token: "t",
      canPersistScene: true,
      sceneFileId,
    } as never);

    return saveToStorage(
      { roomId, roomKey: "key", socket: {} } as never,
      [{ id: "a", version: 1, versionNonce: 1 }] as never,
      {} as never,
      { flushed },
    );
  };

  let events: SceneArchiveEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    events = [];
    unsubscribe = addSceneArchiveListener((event) => events.push(event));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 502, ok: false })),
    );
  });

  afterEach(() => {
    unsubscribe();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("pages only on the third failed tick in a row", async () => {
    for (let i = 0; i < 3; i++) {
      await save("ticks.excalidraw");
    }

    expect(events.map((e) => e.status === "failed" && e.retried)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("pages at once when the final save fails", async () => {
    await save("final.excalidraw", true);

    expect(events).toEqual([
      expect.objectContaining({ status: "failed", retried: false }),
    ]);
  });
});
