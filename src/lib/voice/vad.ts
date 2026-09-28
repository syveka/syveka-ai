/**
 * Energy-based voice activity detection for live voice conversation.
 *
 * Pure and deterministic: feed it the microphone's RMS level (0..1) with a
 * timestamp; it returns at most one event per call. It calibrates to the
 * room's noise, adapts slowly while nobody speaks, and requires a longer and
 * louder signal to interrupt the assistant, so its own loudspeaker output is
 * less likely to be taken for the user (browser echo cancellation does the
 * rest; neither is perfect, which is why the user can also mute).
 */
export type VadConfig = {
  /** Initial ambient-noise measurement before any speech is accepted. */
  calibrationMs: number;
  /** Speech threshold = noise floor × this, but at least `minThreshold`. */
  speechFactor: number;
  minThreshold: number;
  /** Level must stay above the threshold this long to count as speech. */
  onsetMs: number;
  /** Silence this long after speech ends the turn. */
  endSilenceMs: number;
  /** Shorter bursts (a cough, a click) are discarded, not submitted. */
  minSpeechMs: number;
  /** Interrupting the assistant needs threshold × this, held for bargeInMs. */
  bargeInFactor: number;
  bargeInMs: number;
  /** A turn is cut here even if the user keeps talking. */
  maxTurnMs: number;
};

export const DEFAULT_VAD_CONFIG: VadConfig = {
  calibrationMs: 400,
  speechFactor: 3,
  minThreshold: 0.012,
  onsetMs: 150,
  endSilenceMs: 900,
  minSpeechMs: 400,
  bargeInFactor: 2,
  bargeInMs: 350,
  maxTurnMs: 29_000,
};

export type VadMode = "listening" | "assistant_speaking";
export type VadEvent =
  | { type: "speech_start"; at: number }
  | { type: "speech_end"; durationMs: number }
  | { type: "speech_discarded" }
  | { type: "max_turn" }
  | { type: "barge_in" };

export class VoiceActivityDetector {
  private startedAt = 0;
  private noise = 0;
  private samples = 0;
  private aboveSince: number | null = null;
  private speechStart: number | null = null;
  private lastVoiceAt = 0;

  constructor(private readonly config: VadConfig = DEFAULT_VAD_CONFIG) {}

  /** Starts (or restarts after a turn/mute) without forgetting the noise floor. */
  reset(now: number, { recalibrate = false } = {}): void {
    if (recalibrate || this.samples === 0) {
      this.startedAt = now;
      this.noise = 0;
      this.samples = 0;
    }
    this.aboveSince = null;
    this.speechStart = null;
  }

  /** The user is already talking (e.g. after interrupting the assistant). */
  beginSpeech(now: number): void {
    this.speechStart = now;
    this.lastVoiceAt = now;
    this.aboveSince = null;
  }

  get threshold(): number {
    return Math.max(this.noise * this.config.speechFactor, this.config.minThreshold);
  }

  get speaking(): boolean {
    return this.speechStart !== null;
  }

  feed(level: number, now: number, mode: VadMode): VadEvent | null {
    const c = this.config;
    if (now - this.startedAt < c.calibrationMs) {
      this.samples += 1;
      this.noise += (level - this.noise) / this.samples;
      return null;
    }

    if (mode === "assistant_speaking") {
      if (level > this.threshold * c.bargeInFactor) {
        this.aboveSince ??= now;
        if (now - this.aboveSince >= c.bargeInMs) {
          this.aboveSince = null;
          return { type: "barge_in" };
        }
      } else {
        this.aboveSince = null;
      }
      return null;
    }

    if (this.speechStart === null) {
      if (level > this.threshold) {
        this.aboveSince ??= now;
        if (now - this.aboveSince >= c.onsetMs) {
          this.speechStart = this.aboveSince;
          this.lastVoiceAt = now;
          this.aboveSince = null;
          return { type: "speech_start", at: this.speechStart };
        }
      } else {
        this.aboveSince = null;
        // Adapt slowly to the room while nobody is speaking.
        this.noise += (level - this.noise) * 0.02;
      }
      return null;
    }

    // In speech: hysteresis (70 % of the threshold) keeps short dips inside the turn.
    if (level > this.threshold * 0.7) this.lastVoiceAt = now;
    if (now - this.speechStart >= c.maxTurnMs) {
      this.speechStart = null;
      return { type: "max_turn" };
    }
    if (now - this.lastVoiceAt >= c.endSilenceMs) {
      const durationMs = this.lastVoiceAt - this.speechStart;
      this.speechStart = null;
      return durationMs >= c.minSpeechMs
        ? { type: "speech_end", durationMs }
        : { type: "speech_discarded" };
    }
    return null;
  }
}

/** Root-mean-square level of one frame of time-domain samples (-1..1). */
export function rmsLevel(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}
