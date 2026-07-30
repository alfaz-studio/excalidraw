// SONACOVE: element ownership — per-author edit protection.
//
// Elements carry their author in `customData.authorId`, stamped as they leave
// the collab broadcast choke point (collab/Collab.tsx). When a host passes
// `protectForeignElements`, elements authored by anyone else become read-only
// on that client: the eraser skips them, hit-testing ignores them (which also
// takes away delete, cut, move and restyle, since those act on the selection),
// marquee and lasso selection exclude them, select-all excludes them, and
// clear-canvas leaves them alone.
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
import type { ExcalidrawElement } from "@excalidraw/element/types";

import type { AppProps } from "./types";

/** Where an element records the participant that drew it. */
const ELEMENT_AUTHOR_KEY = "authorId";

/** Read an element's author, or null for elements that predate the feature. */
const getElementAuthorId = (
  element: Pick<ExcalidrawElement, "customData">,
): string | null => {
  const authorId = element.customData?.[ELEMENT_AUTHOR_KEY];

  return typeof authorId === "string" && authorId ? authorId : null;
};

/**
 * The ownership slice of the host's props.
 *
 * Derived from `AppProps` rather than redeclared, so the field names cannot drift
 * apart: every field here is optional, which means a hand-written copy would still
 * satisfy `AppProps` structurally while silently reading `undefined` — marking the
 * caller's own elements foreign.
 */
export type ElementOwnership = Pick<
  AppProps,
  "elementAuthorId" | "protectForeignElements" | "unprotectedAuthorIds"
>;

/**
 * Whether this client may edit (erase, select, move, restyle) an element.
 *
 * Protection is the baseline: everyone's strokes are theirs alone. An author opts
 * their OWN strokes out by appearing in `unprotectedAuthorIds`, which affects
 * nobody else's. Because that list is consulted per check rather than baked into
 * the element, flipping the choice also releases strokes already on the canvas.
 *
 * Exempt surfaces — the presenter's own overlay, or a moderator — pass
 * `protectForeignElements: false` and may edit anything.
 *
 * Untagged elements stay editable: they were drawn before the feature shipped, and
 * treating them as foreign would lock participants out of their own earlier work.
 */
export const canEditElement = (
  element: Pick<ExcalidrawElement, "customData">,
  ownership: ElementOwnership | undefined,
): boolean => {
  if (!ownership?.protectForeignElements) {
    return true;
  }

  const authorId = getElementAuthorId(element);

  if (authorId === null || authorId === ownership.elementAuthorId) {
    return true;
  }

  return ownership.unprotectedAuthorIds?.includes(authorId) ?? false;
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
 * from a peer) are returned untouched.
 *
 * Deliberately not `newElementWith`/`mutateElement`: those bump `version` and
 * `versionNonce`, which during reconciliation would clobber the peer's copy of
 * the very element being described.
 */
export const stampElementAuthors = <T extends ExcalidrawElement>(
  elements: T[],
  authorId: string | undefined,
): T[] => {
  if (!authorId) {
    return elements;
  }

  return elements.map((element) =>
    getElementAuthorId(element) === null
      ? {
          ...element,
          customData: { ...element.customData, [ELEMENT_AUTHOR_KEY]: authorId },
        }
      : element,
  );
};
