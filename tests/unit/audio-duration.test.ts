import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { measureAudioDuration, opusPacketMs } from "@/lib/voice/audio-duration";

/**
 * Duration is measured from the decoded frames (what the provider bills), so
 * a small, low-bitrate file can't smuggle a long recording past the limit.
 * Real fixtures come from Chromium's MediaRecorder (synthetic audio); the
 * hostile inputs are built here byte by byte.
 */
const fixture = (name: string) =>
  new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures/audio", name)));

// ── Minimal EBML/WebM builder ──
const vintSize = (n: number) => {
  if (n < 0x7f) return [0x80 | n];
  if (n < 0x3fff) return [0x40 | (n >> 8), n & 0xff];
  return [0x20 | (n >> 16), (n >> 8) & 0xff, n & 0xff];
};
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const el = (id: number[], body: number[], unknownSize = false) => [
  ...id,
  ...(unknownSize ? UNKNOWN : vintSize(body.length)),
  ...body,
];
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const EBML_HEADER = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], ascii("webm")));
const trackEntry = (n: number, codec: string) =>
  el([0xae], [...el([0xd7], [n]), ...el([0x86], ascii(codec))]);
const simpleBlock = (packet: number[], track = 1, flags = 0x80, timecode = 0) =>
  el([0xa3], [0x80 | track, (timecode >> 8) & 0xff, timecode & 0xff, flags, ...packet]);

function webm({
  packets,
  tracks = [trackEntry(1, "A_OPUS")],
  block = (p: number[]) => simpleBlock(p),
  trailing = [] as number[],
}: {
  packets: number[][];
  tracks?: number[][];
  block?: (p: number[], i: number) => number[];
  trailing?: number[];
}) {
  const cluster = el(
    [0x1f, 0x43, 0xb6, 0x75],
    [...el([0xe7], [0]), ...packets.flatMap((p, i) => block(p, i))],
    true,
  );
  const segmentBody = [...el([0x16, 0x54, 0xae, 0x6b], tracks.flat()), ...cluster];
  const segment = trailing.length
    ? el([0x18, 0x53, 0x80, 0x67], segmentBody)
    : el([0x18, 0x53, 0x80, 0x67], segmentBody, true);
  return new Uint8Array([...EBML_HEADER, ...segment, ...trailing]);
}

describe("opusPacketMs (RFC 6716 TOC)", () => {
  it("decodes frame size and count", () => {
    expect(opusPacketMs(new Uint8Array([0x18]))).toBe(60); // SILK 60 ms, 1 frame
    expect(opusPacketMs(new Uint8Array([0xf8 | 0x01]))).toBe(40); // CELT 20 ms × 2
    expect(opusPacketMs(new Uint8Array([0x80 | 0x03, 0x04]))).toBe(10); // CELT 2.5 ms × 4
    expect(opusPacketMs(new Uint8Array([0x18 | 0x03, 0x02]))).toBe(120); // SILK 60 ms × 2
  });
});

describe("measureAudioDuration on real browser recordings", () => {
  it.each([
    ["chrome-opus-2s.webm", "webm"],
    ["chrome-opus-2s.mp4", "mp4"],
    ["chrome-aac-2s.mp4", "mp4"],
  ])("%s ≈ 2 s", (name, container) => {
    const measured = measureAudioDuration(fixture(name));
    expect(measured?.container).toBe(container);
    expect(measured!.seconds).toBeGreaterThan(1.7);
    expect(measured!.seconds).toBeLessThan(2.3);
  });
});

describe("hostile or unsupported uploads", () => {
  it("counts every frame of a tiny low-bitrate file (30 minutes in ~100 kB)", () => {
    // 15 000 packets × 120 ms, 2 bytes each: far over any size-based guess.
    const file = webm({ packets: Array.from({ length: 15_000 }, () => [0x1b, 0x02]) });
    expect(file.length).toBeLessThan(150_000);
    expect(measureAudioDuration(file)?.seconds).toBeCloseTo(1800, 0);
  });

  it("ignores forged block timestamps (all zero) and still counts the audio", () => {
    const file = webm({
      packets: Array.from({ length: 1000 }, () => [0x18]),
      block: (p) => simpleBlock(p, 1, 0x80, 0),
    });
    expect(measureAudioDuration(file)?.seconds).toBeCloseTo(60, 5);
  });

  it("uses the longer of decoded and declared MP4 durations", () => {
    // Real AAC fixture with its mdhd timescale forged down by 1000×: the
    // declared per-sample durations then claim ~33 minutes.
    const bytes = fixture("chrome-aac-2s.mp4");
    const body = Buffer.from(bytes).indexOf("mdhd") + 4;
    const at = body + (bytes[body] === 1 ? 20 : 12); // timescale (mdhd v1 or v0)
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(at, 48);
    expect(measureAudioDuration(bytes)!.seconds).toBeGreaterThan(60);
  });

  it("counts AAC frames even when the declared durations are forged to ~0", () => {
    // Zero every trun sample duration (flags 0x301: offset, then duration+size per sample).
    const bytes = fixture("chrome-aac-2s.mp4");
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const buf = Buffer.from(bytes);
    for (let at = buf.indexOf("trun"); at !== -1; at = buf.indexOf("trun", at + 4)) {
      const count = view.getUint32(at + 8);
      for (let i = 0; i < count; i++) view.setUint32(at + 16 + i * 8, 0);
    }
    const seconds = measureAudioDuration(bytes)!.seconds;
    expect(seconds).toBeGreaterThan(1.7);
    expect(seconds).toBeLessThan(2.3);
  });

  it.each([
    ["laced blocks", webm({ packets: [[0x18]], block: (p) => simpleBlock(p, 1, 0x82) })],
    [
      "a second track",
      webm({ packets: [[0x18]], tracks: [trackEntry(1, "A_OPUS"), trackEntry(2, "A_VORBIS")] }),
    ],
    ["a non-Opus codec", webm({ packets: [[0x18]], tracks: [trackEntry(1, "A_VORBIS")] })],
    ["data after the segment", webm({ packets: [[0x18]], trailing: [0x1a, 0x45, 0xdf, 0xa3] })],
    ["an invalid Opus packet", webm({ packets: [[0x1b, 0x3f]] })], // 63 × 60 ms > 120 ms
    ["a truncated file", fixture("chrome-opus-2s.webm").subarray(0, 300)],
    ["a truncated MP4", fixture("chrome-aac-2s.mp4").subarray(0, 700)],
    ["Ogg", new Uint8Array([...ascii("OggS"), ...new Array(60).fill(0)])],
    [
      "WAV",
      new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE"), ...new Array(40).fill(0)]),
    ],
    ["MP3", new Uint8Array([...ascii("ID3"), ...new Array(60).fill(0)])],
    ["random bytes", new Uint8Array(4096).map((_, i) => (i * 7919) & 0xff)],
  ])("refuses %s as unmeasurable", (_label, bytes) => {
    expect(measureAudioDuration(bytes)).toBeNull();
  });

  it("doesn't allocate for an absurd MP4 sample count", () => {
    const bytes = fixture("chrome-opus-2s.mp4");
    const at = Buffer.from(bytes).indexOf("stsz") + 4 + 8;
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(at, 0xffffffff);
    // Fragmented file: the sample table isn't used, fragments still measure it.
    expect(() => measureAudioDuration(bytes)).not.toThrow();
  });
});
