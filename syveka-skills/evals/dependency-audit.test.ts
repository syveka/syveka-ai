import { describe, expect, it } from "vitest";
import { runTask } from "../core/orchestrator.js";
import { ApprovalGate } from "../core/approvals/index.js";
import { createDependencyAuditProvider } from "../providers/dependency-audit/index.js";
import {
  dependencyAuditInputSchema,
  dependencyAuditOutputSchema,
  type DependencyAuditResult,
} from "../schemas/dependency-audit.js";
import { findById } from "../core/registry/index.js";

/**
 * Evaluation suite for "security.dependency_audit" - the first SecureShip
 * capability (see docs/secureship.md). Covers Inspect -> Detect ->
 * Prioritize -> Explain -> Report: contract validation, normal cases
 * (clean/vulnerable-direct/vulnerable-transitive/multi-severity/no-fix/
 * fix-available), and the full orchestrator path. Adversarial/security
 * cases live in evals/dependency-audit-security.test.ts.
 *
 * All normal-case tests inject a fake `runAudit` so results are
 * deterministic and don't depend on live npmjs.org advisory data - see
 * "against a real repository" below for the one test that genuinely does
 * shell out to real `npm audit` against this repo's own lockfile.
 */

function fixture(json: Record<string, unknown>): string {
  return JSON.stringify(json);
}

const CLEAN_REPORT = fixture({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    dependencies: { total: 42 },
  },
});

const DIRECT_VULNERABLE_REPORT = fixture({
  auditReportVersion: 2,
  vulnerabilities: {
    "left-pad": {
      name: "left-pad",
      severity: "high",
      isDirect: true,
      via: [
        {
          source: 9999,
          name: "left-pad",
          title: "left-pad: Regular Expression Denial of Service",
          url: "https://github.com/advisories/GHSA-xxxx-yyyy-zzzz",
          severity: "high",
          cwe: ["CWE-1333"],
          cvss: { score: 7.5 },
          range: "<=1.3.0",
        },
      ],
      range: "<=1.3.0",
      nodes: ["node_modules/left-pad"],
      fixAvailable: true,
    },
  },
  metadata: { dependencies: { total: 100 } },
});

const TRANSITIVE_VULNERABLE_REPORT = fixture({
  auditReportVersion: 2,
  vulnerabilities: {
    "some-lib": {
      name: "some-lib",
      severity: "moderate",
      isDirect: false,
      via: ["vulnerable-transitive-dep"],
      range: "<=2.0.0",
      nodes: ["node_modules/some-lib"],
      fixAvailable: false,
    },
  },
  metadata: { dependencies: { total: 100 } },
});

const MULTI_SEVERITY_REPORT = fixture({
  auditReportVersion: 2,
  vulnerabilities: {
    "pkg-info": {
      name: "pkg-info",
      severity: "info",
      isDirect: true,
      via: [{ title: "info advisory", url: "https://example.test/1", severity: "info" }],
      range: "<=1.0.0",
      nodes: ["node_modules/pkg-info"],
      fixAvailable: true,
    },
    "pkg-low": {
      name: "pkg-low",
      severity: "low",
      isDirect: true,
      via: [{ title: "low advisory", url: "https://example.test/2", severity: "low" }],
      range: "<=1.0.0",
      nodes: ["node_modules/pkg-low"],
      fixAvailable: false,
    },
    "pkg-moderate": {
      name: "pkg-moderate",
      severity: "moderate",
      isDirect: false,
      via: [{ title: "moderate advisory", url: "https://example.test/3", severity: "moderate" }],
      range: "<=1.0.0",
      nodes: ["node_modules/pkg-moderate"],
      fixAvailable: true,
    },
    "pkg-high": {
      name: "pkg-high",
      severity: "high",
      isDirect: true,
      via: [{ title: "high advisory", url: "https://example.test/4", severity: "high" }],
      range: "<=1.0.0",
      nodes: ["node_modules/pkg-high"],
      fixAvailable: false,
    },
    "pkg-critical": {
      name: "pkg-critical",
      severity: "critical",
      isDirect: false,
      via: [{ title: "critical advisory", url: "https://example.test/5", severity: "critical" }],
      range: "<=1.0.0",
      nodes: ["node_modules/pkg-critical"],
      fixAvailable: true,
    },
  },
  metadata: { dependencies: { total: 100 } },
});

