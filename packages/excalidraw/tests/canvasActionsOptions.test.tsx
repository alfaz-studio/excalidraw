// SONACOVE: per-surface UIOptions.canvasActions knobs.
import React from "react";

import { KEYS } from "@excalidraw/common";

import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard, UI } from "./helpers/ui";
import {
  act,
  fireEvent,
  GlobalTestState,
  mockBoundingClientRect,
  render,
  restoreOriginalGetBoundingClientRect,
} from "./test-utils";

import type { Collaborator, SocketId } from "../types";

const { h } = window;

const openElementContextMenu = () => {
  const rect = API.createElement({
    type: "rectangle",
    id: "A",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    backgroundColor: "#ffc9c9",
    fillStyle: "solid",
  });
  API.setElements([rect]);
  API.setSelectedElements([rect]);
  fireEvent.contextMenu(GlobalTestState.interactiveCanvas, {
    button: 2,
    clientX: 50,
    clientY: 50,
  });
  return UI.queryContextMenu();
};

describe("UIOptions.canvasActions", () => {
  beforeAll(() => {
    mockBoundingClientRect();
  });

  afterAll(() => {
    restoreOriginalGetBoundingClientRect();
  });

  it("disableShortcuts ignores action shortcuts outside allowedShortcuts", async () => {
    await render(
      <Excalidraw
        handleKeyboardGlobally={true}
        UIOptions={{ canvasActions: { disableShortcuts: true } }}
      />,
    );
    API.setElements([API.createElement({ type: "rectangle", id: "A" })]);

    // select-all is in the default allowedShortcuts
    Keyboard.withModifierKeys({ ctrl: true }, () => {
      Keyboard.keyPress(KEYS.A);
    });
    expect(h.state.selectedElementIds).toEqual({ A: true });

    // duplicate is not
    Keyboard.withModifierKeys({ ctrl: true }, () => {
      Keyboard.keyPress(KEYS.D);
    });
    expect(h.elements).toHaveLength(1);
  });

  it("action shortcuts work by default", async () => {
    await render(<Excalidraw handleKeyboardGlobally={true} />);
    const rect = API.createElement({ type: "rectangle", id: "A" });
    API.setElements([rect]);
    API.setSelectedElements([rect]);

    Keyboard.withModifierKeys({ ctrl: true }, () => {
      Keyboard.keyPress(KEYS.D);
    });
    expect(h.elements).toHaveLength(2);
  });

  it("disableLink and hideLibraries drop their context-menu entries", async () => {
    await render(
      <Excalidraw
        UIOptions={{
          canvasActions: { disableLink: true, hideLibraries: true },
        }}
      />,
    );

    const contextMenu = openElementContextMenu();

    expect(contextMenu).not.toBeNull();
    expect(contextMenu!.querySelector('li[data-testid="hyperlink"]')).toBe(
      null,
    );
    expect(contextMenu!.querySelector('li[data-testid="addToLibrary"]')).toBe(
      null,
    );
    expect(document.querySelector(".sidebar-trigger")).toBe(null);
  });

  it("offers links and the library by default", async () => {
    await render(<Excalidraw />);

    const contextMenu = openElementContextMenu();

    expect(
      contextMenu!.querySelector('li[data-testid="hyperlink"]'),
    ).not.toBeNull();
    expect(
      contextMenu!.querySelector('li[data-testid="addToLibrary"]'),
    ).not.toBeNull();
    expect(document.querySelector(".sidebar-trigger")).not.toBeNull();
  });

  it("hideHelpDialog hides the help button", async () => {
    await render(
      <Excalidraw UIOptions={{ canvasActions: { hideHelpDialog: true } }} />,
    );

    expect(document.querySelector(".help-icon")).toBe(null);
  });

  it("hideUserList hides the collaborator list", async () => {
    const collaborators = new Map<SocketId, Collaborator>([
      ["peer" as SocketId, { username: "Peer" }],
    ]);

    await render(
      <Excalidraw
        isCollaborating={true}
        UIOptions={{ canvasActions: { hideUserList: true } }}
      />,
    );
    act(() => {
      h.app.updateScene({ collaborators });
    });

    expect(document.querySelector(".UserList")).toBe(null);
  });
});
