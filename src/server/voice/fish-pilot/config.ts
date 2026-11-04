import "server-only";

import { z } from "zod";
import type { PilotMockFailure } from "@/lib/voice/fish-pilot-scenarios";
import { createFishSpeechProvider } from "./fish-speech-provider";
import { createMockSpeechProvider, type SpeechProvider } from "./speech-provider";

const fishEnvSchema = z.object({
  FISH_AUDIO_API_KEY: z.string().min(1),
  FISH_AUDIO_VOICE_ID: z.string().min(1),
  FISH_AUDIO_MODEL: z.enum(["s2.1-pro-free", "s2.1-pro", "s2-pro", "drama-3"]).default("s2.1-pro"),
});

export class FishPilotConfigError extends Error {}

/**
 * The mock, unless real calls were explicitly allowed. An API key alone never starts
 * paid usage. When they are allowed, a missing setting is an error, not a silent mock:
 * a test run must not report mock timings as Fish's.
 */
export function selectSpeechProvider(
  mockFailure: PilotMockFailure,
  env: NodeJS.ProcessEnv = process.env,
): SpeechProvider {
  if (env.FISH_VOICE_PILOT_ALLOW_PAID_API !== "1") {
    return createMockSpeechProvider({ failure: mockFailure });
  }
  const parsed = fishEnvSchema.safeParse(env);
  if (!parsed.success) throw new FishPilotConfigError("fish_pilot_not_configured");
  return createFishSpeechProvider({
    apiKey: parsed.data.FISH_AUDIO_API_KEY,
    voiceId: parsed.data.FISH_AUDIO_VOICE_ID,
    model: parsed.data.FISH_AUDIO_MODEL,
  });
}

/** A stop on real calls until restart or hot reload, on top of the per-user rate limit. */
const MAX_REAL_TURNS_PER_PROCESS = 100;
let realTurns = 0;

export function hasRealTurnBudget(): boolean {
  return realTurns < MAX_REAL_TURNS_PER_PROCESS;
}

export function reserveRealTurn(): void {
  realTurns++;
}

export function resetRealTurnsForTests(): void {
  realTurns = 0;
}
