import { describe, expect, it } from "vitest";
import { detectAudioContainer, pickRecordingMimeType } from "@/lib/voice/audio";

const bytes = (...head: number[]) => {
  const b = new Uint8Array(32);
  b.set(head);
  return b;
};
const ascii = (offset: number, text: string, base = new Uint8Array(32)) => {
  base.set(
    Array.from(text, (c) => c.charCodeAt(0)),
    offset,
  );
  return base;
};

describe("detectAudioContainer (server trusts bytes, not declared type)", () => {
  it("recognises browser recorder containers", () => {
    expect(detectAudioContainer(bytes(0x1a, 0x45, 0xdf, 0xa3))).toBe("webm");
    expect(detectAudioContainer(ascii(0, "OggS"))).toBe("ogg");
    expect(detectAudioContainer(ascii(4, "ftyp"))).toBe("mp4");
    expect(detectAudioContainer(ascii(8, "WAVE", ascii(0, "RIFF")))).toBe("wav");
    expect(detectAudioContainer(ascii(0, "ID3"))).toBe("mp3");
  });

  it("rejects non-audio and truncated input", () => {
    expect(detectAudioContainer(ascii(0, "%PDF-1.7"))).toBeNull();
    expect(detectAudioContainer(ascii(0, "<html>"))).toBeNull();
    expect(detectAudioContainer(new Uint8Array([0x1a, 0x45]))).toBeNull();
  });
});

describe("pickRecordingMimeType", () => {
  it("prefers WebM/Opus, then MP4 (Safari)", () => {
    expect(pickRecordingMimeType(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickRecordingMimeType((t) => t === "audio/mp4")).toBe("audio/mp4");
  });

  it("lets the browser choose when it can't report support; undefined when none work", () => {
    expect(pickRecordingMimeType(undefined)).toBeNull();
    expect(pickRecordingMimeType(() => false)).toBeUndefined();
  });
});
