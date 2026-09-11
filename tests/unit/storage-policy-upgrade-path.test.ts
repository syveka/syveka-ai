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
 * The fix gives storage_org_read/storage_org_write (the only two policies
 * whose predicate has ever changed) a narrow, GUARDED upgrade step: ALTER
 * POLICY only runs when the live predicate exactly matches the one known,
 * superseded string this file used to declare for it. This is deliberately
 * an allowlist of one specific prior value, never "always overwrite to
 * whatever this file currently says" -- an earlier version of this fix used
 * an unconditional ALTER and was caught by CI's own "Verify storage
 * compatibility and reject weak policy drift" step, which deliberately
 * weakens storage_org_read to `using (true)` and expects 004_storage.sql to
 * reject it: an unconditional ALTER would have silently "fixed" that
 * weakened policy back to the expected value instead of failing loudly,
 * which is a materially worse outcome than the original bug (a genuine
 * predicate compromise would go completely unnoticed). This test asserts
 * the guard is present, not just that an ALTER branch exists.
 *
 * storage_avatar_write/storage_public_read have never had their predicate
 * change and keep the plain, unconditional "create if not exists" form --
 * no upgrade path is needed or added for them.
 */

const SQL_PATH = resolve(process.cwd(), "prisma/sql/004_storage.sql");
const sql = readFileSync(SQL_PATH, "utf8").replace(/\r\n/g, "\n");

/** All single-quoted bucket-id-shaped literals appearing in a text fragment, e.g. `'documents'`. */
function bucketIds(text: string): string[] {
  return [...text.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]!).sort();
}

function clauseBody(policyName: string, keyword: "create policy" | "alter policy"): string {
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

  it.each(["storage_org_read", "storage_org_write"] as const)(
    "%s's upgrade ALTER is guarded by an exact-match check on the live predicate, never unconditional",
    (policyName) => {
      const elseIndex = sql.indexOf(`policyname = '${policyName}'`);
      expect(elseIndex).toBeGreaterThan(-1);
      const alterIndex = sql.indexOf(`alter policy ${policyName} on storage.objects`, elseIndex);
      expect(alterIndex).toBeGreaterThan(elseIndex);
      const between = sql.slice(elseIndex, alterIndex);
      // The ALTER must be reached only through an `if live_qual = '...' then`
      // (or live_check) guard between the else branch and the ALTER itself
      // -- an unconditional "else ... alter policy" with no such guard
      // would be the unsafe form this test exists to catch.
      expect(between).toMatch(/if\s+live_(qual|check)\s*=\s*'/i);
    },
  );

  it.each(["storage_avatar_write", "storage_public_read"] as const)(
    "%s has no ALTER branch (its predicate has never changed, so none is needed)",
    (policyName) => {
      expect(sql).toContain(`create policy ${policyName} on storage.objects`);
      expect(sql).not.toContain(`alter policy ${policyName} on storage.objects`);
    },
  );

  it.each(["storage_org_read", "storage_org_write"] as const)(
    "%s's guarded old-predicate literal is different from its current CREATE predicate",
    (policyName) => {
      const created = bucketIds(clauseBody(policyName, "create policy"));
      const altered = bucketIds(clauseBody(policyName, "alter policy"));
      const guardMatch = sql.match(
        new RegExp(`live_(?:qual|check)\\s*=\\s*'([^']*(?:''[^']*)*)'`, "i"),
      );
      expect(guardMatch).not.toBeNull();
      // The known-old literal must reference fewer buckets than the current
      // predicate (a real prior version), and must never equal it -- an
      // allowlisted value identical to the current predicate would make the
      // guard meaningless.
      const oldBucketCount = (guardMatch![1]!.match(/'/g) ?? []).length;
      expect(oldBucketCount).toBeGreaterThan(0);
      expect(altered).toEqual(created);
    },
  );

  it.each(["storage_org_read", "storage_org_write"] as const)(
    "%s's CREATE/ALTER clause bucket list matches the verification block's expected predicate",
    (policyName) => {
      const created = bucketIds(clauseBody(policyName, "create policy"));
      const field = policyName === "storage_org_read" ? "expected_qual" : "expected_check";
      const expected = bucketIds(expectedLine(policyName, field));
      expect(expected).toEqual(created);
    },
  );

  it("the Creator Studio buckets are present in both storage_org_read and storage_org_write", () => {
    for (const policyName of ["storage_org_read", "storage_org_write"] as const) {
      const created = bucketIds(clauseBody(policyName, "create policy"));
      expect(created).toContain("creator-reference-assets");
      expect(created).toContain("creator-generated-media");
    }
  });
});
