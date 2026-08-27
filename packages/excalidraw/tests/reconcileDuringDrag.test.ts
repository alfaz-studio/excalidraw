import type { OrderedExcalidrawElement } from "@excalidraw/element/types";

import { reconcileElements } from "../data/reconcile";

import type { AppState } from "../types";
import type { RemoteExcalidrawElement } from "../data/reconcile";

/**
 * The gap that motivates deferring the scene-archive reconcile past an interaction.
 *
 * An element the user is actively editing is protected by ID: `shouldDiscardRemoteElement`
 * forces the local copy to win for `newElement`, `resizingElement` and `editingTextElement`
 * whatever the versions say. A plain DRAG of already-existing elements has no such guard, so it
 * falls through to the version comparison — and a stored snapshot that out-versions the local
 * copy replaces what is under the cursor.
 *
 * These tests pin that asymmetry, so the reason `Collab.applyStoredScene` waits is checkable
 * rather than folklore.
 */

const el = (id: string, version: number, x: number): OrderedExcalidrawElement =>
  ({
    id,
    version,
    versionNonce: 1,
    x,
    y: 0,
    isDeleted: false,
    index: "a0",
  } as unknown as OrderedExcalidrawElement);

const appStateWith = (over: Partial<AppState>): AppState =>
  ({
    editingTextElement: null,
    resizingElement: null,
    newElement: null,
    selectedElementIds: {},
    selectedElementsAreBeingDragged: false,
    ...over,
  } as unknown as AppState);

describe("reconcile during a local interaction", () => {
  it("keeps the element being drawn even when the remote copy is newer", () => {
    const local = el("a", 1, 100);
    const remote = el("a", 99, 0) as RemoteExcalidrawElement;

    const result = reconcileElements(
      [local],
      [remote],
      appStateWith({ newElement: local as AppState["newElement"] }),
    );

    // The id guard wins over the version, so the stroke under the pen survives.
    expect(result[0].x).toBe(100);
  });

  it("does NOT protect a dragged element — the newer stored copy replaces it", () => {
    const local = el("a", 1, 100);
    const remote = el("a", 99, 0) as RemoteExcalidrawElement;

    const result = reconcileElements(
      [local],
      [remote],
      appStateWith({
        selectedElementIds: { a: true },
        selectedElementsAreBeingDragged: true,
      }),
    );

    // Snaps back to the stored position mid-drag. Nothing in reconcile knows a drag is in
    // progress — which is why the archive reconcile has to wait for the pointer instead.
    expect(result[0].x).toBe(0);
  });

  it("keeps a local element the stored scene has never seen", () => {
    const local = el("only-local", 1, 100);

    const result = reconcileElements([local], [], appStateWith({}));

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("only-local");
  });
});
