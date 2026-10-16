// SONACOVE: embeds load under the host's COEP `require-corp`.
import React from "react";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import {
  fireEvent,
  mockBoundingClientRect,
  render,
  restoreOriginalGetBoundingClientRect,
  waitFor,
} from "./test-utils";

// the link must be there when the embed is first validated, so it is set on
// the element rather than with API.updateElement afterwards
const youtubeEmbed = (id: string) => ({
  ...API.createElement({
    type: "embeddable",
    id,
    x: 0,
    y: 0,
    width: 480,
    height: 270,
  }),
  link: "https://www.youtube.com/watch?v=gkGMXY0wekg",
});

describe("embed iframes", () => {
  afterEach(() => {
    restoreOriginalGetBoundingClientRect();
  });

  it("are credentialless, so they load under COEP require-corp", async () => {
    mockBoundingClientRect({ width: 1200, height: 800 });
    await render(<Excalidraw />);

    API.setElements([youtubeEmbed("E")]);

    await waitFor(() => {
      const iframe = document.querySelector("iframe.excalidraw__embeddable");
      expect(iframe).not.toBeNull();
      expect(iframe!.hasAttribute("credentialless")).toBe(true);
    });
  });

  it("activate a newly added embed and move it by its drag bar", async () => {
    mockBoundingClientRect({ width: 1200, height: 800 });
    await render(<Excalidraw />);

    API.setElements([youtubeEmbed("E")]);

    await waitFor(() => {
      expect(window.h.state.activeEmbeddable?.element.id).toBe("E");
      expect(window.h.state.activeEmbeddable?.state).toBe("active");
    });
    expect(window.h.state.selectedElementIds).toEqual({ E: true });

    const dragBar = document.querySelector(".excalidraw__embeddable-dragbar")!;
    expect(dragBar).not.toBeNull();

    fireEvent.pointerDown(dragBar, { clientX: 100, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 160, clientY: 50 });
    fireEvent.pointerUp(window, { clientX: 160, clientY: 50 });

    const zoom = window.h.state.zoom.value;
    expect(window.h.elements[0].x).toBeCloseTo(60 / zoom);
    expect(window.h.elements[0].y).toBeCloseTo(40 / zoom);
  });
});
