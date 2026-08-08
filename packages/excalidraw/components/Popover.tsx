import React, { useLayoutEffect, useRef, useEffect } from "react";
import { unstable_batchedUpdates } from "react-dom";

import { KEYS, queryFocusableElements } from "@excalidraw/common";

import clsx from "clsx";

import "./Popover.scss";

type Props = {
  top?: number;
  left?: number;
  children?: React.ReactNode;
  onCloseRequest?(event: PointerEvent): void;
  fitInViewport?: boolean;
  offsetLeft?: number;
  offsetTop?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  className?: string;
  /**
   * SONACOVE: the box this popover opened from, in `top`/`left`'s space.
   *
   * Given only a point, `fitInViewport` bottom-aligns a popover too tall to fit
   * — landing it over its own trigger. With the box it picks the side with room
   * and caps its height to that room.
   */
  anchor?: { top: number; bottom: number };
};

export const Popover = ({
  children,
  left,
  top,
  onCloseRequest,
  fitInViewport = false,
  offsetLeft = 0,
  offsetTop = 0,
  viewportWidth = window.innerWidth,
  viewportHeight = window.innerHeight,
  className,
  anchor,
}: Props) => {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = popoverRef.current;

    if (!container) {
      return;
    }

    // focus popover only if the caller didn't focus on something else nested
    // within the popover, which should take precedence. Fixes cases
    // like color picker listening to keydown events on containers nested
    // in the popover.
    if (!container.contains(document.activeElement)) {
      container.focus();
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === KEYS.TAB) {
        const focusableElements = queryFocusableElements(container);
        const { activeElement } = document;
        const currentIndex = focusableElements.findIndex(
          (element) => element === activeElement,
        );

        if (activeElement === container) {
          if (event.shiftKey) {
            focusableElements[focusableElements.length - 1]?.focus();
          } else {
            focusableElements[0].focus();
          }
          event.preventDefault();
          event.stopImmediatePropagation();
        } else if (currentIndex === 0 && event.shiftKey) {
          focusableElements[focusableElements.length - 1]?.focus();
          event.preventDefault();
          event.stopImmediatePropagation();
        } else if (
          currentIndex === focusableElements.length - 1 &&
          !event.shiftKey
        ) {
          focusableElements[0]?.focus();
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }
    };

    container.addEventListener("keydown", handleKeyDown);

    return () => container.removeEventListener("keydown", handleKeyDown);
  }, []);

  const lastInitializedPosRef = useRef<{ top: number; left: number } | null>(
    null,
  );

  // ensure the popover doesn't overflow the viewport
  useLayoutEffect(() => {
    if (fitInViewport && popoverRef.current && top != null && left != null) {
      const container = popoverRef.current;
      const { width, height } = container.getBoundingClientRect();

      // hack for StrictMode so this effect only runs once for
      // the same top/left position, otherwise
      // we'd potentically reposition twice (once for viewport overflow)
      // and once for top/left position afterwards
      if (
        lastInitializedPosRef.current?.top === top &&
        lastInitializedPosRef.current?.left === left
      ) {
        return;
      }
      lastInitializedPosRef.current = { top, left };

      if (width >= viewportWidth) {
        container.style.width = `${viewportWidth}px`;
        container.style.left = "0px";
        container.style.overflowX = "scroll";
      } else if (left + width - offsetLeft > viewportWidth) {
        container.style.left = `${viewportWidth - width - 10}px`;
      } else {
        container.style.left = `${left}px`;
      }

      // SONACOVE: anchored placement.
      if (anchor) {
        const MARGIN = 8;
        const below = viewportHeight - anchor.bottom - MARGIN;
        const above = anchor.top - MARGIN;
        // Below by default, above only when that side has more room; capped
        // either way so it scrolls rather than escaping the canvas.
        const useBelow = height <= below || below >= above;
        const room = Math.max(useBelow ? below : above, 0);

        container.style.top = useBelow
          ? `${anchor.bottom + MARGIN}px`
          : `${Math.max(
              MARGIN,
              anchor.top - Math.min(height, room) - MARGIN,
            )}px`;

        if (height > room) {
          container.style.maxHeight = `${room}px`;
          container.style.overflowY = "auto";
        }
      } else if (height >= viewportHeight) {
        container.style.height = `${viewportHeight - 20}px`;
        container.style.top = "10px";
        container.style.overflowY = "scroll";
      } else if (top + height - offsetTop > viewportHeight) {
        container.style.top = `${viewportHeight - height}px`;
      } else {
        container.style.top = `${top}px`;
      }
    }
  }, [
    anchor,
    top,
    left,
    fitInViewport,
    viewportWidth,
    viewportHeight,
    offsetLeft,
    offsetTop,
  ]);

  useEffect(() => {
    if (onCloseRequest) {
      const handler = (event: PointerEvent) => {
        if (!popoverRef.current?.contains(event.target as Node)) {
          unstable_batchedUpdates(() => onCloseRequest(event));
        }
      };
      document.addEventListener("pointerdown", handler, false);
      return () => document.removeEventListener("pointerdown", handler, false);
    }
  }, [onCloseRequest]);

  return (
    <div className={clsx("popover", className)} ref={popoverRef} tabIndex={-1}>
      {children}
    </div>
  );
};
