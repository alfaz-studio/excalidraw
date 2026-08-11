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
 * SONACOVE: upstream this was unlock-only and vanished the moment you
 * unlocked. It now carries the actions people reach for, next to the element,
 * and outlives the unlock (see `actionElementLock`). Delete is disabled while
 * locked — a UI guard only; the actions do not inspect `locked`.
 */
const UnlockPopup = ({
  app,
  activeLockedId,
}: {
  app: App;
  activeLockedId: NonNullable<AppState["activeLockedId"]>;
}) => {
  const barRef = useRef<HTMLDivElement>(null);

  // Popover closes on a document `pointerdown`, before the click — so the
  // trigger has to read that state on the way down to act as a toggle.
  const menuWasOpenRef = useRef(false);

  const [barSize, setBarSize] = useState({ width: 0, height: 0 });

  // Measured once, before paint — clamping needs the real width.
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
  // no room above — anchored to the top-left alone, an element against an edge
  // took the bar off-canvas with it, clipping away the lock button itself.
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

    // The lock toggle manages the selection itself.
    if (action === actionToggleElementLock) {
      return;
    }

    // Nothing left to point at, or the bar hangs over the gap.
    if (action === actionDeleteSelected) {
      app.setState({ activeLockedId: null });

      return;
    }

    // A duplicate arrives UNLOCKED: the copy lands offset and the next thing
    // anyone does is drag it, so inheriting the lock made that a two-step.
    if (action === actionDuplicateSelection) {
      // Diffed off the SCENE: `executeAction` ends in a setState React batches
      // to the end of this handler, so `selectedElementIds` still holds the ids
      // set above — the ORIGINALS. The scene is synchronous.
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
          // Folded into the duplicate's own entry, or it costs two undos.
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
    // `createIcon` returns the ambient JSX.Element, not React's ReactNode.
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
      // Locked is a state the element is held in, so the button stays pressed
      // rather than relying on which padlock glyph is showing.
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
      // The only irreversible button here.
      danger: true,
      // Locking exists to stop shared images being destroyed; offering Delete
      // a click away would undo the point of it.
      disabled: locked,
    },
    {
      key: "more",
      label: t("labels.more_options"),
      icon: DotsHorizontalIcon,
      // The editor's own context menu, not a curated copy that would drift.
      // Its box goes along so the menu can sit below or above by room.
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
        // Nothing to clamp against until the first measure.
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
