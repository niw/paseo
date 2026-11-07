export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CornerRadii {
  topLeft: number;
  topRight: number;
  bottomLeft: number;
  bottomRight: number;
}

/** Window-coordinate regions that system elements cover, and the status bar frame. */
export interface ReservedRegionsSnapshot {
  occlusions: WindowRect[];
  statusBar: WindowRect | null;
  /** The radius of each window corner, which can differ per corner. Null before iOS 26. */
  cornerRadii?: CornerRadii | null;
}
