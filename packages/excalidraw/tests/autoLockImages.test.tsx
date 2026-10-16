// SONACOVE: autoLockImages and the element action bar (UnlockPopup).
import React from "react";

import { randomId, reseed } from "@excalidraw/common";

import type { FileId } from "@excalidraw/element/types";

import * as blobModule from "../data/blob";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { mockMultipleHTMLImageElements } from "./helpers/mocks";
import { act, fireEvent, GlobalTestState, render, waitFor } from "./test-utils";
import { DEER_IMAGE_DIMENSIONS } from "./fixtures/constants";

import type { ExcalidrawProps } from "../types";

const { h } = window;

const dropDeer = async (props?: ExcalidrawProps) => {
  await render(<Excalidraw handleKeyboardGlobally={true} {...props} />);
  h.state.height = 1000;
  mockMultipleHTMLImageElements([
    [DEER_IMAGE_DIMENSIONS.width, DEER_IMAGE_DIMENSIONS.height],
  ]);

  await API.drop([
    { kind: "file", file: await API.loadFile("./fixtures/deer.png") },
  ]);
  // the image is inserted (and locked) once it has loaded
  await waitFor(() => {
    expect(h.elements).toEqual([
      expect.objectContaining({ type: "image", ...DEER_IMAGE_DIMENSIONS }),
    ]);
  });
};

const barButton = (label: string) =>
  document.querySelector<HTMLButtonElement>(
    `.UnlockPopup button[aria-label="${label}"]`,
  );

describe("autoLockImages", () => {
  beforeEach(() => {
    reseed(7);
    vi.spyOn(blobModule, "generateIdFromFile").mockImplementation(() =>
      Promise.resolve(randomId() as FileId),
    );
    vi.spyOn(blobModule, "resizeImageFile").mockImplementation((file: File) =>
      Promise.resolve(file),
    );
    Object.assign(document, {
      elementFromPoint: () => GlobalTestState.canvas,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // the Image stub extends the current global, so stubs must not stack
    vi.unstubAllGlobals();
  });

  it("locks an inserted image and opens the action bar over it", async () => {
    await dropDeer({ autoLockImages: true });

    const [image] = h.elements;

    expect(image.locked).toBe(true);
    expect(h.state.selectedElementIds).toEqual({});
    expect(h.state.activeLockedId).toBe(image.id);
    await waitFor(() => {
      expect(document.querySelector(".UnlockPopup")).not.toBeNull();
    });
    // locking exists to keep shared images from being destroyed
    expect(barButton("Delete")!.disabled).toBe(true);
  });

  it("leaves inserted images unlocked and selected by default", async () => {
    await dropDeer();

    const [image] = h.elements;

    expect(image.locked).toBe(false);
    expect(h.state.selectedElementIds).toEqual({ [image.id]: true });
  });

  it("keeps the bar open after unlocking from it", async () => {
    await dropDeer({ autoLockImages: true });
    await waitFor(() => {
      expect(barButton("Unlock")).not.toBeNull();
    });

    act(() => {
      fireEvent.click(barButton("Unlock")!);
    });

    const [image] = h.elements;

    expect(image.locked).toBe(false);
    expect(h.state.activeLockedId).toBe(image.id);
    expect(barButton("Lock")).not.toBeNull();
    expect(barButton("Delete")!.disabled).toBe(false);
  });
});
