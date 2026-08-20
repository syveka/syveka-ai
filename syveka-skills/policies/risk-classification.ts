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

export function classifyRisk(action: string): RiskLevel {
  if ((HIGH_RISK_ACTIONS as readonly string[]).some((a) => action.startsWith(a))) return "HIGH";
  if ((MEDIUM_RISK_ACTIONS as readonly string[]).some((a) => action.startsWith(a))) return "MEDIUM";
  if ((LOW_RISK_ACTIONS as readonly string[]).some((a) => action.startsWith(a))) return "LOW";
  return DEFAULT_RISK;
}
