import { describe, expect, it } from "vitest";
import { resolveStreamColumn } from "./column";

const MAX_WIDTH = 720;
const LIST_PADDING = 16;

function column(width: number, insetLeft: number, insetRight: number) {
  return resolveStreamColumn({
    width,
    insetLeft,
    insetRight,
    maxWidth: MAX_WIDTH,
    listPadding: LIST_PADDING,
  });
}

describe("resolveStreamColumn", () => {
  it("runs the rows edge to edge while they fill the width", () => {
    const result = column(600, 0, 84);
    expect(result.marginLeft).toBe(0);
    expect(result.marginRight).toBe(0);
  });

  it("keeps a row's controls inside an inset its text runs under", () => {
    // Controls keep the 24pt row padding from the inset that rows keep from the window edge.
    expect(column(600, 0, 84).insets).toEqual({ left: 0, right: 84 });
    expect(column(600, 62, 62).insets).toEqual({ left: 62, right: 62 });
  });

  it("centers a full-width column where the composer centers, between the insets", () => {
    const result = column(1000, 0, 84);
    expect(result.marginLeft).toBe(0);
    expect(result.marginRight).toBe(84);
    expect(result.insets).toEqual({ left: 0, right: 0 });
  });

  it("shifts toward the composer's center only as far as the free space allows", () => {
    // 20pt of free space beside a 720pt column, short of the 84pt the center is off by.
    const result = column(MAX_WIDTH + 2 * LIST_PADDING + 20, 0, 84);
    expect(result.marginLeft).toBe(0);
    expect(result.marginRight).toBe(20);
    expect(result.insets.right).toBe(64);
  });

  it("needs no shift for equal insets", () => {
    const result = column(1000, 62, 62);
    expect(result.marginLeft).toBe(0);
    expect(result.marginRight).toBe(0);
    expect(result.insets).toEqual({ left: 0, right: 0 });
  });
});
