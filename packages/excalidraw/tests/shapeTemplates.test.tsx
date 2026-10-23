import React from "react";

import { reseed } from "@excalidraw/common";

import type { ExcalidrawLineElement } from "@excalidraw/element/types";

import { Excalidraw } from "../index";

import { UI } from "./helpers/ui";
import { fireEvent, render, unmountComponent } from "./test-utils";

unmountComponent();

const { h } = window;

const pickFromShapesMenu = (tool: string) => {
  fireEvent.pointerDown(
    document.querySelector("[data-testid='toolbar-shapes']")!,
  );
  UI.clickOnTestId(`toolbar-${tool}`);
};

const drag = (from: [number, number], to: [number, number]) => {
  const canvas = document.querySelector("canvas.interactive")!;
  fireEvent.pointerDown(canvas, { clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(canvas, { clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(canvas);
};

const sceneBounds = (element: ExcalidrawLineElement) => {
  const xs = element.points.map(([x]) => element.x + x);
  const ys = element.points.map(([, y]) => element.y + y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
};

describe("shape template tools", () => {
  beforeEach(async () => {
    localStorage.clear();
    reseed(7);
    await render(<Excalidraw />);
  });

  it.each([
    ["star", true],
    ["heart", true],
    ["tick", false],
    ["cross", false],
  ])("%s fills the dragged box", (tool, closed) => {
    pickFromShapesMenu(tool);
    drag([30, 20], [130, 80]);

    expect(h.elements).toHaveLength(1);
    const element = h.elements[0] as ExcalidrawLineElement;
    expect(element.type).toBe("line");
    expect(element.polygon).toBe(closed);
    expect(sceneBounds(element)).toEqual({
      minX: 30,
      minY: 20,
      maxX: 130,
      maxY: 80,
    });
    expect(h.state.selectedElementIds).toEqual({ [element.id]: true });
    expect(h.state.activeTool.type).toBe("selection");
  });

  it("draws the same upright shape when dragged up and to the left", () => {
    pickFromShapesMenu("star");
    drag([30, 20], [130, 120]);
    pickFromShapesMenu("star");
    drag([330, 120], [230, 20]);

    const [forward, backward] = h.elements as ExcalidrawLineElement[];
    expect(backward.points).toEqual(forward.points);
    expect(backward.x - forward.x).toBe(200);
    expect(backward.y).toBe(forward.y);
  });

  it("adds nothing on a click without a drag", () => {
    pickFromShapesMenu("heart");
    drag([30, 20], [30, 20]);

    expect(h.elements.filter((element) => !element.isDeleted)).toHaveLength(0);
  });
});
