import React from "react";

import { KEYS } from "@excalidraw/common";
import { CaptureUpdateAction } from "@excalidraw/element";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { fireEvent, render } from "./test-utils";

// The meet client keeps a closed whiteboard mounted under `display: none`.
// Its global key listener must ignore keys pressed anywhere on the page.
const renderBoard = async (hidden: boolean) => {
  const result = await render(
    <div>
      <div role="tab" tabIndex={0}>
        PDF
      </div>
      <div style={{ display: hidden ? "none" : "block" }}>
        <Excalidraw handleKeyboardGlobally autoFocus />
      </div>
    </div>,
  );
  const first = API.createElement({ type: "rectangle", x: 0, y: 0 });
  const second = API.createElement({ type: "rectangle", x: 100, y: 0 });
  API.updateScene({
    elements: [first],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  API.updateScene({
    elements: [first, second],
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
  API.setSelectedElements([first]);
  const tab = result.getByRole("tab");
  tab.focus();
  return { tab, first, second };
};

const press = (
  target: Element,
  init: KeyboardEventInit & { key: string },
): boolean => {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  fireEvent(target, event);
  return event.defaultPrevented;
};

const ctrl = { [KEYS.CTRL_OR_CMD]: true } as KeyboardEventInit;

const liveElements = () => window.h.elements.filter((el) => !el.isDeleted);

describe("hidden board keyboard", () => {
  it("ignores Delete, undo, arrows and select-all while not rendered", async () => {
    const { tab, first } = await renderBoard(true);

    press(tab, { key: KEYS.DELETE });
    press(tab, { key: KEYS.BACKSPACE });
    expect(liveElements()).toHaveLength(2);

    press(tab, { key: KEYS.Z, ...ctrl });
    expect(liveElements()).toHaveLength(2);

    press(tab, { key: KEYS.ARROW_RIGHT });
    expect(API.getElement(first).x).toBe(0);

    press(tab, { key: KEYS.A, ...ctrl });
    press(tab, { key: KEYS.DELETE });
    expect(liveElements()).toHaveLength(2);
    expect(Object.keys(window.h.state.selectedElementIds)).toEqual([first.id]);

    press(tab, { key: "r" });
    expect(window.h.state.activeTool.type).toBe("selection");
  });

  it("leaves browser zoom keys to the page while not rendered", async () => {
    const { tab } = await renderBoard(true);

    const prevented = press(tab, { key: "=", code: "Equal", ...ctrl });

    expect(prevented).toBe(false);
    expect(window.h.state.zoom.value).toBe(1);
  });

  it("keeps acting on the same keys once rendered, without focus in the canvas", async () => {
    const { tab, first } = await renderBoard(false);

    expect(press(tab, { key: "=", code: "Equal", ...ctrl })).toBe(true);
    expect(window.h.state.zoom.value).toBeGreaterThan(1);

    press(tab, { key: KEYS.ARROW_RIGHT });
    expect(API.getElement(first).x).toBe(1);

    press(tab, { key: KEYS.DELETE });
    expect(liveElements()).toHaveLength(1);

    press(tab, { key: KEYS.Z, ...ctrl });
    expect(liveElements()).toHaveLength(2);

    press(tab, { key: KEYS.A, ...ctrl });
    press(tab, { key: KEYS.DELETE });
    expect(liveElements()).toHaveLength(0);
  });
});
