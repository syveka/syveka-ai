import { splitForSpeech } from "./spoken-text";

/**
 * Speech in/out for the assistant's voice mode, behind a small interface so
 * the session logic (`useVoiceSession`) is provider-agnostic and testable.
 * The browser engine below uses the platform Web Speech API: no Syveka
 * provider key, no extra per-minute cost, and every turn still goes through
 * the authenticated `/api/v1/ai/chat` route. A server-side or Vapi-web
 * engine can implement the same interface later without touching the UI.
 */
export type VoiceErrorCode =
  "unsupported" | "permission_denied" | "no_microphone" | "network" | "recognition_failed";

export class VoiceError extends Error {
  constructor(public readonly code: VoiceErrorCode) {
    super(code);
    this.name = "VoiceError";
  }
}

export type ListenHandle = {
  /** Final transcript; "" when nothing was said or listening was stopped. */
  result: Promise<string>;
  stop(): void;
};

export type SpeakHandle = {
  /** Resolves when speech finishes or is cancelled — never rejects. */
  done: Promise<void>;
  cancel(): void;
};

export interface SpeechEngine {
  isSupported(): boolean;
  /** Must be called from a user gesture (tap) — unlocks audio on iOS. */
  primeAudio(): void;
  requestMicrophone(): Promise<void>;
  listen(opts: { lang: string; onInterim?: (text: string) => void }): ListenHandle;
  speak(text: string, lang: string): SpeakHandle;
}

type RecognitionResultList = ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: { resultIndex: number; results: RecognitionResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

type RecognitionCtor = new () => Recognition;

function getRecognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

function recognitionErrorCode(error: string): VoiceErrorCode | null {
  switch (error) {
    case "no-speech":
    case "aborted":
      return null;
    case "not-allowed":
    case "service-not-allowed":
      return "permission_denied";
    case "audio-capture":
      return "no_microphone";
    case "network":
      return "network";
    default:
      return "recognition_failed";
  }
}

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const prefix = lang.split("-")[0]!.toLowerCase();
  return (
    voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(prefix))
  );
}

export function createBrowserSpeechEngine(): SpeechEngine {
  return {
    isSupported() {
      return Boolean(
        getRecognitionCtor() &&
        typeof window !== "undefined" &&
        "speechSynthesis" in window &&
        navigator.mediaDevices?.getUserMedia,
      );
    },

    primeAudio() {
      try {
        const unlock = new SpeechSynthesisUtterance("");
        unlock.volume = 0;
        window.speechSynthesis.speak(unlock);
      } catch {
        // Best effort only — a failure here just means the first reply may
        // need another tap on some mobile browsers.
      }
    },

    async requestMicrophone() {
      if (!navigator.mediaDevices?.getUserMedia) throw new VoiceError("unsupported");
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Only the permission grant is needed — recognition opens its own
        // capture, so release the device immediately.
        stream.getTracks().forEach((track) => track.stop());
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "NotAllowedError" || name === "SecurityError") {
          throw new VoiceError("permission_denied");
        }
        if (name === "NotFoundError" || name === "OverconstrainedError") {
          throw new VoiceError("no_microphone");
        }
        throw new VoiceError("recognition_failed");
      }
    },

    listen({ lang, onInterim }) {
      const Ctor = getRecognitionCtor();
      if (!Ctor) {
        return { result: Promise.reject(new VoiceError("unsupported")), stop() {} };
      }
      const recognition = new Ctor();
      recognition.lang = lang;
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;

      let finalText = "";
      let settled = false;
      const result = new Promise<string>((resolve, reject) => {
        recognition.onresult = (event) => {
          let interim = "";
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const item = event.results[i]!;
            if (item.isFinal) finalText += item[0].transcript;
            else interim += item[0].transcript;
          }
          onInterim?.((finalText + interim).trim());
        };
        recognition.onerror = (event) => {
          const code = recognitionErrorCode(event.error);
          if (code && !settled) {
            settled = true;
            reject(new VoiceError(code));
          }
        };
        recognition.onend = () => {
          if (!settled) {
            settled = true;
            resolve(finalText.trim());
          }
        };
      });
      try {
        recognition.start();
      } catch {
        settled = true;
        return { result: Promise.reject(new VoiceError("recognition_failed")), stop() {} };
      }
      return {
        result,
        stop() {
          finalText = "";
          recognition.abort();
        },
      };
    },

    speak(text, lang) {
      const synth = window.speechSynthesis;
      synth.cancel();
      const chunks = splitForSpeech(text);
      if (chunks.length === 0) return { done: Promise.resolve(), cancel() {} };

      const voice = pickVoice(lang);
      const done = new Promise<void>((resolve) => {
        chunks.forEach((chunk, index) => {
          const utterance = new SpeechSynthesisUtterance(chunk);
          utterance.lang = lang;
          if (voice) utterance.voice = voice;
          if (index === chunks.length - 1) {
            utterance.onend = () => resolve();
          }
          // "interrupted"/"canceled" also land here — speaking is never a
          // reason to fail the session, so always settle.
          utterance.onerror = () => resolve();
          synth.speak(utterance);
        });
      });
      return { done, cancel: () => synth.cancel() };
    },
  };
}