function fakeRunAudit(stdout: string, status = 1) {
  return () => ({ status, stdout, stderr: "" });
}

function providerWithFixture(
  stdout: string,
  lockfile: Record<string, { version?: string }> | null = null,
) {
  return createDependencyAuditProvider({
    cwd: "/tmp/fixture-repo",
    ecosystem: "npm",
    runAudit: fakeRunAudit(stdout),
    checkToolAvailable: () => true,
    getToolVersion: () => "10.0.0",
    readLockfilePackages: () => lockfile,
  });
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return { workspace_ref: "syveka-ai", ecosystem: "npm" as const, ...overrides };
}

describe("dependency audit: contract validation", () => {
  it("input schema rejects an unsupported field", () => {
    const result = dependencyAuditInputSchema.safeParse(baseInput({ path_override: "../../etc" }));
    expect(result.success).toBe(false);
  });

  it("input schema rejects a workspace_ref that isn't a simple label", () => {
    const result = dependencyAuditInputSchema.safeParse(
      baseInput({ workspace_ref: "../../etc/passwd" }),
    );
    expect(result.success).toBe(false);
  });

  it("input schema rejects an unsupported ecosystem", () => {
    const result = dependencyAuditInputSchema.safeParse(baseInput({ ecosystem: "pip" }));
    expect(result.success).toBe(false);
  });

  it("output schema rejects a schema-breaking response (missing required field)", () => {
    const bad = {
      ecosystem: "npm",
      scanned_dependency_count: 1,
      findings: [],
      // risk_summary omitted
      truncated: false,
    };
    expect(dependencyAuditOutputSchema.safeParse(bad).success).toBe(false);
  });

  it("output schema rejects an invalid severity value", () => {
    const result = dependencyAuditOutputSchema.safeParse({
      ecosystem: "npm",
      scanned_dependency_count: 1,
      findings: [
        {
          package: "x",
          installed_version: "1.0.0",
          affected_range: "<=1.0.0",
          severity: "super-critical", // not a valid enum value
          advisory_id: null,
          advisory_url: null,
          title: "x",
          classification: "direct",
          fix_available: false,
          recommended_action: "x",
          evidence_ref: "npm audit --json",
          cwe: [],
          cvss_score: null,
        },
      ],
      risk_summary: {
        total_findings: 1,
        by_severity: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
        direct_count: 1,
        transitive_count: 0,
        fixable_count: 0,
        overall_risk: "high",
      },
      truncated: false,
    });
    expect(result.success).toBe(false);
  });
});

