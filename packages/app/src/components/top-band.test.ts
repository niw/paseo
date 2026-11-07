import { describe, expect, it } from "vitest";
import {
  resolveCornerClearance,
  resolveTopBand,
  resolveTopRowClearance,
  resolveTopStackPadding,
  type TopBand,
} from "./top-band";

const thinStatusBar = { x: 0, y: 0, width: 669, height: 2 };

// iPhone Duo unfolded in portrait: an 82pt top inset, covered only by a 144pt wide camera and
// status block at the top-right corner.
const duoBand: TopBand = {
  height: 82,
  obstacles: [{ side: "right", extent: 144, top: 0, bottom: 82 }],
};

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
    ).toEqual(duoBand);
  });

  it("measures a left corner from the left edge", () => {
    expect(
      resolveTopBand({
        windowWidth: 669,
        topInset: 82,
        snapshot: { statusBar: null, occlusions: [{ x: 0, y: 0, width: 100, height: 82 }] },
      }),
    ).toEqual({ height: 82, obstacles: [{ side: "left", extent: 100, top: 0, bottom: 82 }] });
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
    ).toEqual({ height: 82, obstacles: [] });
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

describe("resolveTopStackPadding", () => {
  const bothSides = { left: true, right: true };

  it("rests a single row on the obstacle's bottom, beside it", () => {
    expect(
      resolveTopStackPadding({ band: duoBand, topInset: 82, sides: bothSides, contentHeight: 44 }),
    ).toBe(38);
  });

  it("starts rows that reach the obstacle's bottom at the window's top", () => {
    // The workspace header and its tab row.
    expect(
      resolveTopStackPadding({ band: duoBand, topInset: 82, sides: bothSides, contentHeight: 88 }),
    ).toBe(0);
  });

  it("starts a stack in no obstacle's corner at the window's top", () => {
    // The left sidebar, beside a block at the top-right corner.
    expect(
      resolveTopStackPadding({
        band: duoBand,
        topInset: 82,
        sides: { left: true, right: false },
        contentHeight: 44,
      }),
    ).toBe(0);
  });

  it("keeps the whole top inset when the band is not shareable", () => {
    expect(
      resolveTopStackPadding({ band: null, topInset: 62, sides: bothSides, contentHeight: 88 }),
    ).toBe(62);
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

describe("resolveTopRowClearance", () => {
  const noInsets = { left: 0, right: 0 };
  const bothSides = { left: true, right: true };
  const noRadii = { left: 0, right: 0 };

  it("moves a top row's ends in past rounded corners when the top inset is 0", () => {
    // iPhone Duo folded: 8pt corners on the hinge side, 59pt on the other.
    const clearance = resolveTopRowClearance({
      band: null,
      sides: bothSides,
      insets: noInsets,
      radii: { left: 8, right: 59 },
      row: { top: 0, height: 44 },
    });
    expect(clearance.left).toBeCloseTo(resolveCornerClearance(8, 6));
    expect(clearance.right).toBeCloseTo(resolveCornerClearance(59, 6));
    expect(clearance.right).toBeGreaterThan(20);
  });

  it("leaves to the side inset what it already covers", () => {
    const clearance = resolveTopRowClearance({
      band: null,
      sides: bothSides,
      insets: { left: 84, right: 0 },
      radii: { left: 55, right: 55 },
      row: { top: 0, height: 44 },
    });
    expect(clearance.left).toBe(0);
    expect(clearance.right).toBeGreaterThan(0);
  });

  it("needs no clearance below the corner's arc", () => {
    expect(
      resolveTopRowClearance({
        band: null,
        sides: bothSides,
        insets: noInsets,
        radii: { left: 55, right: 55 },
        row: { top: 59, height: 44 },
      }),
    ).toEqual({ left: 0, right: 0 });
  });

  it("clears an obstacle beside each row it reaches", () => {
    const row = (top: number) =>
      resolveTopRowClearance({
        band: duoBand,
        sides: bothSides,
        insets: noInsets,
        radii: noRadii,
        row: { top, height: 44 },
      });
    // The header and the tab row both sit beside the 82pt block; a row below it does not.
    expect(row(0)).toEqual({ left: 0, right: 144 });
    expect(row(44)).toEqual({ left: 0, right: 144 });
    expect(row(88)).toEqual({ left: 0, right: 0 });
  });

  it("clears only the corners the row's stack sits in", () => {
    expect(
      resolveTopRowClearance({
        band: duoBand,
        sides: { left: true, right: false },
        insets: noInsets,
        radii: { left: 55, right: 55 },
        row: { top: 0, height: 44 },
      }),
    ).toEqual({ left: resolveCornerClearance(55, 6), right: 0 });
  });
});
