import { describe, expect, it } from "vitest";
import { pickRecordingMimeType } from "@/lib/voice/audio";

describe("pickRecordingMimeType", () => {
  it("prefers WebM/Opus, then MP4 (Safari)", () => {
    expect(pickRecordingMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecordingMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
  });

  it("never picks a format the server can't measure (Ogg)", () => {
    expect(pickRecordingMimeType((t) => t.startsWith("audio/ogg"))).toBeUndefined();
  });

  it("lets the browser choose when it can't report support; undefined when none work", () => {
    expect(pickRecordingMimeType(undefined)).toBeNull();
    expect(pickRecordingMimeType(() => false)).toBeUndefined();
  });
});
