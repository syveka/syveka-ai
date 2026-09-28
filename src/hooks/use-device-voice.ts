"use client";

import { useEffect, useState } from "react";
import { chooseVoice } from "@/lib/voice/voices";

/**
 * Whether this device can speak replies in the interface language:
 * - "available": a voice for the language is installed;
 * - "unavailable": voices are listed but none for this language (or no
 *   speech synthesis at all) — replies can't be spoken in this language;
 * - "unknown": the device didn't list any voices within the wait (some
 *   Android browsers load them late); speaking may or may not work;
 * - "checking": still waiting.
 * Only checked while `active` (the start dialog is open).
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
    const synth = window.speechSynthesis;
    let settled = false;
    const evaluate = (final: boolean) => {
      if (settled) return;
      const voices = synth.getVoices();
      if (voices.length === 0) {
        if (final) {
          settled = true;
          setState("unknown");
        }
        return;
      }
      settled = true;
      setState(chooseVoice(locale, voices).ok ? "available" : "unavailable");
    };
    setState("checking");
    evaluate(false);
    const onChange = () => evaluate(false);
    synth.addEventListener?.("voiceschanged", onChange);
    const timer = setTimeout(() => evaluate(true), WAIT_MS);
    return () => {
      settled = true;
      clearTimeout(timer);
      synth.removeEventListener?.("voiceschanged", onChange);
    };
  }, [locale, active]);

  return state;
}
