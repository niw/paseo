import type { ReservedRegionsSnapshot } from "@/native/reserved-regions-types";

/**
 * A block that covers part of the top band from one side, like iPhone Duo's camera and status
 * block at the top-right corner when unfolded in portrait.
 */
export interface TopObstacle {
  side: "left" | "right";
  /** How far it reaches in from its window edge. */
  extent: number;
  top: number;
  bottom: number;
}

/**
 * The window's top safe-area inset when chrome can share it. On iPhone Duo unfolded in portrait
 * the top inset is 82pt, but only a 144pt wide camera and status block at one corner covers it;
 * the rest of the band is free for toolbar rows.
 */
export interface TopBand {
  /** The band's height: the window's top safe-area inset. */
  height: number;
  obstacles: TopObstacle[];
}

/** The window edges whose top corner a stack of top rows sits in. */
export interface TopChromeSides {
  left: boolean;
  right: boolean;
}

/** Less free width than this and the band is not worth toolbar rows. */
const MIN_FREE_WIDTH = 240;

export function resolveTopBand(input: {
  windowWidth: number;
  topInset: number;
  snapshot: ReservedRegionsSnapshot | null;
}): TopBand | null {
  const { windowWidth, topInset, snapshot } = input;
  if (!snapshot || topInset <= 0) return null;
  // A status bar across the band owns it, as on an iPhone with a notch or Dynamic Island. The
  // band is shareable only when the status items live inside the reserved regions.
  if (snapshot.statusBar && snapshot.statusBar.height >= topInset / 2) return null;
  const obstacles: TopObstacle[] = [];
  let left = 0;
  let right = 0;
  for (const rect of snapshot.occlusions) {
    if (rect.y >= topInset || rect.y + rect.height <= 0) continue;
    const side = rect.x + rect.width / 2 < windowWidth / 2 ? "left" : "right";
    const extent = side === "left" ? rect.x + rect.width : windowWidth - rect.x;
    obstacles.push({ side, extent, top: rect.y, bottom: rect.y + rect.height });
    if (side === "left") left = Math.max(left, extent);
    else right = Math.max(right, extent);
  }
  if (windowWidth - left - right < MIN_FREE_WIDTH) return null;
  return { height: topInset, obstacles };
}

/**
 * The top padding of a stack of rows at the top of a region, which replaces `insets.top`.
 *
 * Where the band is shareable, the stack only has to clear the obstacles in the corners it sits
 * in. Shorter than the lowest of them, it rests on the obstacle's bottom, beside it; as tall or
 * taller, it starts at the window's top and each row moves its ends in past the obstacles beside
 * it (`resolveTopRowClearance`). A stack in no obstacle's corner starts at the window's top.
 */
export function resolveTopStackPadding(input: {
  band: TopBand | null;
  topInset: number;
  sides: TopChromeSides;
  contentHeight: number;
}): number {
  const { band, sides } = input;
  if (!band) return input.topInset;
  let bottom = 0;
  for (const obstacle of band.obstacles) {
    if (sides[obstacle.side]) bottom = Math.max(bottom, obstacle.bottom);
  }
  return Math.max(bottom - input.contentHeight, 0);
}

/**
 * How far in from a side edge a point at `y` from the top has to sit to clear a rounded display
 * corner of `radius`. Zero below the corner's arc.
 */
export function resolveCornerClearance(radius: number, y: number): number {
  if (radius <= 0 || y >= radius) return 0;
  const dy = radius - Math.max(y, 0);
  return radius - Math.sqrt(radius * radius - dy * dy);
}

export interface TopRowClearance {
  left: number;
  right: number;
}

/** Top rows on native are touch-sized; see `usesTouchSizing`. */
export const TOP_ROW_HEIGHT = 44;
/** A top row's controls sit about this tall, centered in the row. */
const TOP_ROW_CONTROL_HEIGHT = 32;

/**
 * How far a row at `row.top` from the window's top moves its ends in, beyond the side insets, to
 * clear what covers the window's top corners: the band's obstacles beside the row, and the
 * display's rounded corners where the row runs into them, as on iPhone Duo with a top inset of 0.
 * The row keeps its height and position; only its end controls move in, just inside the corner's
 * arc at their height. Only the corners on `sides` count.
 */
export function resolveTopRowClearance(input: {
  band: TopBand | null;
  sides: TopChromeSides;
  insets: { left: number; right: number };
  radii: { left: number; right: number };
  row: { top: number; height: number };
}): TopRowClearance {
  const { band, sides, row } = input;
  const controlTop = row.top + Math.max(row.height - TOP_ROW_CONTROL_HEIGHT, 0) / 2;
  const obstacleExtent = { left: 0, right: 0 };
  for (const obstacle of band?.obstacles ?? []) {
    if (obstacle.top >= row.top + row.height || obstacle.bottom <= row.top) continue;
    obstacleExtent[obstacle.side] = Math.max(obstacleExtent[obstacle.side], obstacle.extent);
  }
  const clearance = (side: "left" | "right") => {
    if (!sides[side]) return 0;
    const corner = resolveCornerClearance(input.radii[side], controlTop);
    return Math.max(Math.max(obstacleExtent[side], corner) - input.insets[side], 0);
  };
  return { left: clearance("left"), right: clearance("right") };
}
