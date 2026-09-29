"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MIN_AUDIO_BYTES, pickRecordingMimeType } from "@/lib/voice/audio";
import { splitForSpeech, toSpokenText } from "@/lib/voice/spoken-text";
import { DEFAULT_VAD_CONFIG, VoiceActivityDetector, rmsLevel, type VadMode } from "@/lib/voice/vad";
import { chooseReplyVoice } from "@/lib/voice/voices";
import type { ReplyLanguage } from "@/lib/voice/reply-language";

/**
 * Live voice conversation in AI Chat (hands-free, sequential pipeline):
 *
 *   listen → detect end of speech → upload the turn (server transcribes it,
 *   within the session's server-side limits) → submit the text through the
 *   normal chat pipeline in voice mode → read the reply aloud → listen again.
 *
 * This is not native speech-to-speech: each turn is transcribed, answered by
 * the regular chat model, and spoken with the device's voices. The user can
 * interrupt the spoken reply by talking, mute the microphone, stop the reply
 * or end the session at any time.
 *
 * Every session has an epoch; ending it bumps the epoch, so late callbacks
 * (recorder, network, speech) from an ended session can never act. The
 * microphone is never restarted after the session ends.
 */

export type ConversationPhase =
  | "idle"
  | "connecting"
  | "listening"
  | "user_speaking"
  | "processing"
  | "thinking"
  | "speaking"
  | "ended";

export type ConversationError =
  | "unsupported"
  | "permission_denied"
  | "no_microphone"
  | "microphone_busy"
  | "not_enabled"
  | "limit_reached"
  | "capacity_reached"
  | "session_expired"
  | "unavailable"
  | "network_error"
  | "ended_elsewhere"
  | "reply_failed";

export type ConversationNotice =
  | "not_heard"
  | "no_voice"
  | "language_unknown"
  | "turn_too_long"
  /** The browser refused to speak (needs a tap: see enableSpeech). */
  | "speech_blocked"
  /** Speaking failed or never started. */
  | "speech_failed"
  | null;

export type EndReason =
  | "user"
  | "hidden"
  | "unmount"
  | "locale_changed"
  | "session_expired"
  | "error"
  | "ended_elsewhere";

type Deps = {
  fetch: typeof fetch;
  now: () => number;
};

const TICK_MS = 50;
/** Discard and re-arm the recorder after this much silence, bounding leading silence. */
const IDLE_REARM_MS = 3_000;
const CHANNEL = "syveka-voice-conversation";
/** A reply that hasn't started speaking by then has failed (it never plays). */
const SPEECH_START_TIMEOUT_MS = 6_000;
/** Rough upper bound for one chunk: ~12 chars/s plus slack (as in useSpeechPlayback). */
const chunkWatchdogMs = (text: string) => 5_000 + text.length * 90;

const SESSION_ERRORS: Record<string, ConversationError> = {
  voice_conversation_not_enabled: "not_enabled",
  voice_daily_limit_reached: "limit_reached",
  voice_capacity_reached: "capacity_reached",
  session_expired: "session_expired",
  voice_session_ended: "session_expired",
  session_not_found: "session_expired",
  turn_limit: "limit_reached",
  voice_conversation_unavailable: "unavailable",
  rate_limited: "limit_reached",
  entitlement_exceeded: "limit_reached",
  permission_denied: "not_enabled",
  unauthenticated: "unavailable",
};

function micError(e: unknown): ConversationError {
  const name = e instanceof Error || e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission_denied";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no_microphone";
  if (name === "NotSupportedError" || name === "TypeError") return "unsupported";
  return "microphone_busy";
}

