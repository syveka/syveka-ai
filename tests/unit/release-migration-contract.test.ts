import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const baseline = read("prisma/migrations/20260701000000_initial_baseline/migration.sql");
const security = read("prisma/migrations/20260719000000_initial_security_baseline/migration.sql");
const storage = read("prisma/sql/004_storage.sql");
const workflow = read(".github/workflows/staging-release.yml");

describe("staging release migration contract", () => {
  it("guards existing and partially provisioned databases", () => {
    expect(baseline).toContain("IF to_regclass('public.organizations') IS NOT NULL");
    expect(baseline).toContain("refused an incomplete existing schema");
    expect(baseline).toContain("refused a partially provisioned schema");
  });

  it("adds security without dropping policies", () => {
    expect(security).toContain("ENABLE ROW LEVEL SECURITY");
    expect(security).toContain("IF NOT EXISTS");
    expect(security).toContain("server-only table");
    expect(security).not.toMatch(/DROP\s+POLICY/i);
  });

  it("keeps Supabase Storage setup rerunnable", () => {
    expect(storage).toContain("on conflict (id) do nothing");
    expect(storage.match(/if not exists/gi)).toHaveLength(4);
  });

  it("migrates and asserts staging before deploying", () => {
    const migrateAt = workflow.indexOf("Apply Prisma migrations to staging");
    const assertAt = workflow.indexOf("Verify migration, RLS, and tenant invariants");
    const deployAt = workflow.indexOf("Deploy staging application");

    expect(migrateAt).toBeGreaterThan(0);
    expect(assertAt).toBeGreaterThan(migrateAt);
    expect(deployAt).toBeGreaterThan(assertAt);
    expect(workflow).toContain("environment: staging");
    expect(workflow).not.toContain("environment: production");
  });
});
