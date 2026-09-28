"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MAX_AUDIO_BYTES,
  MAX_RECORDING_SECONDS,
  MIN_AUDIO_BYTES,
  MIN_RECORDING_MS,
  pickRecordingMimeType,
} from "@/lib/voice/audio";

export type VoiceRecorderStatus = "idle" | "requesting" | "recording" | "transcribing";

/** Every outcome the UI can explain (chat.voice.errors.*). */
export type VoiceRecorderError =
  | "unsupported"
  | "unsupported_format"
  | "permission_denied"
  | "no_microphone"
  | "microphone_busy"
  | "too_short"
  | "too_large"
  | "empty_transcript"
  | "rate_limited"
  | "quota_exceeded"
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
 * Records one short voice clip and turns it into text via `transcribe`.
 * The transcript is only handed to `onTranscript`; nothing is ever sent.
 *
 * Every start creates a session id. Stop/cancel/unmount end the session, so a
 * transcription that resolves late can never reach the caller.
 */
export function useVoiceRecorder({
  onTranscript,
  transcribe = transcribeViaApi,
  maxSeconds = MAX_RECORDING_SECONDS,
}: {
  onTranscript: (text: string) => void;
  transcribe?: Transcribe;
  maxSeconds?: number;
}) {
  const [status, setStatusState] = useState<VoiceRecorderStatus>("idle");
  // Mirrors `status` synchronously so a second tap in the same tick can't
  // start a second recording before React re-renders.
  const statusRef = useRef<VoiceRecorderStatus>("idle");
  const setStatus = useCallback((next: VoiceRecorderStatus) => {
    statusRef.current = next;
    setStatusState(next);
  }, []);
  const [error, setError] = useState<VoiceRecorderError | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const sessionRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uploadRef = useRef<AbortController | null>(null);
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
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // Already stopped by the browser.
        }
      }
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  /** Ends the current session without producing a transcript. */
  const cancel = useCallback(() => {
    sessionRef.current += 1;
    uploadRef.current?.abort();
    uploadRef.current = null;
    chunksRef.current = [];
    releaseDevice();
    setElapsedMs(0);
    setStatus("idle");
  }, [releaseDevice, setStatus]);

  const upload = useCallback(
    async (session: number, audio: Blob, durationMs: number) => {
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
      setStatus("transcribing");
      const controller = new AbortController();
      uploadRef.current = controller;
      try {
        const text = await transcribeRef.current(audio, controller.signal);
        if (session !== sessionRef.current) return; // cancelled or unmounted meanwhile
        if (!text.trim()) {
          setError("empty_transcript");
        } else {
          onTranscriptRef.current(text.trim());
        }
      } catch (e) {
        if (session !== sessionRef.current) return;
        setError(e instanceof TranscriptionError ? e.code : "network_error");
      } finally {
        if (session === sessionRef.current) {
          uploadRef.current = null;
          setStatus("idle");
          setElapsedMs(0);
        }
      }
    },
    [setStatus],
  );

  /** Finishes the recording and transcribes it. */
  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    const session = sessionRef.current;
    const durationMs = Date.now() - startedAtRef.current;
    const mimeType = recorder.mimeType;
    recorder.onstop = () => {
      const audio = new Blob(chunksRef.current, mimeType ? { type: mimeType } : undefined);
      chunksRef.current = [];
      releaseDevice();
      if (session !== sessionRef.current) return;
      void upload(session, audio, durationMs);
    };
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    setStatus("transcribing");
    recorder.stop();
  }, [releaseDevice, setStatus, upload]);

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
    recorder.start(1000);
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setStatus("recording");
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current;
      setElapsedMs(Math.min(elapsed, maxSeconds * 1000));
      if (elapsed >= maxSeconds * 1000) stop();
    }, 250);
  }, [maxSeconds, setStatus, stop, supported]);

  // Leaving the page (unmount) or the tab closing ends any session and frees the mic.
  useEffect(() => {
    const onPageHide = () => cancel();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      sessionRef.current += 1;
      uploadRef.current?.abort();
      releaseDevice();
    };
  }, [cancel, releaseDevice]);

  return {
    status,
    error,
    elapsedMs,
    supported,
    start,
    stop,
    cancel,
    clearError: () => setError(null),
  };
}
