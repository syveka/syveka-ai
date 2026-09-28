import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { measureAudioDuration } from "@/lib/voice/audio-duration";

/**
 * Hostile-input review of the duration parser: resource exhaustion, timeline
 * tricks and demuxer differences. Files are built byte by byte; real
 * Chromium recordings are used as fuzzing seeds.
 */
const fixture = (name: string) =>
  new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures/audio", name)));

// ── Minimal ISO BMFF builder ──
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const box = (type: string, ...parts: number[][]) => {
  const body = parts.flat();
  return [...u32(body.length + 8), ...ascii(type), ...body];
};
const full = (type: string, flags: number, ...parts: number[][]) =>
  box(type, [0, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);

const OPUS_60MS = 0x18; // SILK 60 ms, one frame

function mp4({
  tablePackets = 0,
  fragmentPackets = 0,
  stsc,
  elst,
}: {
  tablePackets?: number;
  fragmentPackets?: number;
  stsc?: number[][];
  elst?: number[];
}) {
  const ftyp = box("ftyp", ascii("isom"), u32(0), ascii("isomiso2"));
  const tableData = new Array(tablePackets).fill(OPUS_60MS);
  const mdat1 = box("mdat", tableData);
  const dataOffset = ftyp.length + 8;
  const opusEntry = box("Opus", new Array(6).fill(0), u16(1), new Array(20).fill(0));
  const stbl = box(
    "stbl",
    full("stsd", 0, u32(1), opusEntry),
    full("stts", 0, u32(1), u32(tablePackets), u32(2880)),
    full(
      "stsc",
      0,
      u32(stsc ? stsc.length : 1),
      ...(stsc ?? [[...u32(1), ...u32(tablePackets || 1), ...u32(1)]]),
    ),
    full("stsz", 0, u32(1), u32(tablePackets)),
    full("stco", 0, u32(1), u32(dataOffset)),
  );
  const mdia = box(
    "mdia",
    full("mdhd", 0, u32(0), u32(0), u32(48000), u32(0), u32(0)),
    box("minf", stbl),
  );
  const edts = elst ? box("edts", full("elst", 0, elst)) : [];
  const trak = box("trak", edts, mdia);
  const mvhd = full("mvhd", 0, u32(0), u32(0), u32(1000), u32(0), new Array(80).fill(0));
  const mvex = fragmentPackets
    ? box("mvex", full("trex", 0, u32(1), u32(1), u32(0), u32(0), u32(0)))
    : [];
  const moov = box("moov", mvhd, trak, mvex);
  let frag: number[] = [];
  if (fragmentPackets) {
    const trunBody = (offset: number) => [
      ...u32(fragmentPackets),
      ...u32(offset),
      ...new Array(fragmentPackets).fill(0).flatMap(() => u32(1)), // per-sample size 1
    ];
    const build = (offset: number) =>
      box(
        "moof",
        full("mfhd", 0, u32(1)),
        box("traf", full("tfhd", 0x020000, u32(1)), full("trun", 0x000201, trunBody(offset))),
      );
    const moofLength = build(0).length;
    frag = [...build(moofLength + 8), ...box("mdat", new Array(fragmentPackets).fill(OPUS_60MS))];
  }
  return new Uint8Array([...ftyp, ...mdat1, ...moov, ...frag]);
}

const timed = <T>(fn: () => T) => {
  const started = performance.now();
  const result = fn();
  return { result, ms: performance.now() - started };
};

describe("MP4 sample table and fragments", () => {
  it("measures a plain (non-fragmented) MP4 from its sample table", () => {
    expect(measureAudioDuration(mp4({ tablePackets: 1000 }))?.seconds).toBeCloseTo(60, 5);
  });

  it("counts sample-table AND fragment samples (a demuxer plays both)", () => {
    const file = mp4({ tablePackets: 600, fragmentPackets: 600 });
    expect(measureAudioDuration(file)?.seconds).toBeCloseTo(72, 5);
  });
});

describe("resource limits (bounded by the bytes that back each loop)", () => {
  it("refuses a trun claiming billions of samples with no per-sample data, quickly", () => {
    const bytes = fixture("chrome-opus-2s.mp4");
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const at = Buffer.from(bytes).indexOf("trun") + 4;
    view.setUint32(at, 0x000001); // version 0, flags: data-offset only (defaults for the rest)
    view.setUint32(at + 4, 0xffffffff);
    const { result, ms } = timed(() => measureAudioDuration(bytes));
    expect(result).toBeNull();
    expect(ms).toBeLessThan(200);
  });

  it("refuses a sample-to-chunk run with zero samples per chunk, quickly", () => {
    const file = mp4({
      tablePackets: 10,
      stsc: [[...u32(1), ...u32(0), ...u32(1)]],
    });
    const { result, ms } = timed(() => measureAudioDuration(file));
    expect(result).toBeNull();
    expect(ms).toBeLessThan(200);
  });

  it("refuses deeply nested WebM block groups without exhausting the stack", () => {
    // EBML header, unknown-size Segment, then 50 000 nested BlockGroups.
    const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x80];
    const segment = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    const depth = 50_000;
    const nested: number[] = [];
    for (let i = 0; i < depth; i++) {
      const remaining = (depth - i - 1) * 5;
      nested.push(
        0xa0,
        0x10 | ((remaining >>> 24) & 0x0f),
        (remaining >>> 16) & 255,
        (remaining >>> 8) & 255,
        remaining & 255,
      );
    }
    const { result, ms } = timed(() =>
      measureAudioDuration(new Uint8Array([...ebml, ...segment, ...nested])),
    );
    expect(result).toBeNull();
    expect(ms).toBeLessThan(500);
  });
});

