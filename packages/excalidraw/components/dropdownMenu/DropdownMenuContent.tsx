import clsx from "clsx";
import React, { useCallback, useEffect, useRef } from "react";

import { EVENT, KEYS } from "@excalidraw/common";

import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";

import { useOutsideClick } from "../../hooks/useOutsideClick";
import { useStable } from "../../hooks/useStable";
import { useEditorInterface, useExcalidrawContainer } from "../App";
import { Island } from "../Island";
import Stack from "../Stack";

import { DropdownMenuContentPropsContext } from "./common";

const MenuContent = ({
  children,
  onClickOutside,
  className = "",
  onSelect,
  open = true,
  align = "end",
  style,
  eventWrapperRef,
}: {
  children?: React.ReactNode;
  onClickOutside?: () => void;
  className?: string;
  /**
   * Called when any menu item is selected (clicked on).
   */
  onSelect?: (event: Event) => void;
  open?: boolean;
  style?: React.CSSProperties;
  align?: "start" | "center" | "end";
  /**
   * The DropdownMenu event-wrapper node (trigger + content), passed by ref so
   * the outside-click check can be scoped to THIS instance even though the
   * content is portaled out of the wrapper's subtree.
   */
  eventWrapperRef?: React.RefObject<HTMLDivElement | null>;
}) => {
  const editorInterface = useEditorInterface();
  const { container } = useExcalidrawContainer();
  const menuRef = useRef<HTMLDivElement>(null);

  const callbacksRef = useStable({ onClickOutside });

  useOutsideClick(
    menuRef,
    useCallback(
      (event) => {
        // Close on clicks outside this menu, but NOT on its own trigger. The
        // content is portaled out of the trigger's subtree, so it can't reach
        // its wrapper by walking up from the menu node; matching the shared
        // DROPDOWN_MENU_EVENT_WRAPPER class on the event target would in turn
        // match every OTHER dropdown's wrapper and wrongly keep this one open.
        // Scope to this instance's wrapper node (passed down by ref).
        if (!eventWrapperRef?.current?.contains(event.target)) {
          callbacksRef.onClickOutside?.();
        }
      },
      [callbacksRef, eventWrapperRef],
    ),
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === KEYS.ESCAPE) {
        event.stopImmediatePropagation();
        callbacksRef.onClickOutside?.();
      }
    };

    const option = {
      // so that we can stop propagation of the event before it reaches
      // event handlers that were bound before this one
      capture: true,
    };

    document.addEventListener(EVENT.KEYDOWN, onKeyDown, option);
    return () => {
      document.removeEventListener(EVENT.KEYDOWN, onKeyDown, option);
    };
  }, [callbacksRef, open]);

  const classNames = clsx(`dropdown-menu ${className}`, {
    "dropdown-menu--mobile": editorInterface.formFactor === "phone",
  }).trim();

  return (
    <DropdownMenuContentPropsContext.Provider value={{ onSelect }}>
      <DropdownMenuPrimitive.Portal container={container}>
        <DropdownMenuPrimitive.Content
          ref={menuRef}
          className={classNames}
          style={style}
          data-testid="dropdown-menu"
          side="top"
          align={align}
          sideOffset={8}
          collisionBoundary={container ?? undefined}
          collisionPadding={8}
          onCloseAutoFocus={(event: Event) => event.preventDefault()}
        >
          {/* the zIndex ensures this menu has higher stacking order,
    see https://github.com/excalidraw/excalidraw/pull/1445 */}
          {editorInterface.formFactor === "phone" ? (
            <Stack.Col className="dropdown-menu-container">
              {children}
            </Stack.Col>
          ) : (
            <Island className="dropdown-menu-container" padding={2}>
              {children}
            </Island>
          )}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuContentPropsContext.Provider>
  );
};
MenuContent.displayName = "DropdownMenuContent";

export default MenuContent;
