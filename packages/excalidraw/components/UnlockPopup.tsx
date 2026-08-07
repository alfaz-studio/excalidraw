import { clamp } from "@excalidraw/math";

import {
  CaptureUpdateAction,
  getCommonBounds,
  getElementsInGroup,
  newElementWith,
  selectGroupsFromGivenElements,
} from "@excalidraw/element";
import { sceneCoordsToViewportCoords } from "@excalidraw/common";

import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import {
  actionBringToFront,
  actionDeleteSelected,
  actionDuplicateSelection,
  actionSendToBack,
  actionToggleElementLock,
} from "../actions";
import { t } from "../i18n";

import { ToolButton } from "./ToolButton";

import "./UnlockPopup.scss";

import {
  DotsHorizontalIcon,
  LayersArrowUpIcon,
  DuplicatePlusIcon,
  LockedIconFilled,
  LayersArrowDownIcon,
  TrashIcon,
  UnlockedIcon,
} from "./icons";

import type { Action } from "../actions/types";
import type App from "./App";

import type { AppState } from "../types";

/** Breathing room between the bar and the element, and the canvas edges. */
const ELEMENT_GAP = 12;
const EDGE_MARGIN = 8;

/**
 * The floating bar for the element the user is focused on.
 *
 * SONACOVE: upstream this was unlock-only — shown over a locked element and
 * gone the moment you unlocked it. Images on a shared board are auto-locked
 * so the eraser cannot wipe them, which made "why can't I move this?" the
 * common confusion, and the answer once unlocked was a properties panel on
 * the far side of the screen. It now carries the actions people reach for,
 * next to the element, and outlives the unlock (see `actionElementLock`).
 *
 * Delete is disabled while locked — a UI guard only; neither delete nor
 * duplicate inspects `locked`.
 */
