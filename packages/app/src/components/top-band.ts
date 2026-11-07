import type { ReservedRegionsSnapshot } from "@/native/reserved-regions-types";

/**
 * The part of the top safe-area inset that chrome can share. On iPhone Duo unfolded in portrait
 * the top inset is 82pt, but only a 144pt camera and status block at one corner covers it; the
 * rest of the band is free for a toolbar row.
 */
export interface TopBand {
  /** The band's height: the window's top safe-area inset. */
  height: number;
  /** How far from each window edge the occluded corners reach into the band. */
  left: number;
  right: number;
}

/** Less free width than this and the band is not worth a toolbar row. */
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
  let left = 0;
  let right = 0;
  for (const rect of snapshot.occlusions) {
    if (rect.y >= topInset || rect.y + rect.height <= 0) continue;
    if (rect.x + rect.width / 2 < windowWidth / 2) {
      left = Math.max(left, rect.x + rect.width);
    } else {
      right = Math.max(right, windowWidth - rect.x);
    }
  }
  if (windowWidth - left - right < MIN_FREE_WIDTH) return null;
  return { height: topInset, left, right };
}
