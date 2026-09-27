import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A raw NUL (or other C0 control) byte in a source file makes git and GitHub
 * treat the file as binary, so its diffs stop rendering in PR review. This
 * happened to the calendar webhook route (a literal NUL used as a map-key
 * separator), hiding every later change to a signature-verification path.
 * Write such characters as escapes (e.g. "\u0000") instead.
 */
describe("tracked source files are reviewable text", () => {
  it("contain no NUL or other C0 control characters besides tab/LF/CR", () => {
    const files = execFileSync("git", ["ls-files", "-z", "--", "src", "scripts", "tests"], {
      encoding: "utf8",
    })
      .split("\0")
      .filter((file) => /\.(ts|tsx|mts|js|mjs|sql|json)$/.test(file));

    const offenders = files.filter((file) =>
      /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(readFileSync(file, "utf8")),
    );

    expect(files.length).toBeGreaterThan(100);
    expect(offenders).toEqual([]);
  });
});