const UnlockPopup = ({
  app,
  activeLockedId,
}: {
  app: App;
  activeLockedId: NonNullable<AppState["activeLockedId"]>;
}) => {
  const barRef = useRef<HTMLDivElement>(null);

  // Popover closes on a document `pointerdown`, which lands before the click,
  // so the button that opened it would close and immediately reopen it. Read
  // on the way down, acted on on the way up — that makes it a toggle.
  const menuWasOpenRef = useRef(false);

  const [barSize, setBarSize] = useState({ width: 0, height: 0 });

  // Measured once, before paint: clamping needs the real width, and the button
  // set is fixed so it cannot change while this stays mounted.
  useLayoutEffect(() => {
    const node = barRef.current;

    if (!node) {
      return;
    }

    setBarSize({ width: node.offsetWidth, height: node.offsetHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const element = app.scene.getElement(activeLockedId);

  const elements =
    element && !element.isDeleted
      ? [element]
      : getElementsInGroup(
          app.scene.getNonDeletedElementsMap(),
          activeLockedId,
        );

  if (elements.length === 0) {
    return null;
  }

  const locked = elements.some((el) => el.locked);

  const [x, y, , y2] = getCommonBounds(elements);
  const { x: viewX, y: viewY } = sceneCoordsToViewportCoords(
    { sceneX: x, sceneY: y },
    app.state,
  );
  const { y: viewY2 } = sceneCoordsToViewportCoords(
    { sceneX: x, sceneY: y2 },
    app.state,
  );

  // SONACOVE: clamped to the canvas, flipping below the element when there is
  // no room above. Anchored to the element's top-left, an element against an
  // edge took the bar off-canvas with it — and the clipped part was the lock
  // button, leaving no way to unlock and so no way to move it back.
  // lands it at the margin rather than off the opposite edge.
  const clampToCanvas = (value: number, max: number) =>
    clamp(value, EDGE_MARGIN, Math.max(EDGE_MARGIN, max));

  const left = clampToCanvas(
    viewX - app.state.offsetLeft,
    app.state.width - barSize.width - EDGE_MARGIN,
  );

  const above = viewY - app.state.offsetTop - barSize.height - ELEMENT_GAP;
  const below = viewY2 - app.state.offsetTop + ELEMENT_GAP;
  const top = clampToCanvas(
    above < EDGE_MARGIN ? below : above,
    app.state.height - barSize.height - EDGE_MARGIN,
  );

  /**
   * Runs an action against these elements.
   *
   * A locked element is never in the selection by any normal route, so it is
   * put there, the action runs, and anything still locked is deselected again.
   * `flushSync` so the action reads this selection, not the last render's.
   */
  const run = (action: Action) => {
    flushSync(() => {
      app.setState({
        selectedElementIds: Object.fromEntries(
          elements.map((el) => [el.id, true]),
        ),
        selectedGroupIds: selectGroupsFromGivenElements(elements, app.state),
      });
    });

    const before = new Set(
      app.scene.getElementsIncludingDeleted().map((el) => el.id),
    );

    app.actionManager.executeAction(action);

    // The lock toggle manages the selection itself, and delete leaves nothing
    // to deselect.
    if (action === actionToggleElementLock) {
      return;
    }

    // Nothing left to point at. Without this the bar hangs over the gap where
    // the element was until the next click somewhere lands and clears it.
    if (action === actionDeleteSelected) {
      app.setState({ activeLockedId: null });

      return;
    }

    // A duplicate arrives UNLOCKED whatever the original was: the copy lands
    // offset and the next thing anyone does is drag it, so inheriting the lock
    // made that a two-step every time.
    if (action === actionDuplicateSelection) {
      // Found by diffing the SCENE, not by reading `selectedElementIds`:
      // `executeAction` ends in a setState React batches to the end of this
      // handler, so that still holds the ids set above — the ORIGINALS — and
      // unlocking those inverts the whole thing. The scene is synchronous.
      const copies = app.scene
        .getElementsIncludingDeleted()
        .filter((el) => !before.has(el.id));

      if (copies.length > 0) {
        const copyIds = new Set(copies.map((el) => el.id));

        app.updateScene({
          elements: app.scene
            .getElementsIncludingDeleted()
            .map((el) =>
              copyIds.has(el.id) ? newElementWith(el, { locked: false }) : el,
            ),
          appState: { activeLockedId: copies[0].id },
          // Folded into the entry the duplicate itself captured — a second
          // IMMEDIATELY made one duplicate cost two undos.
          captureUpdate: CaptureUpdateAction.NEVER,
        });
      }

      return;
    }

    if (locked) {
      app.setState({ selectedElementIds: {}, selectedGroupIds: {} });
    }
  };

  const buttons: {
    key: string;
    label: string;
    // Inferred from an icon rather than annotated: `createIcon` returns the
    // ambient JSX.Element, which is not assignable to React's own ReactNode
    // under the types this package builds against.
    icon: typeof LockedIconFilled;
    onClick: () => void;
    onPointerDown?: () => void;
    /** Rendered as an engaged toggle rather than an idle button. */
    active?: boolean;
    danger?: boolean;
    disabled?: boolean;
  }[] = [
    {
      key: "lock",
      label: locked
        ? t("labels.elementLock.unlock")
        : t("labels.elementLock.lock"),
      icon: locked ? LockedIconFilled : UnlockedIcon,
      onClick: () => run(actionToggleElementLock),
      // Locked is a STATE the element is being held in, not a thing that just
      // happened — so the button reads as pressed for as long as it holds,
      // rather than relying on the reader noticing which of two padlock glyphs
      // is showing.
      active: locked,
    },
    {
      key: "duplicate",
      label: t("labels.duplicateSelection"),
      icon: DuplicatePlusIcon,
      onClick: () => run(actionDuplicateSelection),
    },
    {
      key: "front",
      label: t("labels.bringToFront"),
      icon: LayersArrowUpIcon,
      onClick: () => run(actionBringToFront),
    },
    {
      key: "back",
      label: t("labels.sendToBack"),
      icon: LayersArrowDownIcon,
      onClick: () => run(actionSendToBack),
    },
    {
      key: "delete",
      label: t("labels.delete"),
      icon: TrashIcon,
      onClick: () => run(actionDeleteSelected),
      // The only irreversible button here; it should not look like its
      // neighbours.
      danger: true,
      // Locking exists to stop the board's shared images being destroyed;
      // offering Delete a click away from that would undo the point of it.
      disabled: locked,
    },
    {
      key: "more",
      label: t("labels.more_options"),
      icon: DotsHorizontalIcon,
      // The editor's own context menu, not a curated copy — so the two cannot
      // drift as actions are added. Its box goes along, letting the menu sit
      // below or above depending on room; a bare point let `fitInViewport`
      // bottom-align a tall menu over the bar that opened it.
      onPointerDown: () => {
        menuWasOpenRef.current = Boolean(app.state.contextMenu);
      },
      onClick: () => {
        if (menuWasOpenRef.current) {
          menuWasOpenRef.current = false;

          return;
        }

        app.showContextMenu({
          element: elements[0],
          type: "element",
          top,
          left,
          anchor: { top, bottom: top + barSize.height },
        });
      },
    },
  ];

  return (
    <div
      ref={barRef}
      className="UnlockPopup"
      style={{
        top: `${top}px`,
        left: `${left}px`,
        // Nothing to clamp against until the first measure; showing it at the
        // raw anchor for one frame is the flicker this avoids.
        visibility: barSize.width === 0 ? "hidden" : undefined,
      }}
    >
      {buttons.map(
        ({
          key,
          label,
          icon,
          onClick,
          onPointerDown,
          active,
          danger,
          disabled,
        }) => (
          <ToolButton
            key={key}
            type="icon"
            icon={icon}
            title={label}
            aria-label={label}
            selected={active}
            disabled={disabled}
            className={danger ? "UnlockPopup__danger" : undefined}
            onPointerDown={onPointerDown}
            onClick={onClick}
          />
        ),
      )}
    </div>
  );
};

export default UnlockPopup;
