import { describe, expect, it } from "vitest";
import { mediaTypeForPath } from "./media";

describe("mediaTypeForPath", () => {
  it("classifies video and audio files by extension", () => {
    expect(mediaTypeForPath("clips/demo.MP4")).toEqual({ kind: "video", mimeType: "video/mp4" });
    expect(mediaTypeForPath("/tmp/voice.m4a")).toEqual({ kind: "audio", mimeType: "audio/mp4" });
  });

  it("ignores other files and extension-like directory names", () => {
    expect(mediaTypeForPath("src/index.ts")).toBeNull();
    expect(mediaTypeForPath("/tmp/out.mp4/notes")).toBeNull();
  });
});