describe("dependency audit: normal cases", () => {
  it("a clean dependency set produces zero findings, never a fabricated 'no vulnerabilities' text claim", async () => {
    const provider = providerWithFixture(CLEAN_REPORT);
    const result = await provider.execute(baseInput());
    expect(result.status).toBe("SUCCESS");
    const data = result.data as DependencyAuditResult;
    expect(dependencyAuditOutputSchema.safeParse(data.output).success).toBe(true);
    expect(data.output.findings).toHaveLength(0);
    expect(data.output.risk_summary.overall_risk).toBe("none");
  });

  it("detects a known vulnerable DIRECT dependency and classifies it correctly", async () => {
    const provider = providerWithFixture(DIRECT_VULNERABLE_REPORT, {
      "node_modules/left-pad": { version: "1.2.9" },
    });
    const result = await provider.execute(baseInput());
    const data = result.data as DependencyAuditResult;
    expect(data.output.findings).toHaveLength(1);
    const finding = data.output.findings[0]!;
    expect(finding.package).toBe("left-pad");
    expect(finding.classification).toBe("direct");
    expect(finding.severity).toBe("high");
    expect(finding.installed_version).toBe("1.2.9");
    expect(finding.advisory_id).toBe("GHSA-xxxx-yyyy-zzzz");
    expect(finding.fix_available).toBe(true);
  });

  it("detects a known vulnerable TRANSITIVE dependency where supported (no direct advisory object)", async () => {
    const provider = providerWithFixture(TRANSITIVE_VULNERABLE_REPORT);
    const result = await provider.execute(baseInput());
    const data = result.data as DependencyAuditResult;
    expect(data.output.findings).toHaveLength(1);
    const finding = data.output.findings[0]!;
    expect(finding.classification).toBe("transitive");
    // No object-shaped advisory in `via` (only a string reference) -
    // advisory_id/url are honestly null, never fabricated.
    expect(finding.advisory_id).toBeNull();
    expect(finding.advisory_url).toBeNull();
    expect(finding.fix_available).toBe(false);
  });

  it("handles multiple severity levels and prioritizes highest severity first", async () => {
    const provider = providerWithFixture(MULTI_SEVERITY_REPORT);
    const result = await provider.execute(baseInput());
    const data = result.data as DependencyAuditResult;
    expect(data.output.findings).toHaveLength(5);
    expect(data.output.findings[0]!.severity).toBe("critical");
    expect(data.output.findings.at(-1)!.severity).toBe("info");
    expect(data.output.risk_summary.overall_risk).toBe("critical");
    expect(data.output.risk_summary.by_severity).toEqual({
      info: 1,
      low: 1,
      moderate: 1,
      high: 1,
      critical: 1,
    });
  });

  it("honestly reports no fix available, never inventing a remediation", async () => {
    const provider = providerWithFixture(TRANSITIVE_VULNERABLE_REPORT);
    const result = await provider.execute(baseInput());
    const data = result.data as DependencyAuditResult;
    expect(data.output.findings[0]!.fix_available).toBe(false);
    expect(data.output.findings[0]!.recommended_action).toContain("No fix currently published");
  });

  it("reports a concrete recommended action when a fix is available (object form: name/version/major)", async () => {
    const reportWithObjectFix = fixture({
      vulnerabilities: {
        "react-email": {
          name: "react-email",
          severity: "high",
          isDirect: true,
          via: ["@babel/core"],
          range: "1.0.0 - 4.1.0",
          nodes: ["node_modules/react-email"],
          fixAvailable: { name: "react-email", version: "6.9.3", isSemVerMajor: true },
        },
      },
      metadata: { dependencies: { total: 50 } },
    });
    const provider = providerWithFixture(reportWithObjectFix);
    const result = await provider.execute(baseInput());
    const data = result.data as DependencyAuditResult;
    expect(data.output.findings[0]!.fix_available).toBe(true);
    expect(data.output.findings[0]!.recommended_action).toContain("6.9.3");
    expect(data.output.findings[0]!.recommended_action).toContain("major version bump");
  });

  it("caps findings at max_findings and reports truncated=true rather than returning unbounded output", async () => {
    const manyVulnerabilities: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      manyVulnerabilities[`pkg-${i}`] = {
        name: `pkg-${i}`,
        severity: "moderate",
        isDirect: true,
        via: [{ title: `advisory ${i}`, url: `https://example.test/${i}`, severity: "moderate" }],
        range: "<=1.0.0",
        nodes: [],
        fixAvailable: false,
      };
    }
    const provider = providerWithFixture(
      fixture({ vulnerabilities: manyVulnerabilities, metadata: { dependencies: { total: 10 } } }),
    );
    const result = await provider.execute(baseInput({ policy: { max_findings: 3 } }));
    const data = result.data as DependencyAuditResult;
    expect(data.output.findings).toHaveLength(3);
    expect(data.output.truncated).toBe(true);
    // The summary still reflects only the returned findings, never a
    // fabricated total for the ones that were capped away.
    expect(data.output.risk_summary.total_findings).toBe(3);
  });

  it("honors a minimum_severity policy override, filtering lower-severity findings", async () => {
    const provider = providerWithFixture(MULTI_SEVERITY_REPORT);
    const result = await provider.execute(baseInput({ policy: { minimum_severity: "high" } }));
    const data = result.data as DependencyAuditResult;
    expect(data.output.findings).toHaveLength(2);
    expect(
      data.output.findings.every((f) => f.severity === "high" || f.severity === "critical"),
    ).toBe(true);
  });
});

