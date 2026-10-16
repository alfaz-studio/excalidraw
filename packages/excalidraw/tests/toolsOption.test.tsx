// SONACOVE: UIOptions.tools widened to every tool — tests for the D14 patch.
import React from "react";

import { Excalidraw } from "../index";

import { Keyboard } from "./helpers/ui";
import { act, fireEvent, render } from "./test-utils";

const { h } = window;

const queryTool = (type: string) =>
  document.querySelector(`[data-testid="toolbar-${type}"]`);

describe("UIOptions.tools (D14)", () => {
  it("hides a main-row tool button", async () => {
    await render(<Excalidraw UIOptions={{ tools: { rectangle: false } }} />);

    expect(queryTool("rectangle")).toBeNull();
    expect(queryTool("ellipse")).not.toBeNull();
  });

  it("hides an extra-tools entry", async () => {
    await render(<Excalidraw UIOptions={{ tools: { frame: false } }} />);

    fireEvent.click(
      document.querySelector(".App-toolbar__extra-tools-trigger")!,
    );
    expect(queryTool("frame")).toBeNull();
    expect(queryTool("embeddable")).not.toBeNull();
  });

  it("refuses to activate a disabled tool through setActiveTool", async () => {
    await render(<Excalidraw UIOptions={{ tools: { ellipse: false } }} />);

    act(() => h.app.setActiveTool({ type: "ellipse" }));

    expect(h.state.activeTool.type).not.toBe("ellipse");
  });

  it("refuses to activate a disabled tool through its shortcut", async () => {
    await render(
      <Excalidraw
        handleKeyboardGlobally={true}
        UIOptions={{ tools: { diamond: false } }}
      />,
    );

    Keyboard.keyPress("d");

    expect(h.state.activeTool.type).not.toBe("diamond");
  });

  it("keeps every tool when nothing is disabled", async () => {
    await render(<Excalidraw />);

    expect(queryTool("rectangle")).not.toBeNull();
    expect(queryTool("ellipse")).not.toBeNull();
  });
});
