import React from "react";

import { actionClearCanvas, actionSelectAll } from "../actions";
import { canEditElement, stampElementAuthors } from "../elementOwnership";
import { Excalidraw } from "../index";

import { API } from "./helpers/api";
import { Keyboard, UI } from "./helpers/ui";
import { render, waitFor } from "./test-utils";

const { h } = window;

const TEACHER = "teacher-1";
const STUDENT = "student-1";

// API.createElement builds from a field whitelist that excludes customData, so
// the author has to be attached afterwards or it is silently dropped.
const elementBy = (id: string, authorId?: string) => {
  const element = API.createElement({ type: "rectangle", id });

  return authorId ? { ...element, customData: { authorId } } : element;
};

describe("elementOwnership", () => {
  describe("canEditElement", () => {
    it("allows everything when protection is off", () => {
      const foreign = elementBy("a", TEACHER);

      expect(canEditElement(foreign, undefined)).toBe(true);
      expect(canEditElement(foreign, { elementAuthorId: STUDENT })).toBe(true);
    });

    it("blocks foreign elements and allows own when protection is on", () => {
      const ownership = {
        elementAuthorId: STUDENT,
        protectForeignElements: true,
      };

      expect(canEditElement(elementBy("a", TEACHER), ownership)).toBe(false);
      expect(canEditElement(elementBy("b", STUDENT), ownership)).toBe(true);
    });

    it("treats untagged elements as editable", () => {
      // Drawn before the feature shipped — locking these out would take away a
      // participant's own earlier strokes.
      expect(
        canEditElement(elementBy("a"), {
          elementAuthorId: STUDENT,
          protectForeignElements: true,
        }),
      ).toBe(true);
    });

    it("reads the same field name AppProps uses", () => {
      // Regression guard: ElementOwnership's fields are all optional, so a
      // renamed field still typechecks against AppProps while silently reading
      // undefined — which would mark the caller's OWN elements foreign.
      expect(
        canEditElement(elementBy("a", STUDENT), {
          elementAuthorId: STUDENT,
          protectForeignElements: true,
        }),
      ).toBe(true);
    });
  });

  describe("stampElementAuthors", () => {
    it("stamps only untagged elements and preserves peers' authors", () => {
      const [own, peer] = [elementBy("a"), elementBy("b", TEACHER)];
      const stamped = stampElementAuthors([own, peer], STUDENT);

      expect(stamped[0].customData?.authorId).toBe(STUDENT);
      expect(stamped[1].customData?.authorId).toBe(TEACHER);
    });

    it("preserves array identity when nothing needs stamping", () => {
      const elements = [elementBy("a", TEACHER)];

      expect(stampElementAuthors(elements, STUDENT)).toBe(elements);
    });

    it("is a no-op without an author id", () => {
      const elements = [elementBy("a")];

      expect(stampElementAuthors(elements, undefined)).toBe(elements);
    });

    it("does not bump version, so a peer's copy can't be clobbered", () => {
      const own = elementBy("a");
      const [stamped] = stampElementAuthors([own], STUDENT);

      expect(stamped.version).toBe(own.version);
      expect(stamped.versionNonce).toBe(own.versionNonce);
    });
  });

  describe("enforcement in the editor", () => {
    const renderProtected = async () => {
      await render(
        <Excalidraw elementAuthorId={STUDENT} protectForeignElements={true} />,
      );

      API.setElements([
        elementBy("mine", STUDENT),
        elementBy("theirs", TEACHER),
      ]);

      await waitFor(() => {
        expect(h.elements.length).toBe(2);
      });
    };

    it("keeps foreign elements out of select-all", async () => {
      await renderProtected();

      API.executeAction(actionSelectAll);

      expect(Object.keys(h.state.selectedElementIds)).toEqual(["mine"]);
    });

    it("leaves foreign elements standing on clear-canvas", async () => {
      await renderProtected();

      API.executeAction(actionClearCanvas);

      const byId = new Map(h.elements.map((el) => [el.id, el]));

      expect(byId.get("mine")!.isDeleted).toBe(true);
      expect(byId.get("theirs")!.isDeleted).toBe(false);
    });

    it("undo after a clear cannot resurrect a foreign element", async () => {
      // Mirrors the real shape: the caller DREW their element (so it is in local
      // history), while the foreign one arrived over collab — applied with
      // CaptureUpdateAction.NEVER (collab/Collab.tsx), so it never enters history
      // and no undo can bring it back or take it away.
      await render(
        <Excalidraw elementAuthorId={STUDENT} protectForeignElements={true} />,
      );

      UI.createElement("freedraw", { x: 0, y: 0, width: 50, height: 50 });

      const ownId = h.elements[0].id;

      API.setElements([...h.elements, elementBy("theirs", TEACHER)]);
      await waitFor(() => {
        expect(h.elements.length).toBe(2);
      });

      API.executeAction(actionClearCanvas);

      const clearedById = new Map(h.elements.map((el) => [el.id, el]));

      expect(clearedById.get(ownId)!.isDeleted).toBe(true);
      expect(clearedById.get("theirs")!.isDeleted).toBe(false);

      Keyboard.undo();

      const undoneById = new Map(h.elements.map((el) => [el.id, el]));

      // The security property: undo is not a bypass. It cannot delete a foreign
      // element, nor resurrect one the presenter removed.
      //
      // Whether the caller's OWN element comes back is deliberately not asserted:
      // API.setElements replaces the scene without a history entry, so the chain
      // between the draw and the clear is broken in the harness in a way it is not
      // in the app.
      expect(undoneById.get("theirs")!.isDeleted).toBe(false);
      expect(undoneById.has(ownId)).toBe(true);
    });

    it("clears everything once protection is toggled off", async () => {
      await render(
        <Excalidraw elementAuthorId={STUDENT} protectForeignElements={false} />,
      );

      API.setElements([
        elementBy("mine", STUDENT),
        elementBy("theirs", TEACHER),
      ]);

      await waitFor(() => {
        expect(h.elements.length).toBe(2);
      });

      API.executeAction(actionSelectAll);
      expect(Object.keys(h.state.selectedElementIds).sort()).toEqual([
        "mine",
        "theirs",
      ]);

      API.executeAction(actionClearCanvas);
      expect(h.elements.every((el) => el.isDeleted)).toBe(true);
    });
  });
});
