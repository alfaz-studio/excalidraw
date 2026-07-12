// SONACOVE: lockedViewport — first-class locked-viewport mode.
//
// When the host passes the `lockedViewport` prop, the canvas viewport
// (scrollX/scrollY/zoom) becomes fully DERIVED state: the scene box
// [0, width] × [0, height] is aspect-fit and centered into the canvas, and
// every user or programmatic viewport mutation is ignored (see the guards in
// components/App.tsx and actions/actionCanvas.tsx). Editing tools, collab,
// and selection are unaffected.
//
// This exists for the Sonacove screen-share annotation surfaces, where every
// participant must render the same scene box onto the same video content —
// pan/zoom drift on any participant breaks cross-device stroke registration.
import type { AppState, NormalizedZoomValue } from "./types";

export type LockedViewport = {
  /** Scene-box width, in scene units. */
  width: number;
  /** Scene-box height, in scene units. */
  height: number;
};

/**
 * The derived viewport for a locked canvas: aspect-fit zoom of the scene box
 * into the canvas, scrolled so the box is centered.
 *
 * With the render transform `renderX = (sceneX + scrollX) * zoom`, centering
 * requires `scrollX = canvasW / (2 * zoom) - sceneW / 2` (likewise for Y);
 * when the canvas aspect matches the box this reduces to scroll = 0, i.e. the
 * canvas shows exactly [0, sceneW] × [0, sceneH].
 *
 * NOTE: the zoom is deliberately NOT clamped to MIN_ZOOM/MAX_ZOOM — a locked
 * surface must keep registration even when a tiny canvas demands a zoom below
 * MIN_ZOOM. The lock disables all zoom UI/gestures, so the clamp's UX purpose
 * doesn't apply.
 */
export const getLockedViewportState = (
  lock: LockedViewport,
  canvasWidth: number,
  canvasHeight: number,
): {
  scrollX: number;
  scrollY: number;
  zoom: { value: NormalizedZoomValue };
} => {
  const zoom = Math.min(canvasWidth / lock.width, canvasHeight / lock.height);

  return {
    scrollX: canvasWidth / (2 * zoom) - lock.width / 2,
    scrollY: canvasHeight / (2 * zoom) - lock.height / 2,
    zoom: { value: zoom as NormalizedZoomValue },
  };
};

/**
 * Whether the app state's viewport deviates from the locked target enough to
 * need re-deriving. Epsilons absorb float noise so the enforcement in
 * componentDidUpdate can't ping-pong.
 */
export const lockedViewportNeedsUpdate = (
  lock: LockedViewport,
  state: Readonly<
    Pick<AppState, "width" | "height" | "scrollX" | "scrollY" | "zoom">
  >,
): boolean => {
  if (!lock.width || !lock.height || !state.width || !state.height) {
    return false;
  }

  const target = getLockedViewportState(lock, state.width, state.height);

  return (
    Math.abs(state.zoom.value - target.zoom.value) > 0.0001 ||
    Math.abs(state.scrollX - target.scrollX) > 0.25 ||
    Math.abs(state.scrollY - target.scrollY) > 0.25
  );
};
