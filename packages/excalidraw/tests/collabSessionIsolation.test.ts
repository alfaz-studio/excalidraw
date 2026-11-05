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

const board = (onCollaboratingChange?: (value: boolean) => void) =>
  new Collab({
    excalidrawAPI: {
      updateScene: () => {},
      getSceneElementsIncludingDeleted: () => [],
      getAppState: () => ({}),
    },
    collabSocketFactory: pendingSocket,
    onCollaboratingChange,
  } as unknown as ExcalidrawCollabProps);

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
});