describe("timeline tricks", () => {
  const edit = (segment: number, mediaTime: number, rate = 1) => [
    ...u32(1),
    ...u32(segment),
    ...u32(mediaTime >>> 0),
    ...u16(rate),
    ...u16(0),
  ];

  it("accepts one plain edit and never lets it shorten the result", () => {
    expect(
      measureAudioDuration(mp4({ tablePackets: 100, elst: edit(500, 0) }))?.seconds,
    ).toBeCloseTo(6, 5);
  });

  it("counts a single edit presented longer than the media", () => {
    // 6 s of media presented over 90 s (movie timescale 1000).
    expect(measureAudioDuration(mp4({ tablePackets: 100, elst: edit(90_000, 0) }))?.seconds).toBe(
      90,
    );
  });

  it.each([
    ["an empty edit (inserted silence)", edit(3_600_000, -1)],
    ["a non-1.0 playback rate", edit(1000, 0, 2)],
    ["several edits", [...u32(2), ...edit(1000, 0).slice(4), ...edit(1000, 0).slice(4)]],
  ])("refuses %s", (_label, elst) => {
    expect(measureAudioDuration(mp4({ tablePackets: 100, elst }))).toBeNull();
  });
});

describe("deprecated frame-carrying WebM elements", () => {
  it.each([
    ["EncryptedBlock", 0xaf],
    ["BlockVirtual", 0xa2],
  ])("refuses %s", (_label, id) => {
    const bytes = fixture("chrome-opus-2s.webm");
    const at = bytes.findIndex((v, i) => v === 0xa3 && i > 100); // first SimpleBlock ID
    const mutated = bytes.slice();
    mutated[at] = id;
    expect(measureAudioDuration(mutated)).toBeNull();
  });
});

describe("fuzzing with real recordings as seeds", () => {
  // Deterministic xorshift PRNG so failures are reproducible.
  let seed = 0x5eed;
  const random = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x100000000;
  };

  it.each(["chrome-opus-2s.webm", "chrome-opus-2s.mp4", "chrome-aac-2s.mp4"])(
    "%s: 1500 random corruptions never throw, never hang, never report nonsense",
    (name) => {
      const original = fixture(name);
      let slowest = 0;
      for (let i = 0; i < 1500; i++) {
        const bytes = original.slice(
          0,
          random() < 0.2 ? Math.floor(random() * original.length) : original.length,
        );
        const edits = 1 + Math.floor(random() * 8);
        for (let k = 0; k < edits; k++) {
          bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
        }
        const { result, ms } = timed(() => measureAudioDuration(bytes));
        slowest = Math.max(slowest, ms);
        if (result) {
          expect(Number.isFinite(result.seconds)).toBe(true);
          expect(result.seconds).toBeGreaterThanOrEqual(0);
        }
      }
      expect(slowest).toBeLessThan(250);
    },
  );
});
