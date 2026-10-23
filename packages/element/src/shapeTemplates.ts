import { ROUNDNESS } from "@excalidraw/common";
import { pointFrom } from "@excalidraw/math";

import type { LocalPoint } from "@excalidraw/math";

import { newLinearElement } from "./newElement";

import type { ElementConstructorOpts } from "./newElement";
import type { ExcalidrawLineElement, NonDeleted } from "./types";

/**
 * Tools that stretch a fixed outline over the dragged box. They draw plain
 * `line` elements, so collab, export and history need nothing new.
 */
export const SHAPE_TEMPLATE_TOOLS = ["star", "heart", "tick", "cross"] as const;

export type ShapeTemplateTool = typeof SHAPE_TEMPLATE_TOOLS[number];

export const isShapeTemplateTool = (type: unknown): type is ShapeTemplateTool =>
  SHAPE_TEMPLATE_TOOLS.includes(type as ShapeTemplateTool);

type UnitPoint = readonly [number, number];

/** Scales points to exactly fill the unit box, so the shape fills the drag. */
const fitUnitBox = (points: UnitPoint[]): UnitPoint[] => {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const width = Math.max(...xs) - minX;
  const height = Math.max(...ys) - minY;
  return points.map(([x, y]) => [(x - minX) / width, (y - minY) / height]);
};

// Inner radius 0.5 matches the toolbar's star icon.
const star = (): UnitPoint[] => {
  const points: UnitPoint[] = Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 === 0 ? 1 : 0.5;
    const angle = -Math.PI / 2 + (index * Math.PI) / 5;
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  });
  return fitUnitBox([...points, points[0]]);
};

// The classic parametric heart, starting at the bottom tip. Few points, drawn
// as a curve: rough strokes on many short segments look bumpy.
const heart = (): UnitPoint[] => {
  const steps = 16;
  const points: UnitPoint[] = Array.from({ length: steps }, (_, index) => {
    const t = Math.PI + (index / steps) * 2 * Math.PI;
    return [
      16 * Math.sin(t) ** 3,
      -(
        13 * Math.cos(t) -
        5 * Math.cos(2 * t) -
        2 * Math.cos(3 * t) -
        Math.cos(4 * t)
      ),
    ];
  });
  return fitUnitBox([...points, points[0]]);
};

const TEMPLATES: Record<ShapeTemplateTool, readonly UnitPoint[]> = {
  star: star(),
  heart: heart(),
  tick: [
    [0, 0.5],
    [1 / 3, 1],
    [1, 0],
  ],
  // A line can't lift the pen, so the cross runs out and back along two arms.
  cross: [
    [0, 0],
    [0.5, 0.5],
    [1, 0],
    [0.5, 0.5],
    [0, 1],
    [0.5, 0.5],
    [1, 1],
  ],
};

const isClosedTemplate = (tool: ShapeTemplateTool) =>
  tool === "star" || tool === "heart";

/**
 * The template scaled to `width` x `height`. Points are relative to the first
 * one, as linear elements require; `offsetX`/`offsetY` place that point in
 * the box.
 */
export const getShapeTemplatePoints = (
  tool: ShapeTemplateTool,
  width: number,
  height: number,
) => {
  const [[x0, y0]] = TEMPLATES[tool];
  return {
    offsetX: x0 * width,
    offsetY: y0 * height,
    points: TEMPLATES[tool].map(([x, y]) =>
      pointFrom<LocalPoint>((x - x0) * width, (y - y0) * height),
    ),
  };
};

/**
 * Starts with a single point so an undragged click is discarded as
 * invisibly small, like any other new line.
 */
export const newShapeTemplateElement = (
  tool: ShapeTemplateTool,
  opts: ElementConstructorOpts,
) =>
  newLinearElement({
    ...opts,
    type: "line",
    roundness:
      tool === "heart" ? { type: ROUNDNESS.PROPORTIONAL_RADIUS } : null,
    points: [pointFrom<LocalPoint>(0, 0)],
    polygon: isClosedTemplate(tool),
  }) as NonDeleted<ExcalidrawLineElement>;
