"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceError, type SpeechEngine, type VoiceErrorCode } from "@/lib/voice/speech-engine";
import { toSpokenText } from "@/lib/voice/spoken-text";

export type VoiceSessionStatus =
  "idle" | "connecting" | "listening" | "thinking" | "speaking" | "muted" | "error";

/** Voice-layer failures plus any chat-route error code (rate_limited, …). */
export type VoiceSessionError = VoiceErrorCode | string;

export type VoiceTurnResult = { text: string; error: string | null };

/** Consecutive silent listens before auto-muting instead of looping forever. */
export const MAX_SILENT_LISTENS = 3;

/**
 * Hands-free, turn-by-turn voice conversation: listen → send the transcript
 * as a normal chat turn → speak the reply → listen again. The actual turn is
 * delegated to `sendTurn` (the existing authenticated chat pipeline), so
 * voice never has its own auth, tenant or context path.
 *
 * Every async continuation checks the session generation it started in, so
 * ending (or restarting) a session can never be overwritten by a stale
 * listen/think/speak step finishing late.
 */
export function useVoiceSession(params: {
  engine: SpeechEngine;
  lang: string;
  sendTurn: (text: string) => Promise<VoiceTurnResult>;
  onAbortTurn?: () => void;
}) {
  const [status, setStatus] = useState<VoiceSessionStatus>("idle");
  const [error, setError] = useState<VoiceSessionError | null>(null);
  const [interim, setInterim] = useState("");
  const [lastReply, setLastReply] = useState("");
  const [isMuted, setIsMuted] = useState(false);

  const generationRef = useRef(0);
  const mutedRef = useRef(false);
  const statusRef = useRef<VoiceSessionStatus>("idle");
  const listenRef = useRef<{ stop(): void } | null>(null);
  const speakRef = useRef<{ cancel(): void } | null>(null);
  const silentListensRef = useRef(0);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const setState = useCallback((next: VoiceSessionStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const fail = useCallback(
    (code: VoiceSessionError) => {
      setError(code);
      setState("error");
    },
    [setState],
  );

  const listenLoop = useCallback(
    async (generation: number): Promise<void> => {
      const isCurrent = () => generation === generationRef.current;
      while (isCurrent()) {
        if (mutedRef.current) {
          setState("muted");
          return;
        }
        setInterim("");
        setState("listening");
        const { engine, lang } = paramsRef.current;
        const handle = engine.listen({
          lang,
          onInterim: (text) => isCurrent() && setInterim(text),
        });
        listenRef.current = handle;

        let transcript: string;
        try {
          transcript = await handle.result;
        } catch (err) {
          if (isCurrent()) fail(err instanceof VoiceError ? err.code : "recognition_failed");
          return;
        } finally {
          if (listenRef.current === handle) listenRef.current = null;
        }
        if (!isCurrent()) return;

        if (!transcript) {
          if (mutedRef.current) continue;
          silentListensRef.current += 1;
          if (silentListensRef.current >= MAX_SILENT_LISTENS) {
            mutedRef.current = true;
            setIsMuted(true);
          }
          continue;
        }
        silentListensRef.current = 0;

        setState("thinking");
        const reply = await paramsRef.current.sendTurn(transcript);
        if (!isCurrent()) return;
        if (reply.error) {
          fail(reply.error);
          return;
        }

        const spoken = toSpokenText(reply.text);
        setLastReply(spoken);
        if (spoken) {
          setState("speaking");
          const speech = paramsRef.current.engine.speak(spoken, paramsRef.current.lang);
          speakRef.current = speech;
          await speech.done;
          if (speakRef.current === speech) speakRef.current = null;
        }
      }
    },
    [fail, setState],
  );

  const start = useCallback(async () => {
    const generation = ++generationRef.current;
    const { engine } = paramsRef.current;
    setError(null);
    setInterim("");
    setLastReply("");
    mutedRef.current = false;
    setIsMuted(false);
    silentListensRef.current = 0;

    if (!engine.isSupported()) {
      fail("unsupported");
      return;
    }
    setState("connecting");
    // Unlock audio while still inside the tap's user-gesture window.
    engine.primeAudio();
    try {
      await engine.requestMicrophone();
    } catch (err) {
      if (generation === generationRef.current) {
        fail(err instanceof VoiceError ? err.code : "recognition_failed");
      }
      return;
    }
    if (generation !== generationRef.current) return;
    await listenLoop(generation);
  }, [fail, listenLoop, setState]);

  const end = useCallback(() => {
    generationRef.current += 1;
    listenRef.current?.stop();
    listenRef.current = null;
    speakRef.current?.cancel();
    speakRef.current = null;
    if (statusRef.current === "thinking") paramsRef.current.onAbortTurn?.();
    mutedRef.current = false;
    setIsMuted(false);
    setInterim("");
    setError(null);
    setState("idle");
  }, [setState]);

  const mute = useCallback(() => {
    mutedRef.current = true;
    setIsMuted(true);
    if (statusRef.current === "listening") {
      // Stopping resolves the pending listen with "", and the loop then
      // parks in the muted state.
      listenRef.current?.stop();
    }
  }, []);

  const unmute = useCallback(() => {
    mutedRef.current = false;
    setIsMuted(false);
    silentListensRef.current = 0;
    if (statusRef.current === "muted") void listenLoop(generationRef.current);
  }, [listenLoop]);

  /** Barge-in: stop the spoken reply and go straight back to listening. */
  const interrupt = useCallback(() => {
    if (statusRef.current === "speaking") speakRef.current?.cancel();
  }, []);

  /** Recover from an error without re-running the whole connect flow when possible. */
  const retry = useCallback(() => {
    if (statusRef.current !== "error") return;
    setError(null);
    silentListensRef.current = 0;
    void start();
  }, [start]);

  // Never leave the microphone or speech running after unmount.
  useEffect(
    () => () => {
      generationRef.current += 1;
      listenRef.current?.stop();
      speakRef.current?.cancel();
    },
    [],
  );

  return {
    status,
    error,
    interim,
    lastReply,
    isMuted,
    isActive: status !== "idle",
    start,
    end,
    mute,
    unmute,
    interrupt,
    retry,
  };
}