describe("dependency audit: governance/orchestrator integration", () => {
  it("reaches COMPLETE/VERIFIED with real evidence and audit trail (LOW risk, no approval required)", async () => {
    const report = await runTask("eval-dep-audit-1", "Run a dependency audit on this repo", {
      providerMap: {
        "security-dependency-audit-npm": providerWithFixture(DIRECT_VULNERABLE_REPORT),
      },
      approvalGate: new ApprovalGate(),
      actionForCapability: () => "security.dependency_audit.execute",
      // No orchestrator `context` support on this branch (deliberately not
      // depended on - see docs/secureship.md "Git strategy"), so the
      // provider is pre-wired with fixture data; the free-text `request`
      // still drives real intent classification/routing/permission/
      // evidence/verification below it.
    });
    expect(report.status).toBe("COMPLETE");
    expect(report.verification.status).toBe("VERIFIED");
    expect(report.plan.steps[0]!.capability).toBe("security.dependency_audit");
  });

  it("is BLOCKED, not COMPLETE, when forced to a gated risk level - proves the same permission gate applies to this capability too", async () => {
    const report = await runTask("eval-dep-audit-blocked", "Run a dependency audit on this repo", {
      providerMap: { "security-dependency-audit-npm": providerWithFixture(CLEAN_REPORT) },
      approvalGate: new ApprovalGate(),
      actionForCapability: () => "deploy.production", // force HIGH classification
    });
    expect(report.status).toBe("BLOCKED");
  });

  it("reports CAPABILITY_UNAVAILABLE, not a fabricated clean result, when no provider is wired", async () => {
    const report = await runTask(
      "eval-dep-audit-unavailable",
      "Run a dependency audit on this repo",
      {
        providerMap: {},
        approvalGate: new ApprovalGate(),
        actionForCapability: () => "security.dependency_audit.execute",
      },
    );
    expect(report.status).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("is registered, APPROVED, VERIFIED, and routable under security.dependency_audit", () => {
    const entry = findById("security-dependency-audit-npm");
    expect(entry?.capability).toBe("security.dependency_audit");
    expect(entry?.status).toBe("APPROVED");
    expect(entry?.integration_state).toBe("VERIFIED");
  });
});

describe("dependency audit: against a real repository", () => {
  it("runs real `npm audit` against this repo's own syveka-skills workspace and returns a schema-valid, real result", async () => {
    // No fixture injection here - this is a genuine live run of npm audit
    // against syveka-skills/'s own package.json/package-lock.json, proving
    // the capability is useful against a real repository, not only fixtures.
    const provider = createDependencyAuditProvider({ cwd: process.cwd(), ecosystem: "npm" });
    const available = await provider.isAvailable();
    expect(available).toBe(true);

    const result = await provider.execute(baseInput({ workspace_ref: "syveka-ai/syveka-skills" }));
    expect(result.status).toBe("SUCCESS");
    const data = result.data as DependencyAuditResult;
    expect(dependencyAuditOutputSchema.safeParse(data.output).success).toBe(true);
    // A real scan of a real lockfile - dependency count must be genuinely
    // positive, not a placeholder.
    expect(data.output.scanned_dependency_count).toBeGreaterThan(0);
  }, 30_000);
});
