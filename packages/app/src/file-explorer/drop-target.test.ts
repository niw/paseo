import { describe, expect, it } from "vitest";
import { explorerDropDirectory } from "./drop-target";

describe("explorer drop directory", () => {
  it("drops onto a directory row into that directory", () => {
    expect(explorerDropDirectory({ path: "src/components", kind: "directory" })).toBe(
      "src/components",
    );
  });

  it("drops onto a file row into the file's directory", () => {
    expect(explorerDropDirectory({ path: "src/index.ts", kind: "file" })).toBe("src");
  });

  it("drops onto a top-level file row into the workspace root", () => {
    expect(explorerDropDirectory({ path: "README.md", kind: "file" })).toBe(".");
  });
});
