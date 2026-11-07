import { describe, expect, it } from "vitest";
import { resolveCornerClearance, resolveTopBand } from "./top-band";

const thinStatusBar = { x: 0, y: 0, width: 669, height: 2 };

describe("resolveTopBand", () => {
  it("shares the top inset beside an occluded corner", () => {
    expect(
      resolveTopBand({
        windowWidth: 669,
        topInset: 82,
        snapshot: {
          statusBar: thinStatusBar,
          occlusions: [{ x: 525, y: 0, width: 144, height: 82 }],
        },
      }),
    ).toEqual({ height: 82, left: 0, right: 144 });
  });

  it("measures a left corner from the left edge", () => {
    expect(
      resolveTopBand({
        windowWidth: 669,
        topInset: 82,
        snapshot: { statusBar: null, occlusions: [{ x: 0, y: 0, width: 100, height: 82 }] },
      }),
    ).toEqual({ height: 82, left: 100, right: 0 });
  });

  it("ignores regions below the band", () => {
    expect(
      resolveTopBand({
        windowWidth: 669,
        topInset: 82,
        snapshot: {
          statusBar: thinStatusBar,
          occlusions: [{ x: 21, y: 215, width: 37, height: 58 }],
        },
      }),
    ).toEqual({ height: 82, left: 0, right: 0 });
  });

  it("leaves a band with a status bar across it to the status bar", () => {
    expect(
      resolveTopBand({
        windowWidth: 402,
        topInset: 62,
        snapshot: {
          statusBar: { x: 0, y: 0, width: 402, height: 62 },
          occlusions: [{ x: 140, y: 11, width: 122, height: 37 }],
        },
      }),
    ).toBeNull();
  });

  it("needs a top inset and a snapshot", () => {
    expect(resolveTopBand({ windowWidth: 466, topInset: 0, snapshot: null })).toBeNull();
    expect(
      resolveTopBand({
        windowWidth: 466,
        topInset: 0,
        snapshot: { statusBar: thinStatusBar, occlusions: [] },
      }),
    ).toBeNull();
  });

  it("gives up when the occlusions leave too little width", () => {
    expect(
      resolveTopBand({
        windowWidth: 400,
        topInset: 82,
        snapshot: { statusBar: null, occlusions: [{ x: 200, y: 0, width: 200, height: 82 }] },
      }),
    ).toBeNull();
  });
});

describe("resolveCornerClearance", () => {
  it("reaches the full radius at the top edge", () => {
    expect(resolveCornerClearance(59, 0)).toBe(59);
  });

  it("shrinks along the arc", () => {
    expect(resolveCornerClearance(59, 20)).toBeCloseTo(14.7, 1);
  });

  it("is zero below the arc and without a radius", () => {
    expect(resolveCornerClearance(59, 59)).toBe(0);
    expect(resolveCornerClearance(0, 0)).toBe(0);
  });
});
