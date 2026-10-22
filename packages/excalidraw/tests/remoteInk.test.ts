import { vi } from "vitest";

import Portal from "../../../excalidraw-app/collab/Portal";
import Collab from "../collab/Collab";
import {
  applyInkFrame,
  applyInkFrameToStrokes,
  buildInkFrame,
  isInkFrame,
  MAX_INK_POINTS_PER_STROKE,
  MAX_INK_STROKES_PER_PEER,
} from "../remoteInk";

import type { InkFrame } from "../remoteInk";
import type { RemoteInk } from "../types";

type Stroke = Parameters<typeof buildInkFrame>[0];

const stroke = (points: number, id = "s1"): Stroke => ({
  id,
  x: 10,
  y: 20,
  points: Array.from(
    { length: points },
    (_, i) => [i, i * 2] as [number, number],
  ) as unknown as Stroke["points"],
  pressures: [],
  simulatePressure: true,
  strokeColor: "#1e1e1e",
  strokeWidth: 2,
  opacity: 100,
});

/** A pen moving: a frame after every `step` points, as the 33ms throttle would. */
const frames = (points: number, step: number) => {
  const out: InkFrame[] = [];
  let sent = 0;

  for (let n = step; n <= points; n += step) {
    const built = buildInkFrame(stroke(n), sent);

    sent = built.sent;
    out.push(built.frame);
  }

  return out;
};

const receive = (list: InkFrame[]) =>
  list.reduce<RemoteInk | undefined>(
    (preview, frame) => applyInkFrame(preview, frame, 0),
    undefined,
  );

