import React, { useEffect, useState } from "react";
import clsx from "clsx";

import { capitalizeString } from "@excalidraw/common";

import { Popover } from "radix-ui";

import { trackEvent } from "../analytics";

import { IconButton } from "./IconButton";
import { isToolButtonDisabled, isToolHidden } from "./Tools";

import "./ToolPopover.scss";

import { useExcalidrawContainer } from "./App";

import type { AppClassProperties } from "../types";

type ToolOption = {
  type: string;
  icon: React.ReactNode;
  title: string;
  fillable?: boolean;
};

type ToolPopoverProps = {
  app: AppClassProperties;
  options: readonly ToolOption[];
  activeTool: { type: string };
  defaultOption: string;
  className?: string;
  wrapperClassName?: string;
  namePrefix?: string;
  title?: string;
  fillable?: boolean;
  "data-testid": string;
  onToolChange: (type: string) => void;
  displayedOption: ToolOption;
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
  fillable,
  "data-testid": dataTestId,
  onToolChange,
  displayedOption,
}: ToolPopoverProps) => {
  const [isPopupOpen, setIsPopupOpen] = useState(false);
  const currentType = activeTool.type;
  const isActive = displayedOption.type === currentType;
  const SIDE_OFFSET = 16;
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

  // SONACOVE: tools switched off via `UIOptions.tools` drop out of the group;
  // the group itself disappears when nothing is left
  const visibleOptions = options.filter(
    (option) => !isToolHidden(app, option.type),
  );
  if (visibleOptions.length === 0) {
    return null;
  }

  const popover = (
    <Popover.Root open={isPopupOpen}>
      <Popover.Trigger asChild>
        <IconButton
          className={clsx({ fillable: fillable ?? displayedOption.fillable })}
          type="toggle"
          icon={displayedOption.icon}
          checked={isActive}
          disabled={options.every((option) =>
            isToolButtonDisabled(app, option.type),
          )}
          title={capitalizeString(displayedOption.title)}
          aria-label={capitalizeString(displayedOption.title)}
          data-testid={dataTestId}
          onSelect={() => {
            setIsPopupOpen((v) => !v);
            onToolChange(defaultOption);
          }}
        />
      </Popover.Trigger>

      <Popover.Portal container={container}>
        <Popover.Content
          className="tool-popover-content"
          side="top"
          sideOffset={SIDE_OFFSET}
          collisionBoundary={container ?? undefined}
          collisionPadding={8}
        >
          {visibleOptions.map(({ type, icon, title }) => (
            <IconButton
              className={clsx(className, {
                active: currentType === type,
              })}
              key={type}
              type="toggle"
              icon={icon}
              checked={currentType === type}
              disabled={isToolButtonDisabled(app, type)}
              title={title || capitalizeString(type)}
              keyBindingLabel=""
              aria-label={title || capitalizeString(type)}
              data-testid={`toolbar-${type}`}
              onSelect={() => {
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
