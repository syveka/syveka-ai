"use client";

import { useEffect, useState } from "react";
import { chooseVoice } from "@/lib/voice/voices";
import { watchVoices } from "@/lib/voice/voice-list";

/**
 * Whether this device can speak replies in the interface language:
 * - "available": a voice for the language is installed;
 * - "unavailable": voices are listed but none for this language (or no
 *   speech synthesis at all) — replies can't be spoken in this language;
 * - "unknown": the device didn't list any voices within the wait (some
 *   Android browsers load them late); speaking may or may not work;
 * - "checking": still waiting.
 * Only checked while `active` (the start dialog is open). Voices can arrive
 * in several updates (Android lists them late), so every later update is
 * re-evaluated: an early partial list never settles the answer.
 */
export type DeviceVoice = "checking" | "available" | "unavailable" | "unknown";

const WAIT_MS = 1500;

export function useDeviceVoice(locale: string, active: boolean): DeviceVoice {
  const [state, setState] = useState<DeviceVoice>("checking");

  useEffect(() => {
    if (!active) return;
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setState("unavailable");
      return;
    }
    setState("checking");
    return watchVoices(
      window.speechSynthesis,
      (voices, final) => {
        if (voices.length === 0) {
          if (final) setState((s) => (s === "checking" ? "unknown" : s));
          return;
        }
        setState(chooseVoice(locale, voices).ok ? "available" : "unavailable");
      },
      WAIT_MS,
    );
  }, [locale, active]);

  return state;
}
