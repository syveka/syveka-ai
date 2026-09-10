import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression coverage for the staging incident where storage_org_read/write
 * were created on staging before the Creator Studio buckets existed, then
 * silently never updated when 004_storage.sql's own bucket list grew --
 * "create policy ... if not exists" only ever fires the very first time a
 * database sees a given policy name, so an already-existing policy's
 * predicate was left stale indefinitely, and the file's own fail-closed
 * verification block (correctly) refused to proceed rather than silently
 * accept the drift.
 *
 * The fix gives every policy in 004_storage.sql an `else alter policy ...`
 * branch, so a rerun always brings an existing policy's predicate up to
 * date instead of silently no-op'ing. This test asserts the fix's shape
 * directly against the source text (no live Postgres/storage schema is
 * available in the plain `npm test` environment -- that live verification
 * was done manually against a local Supabase instance and is described in
 * the accompanying PR/report), and guards against the same class of bug
 * recurring for a future predicate change: a bucket added to a CREATE
 * clause's list but not to its matching ALTER clause (or to the
 * verification block's expected string) would silently reopen this exact
 * incident the next time the file changes.
 */

const SQL_PATH = resolve(process.cwd(), "prisma/sql/004_storage.sql");
const sql = readFileSync(SQL_PATH, "utf8").replace(/\r\n/g, "\n");

const POLICIES = [
  "storage_org_read",
  "storage_org_write",
  "storage_avatar_write",
  "storage_public_read",
] as const;

/** All single-quoted bucket-id-shaped literals appearing in a text fragment, e.g. `'documents'`. */
function bucketIds(text: string): string[] {
  return [...text.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]!).sort();
}

function branchBody(policyName: string, keyword: "create policy" | "alter policy"): string {
  const start = sql.indexOf(`${keyword} ${policyName} on storage.objects`);
  if (start < 0) {
    throw new Error(
      `Could not find "${keyword} ${policyName} on storage.objects" in 004_storage.sql`,
    );
  }
  const end = sql.indexOf(";", start);
  if (end < 0) throw new Error(`No terminating ";" found for ${keyword} ${policyName}`);
  return sql.slice(start, end);
}

/** The `expected_qual :=` / `expected_check :=` line for one policy in the verification DO block. */
function expectedLine(policyName: string, field: "expected_qual" | "expected_check"): string {
  const blockStart = sql.indexOf(`policy_name = '${policyName}'`);
  if (blockStart < 0) throw new Error(`No verification branch found for ${policyName}`);
  const nextBranch = sql.indexOf("elsif policy_name", blockStart + 1);
  const blockEnd =
    nextBranch > 0 ? nextBranch : sql.indexOf("end if;\n\n    if policy_qual", blockStart);
  const block = sql.slice(blockStart, blockEnd > 0 ? blockEnd : blockStart + 500);
  const line = block.split("\n").find((l) => l.includes(`${field} :=`));
  if (!line) throw new Error(`No ${field} line found for ${policyName}`);
  return line;
}

describe("prisma/sql/004_storage.sql: policy upgrade path", () => {
  it("never uses DROP POLICY (RLS coverage must never have a gap)", () => {
    expect(sql).not.toMatch(/drop\s+policy/i);
  });

  it.each(POLICIES)("has both a CREATE and an ALTER branch for %s", (policyName) => {
    expect(sql).toContain(`create policy ${policyName} on storage.objects`);
    expect(sql).toMatch(
      new RegExp(`else\\s*\\n\\s*alter policy ${policyName} on storage\\.objects`, "i"),
    );
  });

  it.each(POLICIES)(
    "the CREATE and ALTER branches for %s reference the exact same set of bucket ids",
    (policyName) => {
      const created = bucketIds(branchBody(policyName, "create policy"));
      const altered = bucketIds(branchBody(policyName, "alter policy"));
      expect(created.length).toBeGreaterThan(0);
      expect(altered).toEqual(created);
    },
  );

  it.each(["storage_org_read", "storage_org_write"] as const)(
    "%s's CREATE clause bucket list matches the verification block's expected predicate",
    (policyName) => {
      const created = bucketIds(branchBody(policyName, "create policy"));
      const field = policyName === "storage_org_read" ? "expected_qual" : "expected_check";
      const expected = bucketIds(expectedLine(policyName, field));
      expect(expected).toEqual(created);
    },
  );

  it("the Creator Studio buckets are present in both storage_org_read and storage_org_write", () => {
    for (const policyName of ["storage_org_read", "storage_org_write"] as const) {
      const created = bucketIds(branchBody(policyName, "create policy"));
      expect(created).toContain("creator-reference-assets");
      expect(created).toContain("creator-generated-media");
    }
  });
});
