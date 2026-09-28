/**
 * Chat voice input limits and audio-format helpers, shared by the browser
 * recorder and the transcription endpoint so both enforce the same numbers.
 */

/** Recording stops automatically at this length (shown in the UI). */
export const MAX_RECORDING_SECONDS = 60;

/** Anything shorter is treated as an accidental tap, not sent for transcription. */
export const MIN_RECORDING_MS = 700;

/**
 * Upload cap. A minute of browser audio is ~0.2–1 MB (Opus/AAC); the cap
 * leaves headroom for higher-bitrate recorders. Duration is enforced
 * separately on the server from the decoded frames (audio-duration.ts); a
 * size cap alone can't bound duration.
 */
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

/** Recorded chunks smaller than this carry no usable speech. */
export const MIN_AUDIO_BYTES = 1024;

/**
 * Formats the recorder may produce, in order of preference. These are exactly
 * the formats the server can measure (WebM/Opus, MP4 with Opus or AAC); Ogg is
 * deliberately absent — every browser that records Ogg also records WebM.
 */
export const RECORDING_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
] as const;

/**
 * First recorder format this browser supports, `null` for "let the browser
 * choose" when it can't report support, or `undefined` when it supports none.
 */
export function pickRecordingMimeType(
  isTypeSupported: ((type: string) => boolean) | undefined,
): string | null | undefined {
  if (!isTypeSupported) return null;
  return RECORDING_MIME_CANDIDATES.find((type) => isTypeSupported(type));
}
