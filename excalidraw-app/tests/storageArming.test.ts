import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FileId } from "@excalidraw/element/types";

import {
  expectBackend,
  initializeBackend,
  loadFilesFromStorage,
  releaseBackend,
} from "../data/storage";

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
});
