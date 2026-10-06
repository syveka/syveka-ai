/**
 * Live voice allowance as the server reports it (GET /voice-conversation/session,
 * and with every start and turn response). Temporary pilot limits per
 * organization and Helsinki day -- not purchased credits.
 */
export type AllowanceCount = { used: number; limit: number; remaining: number };

export type VoiceAllowance = {
  /** Helsinki calendar day the daily counts belong to (YYYY-MM-DD). */
  day: string;
  /** When the daily counts renew (next Helsinki midnight, epoch ms). */
  renewsAt: number;
  startsToday: AllowanceCount;
  turnsToday: AllowanceCount;
  /** Accepted turn audio, in milliseconds. */
  audioMsToday: AllowanceCount;
  /** Longest possible session; it can end earlier when another limit is reached. */
  sessionSeconds: number;
  maxTurnSeconds: number;
  maxTurnsPerSession: number;
  /** The current session (owner only): turns used and left in it. */
  session: { turns: AllowanceCount; expiresAt: number } | null;
  /**
   * Turns that can still be accepted: today's turns, within the session's
   * own cap when a session is given, and none once today's audio is used.
   */
  turnsAvailable: number;
};

/** Which limit stops (or refused) live voice. */
export type LimitReason = "daily_sessions" | "daily_turns" | "daily_audio" | "session_turns";

/**
 * The newer of two readings. Within one Helsinki day the counts only grow,
 * so a reading that shows less use is stale (e.g. a slow response overtaken
 * by a later one); a later day always wins (the counts renewed at midnight).
 */
export function newerAllowance(
  current: VoiceAllowance | null,
  next: VoiceAllowance | null | undefined,
): VoiceAllowance | null {
  if (!next) return current;
  if (!current || next.day > current.day) return next;
  if (next.day < current.day) return current;
  const used = (a: VoiceAllowance) =>
    a.turnsToday.used + a.audioMsToday.used + a.startsToday.used + (a.session?.turns.used ?? 0);
  return used(next) >= used(current) ? next : current;
}

/** Why no further turn can be accepted, or null if one can. */
export function exhaustedReason(a: VoiceAllowance): LimitReason | null {
  if (a.turnsAvailable > 0) return null;
  if (a.turnsToday.remaining === 0) return "daily_turns";
  if (a.session && a.session.turns.remaining === 0) return "session_turns";
  return "daily_audio";
}

/** m:ss for a duration in milliseconds (rounded down). */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The renewal time as Helsinki wall-clock time in the user's language (e.g. "00:00"). */
export function helsinkiTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Europe/Helsinki",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at));
}
