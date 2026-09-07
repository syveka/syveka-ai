import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Provider } from "../types.js";
import type { EvidenceItem, ProviderResult } from "../../schemas/index.js";
import {
  dependencyAuditInputSchema,
  dependencyAuditOutputSchema,
  dependencyAuditExecutionMetaSchema,
  type DependencyAuditPolicy,
  type DependencyAuditResult,
  type DependencyEcosystem,
} from "../../schemas/dependency-audit.js";
import { normalizeNpmAudit, parseRawNpmAudit } from "./npm-audit-parser.js";

export const DEPENDENCY_AUDIT_SKILL_ID = "secureship/dependency-audit" as const;
export const DEPENDENCY_AUDIT_SKILL_VERSION = "1.0.0" as const;

const DEFAULT_POLICY: Required<DependencyAuditPolicy> = {
  minimum_severity: "info",
  production_only: false,
  max_findings: 200,
};

interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

type RunAudit = (args: string[], cwd: string) => SpawnResult;
type ReadLockfilePackages = (cwd: string) => Record<string, { version?: string }> | null;

/** Real `npm audit --json`, argv-array only - never a shell string, so no caller-supplied value can be interpreted as shell syntax (moot anyway: nothing caller-supplied ever reaches this call, see index.ts's module doc comment). */
function realRunAudit(args: string[], cwd: string): SpawnResult {
  const result = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function realCheckToolAvailable(): boolean {
  const result = spawnSync("npm", ["--version"], { encoding: "utf8" });
  return result.error === undefined && result.status === 0;
}

function realGetToolVersion(): string | null {
  const result = spawnSync("npm", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return (result.stdout ?? "").trim() || null;
}

function realReadLockfilePackages(cwd: string): Record<string, { version?: string }> | null {
  try {
    const raw = readFileSync(path.join(cwd, "package-lock.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "packages" in parsed &&
      parsed.packages &&
      typeof parsed.packages === "object"
    ) {
      return parsed.packages as Record<string, { version?: string }>;
    }
    return null;
  } catch {
    // Missing/unparseable lockfile is not a scan failure - installed_version
    // is honestly represented as unknown (null) per docs/secureship.md.
    return null;
  }
}

/**
 * Reference provider for "security.dependency_audit": real, deterministic
 * detection via `npm audit --json` (npm's own ecosystem-native advisory
 * database - the same tool this repo's CI already gates on, see
 * scripts/run-npm-audit.ts) cross-referenced against package-lock.json for
 * installed versions. No LLM is ever the source of vulnerability truth -
 * see docs/secureship.md "Trust model".
 *
 * FILESYSTEM SCOPE: `cwd`/`ecosystem` are fixed at construction time (same
 * pattern as providers/local-test-runner and providers/git-diff) - the
 * caller-supplied `workspace_ref` input field is a label for evidence/audit
 * only and never selects or overrides what gets scanned.
 *
 * INPUT RESOLUTION: this branch deliberately does not depend on the
 * unmerged platform-proof branch's `OrchestratorDeps.context` field (see
 * docs/secureship.md "Git strategy"), so a call routed through
 * `runTask()` reaches `execute()` as plain `{capability, request}` with no
 * structured payload at all. `defaultWorkspaceRef` exists for exactly that
 * case: when neither a `context` payload nor a directly-shaped input
 * (containing `workspace_ref`) is present, the provider falls back to its
 * own constructor-configured defaults - the same "configured at
 * construction time" pattern local-test-runner/git-diff already use for
 * their entire input. An explicit `context` payload or a directly-shaped
 * input (both exercised in evals/dependency-audit.test.ts) still override
 * those defaults field-by-field.
 *
 * SECURITY: every value copied from npm's JSON response (package names,
 * advisory titles/URLs) is treated as untrusted external data end-to-end -
 * see npm-audit-parser.ts's module doc comment and
 * evals/dependency-audit-security.test.ts. A scanner failure (tool missing,
 * unparseable output) always returns FAILURE, never a fabricated "clean"
 * SUCCESS with zero findings.
 */
export function createDependencyAuditProvider(params: {
  cwd: string;
  ecosystem: DependencyEcosystem;
  /** Used only when a call carries no structured workspace_ref of its own (see "INPUT RESOLUTION" above). */
  defaultWorkspaceRef?: string;
  defaultPolicy?: Partial<DependencyAuditPolicy>;
  runAudit?: RunAudit;
  checkToolAvailable?: () => boolean;
  getToolVersion?: () => string | null;
  readLockfilePackages?: ReadLockfilePackages;
}): Provider {
  const runAudit = params.runAudit ?? realRunAudit;
  const checkToolAvailable = params.checkToolAvailable ?? realCheckToolAvailable;
  const getToolVersion = params.getToolVersion ?? realGetToolVersion;
  const readLockfilePackages = params.readLockfilePackages ?? realReadLockfilePackages;
  const defaultWorkspaceRef =
    (params.defaultWorkspaceRef ?? path.basename(params.cwd)) || "workspace";

  return {
    id: "security-dependency-audit-npm",
    isAvailable: () => checkToolAvailable(),
    async execute(rawInput: Record<string, unknown>): Promise<ProviderResult> {
      const startedAt = new Date();
      const toolVersion = getToolVersion();

      // See "INPUT RESOLUTION" in this function's doc comment above: a
      // `context` payload or a directly-shaped input (one that already
      // carries its own `workspace_ref`) is used as-is; a plain
      // orchestrator call (`{capability, request}`, no structured payload)
      // falls back to this provider's own configured defaults.
      const raw = rawInput as { context?: unknown; workspace_ref?: unknown };
      const overrides =
        raw.context !== undefined
          ? raw.context
          : raw.workspace_ref !== undefined
            ? rawInput
            : undefined;
      const candidateInput = {
        workspace_ref: defaultWorkspaceRef,
        ecosystem: params.ecosystem,
        ...(overrides && typeof overrides === "object" ? overrides : {}),
      };

      const parsedInput = dependencyAuditInputSchema.safeParse(candidateInput);

      if (!parsedInput.success) {
        return failure({
          startedAt,
          tenantRef: null,
          ecosystem: params.ecosystem,
          workspaceRef: "unknown",
          toolVersion,
          errorClassification: "validation_error",
          message: "dependency audit rejected: input failed schema validation",
        });
      }

      const input = parsedInput.data;

      if (input.ecosystem !== params.ecosystem) {
        return failure({
          startedAt,
          tenantRef: input.tenant_ref ?? null,
          ecosystem: params.ecosystem,
          workspaceRef: input.workspace_ref,
          toolVersion,
          errorClassification: "validation_error",
          message: `dependency audit rejected: this provider is configured for ecosystem "${params.ecosystem}", not "${input.ecosystem}"`,
        });
      }

      const policy: Required<DependencyAuditPolicy> = {
        ...DEFAULT_POLICY,
        ...params.defaultPolicy,
        ...input.policy,
      };

      try {
        const args = ["audit", "--json", ...(policy.production_only ? ["--omit=dev"] : [])];
        const spawnResult = runAudit(args, params.cwd);

        if (spawnResult.error) {
          return failure({
            startedAt,
            tenantRef: input.tenant_ref ?? null,
            ecosystem: params.ecosystem,
            workspaceRef: input.workspace_ref,
            toolVersion,
            errorClassification: "tool_unavailable",
            message: "dependency audit failed: npm audit could not be launched in this environment",
          });
        }

        const report = parseRawNpmAudit(spawnResult.stdout);
        if (!report) {
          return failure({
            startedAt,
            tenantRef: input.tenant_ref ?? null,
            ecosystem: params.ecosystem,
            workspaceRef: input.workspace_ref,
            toolVersion,
            errorClassification: "scanner_output_invalid",
            // Never a clean result on malformed output - fail closed, per
            // docs/secureship.md "scanner/tool failure cannot be reported
            // as a clean repository".
            message:
              "dependency audit failed: npm audit produced output that did not match the expected shape",
          });
        }

        const lockfilePackages = readLockfilePackages(params.cwd);
        const normalized = normalizeNpmAudit({ report, lockfilePackages, policy });

        const output = dependencyAuditOutputSchema.parse({
          ecosystem: params.ecosystem,
          scanned_dependency_count: normalized.scannedDependencyCount,
          findings: normalized.findings,
          risk_summary: normalized.riskSummary,
          truncated: normalized.truncated,
        });

        const endedAt = new Date();
        const meta = dependencyAuditExecutionMetaSchema.parse({
          skill: DEPENDENCY_AUDIT_SKILL_ID,
          skill_version: DEPENDENCY_AUDIT_SKILL_VERSION,
          tenant_ref: input.tenant_ref ?? null,
          provider: "security-dependency-audit-npm",
          ecosystem: params.ecosystem,
          workspace_ref: input.workspace_ref,
          tool_version: toolVersion,
          started_at: startedAt.toISOString(),
          ended_at: endedAt.toISOString(),
          duration_ms: endedAt.getTime() - startedAt.getTime(),
          status: "success",
          error_classification: "none",
        });

        const result: DependencyAuditResult = { output, meta };

        const evidence: EvidenceItem[] = [
          {
            type: "test",
            description:
              "dependency audit output validated against dependencyAuditOutputSchema (zod, strict)",
            data:
              `PASS: ${normalized.findings.length} finding(s), ` +
              `severity_breakdown=${JSON.stringify(normalized.riskSummary.by_severity)}, ` +
              `overall_risk=${normalized.riskSummary.overall_risk}`,
            timestamp: endedAt.toISOString(),
          },
        ];

        return {
          status: "SUCCESS",
          // Counts and severity summary only - never raw advisory titles/
          // URLs (which came from external, in-principle-attacker-influenced
          // package metadata) in the audit-log-visible message. Full detail
          // lives only in `data.output.findings`, the structured RESULT
          // returned to the caller, not automatically copied into the audit
          // trail - see core/orchestrator.ts's tool_executed audit event.
          message:
            `security.dependency_audit: scanned ${normalized.scannedDependencyCount} dependencies ` +
            `for workspace=${input.workspace_ref}` +
            (input.tenant_ref ? ` tenant=${input.tenant_ref}` : "") +
            `; ${normalized.findings.length} finding(s); overall_risk=${normalized.riskSummary.overall_risk}`,
          evidence,
          data: result,
        };
      } catch {
        return failure({
          startedAt,
          tenantRef: input.tenant_ref ?? null,
          ecosystem: params.ecosystem,
          workspaceRef: input.workspace_ref,
          toolVersion,
          errorClassification: "internal_error",
          message: "dependency audit failed: unexpected internal error during analysis",
        });
      }
    },
  };
}

function failure(params: {
  startedAt: Date;
  tenantRef: string | null;
  ecosystem: DependencyEcosystem;
  workspaceRef: string;
  toolVersion: string | null;
  errorClassification:
    "validation_error" | "tool_unavailable" | "scanner_output_invalid" | "internal_error";
  message: string;
}): ProviderResult {
  const endedAt = new Date();
  const meta = dependencyAuditExecutionMetaSchema.parse({
    skill: DEPENDENCY_AUDIT_SKILL_ID,
    skill_version: DEPENDENCY_AUDIT_SKILL_VERSION,
    tenant_ref: params.tenantRef,
    provider: "security-dependency-audit-npm",
    ecosystem: params.ecosystem,
    workspace_ref: params.workspaceRef,
    tool_version: params.toolVersion,
    started_at: params.startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    duration_ms: endedAt.getTime() - params.startedAt.getTime(),
    status: "failure",
    error_classification: params.errorClassification,
  });
  return {
    status: "FAILURE",
    message: params.message,
    evidence: [],
    data: { meta },
  };
}
