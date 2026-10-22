// SONACOVE: draws peers' strokes in progress on the interactive canvas. See remoteInk.ts.
import { applyDarkModeFilter, THEME } from "@excalidraw/common";
import { getFreedrawOutlinePoints } from "@excalidraw/element";

import type { ExcalidrawFreeDrawElement } from "@excalidraw/element/types";

import type { InteractiveCanvasAppState, RemoteInk } from "../types";

/**
 * Fills each stroke the way the static renderer fills a freedraw element, so the preview looks
 * like the stroke it turns into. The context must already be scaled for zoom.
 *
 * @param context - The interactive canvas context.
 * @param appState - For scroll and theme.
 * @param strokes - The strokes to draw.
 */
export const renderRemoteInk = (
  context: CanvasRenderingContext2D,
  appState: InteractiveCanvasAppState,
  strokes: readonly RemoteInk[],
) => {
  for (const stroke of strokes) {
    if (!stroke.points.length) {
      continue;
    }

    const outline = getFreedrawOutlinePoints({
      points: stroke.points,
      pressures: stroke.pressures,
      simulatePressure: stroke.simulatePressure,
      strokeWidth: stroke.strokeWidth,
    } as unknown as ExcalidrawFreeDrawElement);

    if (!outline.length) {
      continue;
    }

    context.save();
    context.translate(appState.scrollX + stroke.x, appState.scrollY + stroke.y);
    context.globalAlpha = stroke.opacity / 100;
    context.fillStyle =
      appState.theme === THEME.DARK
        ? applyDarkModeFilter(stroke.strokeColor)
        : stroke.strokeColor;

    const path = new Path2D();

    path.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) {
      path.lineTo(outline[i][0], outline[i][1]);
    }
    path.closePath();
    context.fill(path);
    context.restore();
  }
};
