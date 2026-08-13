import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type GateResult = "MATCH" | "MISMATCH_CONFIRMED" | "AMBIGUOUS";

const workflow = readFileSync(
  resolve(process.cwd(), ".github/workflows/readonly-staging-baseline-checksum.yml"),
  "utf8",
).replace(/\r\n?/g, "\n");

function classifyAggregate(result: string | null): GateResult {
  if (result === null || !/^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$/.test(result)) {
    return "AMBIGUOUS";
  }

  const [total, active, rolledBack, unfinished, activeMatching] = result.split("|").map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];

  if (
    active + rolledBack + unfinished !== total ||
    activeMatching > active ||
    active !== 1 ||
    unfinished !== 0
  ) {
    return "AMBIGUOUS";
  }

  if (activeMatching === 1) {
    return "MATCH";
  }

  if (activeMatching === 0) {
    return "MISMATCH_CONFIRMED";
  }

  return "AMBIGUOUS";
}

describe("read-only staging baseline checksum gate", () => {
  it.each([
    ["one successful mismatch", "1|1|0|0|0", "MISMATCH_CONFIRMED"],
    ["one historical rollback", "2|1|1|0|0", "MISMATCH_CONFIRMED"],
    ["multiple historical rollbacks", "4|1|3|0|0", "MISMATCH_CONFIRMED"],
    ["active checksum match", "2|1|1|0|1", "MATCH"],
    ["zero active successes", "1|0|1|0|0", "AMBIGUOUS"],
    ["two active successes", "2|2|0|0|0", "AMBIGUOUS"],
    ["unfinished-only row", "1|0|0|1|0", "AMBIGUOUS"],
    ["query failure", null, "AMBIGUOUS"],
    ["malformed output", "1|1|0|0", "AMBIGUOUS"],
    ["negative count", "1|1|-1|0|0", "AMBIGUOUS"],
    ["non-numeric count", "1|one|0|0|0", "AMBIGUOUS"],
    ["contradictory lifecycle partition", "2|1|0|0|0", "AMBIGUOUS"],
    ["active success plus unfinished attempt", "2|1|0|1|0", "AMBIGUOUS"],
    ["matching count exceeds active count", "1|1|0|0|2", "AMBIGUOUS"],
  ] as const)("classifies %s fail-closed", (_label, aggregate, expected) => {
    expect(classifyAggregate(aggregate)).toBe(expected);
  });

  it("queries only lifecycle aggregates and compares only the active successful row", () => {
    expect(workflow.match(/^\s*SELECT\s*$/gm)).toHaveLength(1);
    expect(workflow).toContain("FROM public._prisma_migrations");
    expect(workflow).toContain("finished_at IS NOT NULL AND rolled_back_at IS NULL");
    expect(workflow).toContain("finished_at IS NULL AND rolled_back_at IS NOT NULL");
    expect(workflow).toContain("finished_at IS NULL AND rolled_back_at IS NULL");
    expect(workflow).toMatch(
      /finished_at IS NOT NULL\s+AND rolled_back_at IS NULL\s+AND checksum = :'expected_checksum'/,
    );
    expect(workflow).toContain(
      "active_count + rolled_back_count + unfinished_count != total_count",
    );
    expect(workflow).toContain("active_count != 1");
    expect(workflow).toContain("unfinished_count != 0");
  });

  it("retains the trusted read-only workflow boundary", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/\n\s+(pull_request|push|schedule):/);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("environment: staging");
    expect(workflow).toContain("uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("submodules: false");
    expect(workflow).toContain("lfs: false");
    expect(workflow).toContain('PGOPTIONS: "-c default_transaction_read_only=on"');
    expect(workflow).toContain("-X -A -t -F '|'");
    expect(workflow).toContain("-v ON_ERROR_STOP=1");
    expect(workflow).toContain("2>/dev/null <<'SQL'");
    expect(workflow).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/);
    expect(workflow).not.toMatch(/prisma migrate (deploy|resolve|reset)/);
    expect(workflow).not.toMatch(/echo[^\n]*(expected_checksum|active_matching_count)/);
  });
});
