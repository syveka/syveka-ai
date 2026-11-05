import "server-only";

import type { PilotTurnUsage } from "@/lib/voice/fish-pilot-scenarios";

const BYTES_PER_SAMPLE = 2;
const MAX_ORGS = 100;
const MAX_SAMPLES_PER_ORG = 500;

export function turnUsage(input: {
  text: string;
  audioBytes: number;
  sampleRate: number;
  usdPerMillionBytes: number | null | undefined;
}): PilotTurnUsage {
  const textBytes = Buffer.byteLength(input.text, "utf8");
  return {
    textCharacters: [...input.text].length,
    textBytes,
    audioSeconds: input.audioBytes / BYTES_PER_SAMPLE / input.sampleRate,
    listPriceUsd:
      input.usdPerMillionBytes == null ? null : (textBytes / 1_000_000) * input.usdPerMillionBytes,
  };
}

type OrgUsage = {
  turns: number;
  failedTurns: number;
  textCharacters: number;
  textBytes: number;
  audioSeconds: number;
  completedListPriceUsd: number;
  /**
   * Whether a provider bills a failed or interrupted request isn't documented, so these are
   * reported apart as an upper bound, not added to what completed turns cost.
   */
  failedListPriceUpperBoundUsd: number;
  unpricedTurns: number;
  firstAudioMs: { real: number[]; synthetic: number[] };
};

/**
 * In memory for one development process, like the rest of the pilot, and holds counts only:
 * no caller or reply text. A real product would write to the shared usage records instead.
 */
const usageByOrg = new Map<string, OrgUsage>();

export function resetPilotUsageForTests(): void {
  usageByOrg.clear();
}

function emptyUsage(): OrgUsage {
  return {
    turns: 0,
    failedTurns: 0,
    textCharacters: 0,
    textBytes: 0,
    audioSeconds: 0,
    completedListPriceUsd: 0,
    failedListPriceUpperBoundUsd: 0,
    unpricedTurns: 0,
    firstAudioMs: { real: [], synthetic: [] },
  };
}

export function recordPilotTurnUsage(
  orgId: string,
  turn: {
    usage: PilotTurnUsage;
    completed: boolean;
    syntheticTiming: boolean;
    firstAudioMs: number | null;
    totalMs: number;
  },
): void {
  let entry = usageByOrg.get(orgId);
  if (!entry) {
    if (usageByOrg.size >= MAX_ORGS) return;
    entry = emptyUsage();
    usageByOrg.set(orgId, entry);
  }
  entry.turns++;
  if (!turn.completed) entry.failedTurns++;
  entry.textCharacters += turn.usage.textCharacters;
  entry.textBytes += turn.usage.textBytes;
  entry.audioSeconds += turn.usage.audioSeconds;
  if (turn.usage.listPriceUsd === null) entry.unpricedTurns++;
  else if (turn.completed) entry.completedListPriceUsd += turn.usage.listPriceUsd;
  else entry.failedListPriceUpperBoundUsd += turn.usage.listPriceUsd;
  if (turn.firstAudioMs !== null) {
    // Kept apart: a mock's injected delay must never be read as a provider's latency.
    const samples = turn.syntheticTiming ? entry.firstAudioMs.synthetic : entry.firstAudioMs.real;
    if (samples.length >= MAX_SAMPLES_PER_ORG) samples.shift();
    samples.push(turn.firstAudioMs);
  }
}

function percentiles(samples: number[]) {
  if (samples.length === 0) return { count: 0, p50: null, p95: null };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95) };
}

export function getPilotUsage(orgId: string) {
  const entry = usageByOrg.get(orgId) ?? emptyUsage();
  return {
    turns: entry.turns,
    failedTurns: entry.failedTurns,
    textCharacters: entry.textCharacters,
    textBytes: entry.textBytes,
    audioSeconds: entry.audioSeconds,
    completedListPriceUsd: entry.completedListPriceUsd,
    failedListPriceUpperBoundUsd: entry.failedListPriceUpperBoundUsd,
    unpricedTurns: entry.unpricedTurns,
    firstAudioMs: {
      real: percentiles(entry.firstAudioMs.real),
      synthetic: percentiles(entry.firstAudioMs.synthetic),
    },
  };
}
