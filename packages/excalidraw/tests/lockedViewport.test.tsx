// SONACOVE: lockedViewport — tests for the derived-viewport lock mode.
import React from "react";

import { Excalidraw } from "../index";
import {
  getLockedViewportState,
  lockedViewportNeedsUpdate,
} from "../lockedViewport";

import { fireEvent } from "./test-utils";
import {
  mockBoundingClientRect,
  render,
  restoreOriginalGetBoundingClientRect,
  waitFor,
} from "./test-utils";

const { h } = window;

const LOCK = { width: 1920, height: 1080 };

describe("getLockedViewportState (pure math)", () => {
  it("aspect-matched canvas shows exactly the scene box (scroll = 0)", () => {
    const { scrollX, scrollY, zoom } = getLockedViewportState(LOCK, 960, 540);

    expect(zoom.value).toBeCloseTo(0.5, 10);
    expect(scrollX).toBeCloseTo(0, 10);
    expect(scrollY).toBeCloseTo(0, 10);
  });

  it("letterboxed canvas centers the scene box", () => {
    // canvas is wider than 16:9 — zoom is height-limited, extra width split
    const canvasW = 1200;
    const canvasH = 540;
    const { scrollX, scrollY, zoom } = getLockedViewportState(
      LOCK,
      canvasW,
      canvasH,
    );

    expect(zoom.value).toBeCloseTo(0.5, 10);

    // scene-box center must land at canvas center:
    // (sceneW/2 + scrollX) * zoom === canvasW/2
    expect((LOCK.width / 2 + scrollX) * zoom.value).toBeCloseTo(canvasW / 2, 8);
    expect((LOCK.height / 2 + scrollY) * zoom.value).toBeCloseTo(
      canvasH / 2,
      8,
    );
  });

  it("registers the same content fraction to the same scene coords on any canvas size", () => {
    // Two participants with aspect-matched canvases of very different sizes:
    // a given fraction of the canvas must map to the same scene point.
    const toScene = (fx: number, fy: number, w: number, h_: number) => {
      const { scrollX, scrollY, zoom } = getLockedViewportState(LOCK, w, h_);

      return {
        x: (fx * w) / zoom.value - scrollX,
        y: (fy * h_) / zoom.value - scrollY,
      };
    };

    const a = toScene(0.25, 0.75, 3456, 1944);
    const b = toScene(0.25, 0.75, 640, 360);

    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
  });

  it("does NOT clamp zoom to MIN_ZOOM for tiny canvases", () => {
    const { zoom } = getLockedViewportState(LOCK, 96, 54);

    expect(zoom.value).toBeCloseTo(0.05, 10);
  });
});

describe("lockedViewportNeedsUpdate", () => {
  const stateFor = (w: number, h_: number) => {
    const target = getLockedViewportState(LOCK, w, h_);

    return {
      width: w,
      height: h_,
      scrollX: target.scrollX,
      scrollY: target.scrollY,
      zoom: target.zoom,
    };
  };

  it("is false when already at the derived target (no ping-pong)", () => {
    expect(lockedViewportNeedsUpdate(LOCK, stateFor(960, 540))).toBe(false);
  });

  it("is true when scroll drifted", () => {
    const state = { ...stateFor(960, 540), scrollX: 10 };

    expect(lockedViewportNeedsUpdate(LOCK, state)).toBe(true);
  });

  it("is false while the canvas is unmeasured", () => {
    const state = { ...stateFor(960, 540), width: 0, height: 0 };

    expect(lockedViewportNeedsUpdate(LOCK, state)).toBe(false);
  });
});

describe("<Excalidraw lockedViewport>", () => {
  afterEach(() => {
    restoreOriginalGetBoundingClientRect();
  });

  const renderLocked = async () => {
    mockBoundingClientRect({ width: 960, height: 540 });
    await render(
      <div>
        <Excalidraw lockedViewport={LOCK} />
      </div>,
    );
    await waitFor(() => {
      expect(h.state.width).toBe(960);
      expect(h.state.zoom.value).toBeCloseTo(0.5, 6);
      expect(h.state.scrollX).toBeCloseTo(0, 4);
      expect(h.state.scrollY).toBeCloseTo(0, 4);
    });
  };

  it("derives the locked viewport once measured", async () => {
    await renderLocked();
  });

  it("ignores ctrl-wheel zoom and wheel pan", async () => {
    await renderLocked();

    fireEvent.wheel(h.app.interactiveCanvas!, {
      deltaY: -100,
      ctrlKey: true,
    });
    fireEvent.wheel(h.app.interactiveCanvas!, { deltaX: 40, deltaY: 40 });

    expect(h.state.zoom.value).toBeCloseTo(0.5, 6);
    expect(h.state.scrollX).toBeCloseTo(0, 4);
    expect(h.state.scrollY).toBeCloseTo(0, 4);
  });

  it("ignores scrollToContent", async () => {
    await renderLocked();

    h.app.scrollToContent();

    expect(h.state.zoom.value).toBeCloseTo(0.5, 6);
    expect(h.state.scrollX).toBeCloseTo(0, 4);
  });

  it("re-derives after an updateScene tries to move the viewport", async () => {
    await renderLocked();

    h.app.updateScene({
      appState: { scrollX: 500, scrollY: 500, zoom: { value: 2 as any } },
    });

    await waitFor(() => {
      expect(h.state.zoom.value).toBeCloseTo(0.5, 6);
      expect(h.state.scrollX).toBeCloseTo(0, 4);
      expect(h.state.scrollY).toBeCloseTo(0, 4);
    });
  });

  it("leaves the viewport free when the prop is absent", async () => {
    mockBoundingClientRect({ width: 960, height: 540 });
    await render(
      <div>
        <Excalidraw />
      </div>,
    );
    await waitFor(() => expect(h.state.width).toBe(960));

    fireEvent.wheel(h.app.interactiveCanvas!, { deltaX: 40, deltaY: 40 });

    expect(h.state.scrollX).not.toBeCloseTo(0, 4);
  });
});
