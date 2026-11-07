import { describe, expect, it } from "vitest";
import { resolveSafeAreaInsets, resolveVerticalBarEdge, type WindowLayout } from "./model";

const systemInsets = { top: 59, right: 0, bottom: 34, left: 0 };

function layout(bottomClearance: number | null | undefined): WindowLayout {
  return {
    bounds: { x: 0, y: 0, width: 402, height: 874 },
    verticalBarEdge: "none",
    verticalBar: null,
    bottomClearance,
    divisions: [],
  };
}

describe("resolveSafeAreaInsets", () => {
  it("replaces only the bottom with the measured bar clearance", () => {
    expect(resolveSafeAreaInsets(systemInsets, layout(24))).toEqual({
      ...systemInsets,
      bottom: 24,
    });
  });

  it("keeps a measured zero instead of falling back to the system inset", () => {
    expect(resolveSafeAreaInsets(systemInsets, layout(0)).bottom).toBe(0);
  });

  it.each([null, undefined])("leaves system insets alone without a clearance (%s)", (value) => {
    expect(resolveSafeAreaInsets(systemInsets, layout(value))).toBe(systemInsets);
  });

  it("leaves system insets alone before the native layout arrives", () => {
    expect(resolveSafeAreaInsets(systemInsets, null)).toBe(systemInsets);
  });
});

describe("resolveVerticalBarEdge", () => {
  const folded: WindowLayout = {
    bounds: { x: 0, y: 0, width: 466, height: 678 },
    verticalBarEdge: "trailing",
    verticalBar: { x: 412, y: 160, width: 44, height: 440 },
    divisions: [],
  };

  it("puts a trailing bar's actions in the right inset", () => {
    expect(resolveVerticalBarEdge(folded)).toBe("right");
  });

  it("has no bar edge for a leading bar or without a bar guide", () => {
    expect(resolveVerticalBarEdge({ ...folded, verticalBarEdge: "leading" })).toBeNull();
    expect(resolveVerticalBarEdge({ ...folded, verticalBar: null })).toBeNull();
    expect(resolveVerticalBarEdge(null)).toBeNull();
  });
});
