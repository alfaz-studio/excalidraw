// SONACOVE: element ownership — per-author edit protection.
//
// Elements carry their author in `customData.authorId`, stamped as they leave
// the collab broadcast choke point (collab/Collab.tsx). When a host passes
// `protectForeignElements`, elements authored by anyone else become read-only
// on that client: the eraser skips them, hit-testing ignores them (which also
// takes away delete, cut, move and restyle, since those act on the selection),
// select-all excludes them, and clear-canvas leaves them alone.
//
// This exists for Sonacove's screen-share annotation surfaces: a teacher shares
// their screen and annotates it, and students must be able to draw without
// wiping the teacher's work.
//
// Why not `locked`? Excalidraw's own `locked` flag already gates every one of
// those paths, which makes it tempting. But it is a user-facing convenience,
// not a permission: `actionUnlockAllElements` (context menu) and
// `actionToggleElementLock` (Cmd/Ctrl+Shift+L) let anyone clear it, and because
// `locked` is a synced element property, one student unlocking would strip the
// protection for every participant at once. Ownership is checked directly
// instead, so no UI affordance can defeat it.
//
// This is UX-level protection on a drawing surface, not a security boundary — a
// determined participant with devtools can bypass any client-side check.
import type { ElementsMap, ExcalidrawElement } from "@excalidraw/element/types";

/** Where an element records the participant that drew it. */
export const ELEMENT_AUTHOR_KEY = "authorId";

/** Read an element's author, or null for elements that predate the feature. */
export const getElementAuthorId = (
  element: Pick<ExcalidrawElement, "customData">,
): string | null => {
  const authorId = element.customData?.[ELEMENT_AUTHOR_KEY];

  return typeof authorId === "string" && authorId ? authorId : null;
};

/**
 * The ownership slice of `AppProps`. Field names MUST match the props exactly —
 * every field is optional, so `AppProps` satisfies this structurally either way
 * and a rename here would silently read `undefined` (marking the caller's own
 * elements foreign) rather than fail to compile.
 */
export type ElementOwnership = {
  /** This client's identity, or undefined when the host passes none. */
  elementAuthorId?: string;
  /** Whether foreign-authored elements are read-only here. */
  protectForeignElements?: boolean;
};

/**
 * Whether this client may edit (erase, select, move, restyle) an element.
 *
 * Unprotected surfaces — the presenter's own overlay, or any surface whose host
 * turned protection off — allow everything. Untagged elements stay editable: they
 * were drawn before the feature shipped, and treating them as foreign would lock
 * participants out of their own earlier strokes.
 */
export const canEditElement = (
  element: Pick<ExcalidrawElement, "customData">,
  ownership: ElementOwnership | undefined,
): boolean => {
  if (!ownership?.protectForeignElements) {
    return true;
  }

  const authorId = getElementAuthorId(element);

  return authorId === null || authorId === ownership.elementAuthorId;
};

/** Convenience predicate for the `!el.locked` filters this composes with. */
export const isElementEditable = (
  element: ExcalidrawElement,
  ownership: ElementOwnership | undefined,
): boolean => !element.locked && canEditElement(element, ownership);

/**
 * Stamp this client's author id onto elements that don't have one yet.
 *
 * Called on the outgoing collab path, so a locally drawn element is tagged once,
 * on its first broadcast, regardless of which tool created it — freedraw, shape,
 * text, image or paste. Elements that already carry an author (anything received
 * from a peer) are returned untouched, and the array identity is preserved when
 * nothing needs stamping so callers can skip redundant work.
 */
export const stampElementAuthors = <T extends ExcalidrawElement>(
  elements: readonly T[],
  authorId: string | undefined,
): readonly T[] => {
  if (!authorId) {
    return elements;
  }

  let changed = false;
  const stamped = elements.map((element) => {
    if (getElementAuthorId(element) !== null) {
      return element;
    }

    changed = true;

    return {
      ...element,
      customData: { ...element.customData, [ELEMENT_AUTHOR_KEY]: authorId },
    };
  });

  return changed ? stamped : elements;
};

/** `ElementsMap` variant of {@link canEditElement}, for hit-test call sites. */
export const filterEditableElements = (
  elements: ElementsMap,
  ownership: ElementOwnership | undefined,
): ExcalidrawElement[] =>
  Array.from(elements.values()).filter((element) =>
    canEditElement(element, ownership),
  );
