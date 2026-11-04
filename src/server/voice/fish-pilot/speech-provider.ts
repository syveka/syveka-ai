import "server-only";

import type { PilotLanguage, PilotMockFailure } from "@/lib/voice/fish-pilot-scenarios";

export type SpeechRequest = { text: string; language: PilotLanguage; signal: AbortSignal };

/** Streaming text-to-speech. Audio is 16-bit little-endian mono PCM at `sampleRate`. */
export type SpeechProvider = {
  name: string;
  sampleRate: number;
  /** True when timings come from injected delays, so they say nothing about a real provider. */
  syntheticTiming: boolean;
  stream(request: SpeechRequest): AsyncIterable<Uint8Array>;
};

export type SpeechErrorCode =
  "provider_failed" | "provider_timeout" | "malformed_audio" | "interrupted";

/** Carries a stable code only: provider response bodies never reach the caller or the logs. */
export class SpeechError extends Error {
  constructor(public readonly code: SpeechErrorCode) {
    super(code);
    this.name = "SpeechError";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new SpeechError("interrupted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SpeechError("interrupted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type MockSpeechOptions = {
  failure?: PilotMockFailure;
  firstChunkDelayMs?: number;
  chunkDelayMs?: number;
};

/** A deterministic tone, as long as the text would roughly take to say. Costs nothing. */
export function createMockSpeechProvider(options: MockSpeechOptions = {}): SpeechProvider {
  const { failure = "none", firstChunkDelayMs = 150, chunkDelayMs = 20 } = options;
  const sampleRate = 16_000;
  const samplesPerChunk = sampleRate / 10;

  function chunk(index: number): Uint8Array {
    const pcm = new Int16Array(samplesPerChunk);
    for (let i = 0; i < pcm.length; i++) {
      const t = (index * samplesPerChunk + i) / sampleRate;
      pcm[i] = Math.round(Math.sin(2 * Math.PI * 220 * t) * 4000);
    }
    return new Uint8Array(pcm.buffer);
  }

  return {
    name: "mock",
    sampleRate,
    syntheticTiming: true,
    async *stream({ text, signal }) {
      await sleep(firstChunkDelayMs, signal);
      if (failure === "provider_error") throw new SpeechError("provider_failed");
      if (failure === "stall") await sleep(60 * 60 * 1000, signal);
      if (failure === "malformed_audio") {
        yield new Uint8Array([1]);
        return;
      }
      const chunks = Math.max(3, Math.ceil(text.length / 2));
      for (let i = 0; i < chunks; i++) {
        if (failure === "mid_stream" && i === 2) throw new SpeechError("provider_failed");
        yield chunk(i);
        await sleep(chunkDelayMs, signal);
      }
    },
  };
}

export type SpeechGuardOptions = {
  firstChunkTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
};

export const DEFAULT_SPEECH_GUARD: SpeechGuardOptions = {
  firstChunkTimeoutMs: 5_000,
  idleTimeoutMs: 3_000,
  totalTimeoutMs: 25_000,
};

/**
 * What a phone call needs from any provider: a stream that can't hang (first-chunk
 * and idle timeouts, and an overall deadline), stops promptly on barge-in, yields only whole 16-bit samples
 * even when the network splits one, and reports failure as a stable code.
 */
export async function* guardSpeechStream(
  provider: SpeechProvider,
  request: Omit<SpeechRequest, "signal">,
  signal: AbortSignal,
  options: SpeechGuardOptions = DEFAULT_SPEECH_GUARD,
): AsyncGenerator<Uint8Array> {
  const internal = new AbortController();
  const stopProvider = () => internal.abort();
  if (signal.aborted) stopProvider();
  else signal.addEventListener("abort", stopProvider, { once: true });

  const iterator = provider.stream({ ...request, signal: internal.signal })[Symbol.asyncIterator]();
  let carry: number | null = null;
  let yieldedAudio = false;
  const startedAt = Date.now();
  const firstChunkDeadline = startedAt + options.firstChunkTimeoutMs;
  const totalDeadline = startedAt + options.totalTimeoutMs;

  // Empty or half-sample chunks don't extend the first-chunk wait; nothing extends the total.
  function timeLeftMs(): number {
    const now = Date.now();
    const stage = yieldedAudio ? now + options.idleTimeoutMs : firstChunkDeadline;
    return Math.max(0, Math.min(stage, totalDeadline) - now);
  }

  async function nextChunk(timeoutMs: number): Promise<IteratorResult<Uint8Array>> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new SpeechError("provider_timeout")), timeoutMs);
        }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new SpeechError("interrupted"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  try {
    while (true) {
      const next = await nextChunk(timeLeftMs());
      if (next.done) break;
      const incoming = next.value;
      if (incoming.length === 0) continue;

      const bytes: Uint8Array = new Uint8Array(incoming.length + (carry === null ? 0 : 1));
      if (carry !== null) bytes[0] = carry;
      bytes.set(incoming, carry === null ? 0 : 1);
      const whole: number = bytes.length - (bytes.length % 2);
      carry = whole < bytes.length ? (bytes[whole] as number) : null;
      if (whole === 0) continue;
      yieldedAudio = true;
      yield bytes.slice(0, whole);
    }
    if (!yieldedAudio) throw new SpeechError("malformed_audio");
  } catch (error) {
    if (error instanceof SpeechError) throw error;
    if (signal.aborted) throw new SpeechError("interrupted");
    throw new SpeechError("provider_failed");
  } finally {
    stopProvider();
    signal.removeEventListener("abort", stopProvider);
    // Not awaited: a stalled provider's pending next() must not delay the caller.
    void iterator.return?.(undefined)?.catch(() => undefined);
  }
}
