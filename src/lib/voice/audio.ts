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
 * leaves headroom for higher-bitrate recorders while bounding the paid
 * provider work a single request can cause. The server can't cheaply decode
 * duration, so this size cap is its enforceable bound.
 */
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

/** Recorded chunks smaller than this carry no usable speech. */
export const MIN_AUDIO_BYTES = 1024;

/** Formats the recorder may produce, in order of preference. */
export const RECORDING_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
  "audio/ogg",
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

export type AudioContainer = "webm" | "ogg" | "mp4" | "wav" | "mp3";

/**
 * Identifies the container from its leading bytes. The declared MIME type
 * and file name come from the client and are not trusted.
 */
export function detectAudioContainer(bytes: Uint8Array): AudioContainer | null {
  const at = (offset: number, ...values: number[]) =>
    values.every((value, i) => bytes[offset + i] === value);
  const ascii = (offset: number, text: string) =>
    at(offset, ...Array.from(text, (c) => c.charCodeAt(0)));

  if (bytes.length < 12) return null;
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return "webm"; // EBML (WebM/Matroska)
  if (ascii(0, "OggS")) return "ogg";
  if (ascii(4, "ftyp")) return "mp4"; // ISO BMFF (MP4/M4A)
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "wav";
  if (ascii(0, "ID3") || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)) return "mp3";
  return null;
}

export const AUDIO_CONTAINER_MIME: Record<AudioContainer, string> = {
  webm: "audio/webm",
  ogg: "audio/ogg",
  mp4: "audio/mp4",
  wav: "audio/wav",
  mp3: "audio/mpeg",
};