describe("live ink frames", () => {
  it("rebuild the stroke on the receiving side", () => {
    expect(receive(frames(60, 3))?.points).toEqual(stroke(60).points);
  });

  it("carry only the new points, not the stroke so far", () => {
    const sizes = frames(600, 3).map((frame) => frame.points.length);

    expect(Math.max(...sizes)).toBeLessThanOrEqual(5);
  });

  it("survive a lost frame with every later point intact", () => {
    const sent = frames(30, 3);
    const preview = receive(sent.filter((_, i) => i !== 4));

    // Frame 4 alone carried point 12; the preview joins across it.
    expect(preview?.points).toEqual(
      stroke(30).points.filter((_, i) => i !== 12),
    );
  });

  // The lossy channel is unordered too.
  it("never cut the stroke short for a frame that arrives late", () => {
    const [a, b, c] = frames(9, 3);
    const preview = receive([a, c, b]);

    expect(preview?.points.at(-1)).toEqual(stroke(9).points.at(-1));
    expect(preview?.received).toBe(9);
  });

  it("drop the preview of a stroke that was thrown away", () => {
    const preview = receive(frames(9, 3));

    expect(
      applyInkFrame(preview, { ...frames(3, 3)[0], discarded: true }, 0),
    ).toBeUndefined();
  });

  it("keep a peer's earlier strokes while the next one starts", () => {
    const first = applyInkFrameToStrokes(undefined, frames(3, 3)[0], 0);
    const both = applyInkFrameToStrokes(
      first,
      buildInkFrame(stroke(3, "s2"), 0).frame,
      0,
    );

    expect(both.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("bound how many strokes one peer can have on screen", () => {
    let strokes: readonly RemoteInk[] = [];

    for (let i = 0; i < MAX_INK_STROKES_PER_PEER + 5; i++) {
      strokes = applyInkFrameToStrokes(
        strokes,
        buildInkFrame(stroke(3, `s${i}`), 0).frame,
        0,
      );
    }

    expect(strokes).toHaveLength(MAX_INK_STROKES_PER_PEER);
  });

  it("reject a malformed frame from a peer", () => {
    const good = frames(3, 3)[0];

    expect(isInkFrame(good)).toBe(true);
    expect(isInkFrame({ id: "s", points: "nope" })).toBe(false);
    expect(isInkFrame({ ...good, x: NaN })).toBe(false);
    expect(isInkFrame({ ...good, pressures: [0.5] })).toBe(false);
    expect(isInkFrame({ ...good, pressures: [0.5, "x", 0.5] })).toBe(false);
    expect(
      isInkFrame({
        ...good,
        points: Array.from({ length: 10_000 }, () => [0, 0]),
      }),
    ).toBe(false);
  });

  it("stop growing a preview at the cap", () => {
    let preview: RemoteInk | undefined;

    for (let i = 0; i * 500 < MAX_INK_POINTS_PER_STROKE + 2000; i++) {
      preview = applyInkFrame(
        preview,
        {
          ...frames(3, 3)[0],
          from: i * 500,
          points: Array.from({ length: 500 }, () => [1, 1]),
        },
        0,
      );
    }

    expect(preview!.points.length).toBeLessThanOrEqual(
      MAX_INK_POINTS_PER_STROKE + 500,
    );
  });
});

/** The scene elements Portal emitted, per broadcast. */
const emittedScenes = (emit: ReturnType<typeof vi.fn>) =>
  emit.mock.calls
    .filter(([event]) => event === "server-broadcast")
    .map(([, , bytes]) =>
      JSON.parse(new TextDecoder().decode(bytes as Uint8Array)),
    );

const element = (id: string, version: number, type = "freedraw") =>
  ({
    id,
    version,
    versionNonce: 1,
    type,
    isDeleted: false,
    points: [
      [0, 0],
      [5, 5],
    ],
    pressures: [],
    simulatePressure: true,
    x: 0,
    y: 0,
    strokeColor: "#000",
    strokeWidth: 1,
    opacity: 100,
    index: "a0",
  } as any);

describe("holding a stroke back while it is drawn", () => {
  const setup = (inkId: { current: string | null }) => {
    const emit = vi.fn();
    const portal = new Portal({
      getInkElementId: () => inkId.current,
      getElementAuthorId: () => "me",
      filesEnabled: false,
    } as any);

    portal.socket = { id: "me", emit } as any;
    portal.roomId = "room";
    portal.roomKey = "key";
    portal.socketInitialized = true;

    return { emit, portal };
  };

  it("leaves the stroke being drawn out of scene sync, then sends it once released", async () => {
    const inkId = { current: "ink" as string | null };
    const { emit, portal } = setup(inkId);

    await portal.broadcastScene(
      "SCENE_UPDATE" as any,
      [element("ink", 5), element("other", 1, "rectangle")],
      false,
    );
    inkId.current = null;
    await portal.broadcastScene(
      "SCENE_UPDATE" as any,
      [element("ink", 6), element("other", 1, "rectangle")],
      false,
    );

    const sent = emittedScenes(emit).map((scene) =>
      scene.payload.elements.map((e: { id: string }) => e.id),
    );

    expect(sent).toEqual([["other"], ["ink"]]);
  });
});

describe("Collab live ink", () => {
  const setup = (scene: string[] = []) => {
    const appState: { newElement: any } = { newElement: null };
    const updateScene = vi.fn();
    const collab = new Collab({
      excalidrawAPI: {
        getAppState: () => appState,
        getSceneElementsIncludingDeleted: () => [],
        getSceneElementsMapIncludingDeleted: () =>
          new Map(scene.map((id) => [id, element(id, 1)])),
        updateScene,
      },
    } as any);
    const broadcastScene = vi.fn();
    const broadcastInk = vi.fn();

    collab.portal.broadcastScene = broadcastScene as any;
    collab.portal.broadcastInk = broadcastInk as any;

    return { appState, broadcastInk, broadcastScene, collab, updateScene };
  };

  /** Ink previews the collab layer has put on the board. */
  const previews = (updateScene: ReturnType<typeof vi.fn>) =>
    updateScene.mock.calls.flatMap(([data]) =>
      data.collaborators
        ? [...data.collaborators.values()].flatMap(
            (c: any) => c.inkStrokes ?? [],
          )
        : [],
    );

  // The finished element goes reliably and its frames lossily, so it can arrive first.
  it("ignores a late frame for a stroke already on the board", () => {
    const { collab, updateScene } = setup(["s1"]);

    collab.handleInkFrame("peer" as any, { ...frames(3, 3)[0], done: true });

    expect(previews(updateScene)).toEqual([]);
  });

  it("previews a peer's stroke that is not on the board yet", () => {
    const { collab, updateScene } = setup();

    collab.handleInkFrame("peer" as any, frames(3, 3)[0]);

    expect(previews(updateScene).map((s) => s.id)).toEqual(["s1"]);
  });

  it("releases a stroke when the next one starts in the same change", () => {
    const { appState, broadcastInk, collab } = setup();
    const a = element("a", 3);
    const b = element("b", 1);

    appState.newElement = a;
    collab.broadcastElements([a]);
    appState.newElement = b;
    collab.broadcastElements([a, b]);

    expect(broadcastInk).toHaveBeenCalledWith(
      expect.objectContaining({ id: "a", done: true }),
    );
  });

  it("sends the finished stroke at pen-up even when its version did not move", () => {
    const { appState, broadcastInk, broadcastScene, collab } = setup();
    const ink = element("ink", 3);

    appState.newElement = ink;
    collab.broadcastElements([ink]);
    appState.newElement = null;
    broadcastScene.mockClear();
    collab.broadcastElements([ink]);

    expect(broadcastScene).toHaveBeenCalledTimes(1);
    expect(broadcastInk).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "ink", done: true }),
    );
  });

  it("tells peers to drop the preview of a stroke that was thrown away", () => {
    const { appState, broadcastInk, collab } = setup();
    const ink = element("ink", 3);

    appState.newElement = ink;
    collab.broadcastElements([ink]);
    appState.newElement = null;
    collab.broadcastElements([]);

    expect(broadcastInk).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "ink", discarded: true }),
    );
  });

  it("streams frames while the pen is down", () => {
    vi.useFakeTimers();
    const { appState, broadcastInk, collab } = setup();

    appState.newElement = element("ink", 1);
    collab.broadcastElements([appState.newElement]);
    vi.advanceTimersByTime(100);

    expect(broadcastInk).toHaveBeenCalledWith(
      expect.objectContaining({ id: "ink", from: 0 }),
    );
    vi.useRealTimers();
  });
});
