import {
  getCommonBounds,
  getElementsInGroup,
  selectGroupsFromGivenElements,
} from "@excalidraw/element";
import { sceneCoordsToViewportCoords } from "@excalidraw/common";

import { flushSync } from "react-dom";

import type { ExcalidrawElement } from "@excalidraw/element/types";

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
  BringToFrontIcon,
  DuplicateIcon,
  LockedIconFilled,
  SendToBackIcon,
  TrashIcon,
  UnlockedIcon,
} from "./icons";

import type { Action } from "../actions/types";
import type App from "./App";

import type { AppState } from "../types";

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
  const element = app.scene.getElement(activeLockedId);

  const elements = element
    ? [element]
    : getElementsInGroup(app.scene.getNonDeletedElementsMap(), activeLockedId);

  if (elements.length === 0) {
    return null;
  }

  const locked = elements.some((el) => el.locked);

  const [x, y] = getCommonBounds(elements);
  const { x: viewX, y: viewY } = sceneCoordsToViewportCoords(
    { sceneX: x, sceneY: y },
    app.state,
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
  const run = (
    action: Action,
    elementsToActOn: readonly ExcalidrawElement[],
  ) => {
    flushSync(() => {
      const groupIds = selectGroupsFromGivenElements(
        elementsToActOn,
        app.state,
      );

      app.setState({
        selectedElementIds: elementsToActOn.reduce(
          (acc, el) => ({
            ...acc,
            [el.id]: true,
          }),
          {},
        ),
        selectedGroupIds: groupIds,
      });
    });

    app.actionManager.executeAction(action);

    // The lock toggle manages the selection itself, and delete leaves nothing
    // to deselect.
    if (action === actionToggleElementLock || action === actionDeleteSelected) {
      return;
    }

    if (elementsToActOn.some((el) => el.locked)) {
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
    disabled?: boolean;
  }[] = [
    {
      key: "lock",
      label: locked
        ? t("labels.elementLock.unlock")
        : t("labels.elementLock.lock"),
      icon: locked ? LockedIconFilled : UnlockedIcon,
      action: actionToggleElementLock,
    },
    {
      key: "duplicate",
      label: t("labels.duplicateSelection"),
      icon: DuplicateIcon,
      action: actionDuplicateSelection,
    },
    {
      key: "front",
      label: t("labels.bringToFront"),
      icon: BringToFrontIcon,
      action: actionBringToFront,
    },
    {
      key: "back",
      label: t("labels.sendToBack"),
      icon: SendToBackIcon,
      action: actionSendToBack,
    },
    {
      key: "delete",
      label: t("labels.delete"),
      icon: TrashIcon,
      action: actionDeleteSelected,
      // Locking exists to stop the board's shared images being destroyed;
      // offering Delete a click away from that would undo the point of it.
      disabled: locked,
    },
  ];

  return (
    <div
      className="UnlockPopup"
      style={{
        bottom: `${app.state.height + 12 - viewY + app.state.offsetTop}px`,
        left: `${viewX - app.state.offsetLeft}px`,
      }}
    >
      {buttons.map(({ key, label, icon, action, disabled }) => (
        <button
          key={key}
          type="button"
          className="UnlockPopup__button"
          title={label}
          aria-label={label}
          disabled={disabled}
          onClick={() => run(action, elements)}
        >
          {icon}
        </button>
      ))}
    </div>
  );
};

export default UnlockPopup;
