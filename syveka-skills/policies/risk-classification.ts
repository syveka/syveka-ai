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
] as const;

export const LOW_RISK_ACTIONS = [
  "fs.read",
  "docs.search",
  "test.run.local",
  "lint.run",
  "typecheck.run",
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
