"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_AUDIO_BYTES,
  MAX_RECORDING_SECONDS,
  MIN_AUDIO_BYTES,
  MIN_RECORDING_MS,
  RECORDING_AUTO_STOP_MS,
  pickRecordingMimeType,
} from "@/lib/voice/audio";

/**
 * idle → requesting (permission prompt) → recording → review (held in this
 * browser only: nothing has been uploaded) → transcribing → idle. A failed
 * transcription worth retrying returns to review with the recording kept.
 */
export type VoiceRecorderStatus = "idle" | "requesting" | "recording" | "review" | "transcribing";

/** A finished recording held in this browser only, awaiting Transcribe or Discard. */
export type PendingRecording = {
  /** Object URL for local playback; null where the browser can't create one. */
  url: string | null;
  durationMs: number;
};

/** Every outcome the UI can explain (chat.voice.errors.*). */
export type VoiceRecorderError =
  | "unsupported"
  | "unsupported_format"
  | "permission_denied"
  | "no_microphone"
  | "microphone_busy"
  | "interrupted"
  | "too_short"
  | "too_large"
  | "empty_transcript"
  | "rate_limited"
  | "quota_exceeded"
  | "daily_limit"
  | "not_allowed"
  | "session_expired"
  | "unavailable"
  | "timeout"
  | "network_error"
  | "transcription_failed";

export class TranscriptionError extends Error {
  constructor(public readonly code: VoiceRecorderError) {
    super(code);
    this.name = "TranscriptionError";
  }
}

export type Transcribe = (audio: Blob, signal: AbortSignal) => Promise<string>;

const HTTP_ERRORS: Record<string, VoiceRecorderError> = {
  unauthenticated: "session_expired",
  permission_denied: "not_allowed",
  transcription_unavailable: "unavailable",
  rate_limited: "rate_limited",
  entitlement_exceeded: "quota_exceeded",
  audio_too_large: "too_large",
  audio_too_long: "too_large",
  daily_limit_reached: "daily_limit",
  voice_not_enabled: "unavailable",
  cross_origin_request: "not_allowed",
  audio_too_short: "too_short",
  unsupported_audio_format: "unsupported_format",
  empty_transcript: "empty_transcript",
  transcription_timeout: "timeout",
};

/** Default transport: the authenticated transcription endpoint. */
export const transcribeViaApi: Transcribe = async (audio, signal) => {
  const form = new FormData();
  form.append("audio", audio, "recording");
  let res: Response;
  try {
    res = await fetch("/api/v1/ai/transcribe", { method: "POST", body: form, signal });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new TranscriptionError("network_error");
  }
  const body = (await res.json().catch(() => null)) as {
    data?: { text?: string };
    error?: { code?: string };
  } | null;
  if (!res.ok || typeof body?.data?.text !== "string") {
    throw new TranscriptionError(HTTP_ERRORS[body?.error?.code ?? ""] ?? "transcription_failed");
  }
  return body.data.text;
};

async function microphoneError(e: unknown): Promise<VoiceRecorderError> {
  const name = e instanceof Error || e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission_denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no_microphone";
  // Some browsers report a blocked prompt with another error name; the
  // Permissions API (where available) says definitively whether it's blocked.
  try {
    const permission = await navigator.permissions?.query({ name: "microphone" as PermissionName });
    if (permission?.state === "denied") return "permission_denied";
  } catch {
    // Not queryable in this browser (e.g. Firefox): fall through.
  }
  if (name === "NotSupportedError" || name === "TypeError") return "unsupported";
  // Held by another app/tab (common on Android during a call) or an OS failure.
  return "microphone_busy";
}

/**
 * Failures where sending the same recording again can succeed. Anything else
 * (limits, permissions, unusable audio) discards the recording.
 */
const RETRYABLE: ReadonlySet<VoiceRecorderError> = new Set<VoiceRecorderError>([
  "network_error",
  "timeout",
  "transcription_failed",
  "rate_limited",
  "unavailable",
]);

export const isRetryableTranscriptionError = (code: VoiceRecorderError | null): boolean =>
  code !== null && RETRYABLE.has(code);