export function useVoiceConversation({
  locale,
  onUserTurn,
  onAbortReply,
  speakReplies = true,
  getConversationId,
  deps = { fetch: (...a) => fetch(...a), now: () => Date.now() },
}: {
  locale: string;
  /**
   * Submits the transcript with its single-use server grant through the
   * normal chat pipeline, in the session's conversation; resolves with the
   * reply text (null on failure).
   */
  onUserTurn: (text: string, grant: string, conversationId: string) => Promise<string | null>;
  /** Aborts an in-flight chat reply (ending mid-reply). */
  onAbortReply?: () => void;
  /** False: replies are shown as text only (e.g. no device voice for the language). */
  speakReplies?: boolean;
  /**
   * The conversation the session is for, if it already exists. Without one
   * the server reserves a conversation id for the new chat.
   */
  getConversationId?: () => string | undefined;
  deps?: Deps;
}) {
  const [phase, setPhaseState] = useState<ConversationPhase>("idle");
  const [error, setError] = useState<ConversationError | null>(null);
  const [notice, setNotice] = useState<ConversationNotice>(null);
  const [muted, setMuted] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => deps.now());
  /** Spoken replies turned on during this session (enableSpeech). */
  const [speechEnabledInSession, setSpeechEnabledInSession] = useState(false);

  const phaseRef = useRef<ConversationPhase>("idle");
  const epochRef = useRef(0);
  const mutedRef = useRef(false);
  const sessionRef = useRef<{ id: string; conversationId: string; maxTurnMs: number } | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recorderArmedAtRef = useRef(0);
  const vadRef = useRef<VoiceActivityDetector | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const expiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const uploadRef = useRef<AbortController | null>(null);
  const speakTokenRef = useRef(0);
  /** Last reply language used in this session: context for short replies. */
  const lastLanguageRef = useRef<ReplyLanguage | null>(null);
  const utterancesRef = useRef<SpeechSynthesisUtterance[]>([]);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const tabIdRef = useRef(Math.random().toString(36).slice(2));
  const onUserTurnRef = useRef(onUserTurn);
  onUserTurnRef.current = onUserTurn;
  const getConversationIdRef = useRef(getConversationId);
  getConversationIdRef.current = getConversationId;
  const onAbortReplyRef = useRef(onAbortReply);
  onAbortReplyRef.current = onAbortReply;
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const localeRef = useRef(locale);
  const speakRepliesRef = useRef(speakReplies);
  speakRepliesRef.current = speakReplies;
  const speechEnabledInSessionRef = useRef(false);
  /** The last reply that wasn't spoken (text-only, blocked or failed), for enableSpeech. */
  const unspokenReplyRef = useRef<{ text: string; turn?: string } | null>(null);
  const speechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setPhase = useCallback((next: ConversationPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const cancelSpeech = useCallback(() => {
    speakTokenRef.current += 1;
    utterancesRef.current = [];
    if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
    speechTimerRef.current = null;
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
  }, []);

  const discardRecorder = useCallback(() => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    chunksRef.current = [];
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // already stopped
        }
      }
    }
  }, []);

  /** Tears everything down. Safe to call repeatedly; never restarts anything. */
  const end = useCallback(
    (reason: EndReason = "user", endError: ConversationError | null = null) => {
      if (phaseRef.current === "idle" || phaseRef.current === "ended") {
        if (endError) setError(endError);
        return;
      }
      epochRef.current += 1;
      if (tickRef.current) clearInterval(tickRef.current);
      if (expiryRef.current) clearTimeout(expiryRef.current);
      tickRef.current = null;
      expiryRef.current = null;
      uploadRef.current?.abort();
      uploadRef.current = null;
      if (phaseRef.current === "thinking") onAbortReplyRef.current?.();
      cancelSpeech();
      discardRecorder();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      analyserRef.current = null;
      void audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      vadRef.current = null;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (session) {
        void depsRef.current
          .fetch(`/api/v1/ai/voice-conversation/session?sessionId=${session.id}`, {
            method: "DELETE",
            keepalive: true,
          })
          .catch(() => {});
      }
      channelRef.current?.close();
      channelRef.current = null;
      mutedRef.current = false;
      setMuted(false);
      if (endError) setError(endError);
      setNotice(null);
      setPhase("ended");
      void reason;
    },
    [cancelSpeech, discardRecorder, setPhase],
  );

  /** Starts a fresh recorder for the next turn (only while listening and unmuted). */
  const armRecorder = useCallback(() => {
    discardRecorder();
    const stream = streamRef.current;
    if (!stream || mutedRef.current) return;
    const mimeType = pickRecordingMimeType(
      typeof MediaRecorder.isTypeSupported === "function"
        ? (t) => MediaRecorder.isTypeSupported(t)
        : undefined,
    );
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    } catch {
      end("error", "unsupported");
      return;
    }
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.start(250);
    recorderRef.current = recorder;
    recorderArmedAtRef.current = depsRef.current.now();
  }, [discardRecorder, end]);

  const resumeListening = useCallback(() => {
    if (phaseRef.current === "ended" || phaseRef.current === "idle") return;
    setPhase("listening");
    vadRef.current?.reset(depsRef.current.now());
    armRecorder();
  }, [armRecorder, setPhase]);

  const speak = useCallback(
    /** `turn`: the transcript this reply answers (its language context). */
    (text: string, epoch: number, turn?: string) => {
      const synthOk =
        typeof window !== "undefined" &&
        "speechSynthesis" in window &&
        typeof window.SpeechSynthesisUtterance !== "undefined";
      const chunks = splitForSpeech(toSpokenText(text));
      if (!speakRepliesRef.current && !speechEnabledInSessionRef.current) {
        unspokenReplyRef.current = { text, turn };
        resumeListening();
        return;
      }
      // The reply's own language (users may switch languages between turns);
      // the UI language only drives the controls.
      const choice = synthOk
        ? chooseReplyVoice(text, window.speechSynthesis.getVoices(), {
            turn,
            previous: lastLanguageRef.current,
          })
        : null;
      if (choice?.language) lastLanguageRef.current = choice.language;
      if (!synthOk || !choice || !choice.ok || chunks.length === 0) {
        // This reply stays as text; the conversation continues.
        if (chunks.length > 0) {
          setNotice(
            choice?.ok === false && choice.reason === "unknown_language"
              ? "language_unknown"
              : "no_voice",
          );
        }
        resumeListening();
        return;
      }
      const token = ++speakTokenRef.current;
      const current = () => token === speakTokenRef.current && epoch === epochRef.current;
      /** The reply couldn't be spoken: say so, keep its text for enableSpeech, listen again. */
      const fail = (reason: "speech_blocked" | "speech_failed") => {
        if (!current()) return;
        cancelSpeech();
        unspokenReplyRef.current = { text, turn };
        setNotice(reason);
        resumeListening();
      };
      let started = false;
      setNotice(null);
      setPhase("speaking");
      vadRef.current?.reset(depsRef.current.now());
      const next = (i: number) => {
        if (!current()) return;
        if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
        speechTimerRef.current = null;
        if (i >= chunks.length) {
          utterancesRef.current = [];
          resumeListening();
          return;
        }
        const u = new SpeechSynthesisUtterance(chunks[i]!);
        u.lang = choice.lang;
        if (choice.voice) u.voice = choice.voice;
        let done = false;
        const advance = () => {
          if (done) return;
          done = true;
          next(i + 1);
        };
        u.onstart = () => {
          if (!current() || done) return;
          if (speechTimerRef.current) clearTimeout(speechTimerRef.current);
          speechTimerRef.current = setTimeout(advance, chunkWatchdogMs(chunks[i]!));
          if (started) return;
          started = true;
          unspokenReplyRef.current = null;
          // Syveka is now audible: learn its level at the microphone before
          // accepting an interruption, so its own voice can't cut it off.
          vadRef.current?.beginAssistantAudio(depsRef.current.now());
        };
        u.onend = advance;
        u.onerror = (event) => {
          // Our own cancel (Stop reply, interruption, End) is not a failure.
          const code = (event as SpeechSynthesisErrorEvent | undefined)?.error;
          if (code === "interrupted" || code === "canceled") return advance();
          fail(code === "not-allowed" ? "speech_blocked" : "speech_failed");
        };
        utterancesRef.current.push(u);
        // Never hang in "speaking": a reply that doesn't start fails visibly,
        // and a chunk whose end event is lost moves on.
        speechTimerRef.current = started
          ? setTimeout(advance, chunkWatchdogMs(chunks[i]!))
          : setTimeout(() => fail("speech_failed"), SPEECH_START_TIMEOUT_MS);
        window.speechSynthesis.speak(u);
      };
      next(0);
    },
    [cancelSpeech, resumeListening, setPhase],
  );

  const submitTurn = useCallback(
    async (audio: Blob, epoch: number) => {
      const session = sessionRef.current;
      if (!session) return;
      setPhase("processing");
      const controller = new AbortController();
      uploadRef.current = controller;
      const form = new FormData();
      form.append("sessionId", session.id);
      form.append("turnId", crypto.randomUUID());
      form.append("audio", audio, "turn");
      let text: string;
      let grant: string | null = null;
      try {
        const res = await depsRef.current.fetch("/api/v1/ai/voice-conversation/turn", {
          method: "POST",
          body: form,
          signal: controller.signal,
        });
        if (epoch !== epochRef.current) return;
        const body = (await res.json().catch(() => null)) as {
          data?: { text?: string; grant?: string };
          error?: { code?: string };
        } | null;
        if (epoch !== epochRef.current) return;
        if (!res.ok || typeof body?.data?.text !== "string") {
          const code = body?.error?.code ?? "";
          if (code === "audio_too_long") {
            setNotice("turn_too_long");
            resumeListening();
            return;
          }
          if (code === "audio_too_short" || code === "duplicate_turn") {
            setNotice("not_heard");
            resumeListening();
            return;
          }
          end("error", SESSION_ERRORS[code] ?? "network_error");
          return;
        }
        text = body.data.text.trim();
        grant = body.data.grant ?? null;
      } catch {
        if (epoch !== epochRef.current) return;
        // No automatic retry: the turn may already have been paid for.
        end("error", "network_error");
        return;
      } finally {
        if (uploadRef.current === controller) uploadRef.current = null;
      }
      if (!text) {
        setNotice("not_heard");
        resumeListening();
        return;
      }
      if (!grant) {
        end("error", "unavailable");
        return;
      }
      setNotice(null);
      setPhase("thinking");
      const reply = await onUserTurnRef.current(text, grant, session.conversationId);
      if (epoch !== epochRef.current) return;
      if (reply === null) {
        setError("reply_failed");
        resumeListening();
        return;
      }
      setError(null);
      speak(reply, epoch, text);
    },
    [end, resumeListening, setPhase, speak],
  );

  /** Stops the current recorder and submits it as one turn (exactly once). */
  const finishTurn = useCallback(
    (epoch: number) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === "inactive") return;
      recorderRef.current = null;
      recorder.onstop = () => {
        const audio = new Blob(
          chunksRef.current,
          recorder.mimeType ? { type: recorder.mimeType } : undefined,
        );
        chunksRef.current = [];
        if (epoch !== epochRef.current) return;
        if (audio.size < MIN_AUDIO_BYTES) {
          setNotice("not_heard");
          resumeListening();
          return;
        }
        void submitTurn(audio, epoch);
      };
      setPhase("processing");
      recorder.stop();
    },
    [resumeListening, setPhase, submitTurn],
  );

  const tick = useCallback(
    (epoch: number) => {
      if (epoch !== epochRef.current) return;
      const t = depsRef.current.now();
      setNow(t);
      const analyser = analyserRef.current;
      const vad = vadRef.current;
      if (!analyser || !vad || mutedRef.current) return;
      const phaseNow = phaseRef.current;
      if (phaseNow !== "listening" && phaseNow !== "user_speaking" && phaseNow !== "speaking")
        return;
      const frame = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(frame);
      const mode: VadMode = phaseNow === "speaking" ? "assistant_speaking" : "listening";
      const event = vad.feed(rmsLevel(frame), t, mode);
      if (!event) {
        // Bound leading silence: re-arm the recorder while nobody speaks.
        if (
          phaseNow === "listening" &&
          !vad.speaking &&
          t - recorderArmedAtRef.current > IDLE_REARM_MS
        ) {
          armRecorder();
        }
        return;
      }
      switch (event.type) {
        case "speech_start":
          setNotice(null);
          setPhase("user_speaking");
          break;
        case "speech_end":
        case "max_turn":
          finishTurn(epoch);
          break;
        case "speech_discarded":
          setPhase("listening");
          armRecorder();
          break;
        case "barge_in":
          // The user interrupts: stop the reply for good and record the new turn.
          cancelSpeech();
          setPhase("user_speaking");
          armRecorder();
          vad.beginSpeech(t);
          break;
      }
    },
    [armRecorder, cancelSpeech, finishTurn, setPhase],
  );

  const start = useCallback(async () => {
    if (phaseRef.current !== "idle" && phaseRef.current !== "ended") return; // no double start
    setError(null);
    setNotice(null);
    lastLanguageRef.current = null;
    unspokenReplyRef.current = null;
    speechEnabledInSessionRef.current = false;
    setSpeechEnabledInSession(false);
    const supported =
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof window.MediaRecorder !== "undefined" &&
      typeof (
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext
      ) !== "undefined";
    if (!supported) {
      setError("unsupported");
      return;
    }
    const epoch = ++epochRef.current;
    setPhase("connecting");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      if (epoch !== epochRef.current) return;
      setPhase("idle");
      setError(micError(e));
      return;
    }
    if (epoch !== epochRef.current) {
      stream.getTracks().forEach((t) => t.stop()); // ended while the prompt was open
      return;
    }
    streamRef.current = stream;

    let res: Response;
    try {
      const conversationId = getConversationIdRef.current?.();
      res = await depsRef.current.fetch("/api/v1/ai/voice-conversation/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(conversationId ? { conversationId } : {}),
      });
    } catch {
      if (epoch !== epochRef.current) return;
      end("error", "network_error");
      return;
    }
    const body = (await res.json().catch(() => null)) as {
      data?: {
        sessionId: string;
        conversationId: string;
        expiresAt: number;
        maxTurnSeconds: number;
      };
      error?: { code?: string };
    } | null;
    if (epoch !== epochRef.current) {
      // Ended before the server answered: release the session it may have created.
      if (body?.data?.sessionId) {
        void depsRef.current
          .fetch(`/api/v1/ai/voice-conversation/session?sessionId=${body.data.sessionId}`, {
            method: "DELETE",
            keepalive: true,
          })
          .catch(() => {});
      }
      return;
    }
    if (!res.ok || !body?.data?.conversationId) {
      end("error", SESSION_ERRORS[body?.error?.code ?? ""] ?? "unavailable");
      return;
    }
    const { sessionId, conversationId: boundConversation, expiresAt: serverExpiry } = body.data;
    const { maxTurnSeconds } = body.data;
    sessionRef.current = {
      id: sessionId,
      conversationId: boundConversation,
      maxTurnMs: maxTurnSeconds * 1000,
    };

    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioCtx = new Ctx();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    audioCtxRef.current = audioCtx;
    analyserRef.current = analyser;
    vadRef.current = new VoiceActivityDetector({
      ...DEFAULT_VAD_CONFIG,
      // Stop a turn a little before the server's per-turn cap.
      maxTurnMs: Math.max(3_000, maxTurnSeconds * 1000 - 1_500),
    });
    vadRef.current.reset(depsRef.current.now(), { recalibrate: true });

    // Another tab starting a conversation ends this one (the server allows one per user).
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (e: MessageEvent<{ type: string; tab: string }>) => {
        if (e.data?.type === "started" && e.data.tab !== tabIdRef.current) {
          end("ended_elsewhere", "ended_elsewhere");
        }
      };
      channel.postMessage({ type: "started", tab: tabIdRef.current });
      channelRef.current = channel;
    }

    const t0 = depsRef.current.now();
    setStartedAt(t0);
    setNow(t0);
    // The server rejects turns after its expiry; the client ends at the same time.
    setExpiresAt(serverExpiry);
    expiryRef.current = setTimeout(
      () => end("session_expired", "session_expired"),
      Math.max(0, serverExpiry - depsRef.current.now()),
    );
    tickRef.current = setInterval(() => tick(epoch), TICK_MS);
    resumeListening();
  }, [end, resumeListening, setPhase, tick]);

  const toggleMute = useCallback(() => {
    const phaseNow = phaseRef.current;
    if (phaseNow === "idle" || phaseNow === "ended" || phaseNow === "connecting") return;
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    streamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !next));
    if (next) {
      // Muting drops a turn in progress instead of submitting it.
      discardRecorder();
      if (phaseNow === "user_speaking" || phaseNow === "listening") setPhase("listening");
    } else if (phaseNow === "listening" || phaseNow === "user_speaking") {
      resumeListening();
    }
  }, [discardRecorder, resumeListening, setPhase]);

  /**
   * Turns spoken replies on within the running session, from a tap -- which
   * also gives the browser any user activation it requires -- and reads the
   * last reply that wasn't spoken. Offered after "speech_blocked" /
   * "speech_failed", or when the session started with text replies.
   */
  const enableSpeech = useCallback(() => {
    const phaseNow = phaseRef.current;
    if (phaseNow === "idle" || phaseNow === "ended" || phaseNow === "connecting") return;
    speechEnabledInSessionRef.current = true;
    setSpeechEnabledInSession(true);
    setNotice(null);
    const pending = unspokenReplyRef.current;
    if (!pending || phaseNow !== "listening") return;
    unspokenReplyRef.current = null;
    discardRecorder();
    speak(pending.text, epochRef.current, pending.turn);
  }, [discardRecorder, speak]);

  /** Stops the spoken reply (the text stays in the chat) and listens again. */
  const stopReply = useCallback(() => {
    if (phaseRef.current !== "speaking") return;
    cancelSpeech();
    resumeListening();
  }, [cancelSpeech, resumeListening]);

  // Hidden tab / page leave: end, never keep listening in the background.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") end("hidden");
    };
    const onPageHide = () => end("hidden");
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [end]);

  // Changing language ends the session (the reply voice and transcript language change).
  useEffect(() => {
    if (localeRef.current !== locale) {
      localeRef.current = locale;
      end("locale_changed");
    }
  }, [locale, end]);

  // Unmount (navigation, logout, organization switch) ends the session.
  useEffect(() => () => end("unmount"), [end]);

  const active = phase !== "idle" && phase !== "ended";
  return {
    phase,
    active,
    error,
    notice,
    muted,
    elapsedMs: active && startedAt !== null ? Math.max(0, now - startedAt) : 0,
    remainingMs: active && expiresAt !== null ? Math.max(0, expiresAt - now) : null,
    start,
    end: () => end("user"),
    toggleMute,
    stopReply,
    enableSpeech,
    speechEnabledInSession,
    clearError: () => setError(null),
  };
}
