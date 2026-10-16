// SONACOVE: embeds load under the host's COEP `require-corp`.
import React from "react";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import {
  mockBoundingClientRect,
  render,
  restoreOriginalGetBoundingClientRect,
  waitFor,
} from "./test-utils";

describe("embed iframes", () => {
  afterEach(() => {
    restoreOriginalGetBoundingClientRect();
  });

  it("are credentialless, so they load under COEP require-corp", async () => {
    mockBoundingClientRect({ width: 1200, height: 800 });
    await render(<Excalidraw />);

    // the link must be there when the embed is first validated
    API.setElements([
      {
        ...API.createElement({
          type: "embeddable",
          x: 0,
          y: 0,
          width: 480,
          height: 270,
        }),
        link: "https://www.youtube.com/watch?v=gkGMXY0wekg",
      },
    ]);

    await waitFor(() => {
      const iframe = document.querySelector("iframe.excalidraw__embeddable");
      expect(iframe).not.toBeNull();
      expect(iframe!.hasAttribute("credentialless")).toBe(true);
    });
  });
});
