import { LocalData } from "../../../excalidraw-app/data/LocalData";
import Collab from "../collab/Collab";

import type { ExcalidrawCollabProps } from "../types";

/**
 * Several boards share one page in the meeting client: the whiteboard stays mounted behind a
 * visibility swap while a document tab mounts and unmounts its own annotation layer. Each board's
 * collaboration state has to be its own — when it was one page-wide flag, the document layer
 * leaving its room switched off the whiteboard's broadcasts, and strokes drawn there afterwards
 * reached nobody while nothing reported a problem.
 */

// A transport that never connects: the session is entered synchronously, before the socket.
const pendingSocket = () => new Promise<never>(() => {});

const board = (
  onCollaboratingChange?: (value: boolean) => void,
  collabSocketFactory: () => Promise<unknown> = pendingSocket,
) =>
  new Collab({
    excalidrawAPI: {
      updateScene: () => {},
      getSceneElementsIncludingDeleted: () => [],
      getAppState: () => ({}),
    },
    collabSocketFactory,
    onCollaboratingChange,
  } as unknown as ExcalidrawCollabProps);

/** The first connect settles when the test says so; every later one never does. */
const slowFirstConnect = () => {
  let settle: {
    resolve: (socket: unknown) => void;
    reject: (error: Error) => void;
  } | null = null;
  let calls = 0;

  const factory = () =>
    ++calls === 1
      ? new Promise<unknown>((resolve, reject) => {
          settle = { resolve, reject };
        })
      : pendingSocket();

  return { factory, settle: () => settle! };
};

// Lets the settled transport's `await` resume and `startCollaboration` run on.
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("collaboration state is per board", () => {
  it("one board leaving its room leaves another board collaborating", () => {
    const whiteboard = board();
    const documentLayer = board();

    whiteboard.startCollaboration({ roomId: "whiteboard", roomKey: "k1" });
    documentLayer.startCollaboration({ roomId: "document", roomKey: "k2" });

    documentLayer.leaveRoom();

    expect(documentLayer.isCollaborating()).toBe(false);
    expect(whiteboard.isCollaborating()).toBe(true);

    whiteboard.leaveRoom();
  });

  it("local saving stays paused while any board is still collaborating", () => {
    const whiteboard = board();
    const documentLayer = board();

    whiteboard.startCollaboration({ roomId: "whiteboard", roomKey: "k1" });
    documentLayer.startCollaboration({ roomId: "document", roomKey: "k2" });

    documentLayer.leaveRoom();
    expect(LocalData.isSavePaused()).toBe(true);

    whiteboard.leaveRoom();
    expect(LocalData.isSavePaused()).toBe(false);
  });

  it("tells only the board's own app when its session starts and ends", () => {
    const whiteboardChanges: boolean[] = [];
    const documentChanges: boolean[] = [];
    const whiteboard = board((value) => whiteboardChanges.push(value));
    const documentLayer = board((value) => documentChanges.push(value));

    whiteboard.startCollaboration({ roomId: "whiteboard", roomKey: "k1" });
    documentLayer.startCollaboration({ roomId: "document", roomKey: "k2" });
    documentLayer.leaveRoom();

    expect(documentChanges).toEqual([true, false]);
    expect(whiteboardChanges).toEqual([true]);

    whiteboard.leaveRoom();
  });

  // A document switch leaves one room and joins the next while the first is still connecting:
  // the first connect then belongs to a session that is over, and must not touch the next one.
  it("a superseded connect leaves the session that replaced it paused for saving", async () => {
    const connect = slowFirstConnect();
    const documentLayer = board(undefined, connect.factory);

    documentLayer.startCollaboration({ roomId: "doc-a", roomKey: "k1" });
    documentLayer.leaveRoom({ keepCollaborating: true });
    documentLayer.startCollaboration({ roomId: "doc-b", roomKey: "k2" });

    connect.settle().resolve({ close: () => {} });
    await nextTask();

    expect(documentLayer.isCollaborating()).toBe(true);
    expect(LocalData.isSavePaused()).toBe(true);

    documentLayer.leaveRoom();
  });

  it("a superseded connect that fails does not end the session that replaced it", async () => {
    const connect = slowFirstConnect();
    const changes: boolean[] = [];
    const documentLayer = board(
      (value) => changes.push(value),
      connect.factory,
    );

    documentLayer.startCollaboration({ roomId: "doc-a", roomKey: "k1" });
    documentLayer.leaveRoom({ keepCollaborating: true });
    documentLayer.startCollaboration({ roomId: "doc-b", roomKey: "k2" });

    connect.settle().reject(new Error("no connected LiveKit room"));
    await nextTask();

    expect(documentLayer.isCollaborating()).toBe(true);
    expect(LocalData.isSavePaused()).toBe(true);
    expect(changes).toEqual([true]);

    documentLayer.leaveRoom();
  });
});
