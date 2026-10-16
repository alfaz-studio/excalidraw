// SONACOVE: public `api.history.undo()/redo()` — tests for the D6 host API.
import React from "react";

import { Excalidraw } from "../index";

import { Keyboard, UI } from "./helpers/ui";
import { act, render } from "./test-utils";

const { h } = window;

const api = () => window.h.app.api!;

const drawRect = () =>
  UI.createElement("rectangle", { x: 0, y: 0, width: 100, height: 100 });

describe("public api.history undo/redo (D6)", () => {
  it("canUndo/canRedo reflect the stacks and undo/redo act like the shortcuts", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);

    expect(api().history.canUndo()).toBe(false);
    expect(api().history.canRedo()).toBe(false);

    // draw a real element, so history records an undoable increment
    drawRect();

    expect(h.elements.length).toBe(1);
    expect(h.elements[0].isDeleted).toBe(false);
    expect(api().history.canUndo()).toBe(true);
    expect(api().history.canRedo()).toBe(false);

    act(() => api().history.undo());

    // Excalidraw soft-deletes on undo; the element stays in the scene
    expect(h.elements[0].isDeleted).toBe(true);
    expect(api().history.canUndo()).toBe(false);
    expect(api().history.canRedo()).toBe(true);

    act(() => api().history.redo());

    expect(h.elements[0].isDeleted).toBe(false);
    expect(api().history.canUndo()).toBe(true);
    expect(api().history.canRedo()).toBe(false);
  });

  it("undo()/redo() are no-ops when the stack is empty", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);

    expect(() => act(() => api().history.undo())).not.toThrow();
    expect(() => act(() => api().history.redo())).not.toThrow();
    expect(h.elements.length).toBe(0);
  });

  it("undo() takes the same path as Ctrl+Z (undoing a drawn element)", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);

    drawRect();
    expect(h.elements[0].isDeleted).toBe(false);

    act(() => api().history.undo());
    expect(h.elements[0].isDeleted).toBe(true);

    // the shortcut redoes what the API undid
    Keyboard.redo();
    expect(h.elements[0].isDeleted).toBe(false);
  });
});
