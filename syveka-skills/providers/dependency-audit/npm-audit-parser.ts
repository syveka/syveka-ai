import { z } from "zod";
import type {
  DependencyAuditFinding,
  DependencyAuditPolicy,
  DependencyRiskSummary,
  DependencySeverity,
} from "../../schemas/dependency-audit.js";
import { dependencySeveritySchema } from "../../schemas/dependency-audit.js";

/**
 * Parses and normalizes `npm audit --json` output into the
 * "security.dependency_audit" contract. This is the DETECTION mechanism -
 * see docs/secureship.md "Trust model": `npm audit` (npm's own ecosystem-
 * native advisory lookup, also used by this repo's CI gate in
 * scripts/run-npm-audit.ts) is the sole source of vulnerability truth here.
 * Nothing in this file asks an LLM whether a package is vulnerable.
 *
 * SECURITY: every value pulled from npm's response (package names, advisory
 * titles, URLs) is treated as untrusted external data throughout this file -
 * copied into typed output fields, never interpreted, concatenated into a
 * command, or used to branch control flow. A malicious/compromised advisory
 * title containing something that reads like an instruction has exactly the
 * same effect here as an ordinary one: it becomes an inert string in one
 * finding's `title` field. See evals/dependency-audit-security.test.ts.
 */

