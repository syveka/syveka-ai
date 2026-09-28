import { describe, expect, it } from "vitest";
import {
  DEFAULT_VAD_CONFIG,
  VoiceActivityDetector,
  rmsLevel,
  type VadEvent,
} from "@/lib/voice/vad";

/** Drives the detector with a level timeline at 50 ms ticks. */
function run(
  vad: VoiceActivityDetector,
  segments: Array<[level: number, ms: number]>,
  mode: "listening" | "assistant_speaking" = "listening",
  start = 0,
) {
  const events: Array<VadEvent & { t: number }> = [];
  let t = start;
  for (const [level, ms] of segments) {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      const e = vad.feed(level, t, mode);
      if (e) events.push({ ...e, t });
      t += 50;
    }
  }
  return { events, t };
}

const QUIET = 0.003;
const VOICE = 0.08;

describe("VoiceActivityDetector", () => {
  it("detects one utterance and ends it after the silence gap", () => {
    const vad = new VoiceActivityDetector();
    vad.reset(0);
    const { events } = run(vad, [
      [QUIET, 600], // calibration + quiet
      [VOICE, 1200],
      [QUIET, 1200],
    ]);
    expect(events.map((e) => e.type)).toEqual(["speech_start", "speech_end"]);
    const end = events[1] as { durationMs: number };
    expect(end.durationMs).toBeGreaterThanOrEqual(1100);
  });

  it("ignores steady background noise and adapts to it", () => {
    const vad = new VoiceActivityDetector();
    vad.reset(0);
    const { events } = run(vad, [[0.01, 5000]]); // constant hum from the start
    expect(events).toEqual([]);
  });

  it("discards short bursts (cough, click) instead of submitting them", () => {
    const vad = new VoiceActivityDetector();
    vad.reset(0);
    const { events } = run(vad, [
      [QUIET, 600],
      [VOICE, 250],
      [QUIET, 1200],
    ]);
    expect(events.map((e) => e.type)).toEqual(["speech_start", "speech_discarded"]);
  });

  it("keeps a short pause inside one turn", () => {
    const vad = new VoiceActivityDetector();
    vad.reset(0);
    const { events } = run(vad, [
      [QUIET, 600],
      [VOICE, 800],
      [QUIET, 400], // shorter than endSilenceMs
      [VOICE, 800],
      [QUIET, 1200],
    ]);
    expect(events.map((e) => e.type)).toEqual(["speech_start", "speech_end"]);
  });

  it("cuts a turn at the maximum length", () => {
    const vad = new VoiceActivityDetector({ ...DEFAULT_VAD_CONFIG, maxTurnMs: 2000 });
    vad.reset(0);
    const { events } = run(vad, [
      [QUIET, 600],
      [VOICE, 5000],
    ]);
    // The hook stops feeding while a cut turn is processed; here the stream just continues.
    expect(events.slice(0, 2).map((e) => e.type)).toEqual(["speech_start", "max_turn"]);
    expect(events[1]!.t - events[0]!.t).toBeLessThanOrEqual(2200);
  });

  it("while the assistant speaks: normal speech level doesn't interrupt, loud sustained speech does", () => {
    const vad = new VoiceActivityDetector();
    vad.reset(0);
    run(vad, [[QUIET, 600]]);
    const echo = run(vad, [[vad.threshold * 1.5, 2000]], "assistant_speaking", 600);
    expect(echo.events).toEqual([]);
    const interrupt = run(vad, [[VOICE, 600]], "assistant_speaking", echo.t);
    expect(interrupt.events.map((e) => e.type)).toEqual(["barge_in"]);
  });

  it("measures RMS", () => {
    expect(rmsLevel(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rmsLevel(new Float32Array(0))).toBe(0);
  });
});
