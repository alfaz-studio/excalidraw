// SONACOVE: viewportRotation — tests for the rotated-ancestor input warp.
import {
  normalizeViewportRotation,
  rotateClientPoint,
} from "../viewportRotation";

import type { ViewportRotation } from "../viewportRotation";

// Landscape local canvas hosted at an arbitrary screen offset. Under 90°/270°
// the on-screen AABB spans (height, width) = (450, 800).
const STATE = { width: 800, height: 450, offsetLeft: 100, offsetTop: 50 };

const LEFT = STATE.offsetLeft;
const TOP = STATE.offsetTop;

/** Forward map: local canvas point → true screen (client) point. */
const localToClient = (
  localX: number,
  localY: number,
  rotation: ViewportRotation,
) => {
  const { width, height } = STATE;
  const swapped = rotation === 90 || rotation === 270;
  const right = LEFT + (swapped ? height : width);
  const bottom = TOP + (swapped ? width : height);

  switch (rotation) {
    case 90:
      return { clientX: right - localY, clientY: TOP + localX };
    case 180:
      return { clientX: right - localX, clientY: bottom - localY };
    case 270:
      return { clientX: LEFT + localY, clientY: bottom - localX };
    default:
      return { clientX: LEFT + localX, clientY: TOP + localY };
  }
};

describe("rotateClientPoint", () => {
  it("is the identity at rotation 0", () => {
    expect(rotateClientPoint(371, 907, 0, STATE)).toEqual({
      clientX: 371,
      clientY: 907,
    });
  });

  it.each([0, 90, 180, 270] as const)(
    "inverts the %d° forward map into pseudo-client (offset + local) space",
    (rotation) => {
      const corners = [
        [0, 0],
        [STATE.width, 0],
        [0, STATE.height],
        [STATE.width, STATE.height],
        [123.5, 402.25],
      ];

      for (const [localX, localY] of corners) {
        const { clientX, clientY } = localToClient(localX, localY, rotation);
        const warped = rotateClientPoint(clientX, clientY, rotation, STATE);

        expect(warped.clientX).toBeCloseTo(LEFT + localX, 10);
        expect(warped.clientY).toBeCloseTo(TOP + localY, 10);
      }
    },
  );

  it("maps the 90° AABB corners onto the right local corners", () => {
    // AABB under 90°: left=100, top=50, right=100+450=550, bottom=50+800=850.
    // Screen top-right of the AABB is the local origin.
    expect(rotateClientPoint(550, 50, 90, STATE)).toEqual({
      clientX: LEFT,
      clientY: TOP,
    });

    // Screen bottom-left is the local bottom-right (800, 450).
    expect(rotateClientPoint(100, 850, 90, STATE)).toEqual({
      clientX: LEFT + 800,
      clientY: TOP + 450,
    });
  });

  it("preserves distances (a stroke's shape survives the warp)", () => {
    const a = localToClient(100, 100, 90);
    const b = localToClient(180, 160, 90);
    const wa = rotateClientPoint(a.clientX, a.clientY, 90, STATE);
    const wb = rotateClientPoint(b.clientX, b.clientY, 90, STATE);

    expect(
      Math.hypot(wb.clientX - wa.clientX, wb.clientY - wa.clientY),
    ).toBeCloseTo(Math.hypot(80, 60), 10);
  });
});

describe("normalizeViewportRotation", () => {
  it("passes the applied orientations through", () => {
    expect(normalizeViewportRotation(0)).toBe(0);
    expect(normalizeViewportRotation(90)).toBe(90);
    expect(normalizeViewportRotation(180)).toBe(180);
    expect(normalizeViewportRotation(270)).toBe(270);
  });

  it("normalizes accumulated and negative host angles", () => {
    expect(normalizeViewportRotation(360)).toBe(0);
    expect(normalizeViewportRotation(450)).toBe(90);
    expect(normalizeViewportRotation(-90)).toBe(270);
    expect(normalizeViewportRotation(720 + 180)).toBe(180);
  });

  it("degrades non-90°-step and missing values to 0 (no warp)", () => {
    expect(normalizeViewportRotation(undefined)).toBe(0);
    expect(normalizeViewportRotation(45)).toBe(0);
    expect(normalizeViewportRotation(Number.NaN)).toBe(0);
  });
});