// `.passthrough()` deliberately, not `.strict()`: this is a third-party
// tool's output shape, which may grow new fields in a future npm version -
// unlike this codebase's OWN input/output contracts (schemas/dependency-audit.ts),
// which stay strict. Fields we don't recognize are simply ignored, never
// rejected outright, as long as the fields we DO depend on are present and
// correctly typed.
const rawAdvisoryObjectSchema = z
  .object({
    source: z.union([z.number(), z.string()]).optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    severity: z.string().optional(),
    range: z.string().optional(),
    cwe: z.array(z.string()).optional(),
    cvss: z
      .object({
        score: z.number().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const rawViaEntrySchema = z.union([z.string(), rawAdvisoryObjectSchema]);

const rawFixAvailableSchema = z.union([
  z.boolean(),
  z
    .object({
      name: z.string(),
      version: z.string(),
      isSemVerMajor: z.boolean().optional(),
    })
    .passthrough(),
]);

const rawVulnerabilityEntrySchema = z
  .object({
    name: z.string().min(1),
    severity: dependencySeveritySchema,
    isDirect: z.boolean().optional(),
    via: z.array(rawViaEntrySchema),
    range: z.string().optional(),
    nodes: z.array(z.string()).optional(),
    fixAvailable: rawFixAvailableSchema.optional(),
  })
  .passthrough();

export const rawNpmAuditReportSchema = z
  .object({
    auditReportVersion: z.number().optional(),
    vulnerabilities: z.record(z.string(), rawVulnerabilityEntrySchema),
    metadata: z
      .object({
        dependencies: z
          .object({
            total: z.number().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type RawNpmAuditReport = z.infer<typeof rawNpmAuditReportSchema>;
type RawVulnerabilityEntry = z.infer<typeof rawVulnerabilityEntrySchema>;

/** JSON.parse + shape validation in one step - never trust the tool's exit code alone. */
export function parseRawNpmAudit(stdout: string): RawNpmAuditReport | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return null;
  }
  const result = rawNpmAuditReportSchema.safeParse(json);
  return result.success ? result.data : null;
}

/** The first object-shaped advisory in `via`, if any - plain strings are dependency-chain references, not advisories of their own. */
function extractPrimaryAdvisory(via: RawVulnerabilityEntry["via"]): {
  title: string;
  url: string | null;
  advisoryId: string | null;
  cwe: string[];
  cvssScore: number | null;
} | null {
  for (const entry of via) {
    if (typeof entry === "object") {
      const advisoryId =
        entry.url && /GHSA-[A-Za-z0-9-]+/.test(entry.url)
          ? (entry.url.match(/GHSA-[A-Za-z0-9-]+/)?.[0] ?? null)
          : entry.source !== undefined
            ? String(entry.source)
            : null;
      return {
        title: entry.title ?? "(advisory title unavailable)",
        url: entry.url ?? null,
        advisoryId,
        cwe: entry.cwe ?? [],
        cvssScore: entry.cvss?.score ?? null,
      };
    }
  }
  return null;
}

function buildRecommendedAction(
  packageName: string,
  fixAvailable: RawVulnerabilityEntry["fixAvailable"],
  advisoryId: string | null,
): { fixAvailable: boolean; action: string } {
  if (fixAvailable === undefined || fixAvailable === false) {
    return {
      fixAvailable: false,
      action: advisoryId
        ? `No fix currently published for ${packageName} - monitor advisory ${advisoryId} and reassess on next audit.`
        : `No fix currently published for ${packageName} - reassess on next audit.`,
    };
  }
  if (fixAvailable === true) {
    return {
      fixAvailable: true,
      action: `Run \`npm audit fix\` to apply a compatible update for ${packageName}.`,
    };
  }
  return {
    fixAvailable: true,
    action: fixAvailable.isSemVerMajor
      ? `Upgrade ${fixAvailable.name} to ${fixAvailable.version} (major version bump - review breaking changes before applying).`
      : `Upgrade ${fixAvailable.name} to ${fixAvailable.version} to resolve this advisory.`,
  };
}

/**
 * Resolves the installed version for a vulnerable package from
 * package-lock.json's `packages` map (lockfileVersion 2/3). Returns `null`
 * (never a guess) when the lockfile is absent or the path isn't found -
 * "unknown" is represented honestly, per docs/secureship.md's "unknown/
 * unverified findings are represented honestly" requirement.
 */
export function resolveInstalledVersion(
  nodes: string[] | undefined,
  lockfilePackages: Record<string, { version?: string }> | null,
): string | null {
  if (!lockfilePackages || !nodes || nodes.length === 0) return null;
  for (const node of nodes) {
    const entry = lockfilePackages[node];
    if (entry?.version) return entry.version;
  }
  return null;
}

export interface NormalizeParams {
  report: RawNpmAuditReport;
  lockfilePackages: Record<string, { version?: string }> | null;
  policy: Required<DependencyAuditPolicy>;
}

const SEVERITY_RANK: Record<DependencySeverity, number> = {
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

export interface NormalizedAudit {
  findings: DependencyAuditFinding[];
  riskSummary: DependencyRiskSummary;
  scannedDependencyCount: number;
  truncated: boolean;
}

/** Turns raw (already schema-validated) npm audit output into the capability's structured, prioritized, explained contract. */
export function normalizeNpmAudit(params: NormalizeParams): NormalizedAudit {
  const { report, lockfilePackages, policy } = params;
  const minRank = SEVERITY_RANK[policy.minimum_severity];

  const allEntries = Object.entries(report.vulnerabilities);
  const eligible = allEntries.filter(([, entry]) => SEVERITY_RANK[entry.severity] >= minRank);
  // Deterministic order: highest severity first, then package name -
  // Prioritize is part of this capability's job, not left to map-insertion
  // order (which mirrors npm's own JSON output, not risk).
  eligible.sort(([nameA, a], [nameB, b]) => {
    const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    return rankDiff !== 0 ? rankDiff : nameA.localeCompare(nameB);
  });

  const truncated = eligible.length > policy.max_findings;
  const selected = eligible.slice(0, policy.max_findings);

  const findings: DependencyAuditFinding[] = selected.map(([name, entry]) => {
    const advisory = extractPrimaryAdvisory(entry.via);
    const installedVersion = resolveInstalledVersion(entry.nodes, lockfilePackages);
    const { fixAvailable, action } = buildRecommendedAction(
      name,
      entry.fixAvailable,
      advisory?.advisoryId ?? null,
    );

    return {
      package: name,
      installed_version: installedVersion,
      affected_range: entry.range ?? "(range unavailable)",
      severity: entry.severity,
      advisory_id: advisory?.advisoryId ?? null,
      advisory_url: advisory?.url ?? null,
      title: (
        advisory?.title ?? `${name} has a known ${entry.severity}-severity vulnerability`
      ).slice(0, 500),
      classification: entry.isDirect ? "direct" : "transitive",
      fix_available: fixAvailable,
      recommended_action: action.slice(0, 500),
      evidence_ref: "npm audit --json (package-lock.json)",
      cwe: advisory?.cwe ?? [],
      cvss_score: advisory?.cvssScore ?? null,
    };
  });

  const bySeverity = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  let directCount = 0;
  let transitiveCount = 0;
  let fixableCount = 0;
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
    if (finding.classification === "direct") directCount += 1;
    else transitiveCount += 1;
    if (finding.fix_available) fixableCount += 1;
  }

  const highestSeverity = findings.reduce<DependencySeverity | null>((highest, f) => {
    if (!highest || SEVERITY_RANK[f.severity] > SEVERITY_RANK[highest]) return f.severity;
    return highest;
  }, null);

  return {
    findings,
    riskSummary: {
      total_findings: findings.length,
      by_severity: bySeverity,
      direct_count: directCount,
      transitive_count: transitiveCount,
      fixable_count: fixableCount,
      overall_risk: highestSeverity ?? "none",
    },
    scannedDependencyCount: report.metadata?.dependencies?.total ?? 0,
    truncated,
  };
}
