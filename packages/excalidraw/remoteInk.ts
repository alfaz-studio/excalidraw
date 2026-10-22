// SONACOVE: live ink — a peer's freehand stroke shown while it is still being drawn.
//
// A stroke in progress is a real scene element whose version bumps on every pen point, and the
// collab layer used to send the whole element reliably each time: bytes per stroke grow with the
// square of its length, and on a slow uplink the board fell a minute behind the voice. Instead,
// the stroke is held back from reliable sync until the pen lifts and goes out once, finished.
// While the pen is down, only the NEW points go out, on the lossy channel, at cursor rate, and
// receivers draw them as a preview on the interactive canvas until the real element lands.
//
// A dropped frame costs a straight segment in the preview, never the stroke: the finished
// element is what everyone keeps.
import type { ExcalidrawFreeDrawElement } from "@excalidraw/element/types";

import type { RemoteInk } from "./types";

/** Points repeated from the previous frame, so one lost frame doesn't open a gap. */
const INK_OVERLAP_POINTS = 2;

/** A sender emits a handful per frame; anything far above that is not a real frame. */
const MAX_INK_POINTS_PER_FRAME = 512;

/** A preview stops growing here; the finished element still lands whole. */
export const MAX_INK_POINTS_PER_STROKE = 20_000;

/** One frame of a stroke in progress, as it goes over the wire. */
export type InkFrame = {
  id: string;
  x: number;
  y: number;
  strokeColor: string;
  strokeWidth: number;
  opacity: number;
  simulatePressure: boolean;
  /** Index of `points[0]` in the stroke. */
  from: number;
  points: [number, number][];
  /** Empty when `simulatePressure`. */
  pressures: number[];
  /** The pen lifted; the finished element follows on the reliable channel. */
  done?: boolean;
  /** The stroke was thrown away (a stray tap), so nothing follows: drop the preview. */
  discarded?: boolean;
};

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * The next frame of a local stroke: everything after what was already sent, plus a little
 * overlap.
 *
 * @param element - The stroke as it stands.
 * @param sent - How many of its points earlier frames carried.
 * @returns The frame, and how many points have been sent once it goes.
 */
export const buildInkFrame = (
  element: Pick<
    ExcalidrawFreeDrawElement,
    | "id"
    | "x"
    | "y"
    | "points"
    | "pressures"
    | "simulatePressure"
    | "strokeColor"
    | "strokeWidth"
    | "opacity"
  >,
  sent: number,
): { frame: InkFrame; sent: number } => {
  const from = Math.max(
    0,
    Math.min(sent, element.points.length) - INK_OVERLAP_POINTS,
  );

  return {
    frame: {
      id: element.id,
      x: element.x,
      y: element.y,
      strokeColor: element.strokeColor,
      strokeWidth: element.strokeWidth,
      opacity: element.opacity,
      simulatePressure: element.simulatePressure,
      from,
      points: element.points
        .slice(from)
        .map(([px, py]) => [round(px), round(py)]),
      pressures: element.simulatePressure
        ? []
        : element.pressures.slice(from).map(round),
    },
    sent: element.points.length,
  };
};

/**
 * Folds a received frame into the preview of that stroke.
 *
 * The preview only ever grows: a frame adds the points past what was already received. The lossy
 * channel is unordered, so a frame that ends before that point arrived late and is ignored; one
 * that starts after it means frames were lost, and the preview joins across the gap.
 *
 * @param current - The preview of the same stroke so far, if any.
 * @param frame - The frame received.
 * @param now - The current time.
 * @returns The new preview, or undefined when there should be none.
 */
export const applyInkFrame = (
  current: RemoteInk | undefined,
  frame: InkFrame,
  now: number,
): RemoteInk | undefined => {
  if (frame.discarded) {
    return undefined;
  }

  const end = frame.from + frame.points.length;

  if (current && current.points.length >= MAX_INK_POINTS_PER_STROKE) {
    return current;
  }

  if (current && end <= current.received) {
    return frame.done && !current.done
      ? { ...current, done: true, updatedAt: now }
      : current;
  }

  const known = current ? Math.max(0, current.received - frame.from) : 0;

  return {
    id: frame.id,
    x: frame.x,
    y: frame.y,
    strokeColor: frame.strokeColor,
    strokeWidth: frame.strokeWidth,
    opacity: frame.opacity,
    simulatePressure: frame.simulatePressure,
    points: [...(current?.points ?? []), ...frame.points.slice(known)],
    pressures: [...(current?.pressures ?? []), ...frame.pressures.slice(known)],
    received: end,
    done: Boolean(frame.done || current?.done),
    updatedAt: now,
  };
};

/** Most strokes of one peer previewed at once; older ones have long since landed. */
export const MAX_INK_STROKES_PER_PEER = 8;

/**
 * Applies a frame to one peer's list of previewed strokes.
 *
 * @param strokes - The peer's previews.
 * @param frame - The frame received.
 * @param now - The current time.
 * @returns The new list.
 */
export const applyInkFrameToStrokes = (
  strokes: readonly RemoteInk[] | undefined,
  frame: InkFrame,
  now: number,
): readonly RemoteInk[] => {
  const list = strokes ?? [];
  const index = list.findIndex((stroke) => stroke.id === frame.id);
  const next = applyInkFrame(index >= 0 ? list[index] : undefined, frame, now);
  const others = list.filter((_, i) => i !== index);

  return (next ? [...others, next] : others).slice(-MAX_INK_STROKES_PER_PEER);
};

/**
 * Whether a value received from a peer is a well-formed frame.
 *
 * @param value - The untrusted payload.
 */
export const isInkFrame = (value: unknown): value is InkFrame => {
  const frame = value as Partial<InkFrame> | null;
  const finite = (n: unknown) => typeof n === "number" && Number.isFinite(n);

  return (
    typeof frame?.id === "string" &&
    finite(frame.x) &&
    finite(frame.y) &&
    finite(frame.from) &&
    frame.from! >= 0 &&
    typeof frame.strokeColor === "string" &&
    finite(frame.strokeWidth) &&
    finite(frame.opacity) &&
    Array.isArray(frame.points) &&
    frame.points.length <= MAX_INK_POINTS_PER_FRAME &&
    frame.points.every(
      (p) => Array.isArray(p) && finite(p[0]) && finite(p[1]),
    ) &&
    Array.isArray(frame.pressures) &&
    // Either no pressures (simulated) or one per point — the outline reads them by index.
    (frame.pressures.length === 0 ||
      frame.pressures.length === frame.points.length) &&
    frame.pressures.every(finite)
  );
};
