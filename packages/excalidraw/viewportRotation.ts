// SONACOVE: viewportRotation — support for hosting Excalidraw inside a
// CSS-rotated ancestor (pure 90° steps, no scale).
//
// The Sonacove stage can rotate the shared-screen container by 90°/180°/270°
// (mobile viewers turn the phone to watch a landscape screenshare). The
// annotation board is a child of that rotated container, so it rotates with
// the video — which keeps cross-participant stroke registration correct by
// construction — but Excalidraw's own geometry assumed an unrotated host:
//
// 1. `updateDOMRect` sized the canvas from the container's
//    getBoundingClientRect(), which under 90°/270° returns the rotated
//    axis-aligned bounding box (width/height swapped).
// 2. Pointer math maps client → scene as a pure translate+scale
//    (`(clientX - offsetLeft) / zoom - scrollX`), which is wrong by a
//    rotation under a rotated ancestor.
//
// The fix preserves one invariant everywhere inside the app: a "client"
// coordinate is `offset + local` — i.e. appState.width/height stay the LOCAL
// (layout) canvas dims, offsetLeft/offsetTop stay the on-screen AABB origin,
// and every REAL pointer event's clientX/clientY is warped through
// `rotateClientPoint` at entry into that pseudo-client space. Synthetic
// "client" values the code fabricates (paste-at-center's
// `width / 2 + offsetLeft`, viewport-culling corners, scroll-center math)
// already live in that space and MUST NOT be warped — which is why the warp
// is applied at the event-entry call sites and never inside
// viewportCoordsToSceneCoords / sceneCoordsToViewportCoords.
//
// DOM children of the container (text editor, popovers, canvases — including
// canvas-drawn collab cursors and laser trails) position themselves with
// LOCAL coords and rotate along with the container, so they need no changes.
//
// Scope: rotation is only supported together with `lockedViewport`. The
// pan/zoom input paths (wheel deltas, pinch centroids, middle-click pan,
// scrollbar drags) are rotation-naive, but the lock already makes all of
// them no-ops; an unlocked rotated canvas would pan along the wrong axes.
//
// Known-unwarped surfaces (all disabled or unreachable on the Sonacove
// annotation boards; fix before relying on them under rotation):
// - Hyperlink popup hide logic + its document.body tooltip
//   (hyperlink/Hyperlink.tsx — links are disabled via `disableLink`).
// - EyeDropper pixel sampling + preview positioning (EyeDropper.tsx).
// - LibraryMenu's sidebar-hover elementFromPoint check (libraries hidden).
import type { AppState } from "./types";

export type ViewportRotation = 0 | 90 | 180 | 270;

/**
 * Maps a REAL client-space point (from a pointer/mouse/touch event) into the
 * pseudo-client space the rest of the app operates in (`offset + local`),
 * inverting the host container's CSS rotation.
 *
 * Derivation: the container's local box (width w, height h — the values in
 * appState) is painted into the on-screen AABB whose origin is
 * (offsetLeft, offsetTop). For a pure rotation the AABB dims are (h, w) at
 * 90°/270° and (w, h) at 180°, and the local axes map onto screen axes
 * corner-to-corner:
 *
 * - 90° (CSS `rotate(90deg)`, clockwise): local (0,0) → AABB top-right;
 *   local +x runs down the screen, local +y runs left.
 *     clientX = right - localY, clientY = top + localX
 * - 180°: local (0,0) → AABB bottom-right.
 *     clientX = right - localX, clientY = bottom - localY
 * - 270°: local (0,0) → AABB bottom-left; local +x runs up, local +y right.
 *     clientX = left + localY, clientY = bottom - localX
 *
 * Inverting each and re-adding the offsets yields the formulas below.
 * Multiples of a full turn are normalized away by the caller passing the
 * applied orientation (rotation % 360).
 */
export const rotateClientPoint = (
  clientX: number,
  clientY: number,
  rotation: ViewportRotation,
  state: Readonly<
    Pick<AppState, "width" | "height" | "offsetLeft" | "offsetTop">
  >,
): { clientX: number; clientY: number } => {
  if (!rotation) {
    return { clientX, clientY };
  }

  const { width, height, offsetLeft, offsetTop } = state;

  // On-screen AABB edges. width/height are LOCAL dims, so the AABB spans
  // (height, width) when the rotation swaps the axes.
  const swapped = rotation === 90 || rotation === 270;
  const right = offsetLeft + (swapped ? height : width);
  const bottom = offsetTop + (swapped ? width : height);

  let localX: number;
  let localY: number;

  if (rotation === 90) {
    localX = clientY - offsetTop;
    localY = right - clientX;
  } else if (rotation === 180) {
    localX = right - clientX;
    localY = bottom - clientY;
  } else {
    // 270
    localX = bottom - clientY;
    localY = clientX - offsetLeft;
  }

  return { clientX: offsetLeft + localX, clientY: offsetTop + localY };
};

/**
 * Normalizes an arbitrary accumulated rotation angle (hosts may accumulate
 * 90° steps forever, e.g. 450) to the applied orientation.
 */
export const normalizeViewportRotation = (
  rotation: number | undefined,
): ViewportRotation => {
  const r = ((Math.round(rotation ?? 0) % 360) + 360) % 360;

  return (r === 90 || r === 180 || r === 270 ? r : 0) as ViewportRotation;
};
