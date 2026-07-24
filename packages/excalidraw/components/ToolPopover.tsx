import React, { useEffect, useState } from "react";
import clsx from "clsx";

import { capitalizeString } from "@excalidraw/common";

import { Popover } from "radix-ui";

import { trackEvent } from "../analytics";

import { ToolButton } from "./ToolButton";

import "./ToolPopover.scss";

import { useExcalidrawContainer } from "./App";

import type { AppClassProperties } from "../types";

type ToolOption = {
  type: string;
  icon: React.ReactNode;
  title?: string;
};

type ToolPopoverProps = {
  app: AppClassProperties;
  options: readonly ToolOption[];
  activeTool: { type: string };
  defaultOption: string;
  className?: string;
  wrapperClassName?: string;
  namePrefix: string;
  title: string;
  "data-testid": string;
  onToolChange: (type: string) => void;
  displayedOption: ToolOption;
  fillable?: boolean;
};

export const ToolPopover = ({
  app,
  options,
  activeTool,
  defaultOption,
  className = "Shape",
  wrapperClassName,
  namePrefix,
  title,
  "data-testid": dataTestId,
  onToolChange,
  displayedOption,
  fillable = false,
}: ToolPopoverProps) => {
  const [isPopupOpen, setIsPopupOpen] = useState(false);
  const currentType = activeTool.type;
  const isActive = displayedOption.type === currentType;
  const SIDE_OFFSET = 32 / 2 + 10;
  const { container } = useExcalidrawContainer();

  // Close popup when user actively switches to a tool outside this group
  const prevType = React.useRef(currentType);
  useEffect(() => {
    if (prevType.current !== currentType) {
      prevType.current = currentType;
      if (isPopupOpen && !options.some((o) => o.type === currentType)) {
        setIsPopupOpen(false);
      }
    }
    // Only re-run when the active tool type changes, not when options/isPopupOpen change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentType]);

  // Close popover when user starts interacting with the canvas (pointer down)
  useEffect(() => {
    // app.onPointerDownEmitter emits when pointer down happens on canvas area
    const unsubscribe = app.onPointerDownEmitter.on(() => {
      setIsPopupOpen(false);
    });
    return () => unsubscribe?.();
  }, [app]);

  const popover = (
    <Popover.Root open={isPopupOpen}>
      <Popover.Trigger asChild>
        <ToolButton
          className={clsx(className, {
            fillable,
            active: options.some((o) => o.type === activeTool.type),
          })}
          type="radio"
          icon={displayedOption.icon}
          checked={isActive}
          name="editor-current-shape"
          title={title}
          aria-label={title}
          data-testid={dataTestId}
          onPointerDown={() => {
            // A single click on the trigger both toggles the group popover AND
            // activates the displayed (last-used) linear tool. Without the
            // setActiveTool, clicking the Arrow/Line group only opened/closed the
            // popover and never selected a tool, so users had to click twice (open
            // popover, then pick the tool) just to start drawing an arrow — they
            // reported "the arrow needs repeated clicks to activate" (issue
            // 019ea26f). Selecting on click restores single-click activation while
            // the popover still lets them switch between Arrow and Line.
            if (app.state.activeTool.type !== displayedOption.type) {
              trackEvent("toolbar", displayedOption.type, "ui");
              app.setActiveTool({ type: displayedOption.type as any });
              onToolChange?.(displayedOption.type);
            }
            setIsPopupOpen((v) => !v);
          }}
        />
      </Popover.Trigger>

      <Popover.Portal container={container}>
        <Popover.Content
          className="tool-popover-content"
          sideOffset={SIDE_OFFSET}
          collisionBoundary={container ?? undefined}
          collisionPadding={8}
        >
          {options.map(({ type, icon, title }) => (
            <ToolButton
              className={clsx(className, {
                active: currentType === type,
              })}
              key={type}
              type="radio"
              icon={icon}
              checked={currentType === type}
              name={`${namePrefix}-option`}
              title={title || capitalizeString(type)}
              keyBindingLabel=""
              aria-label={title || capitalizeString(type)}
              data-testid={`toolbar-${type}`}
              onChange={() => {
                if (app.state.activeTool.type !== type) {
                  trackEvent("toolbar", type, "ui");
                }
                app.setActiveTool({ type: type as any });
                onToolChange?.(type);
              }}
            />
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );

  if (wrapperClassName) {
    return <div className={wrapperClassName}>{popover}</div>;
  }
  return popover;
};
