import type { RiskLevel } from "../schemas/index.js";

/**
 * Data-driven risk policy. Matching is by prefix against an abstract action
 * id (e.g. "fs.read", "deploy.production") so new actions default safely -
 * see DEFAULT_RISK below - rather than silently being treated as LOW risk
 * because nobody wrote a rule for them yet.
 */
export const HIGH_RISK_ACTIONS = [
  "browser.cookies.read",
  "credentials.access",
  "deploy.production",
  "deploy.staging",
  "data.delete",
  "billing.spend",
  "content.publish",
  "infra.modify",
  "message.send.external",
  "database.production.modify",
  "vcs.merge",
  "skill.install.unknown",
] as const;

export const MEDIUM_RISK_ACTIONS = [
  "dependency.install",
  "fs.write.project",
  "tool.generate.external",
  "vcs.push",
  // Local Chromium + bundled-FFmpeg render of one reviewed, first-party
  // composition - see providers/remotion/index.ts. Deliberately narrow:
  // "video.render.local" is classified, but "video.render.remote"/
  // "video.publish"/"video.upload" are NOT listed anywhere in this file,
  // so they fall through to DEFAULT_RISK (HIGH) below and require
  // explicit approval - matching the same pattern "web.research.public"
  // uses above for Scrapling.
  "video.render.local",
  // Sends call-transcript text (potentially containing personally
  // identifiable caller information) to an external AI vendor for
  // summarization - see providers/voice-summary/index.ts. Deliberately
  // narrow and explicit, same pattern as "video.render.local" above:
  // "voice.summarize.external" is classified, but a bare "voice.summarize"
  // prefix is NOT listed here, so any other future voice.* action falls
  // through to DEFAULT_RISK (HIGH) and requires explicit approval rather
  // than silently inheriting this one's MEDIUM classification.
  "voice.summarize.external",
] as const;

export const LOW_RISK_ACTIONS = [
  "fs.read",
  "docs.search",
  "test.run.local",
  "lint.run",
  "typecheck.run",
  // Plain public-page fetch only (Scrapling's HTTP engine, no stealth/
  // cookies/auth/proxy) - see providers/scrapling/index.ts. Deliberately
  // narrow and explicit: "web.research.public" is classified, but
  // "web.research.stealth"/"web.research.authenticated"/etc. are NOT
  // listed anywhere in this file, so they fall through to DEFAULT_RISK
  // (HIGH) below and require explicit approval - do not add them here
  // without a separate security review and explicit owner sign-off, per
  // the Milestone 2 task brief.
  "web.research.public",
] as const;

/**
 * Fail closed: an action nobody has classified yet is HIGH risk until a
 * human reviews and reclassifies it, never LOW-by-default. This mirrors the
 * Syveka charter's "fail closed on missing configuration" principle applied
 * to permissions instead of secrets.
 */
const DEFAULT_RISK: RiskLevel = "HIGH";

/**
 * True prefix match on "."-delimited segments, not a plain substring
 * startsWith: "fs.read" must match "fs.read" or "fs.read.config", but must
 * NOT match "fs.readSecretDump" - a same-string-prefix action with no
 * segment boundary that a naive startsWith() would have silently classified
 * at the shorter, safer prefix's risk level instead of falling through to
 * DEFAULT_RISK. Currently dormant (no action id anywhere in this codebase
 * exercises the gap - `action` only ever comes from first-party
 * actionForCapability glue, never from a provider or Skill), but cheap and
 * safe to close outright rather than leave as a latent footgun for the next
 * action id someone adds.
 */
function matchesActionPrefix(action: string, prefix: string): boolean {
  return action === prefix || action.startsWith(`${prefix}.`);
}

export function classifyRisk(action: string): RiskLevel {
  if ((HIGH_RISK_ACTIONS as readonly string[]).some((a) => matchesActionPrefix(action, a)))
    return "HIGH";
  if ((MEDIUM_RISK_ACTIONS as readonly string[]).some((a) => matchesActionPrefix(action, a)))
    return "MEDIUM";
  if ((LOW_RISK_ACTIONS as readonly string[]).some((a) => matchesActionPrefix(action, a)))
    return "LOW";
  return DEFAULT_RISK;
}
