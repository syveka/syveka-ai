"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplyLanguage } from "@/lib/voice/reply-language";
import { splitForSpeech, toSpokenText } from "@/lib/voice/spoken-text";
import { watchVoices } from "@/lib/voice/voice-list";
import { chooseReplyVoice } from "@/lib/voice/voices";

export type PlaybackError = "unsupported" | "no_voice" | "unknown_language" | "playback_failed";

/** A reply that couldn't be read aloud; `language` is set for "no_voice". */
export type PlaybackFailure = { id: string; code: PlaybackError; language?: ReplyLanguage };

/**
 * How long a tap waits for the reply's voice to be listed. Android lists
 * voices late and in several updates, so a list without the language is only
 * final after this bound.
 */
export const VOICE_WAIT_MS = 2500;

/** Rough upper bound for one chunk: ~12 chars/s plus slack. */
const chunkWatchdogMs = (text: string) => 5_000 + text.length * 90;

/**
 * Reads assistant replies aloud with the device's speech voices (browser
 * speech synthesis — no provider, no cost), always with a voice of the
 * reply's own language. States per reply: idle, loading (`loadingId`:
 * waiting for the device to list a voice for the language), playing
 * (`playingId`), or failed (`error`: "no_voice" = unavailable on this
 * device, "playback_failed" = the engine failed). Only one reply loads or
 * plays at a time; `stop()`, another `play()`, unmount and hiding the page
 * end it, including a pending voice wait. Never autoplays: `play` is only
 * called from a user tap.
 */
export function useSpeechPlayback() {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<PlaybackFailure | null>(null);
  const tokenRef = useRef(0);
  // Chrome can garbage-collect a queued utterance and never fire `onend`;
  // holding strong references (and a watchdog) keeps playback from sticking.
  const utterancesRef = useRef<SpeechSynthesisUtterance[]>([]);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelWaitRef = useRef<(() => void) | null>(null);

  const supported =
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof window.SpeechSynthesisUtterance !== "undefined";

  const stop = useCallback(() => {
    tokenRef.current += 1;
    cancelWaitRef.current?.();
    cancelWaitRef.current = null;
    if (watchdogRef.current) clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
    utterancesRef.current = [];
    if (supported) window.speechSynthesis.cancel();
    setPlayingId(null);
    setLoadingId(null);
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
      const chunks = splitForSpeech(toSpokenText(text));
      if (chunks.length === 0) return;
      const token = tokenRef.current;
      const current = () => token === tokenRef.current;

      const finish = (failed: boolean) => {
        if (!current()) return;
        stop();
        if (failed) setError({ id, code: "playback_failed" });
      };
      const speak = (lang: string, voice: SpeechSynthesisVoice) => {
        const speakChunk = (index: number) => {
          if (!current()) return;
          if (index >= chunks.length) return finish(false);
          const utterance = new SpeechSynthesisUtterance(chunks[index]);
          utterance.lang = lang;
          utterance.voice = voice;
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
        setLoadingId(null);
        setPlayingId(id);
        speakChunk(0);
      };

      // Evaluated now (inside the tap) and on every voice-list update until
      // a voice of the reply's language appears or the wait ends. Without a
      // listed voice nothing is spoken: the engine's fallback for a bare
      // `lang` can be another language's voice.
      const cancelWait = watchVoices(
        window.speechSynthesis,
        (voices, final) => {
          if (!current()) return true;
          const choice = chooseReplyVoice(text, voices, { turn });
          if (!choice.ok && choice.reason === "unknown_language") {
            setLoadingId(null);
            setError({ id, code: "unknown_language" });
            return true;
          }
          if (choice.ok && choice.voice) {
            speak(choice.lang, choice.voice);
            return true;
          }
          if (final) {
            setLoadingId(null);
            setError({ id, code: "no_voice", language: choice.language });
            return true;
          }
          setLoadingId(id);
        },
        VOICE_WAIT_MS,
      );
      if (current()) cancelWaitRef.current = cancelWait;
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

  return { supported, playingId, loadingId, error, play, stop };
}
