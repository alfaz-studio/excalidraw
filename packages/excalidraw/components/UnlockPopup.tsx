import {
  getCommonBounds,
  getElementsInGroup,
  selectGroupsFromGivenElements,
} from "@excalidraw/element";
import { sceneCoordsToViewportCoords } from "@excalidraw/common";

import { useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import { flushSync } from "react-dom";

import {
  actionBringToFront,
  actionDeleteSelected,
  actionDuplicateSelection,
  actionSendToBack,
  actionToggleElementLock,
} from "../actions";
import { t } from "../i18n";

import "./UnlockPopup.scss";

import {
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
 * SONACOVE: upstream this was an unlock-only affordance, shown over a locked
 * element and gone the moment you unlocked it. Images on a shared board are
 * auto-locked so the eraser can't wipe them, which made "why can't I move
 * this?" the single most common confusion — and the answer, once unlocked, was
 * a properties panel on the far side of the screen. So it now carries the
 * actions people actually reach for, next to the element, and it outlives the
 * unlock (see `actionElementLock`).
 *
 * Delete is disabled while the element is locked. That is a UI guard only —
 * neither `actionDeleteSelected` nor `actionDuplicateSelection` inspects
 * `locked`, so nothing in the engine enforces it.
 */
const UnlockPopup = ({
  app,
  activeLockedId,
}: {
  app: App;
  activeLockedId: NonNullable<AppState["activeLockedId"]>;
}) => {
  const barRef = useRef<HTMLDivElement>(null);
  const [barSize, setBarSize] = useState({ width: 0, height: 0 });

  // Measured rather than assumed: the bar's width depends on how many buttons
  // it renders, and clamping it inside the canvas needs its real size. A layout
  // effect runs before paint, so the corrected position is the first one drawn.
  //
  // Measured once — the button set is fixed, so the size cannot change while
  // this stays mounted, and re-measuring every render would mean a setState on
  // every scroll and zoom frame.
  useLayoutEffect(() => {
    const node = barRef.current;

    if (!node) {
      return;
    }

    setBarSize({ width: node.offsetWidth, height: node.offsetHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const element = app.scene.getElement(activeLockedId);

  const elements = element
    ? [element]
    : getElementsInGroup(app.scene.getNonDeletedElementsMap(), activeLockedId);

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

  // SONACOVE: clamped to the canvas, and flipped below the element when there
  // is no room above.
  //
  // The bar is anchored to the element's top-left corner, so an element pushed
  // against an edge took the bar off-canvas with it — drop an image half off
  // the left of the board and the lock button itself was the part clipped away,
  // leaving no way to unlock and therefore no way to move it back. Position is
  // resolved in viewport coordinates so both axes can be bounded.
  //
  // `left` is the element's, pulled back inside the canvas. `top` prefers above
  // the element, falls to below when that would clip, and is bounded either way
  // so a viewport shorter than the element still lands the bar on-screen.
  // `max` is itself floored, so a viewport too small to hold the bar still
  // lands it at the margin rather than off the opposite edge.
  const clamp = (value: number, max: number) =>
    Math.min(Math.max(EDGE_MARGIN, value), Math.max(EDGE_MARGIN, max));

  const left = clamp(
    viewX - app.state.offsetLeft,
    app.state.width - barSize.width - EDGE_MARGIN,
  );

  const above = viewY - app.state.offsetTop - barSize.height - ELEMENT_GAP;
  const below = viewY2 - app.state.offsetTop + ELEMENT_GAP;
  const top = clamp(
    above < EDGE_MARGIN ? below : above,
    app.state.height - barSize.height - EDGE_MARGIN,
  );

  /**
   * Runs an action against these elements.
   *
   * Everything here is selection-driven, and a locked element is never in the
   * selection by any normal route — so it is put there, the action runs, and
   * for anything still locked afterwards the selection is dropped again. Left
   * in place it would be a locked element sitting selected, which the editor
   * otherwise never produces and which the next click would have to unpick.
   *
   * `flushSync` so the action reads the selection this sets rather than the
   * one from the previous render.
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

    app.actionManager.executeAction(action);

    // The lock toggle manages the selection itself, and delete leaves nothing
    // to deselect.
    if (action === actionToggleElementLock || action === actionDeleteSelected) {
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
    action: Action;
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
      action: actionToggleElementLock,
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
      action: actionDuplicateSelection,
    },
    {
      key: "front",
      label: t("labels.bringToFront"),
      icon: LayersArrowUpIcon,
      action: actionBringToFront,
    },
    {
      key: "back",
      label: t("labels.sendToBack"),
      icon: LayersArrowDownIcon,
      action: actionSendToBack,
    },
    {
      key: "delete",
      label: t("labels.delete"),
      icon: TrashIcon,
      action: actionDeleteSelected,
      // The only irreversible button here; it should not look like its
      // neighbours.
      danger: true,
      // Locking exists to stop the board's shared images being destroyed;
      // offering Delete a click away from that would undo the point of it.
      disabled: locked,
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
      {buttons.map(({ key, label, icon, action, active, danger, disabled }) => (
        <button
          key={key}
          type="button"
          className={clsx("UnlockPopup__button", {
            "UnlockPopup__button--active": active,
            "UnlockPopup__button--danger": danger,
          })}
          aria-pressed={active}
          title={label}
          aria-label={label}
          disabled={disabled}
          onClick={() => run(action)}
        >
          {icon}
        </button>
      ))}
    </div>
  );
};

export default UnlockPopup;
