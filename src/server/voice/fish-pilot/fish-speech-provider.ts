import "server-only";

import { SpeechError, type SpeechProvider } from "./speech-provider";

const FISH_TTS_URL = "https://api.fish.audio/v1/tts";
const SAMPLE_RATE = 16_000;

/**
 * Fish Audio REST text-to-speech, written from the published API reference
 * (docs.fish.audio, read 2026-11-05) and never yet run against the real API. The
 * reference states 16-bit mono PCM but neither the byte order nor whether the body is
 * headerless, nor the response content type, so the first approved real call has to
 * check all three.
 *
 * Fails with stable codes only: response bodies stay out of errors and logs.
 */
export function createFishSpeechProvider(config: {
  apiKey: string;
  voiceId: string;
  model: string;
}): SpeechProvider {
  return {
    name: `fish:${config.model}`,
    sampleRate: SAMPLE_RATE,
    syntheticTiming: false,
    async *stream({ text, language, signal }) {
      let response: Response;
      try {
        response = await fetch(FISH_TTS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
            model: config.model,
          },
          body: JSON.stringify({
            text,
            reference_id: config.voiceId,
            language,
            format: "pcm",
            sample_rate: SAMPLE_RATE,
            latency: "balanced",
          }),
          redirect: "error",
          signal,
        });
      } catch {
        throw new SpeechError(signal.aborted ? "interrupted" : "provider_failed");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new SpeechError("provider_failed");
      }
      // An allowlist: a gateway's error page must not be played, or reported, as audio.
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.body || !/^(audio\/|application\/octet-stream)/i.test(contentType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new SpeechError("malformed_audio");
      }

      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } catch {
        throw new SpeechError(signal.aborted ? "interrupted" : "provider_failed");
      } finally {
        reader.cancel().catch(() => undefined);
      }
    },
  };
}
