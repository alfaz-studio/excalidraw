// SONACOVE: UIOptions.hideToolbar — tests for the D13 host flag.
import React from "react";

import { Excalidraw } from "../index";

import { act, render } from "./test-utils";

const { h } = window;

describe("UIOptions.hideToolbar (D13)", () => {
  it("hides the tool row while keeping the menu and footer", async () => {
    await render(<Excalidraw UIOptions={{ hideToolbar: true }} />);

    expect(document.querySelector('[data-testid="toolbar-hand"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="toolbar-rectangle"]'),
    ).toBeNull();

    expect(document.querySelector(".layer-ui__wrapper__footer")).not.toBeNull();
    expect(document.querySelector(".zoom-in-button")).not.toBeNull();
    expect(document.querySelector(".undo-redo-buttons")).not.toBeNull();
  });

  it("shows the tool row by default", async () => {
    await render(<Excalidraw />);

    expect(
      document.querySelector('[data-testid="toolbar-hand"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="toolbar-rectangle"]'),
    ).not.toBeNull();
  });

  it("does not affect programmatic tool selection", async () => {
    await render(<Excalidraw UIOptions={{ hideToolbar: true }} />);

    act(() => h.app.setActiveTool({ type: "rectangle" }));

    expect(h.state.activeTool.type).toBe("rectangle");
  });
});
