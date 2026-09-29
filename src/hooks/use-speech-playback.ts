"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { splitForSpeech, toSpokenText } from "@/lib/voice/spoken-text";
import { chooseReplyVoice } from "@/lib/voice/voices";

export type PlaybackError = "unsupported" | "no_voice" | "unknown_language" | "playback_failed";

/** Rough upper bound for one chunk: ~12 chars/s plus slack. */
const chunkWatchdogMs = (text: string) => 5_000 + text.length * 90;

/**
 * Reads assistant replies aloud with the device's speech voices (browser
 * speech synthesis — no provider, no cost). Only one reply plays at a time;
 * playing stops on `stop()`, on another `play()`, and when the page unmounts
 * or is hidden. Never autoplays: `play` is only called from a user tap.
 */
export function useSpeechPlayback() {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; code: PlaybackError } | null>(null);
  const tokenRef = useRef(0);
  // Chrome can garbage-collect a queued utterance and never fire `onend`;
  // holding strong references (and a watchdog) keeps playback from sticking.
  const utterancesRef = useRef<SpeechSynthesisUtterance[]>([]);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const supported =
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof window.SpeechSynthesisUtterance !== "undefined";

  const stop = useCallback(() => {
    tokenRef.current += 1;
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
    utterancesRef.current = [];
    if (supported) window.speechSynthesis.cancel();
    setPlayingId(null);
  }, [supported]);

  const play = useCallback(
    /** `turn`: the user message this reply answers (language context for short replies). */
    (id: string, text: string, turn?: string) => {
      stop();
      setError(null);
      if (!supported) {
        setError({ id, code: "unsupported" });
        return;
      }
      const choice = chooseReplyVoice(text, window.speechSynthesis.getVoices(), { turn });
      if (!choice.ok) {
        setError({ id, code: choice.reason });
        return;
      }
      const { lang, voice } = choice;
      const chunks = splitForSpeech(toSpokenText(text));
      if (chunks.length === 0) return;

      const token = tokenRef.current;
      const finish = (failed: boolean) => {
        if (token !== tokenRef.current) return;
        stop();
        if (failed) setError({ id, code: "playback_failed" });
      };
      const speakChunk = (index: number) => {
        if (token !== tokenRef.current) return;
        if (index >= chunks.length) return finish(false);
        const utterance = new SpeechSynthesisUtterance(chunks[index]);
        utterance.lang = lang;
        if (voice) utterance.voice = voice;
        let advanced = false;
        const next = () => {
          if (advanced) return; // onend and the watchdog can both fire
          advanced = true;
          if (watchdogRef.current) clearTimeout(watchdogRef.current);
          speakChunk(index + 1);
        };
        utterance.onend = next;
        utterance.onerror = (event) => {
          // "interrupted"/"canceled" come from our own stop() or a new play().
          if (event.error === "interrupted" || event.error === "canceled") return;
          finish(true);
        };
        utterancesRef.current.push(utterance);
        if (watchdogRef.current) clearTimeout(watchdogRef.current);
        watchdogRef.current = setTimeout(next, chunkWatchdogMs(chunks[index]!));
        window.speechSynthesis.speak(utterance);
      };
      setPlayingId(id);
      speakChunk(0);
    },
    [stop, supported],
  );

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") stop();
    };
    window.addEventListener("pagehide", stop);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", stop);
      document.removeEventListener("visibilitychange", onHide);
      stop();
    };
  }, [stop]);

  return { supported, playingId, error, play, stop };
}