/**
 * Records one short voice clip, lets the user review it locally, and turns it
 * into text via `transcribe` only when they ask. The transcript is only
 * handed to `onTranscript`; nothing is ever sent.
 *
 * Every start creates a session id. Cancel/discard/unmount end the session,
 * so a transcription that resolves late can never reach the caller.
 */
export function useVoiceRecorder({
  onTranscript,
  transcribe = transcribeViaApi,
  autoStopMs = RECORDING_AUTO_STOP_MS,
}: {
  onTranscript: (text: string) => void;
  transcribe?: Transcribe;
  /** Recording stops by itself after this long (kept under the server cap). */
  autoStopMs?: number;
}) {
  const [status, setStatusState] = useState<VoiceRecorderStatus>("idle");
  // Mirrors `status` synchronously so a second tap in the same tick can't
  // start a second recording or a second upload before React re-renders.
  const statusRef = useRef<VoiceRecorderStatus>("idle");
  const setStatus = useCallback((next: VoiceRecorderStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);
  const [error, setError] = useState<VoiceRecorderError | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pending, setPending] = useState<PendingRecording | null>(null);

  const sessionRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uploadRef = useRef<AbortController | null>(null);
  const audioRef = useRef<Blob | null>(null);
  const urlRef = useRef<string | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const transcribeRef = useRef(transcribe);
  transcribeRef.current = transcribe;

  const supported =
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof window.MediaRecorder !== "undefined";

  /** Releases the microphone and timers. Idempotent. */
  const releaseDevice = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // Already stopped by the browser.
        }
      }
    }
    streamRef.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    streamRef.current = null;
  }, []);

  /** Forgets the recorded audio and frees its playback URL. Idempotent. */
  const dropRecording = useCallback(() => {
    audioRef.current = null;
    const url = urlRef.current;
    urlRef.current = null;
    if (url) URL.revokeObjectURL(url);
    setPending(null);
  }, []);

  /** Ends the current session without producing a transcript or an upload. */
  const cancel = useCallback(() => {
    sessionRef.current += 1;
    uploadRef.current?.abort();
    uploadRef.current = null;
    chunksRef.current = [];
    releaseDevice();
    dropRecording();
    setElapsedMs(0);
    setStatus("idle");
  }, [dropRecording, releaseDevice, setStatus]);

  /** The microphone or recorder failed mid-recording: nothing is kept or sent. */
  const interrupt = useCallback(
    (session: number) => {
      if (session !== sessionRef.current || statusRef.current !== "recording") return;
      cancel();
      setError("interrupted");
    },
    [cancel],
  );

  /** Finishes the recording and holds it for review. Uploads nothing. */
  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive" || statusRef.current !== "recording") return;
    const session = sessionRef.current;
    const durationMs = Date.now() - startedAtRef.current;
    const mimeType = recorder.mimeType;
    recorder.onstop = () => {
      const audio = new Blob(chunksRef.current, mimeType ? { type: mimeType } : undefined);
      chunksRef.current = [];
      releaseDevice();
      if (session !== sessionRef.current) return;
      setElapsedMs(0);
      // Unusable audio is refused here, before review; the server checks again.
      if (durationMs < MIN_RECORDING_MS || audio.size < MIN_AUDIO_BYTES) {
        setStatus("idle");
        setError("too_short");
        return;
      }
      if (audio.size > MAX_AUDIO_BYTES) {
        setStatus("idle");
        setError("too_large");
        return;
      }
      audioRef.current = audio;
      let url: string | null = null;
      try {
        url = typeof URL.createObjectURL === "function" ? URL.createObjectURL(audio) : null;
      } catch {
        url = null; // Playback is optional; Transcribe and Discard still work.
      }
      urlRef.current = url;
      setPending({ url, durationMs: Math.min(durationMs, MAX_RECORDING_SECONDS * 1000) });
      setStatus("review");
    };
    // Our own stop must not be reported as an interrupted recording.
    recorder.onerror = null;
    streamRef.current?.getTracks().forEach((track) => {
      track.onended = null;
    });
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    // Review starts now; `pending` appears once the browser has written the
    // final chunk (Transcribe is ignored until then, Discard always works).
    setStatus("review");
    recorder.stop();
  }, [releaseDevice, setStatus]);

  /**
   * Uploads the reviewed recording, only on an explicit tap. A second tap
   * while uploading is ignored. A retryable failure keeps the recording so
   * the user can press Transcribe again; a recording yields at most one
   * transcript.
   */
  const transcribeRecording = useCallback(async () => {
    const audio = audioRef.current;
    if (statusRef.current !== "review" || !audio) return;
    const session = sessionRef.current;
    setError(null);
    setStatus("transcribing");
    const controller = new AbortController();
    uploadRef.current = controller;
    let failure: VoiceRecorderError | null = null;
    let text = "";
    try {
      text = (await transcribeRef.current(audio, controller.signal)).trim();
      if (!text) failure = "empty_transcript";
    } catch (e) {
      failure = e instanceof TranscriptionError ? e.code : "network_error";
    }
    if (session !== sessionRef.current) return; // cancelled, discarded or unmounted meanwhile
    uploadRef.current = null;
    if (failure && isRetryableTranscriptionError(failure)) {
      setError(failure);
      setStatus("review");
      return;
    }
    sessionRef.current += 1;
    dropRecording();
    setStatus("idle");
    if (failure) setError(failure);
    else onTranscriptRef.current(text);
  }, [dropRecording, setStatus]);

  const start = useCallback(async () => {
    if (statusRef.current !== "idle") return; // no duplicate recordings
    setError(null);
    if (!supported) {
      setError("unsupported");
      return;
    }
    const mimeType = pickRecordingMimeType(
      typeof MediaRecorder.isTypeSupported === "function"
        ? (type) => MediaRecorder.isTypeSupported(type)
        : undefined,
    );
    if (mimeType === undefined) {
      setError("unsupported_format");
      return;
    }

    const session = ++sessionRef.current;
    setStatus("requesting");
    let stream: MediaStream;
    try {
      // Only ever called from an explicit tap on the microphone button.
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (session !== sessionRef.current) return;
      setStatus("idle");
      setError(await microphoneError(e));
      return;
    }
    if (session !== sessionRef.current) {
      // Cancelled (or unmounted) while the permission prompt was open.
      stream.getTracks().forEach((track) => track.stop());
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      stream.getTracks().forEach((track) => track.stop());
      setStatus("idle");
      setError("unsupported_format");
      return;
    }
    streamRef.current = stream;
    recorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
    };
    // Microphone unplugged, permission revoked or the device taken by the OS.
    recorder.onerror = () => interrupt(session);
    stream.getTracks().forEach((track) => {
      track.onended = () => interrupt(session);
    });
    recorder.start(1000);
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setStatus("recording");
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(Math.min(elapsed, MAX_RECORDING_SECONDS * 1000));
      if (elapsed >= autoStopMs) stop();
    }, 250);
  }, [autoStopMs, interrupt, setStatus, stop, supported]);

  // Hiding the tab never keeps the microphone open: a recording in progress
  // stops and waits for review (nothing is uploaded); a pending permission
  // request is abandoned. Leaving the page discards everything.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      if (statusRef.current === "recording") stop();
      else if (statusRef.current === "requesting") cancel();
    };
    const onPageHide = () => cancel();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [cancel, stop]);

  // Unmount (navigation, organization switch): no upload, no late transcript.
  useEffect(
    () => () => {
      sessionRef.current += 1;
      uploadRef.current?.abort();
      releaseDevice();
      audioRef.current = null;
      const url = urlRef.current;
      urlRef.current = null;
      if (url) URL.revokeObjectURL(url);
    },
    [releaseDevice],
  );

  return {
    status,
    error,
    elapsedMs,
    supported,
    /** The recording awaiting review (status "review", or "transcribing" it). */
    pending,
    start,
    stop,
    cancel,
    /** Discards the reviewed recording without uploading it. */
    discard: cancel,
    transcribe: transcribeRecording,
    clearError: () => setError(null),
  };
}
