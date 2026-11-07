export interface WindowRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Window-coordinate regions that system elements cover, and the status bar frame. */
export interface ReservedRegionsSnapshot {
  occlusions: WindowRect[];
  statusBar: WindowRect | null;
}
