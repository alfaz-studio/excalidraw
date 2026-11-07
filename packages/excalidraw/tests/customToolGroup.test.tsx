import React from "react";

import { Excalidraw } from "../index";

import { UI } from "./helpers/ui";
import { fireEvent, render, unmountComponent } from "./test-utils";

import type { CustomToolGroup, ExcalidrawImperativeAPI } from "../types";

unmountComponent();

const { h } = window;

const STAMPS: CustomToolGroup = {
  title: "Stamp",
  tools: [
    { customType: "stamp:tick", title: "Tick", icon: <svg /> },
    { customType: "stamp:cross", title: "Cross", icon: <svg /> },
  ],
};

const trigger = () =>
  document.querySelector<HTMLElement>("[data-testid='toolbar-custom-tools']");

const pressOnCanvas = (x: number, y: number) => {
  const canvas = document.querySelector("canvas.interactive")!;
  fireEvent.pointerDown(canvas, { clientX: x, clientY: y });
  fireEvent.pointerUp(canvas, { clientX: x, clientY: y });
};

describe("UIOptions.customToolGroup", () => {
  let api: ExcalidrawImperativeAPI;

  beforeEach(async () => {
    localStorage.clear();
    await render(
      <Excalidraw
        UIOptions={{ customToolGroup: STAMPS }}
        onExcalidrawAPI={(excalidrawAPI) => {
          if (excalidrawAPI) {
            api = excalidrawAPI;
          }
        }}
      />,
    );
  });

  it("activates the group's first tool from the trigger", () => {
    fireEvent.click(trigger()!);

    expect(h.state.activeTool).toMatchObject({
      type: "custom",
      customType: "stamp:tick",
    });
  });

  it("activates a tool picked from the popover, and the trigger remembers it", () => {
    fireEvent.click(trigger()!);
    UI.clickOnTestId("toolbar-stamp:cross");
    expect(h.state.activeTool).toMatchObject({
      type: "custom",
      customType: "stamp:cross",
    });

    api.setActiveTool({ type: "selection" });
    fireEvent.click(trigger()!);

    expect(h.state.activeTool).toMatchObject({
      type: "custom",
      customType: "stamp:cross",
    });
  });

  it("leaves the canvas to the host: a press adds nothing and reaches onPointerDown", () => {
    const pressedWith: string[] = [];
    api.onPointerDown((activeTool) => {
      if (activeTool.type === "custom") {
        pressedWith.push(activeTool.customType);
      }
    });

    fireEvent.click(trigger()!);
    pressOnCanvas(100, 100);

    expect(pressedWith).toEqual(["stamp:tick"]);
    expect(h.elements).toHaveLength(0);
  });

  it("reverts to selection after a press, like any other tool", () => {
    fireEvent.click(trigger()!);
    pressOnCanvas(100, 100);

    expect(h.state.activeTool.type).toBe("selection");
  });
});

describe("UIOptions.customToolGroup.stayActive", () => {
  it("keeps the picked tool for back-to-back presses", async () => {
    localStorage.clear();
    await render(
      <Excalidraw
        UIOptions={{ customToolGroup: { ...STAMPS, stayActive: true } }}
      />,
    );

    fireEvent.click(trigger()!);
    pressOnCanvas(100, 100);
    pressOnCanvas(140, 100);

    expect(h.state.activeTool).toMatchObject({
      type: "custom",
      customType: "stamp:tick",
    });
  });
});

describe("without UIOptions.customToolGroup", () => {
  it("renders no custom tool trigger", async () => {
    localStorage.clear();
    await render(<Excalidraw />);

    expect(trigger()).toBeNull();
  });
});
