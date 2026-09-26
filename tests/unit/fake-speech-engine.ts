import { vi } from "vitest";
import { VoiceError, type SpeechEngine, type VoiceErrorCode } from "@/lib/voice/speech-engine";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Fully controllable SpeechEngine for tests: each listen()/speak() call
 * returns a pending promise the test settles explicitly, so every
 * intermediate UI state can be observed. Never touches real audio.
 */
export function createFakeSpeechEngine(opts: { supported?: boolean } = {}) {
  const listens: Array<Deferred<string> & { onInterim?: (text: string) => void; lang: string }> =
    [];
  const speeches: Array<Deferred<void> & { text: string; lang: string }> = [];
  let micError: VoiceErrorCode | null = null;

  const engine: SpeechEngine = {
    isSupported: vi.fn(() => opts.supported ?? true),
    primeAudio: vi.fn(),
    requestMicrophone: vi.fn(async () => {
      if (micError) throw new VoiceError(micError);
    }),
    listen: vi.fn(({ lang, onInterim }) => {
      const d = Object.assign(deferred<string>(), { onInterim, lang });
      listens.push(d);
      return { result: d.promise, stop: vi.fn(() => d.resolve("")) };
    }),
    speak: vi.fn((text: string, lang: string) => {
      const d = Object.assign(deferred<void>(), { text, lang });
      speeches.push(d);
      return { done: d.promise, cancel: vi.fn(() => d.resolve()) };
    }),
  };

  return {
    engine,
    listens,
    speeches,
    denyMicrophone(code: VoiceErrorCode = "permission_denied") {
      micError = code;
    },
    allowMicrophone() {
      micError = null;
    },
    get lastListen() {
      return listens[listens.length - 1]!;
    },
    get lastSpeech() {
      return speeches[speeches.length - 1]!;
    },
  };
}
