import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The repository is public and artifact contents are not secret-masked. A
 * Playwright trace records every request's headers and cookies -- in
 * staging-release.yml, the Deployment Protection bypass secret and the E2E
 * session -- and error-context.md's page snapshot records visible form
 * values (the E2E email, and the password if a test fails while it is still
 * typed). So no staging E2E run keeps a trace and the job uploads no
 * artifact. A failed recovery-link navigation must not quote its URL (it
 * carries a live recovery token) into the job log.
 */

const read = (relative: string) =>
  fs.readFileSync(path.join(__dirname, "../..", relative), "utf8").replace(/\r\n?/g, "\n");
const workflow = read(".github/workflows/staging-release.yml");

describe("staging-release.yml keeps no Playwright output", () => {
  it("runs every Playwright invocation with --trace=off", () => {
    const runs = workflow
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .filter((line) => /playwright(@\S+)?\s+test\b|\btest:e2e\b/.test(line));
    expect(runs.length).toBe(3);
    // The exact forms: `npm run test:e2e --trace=off` (no `--`) would hand the
    // flag to npm, and a `--trace=off` after `#` would be a comment.
    for (const line of runs) {
      expect(line, line).toMatch(
        /^\s*run: (npm run test:e2e -- --trace=off|npx playwright test [^#;&|]*\s--trace=off)$/,
      );
    }
  });

  it("uploads no artifact", () => {
    expect(workflow).not.toContain("upload-artifact");
  });
});

describe("auth journeys never print a recovery link", () => {
  it("replaces Playwright's navigation error for the tokenized verify URL", () => {
    const spec = read("tests/e2e/auth-journeys.spec.ts");
    expect(spec).not.toMatch(/await page\.goto\(verifyUrl\);/);
    const start = spec.indexOf("await page.goto(verifyUrl).catch(");
    expect(start).toBeGreaterThan(-1);
    const handler = spec.slice(start, spec.indexOf("\n    });", start));
    // The replacement message carries only the error's name and its
    // net::ERR_* code -- never the URL, the token or the raw error message.
    expect(handler.indexOf("throw new Error(")).toBeGreaterThan(-1);
    const thrown = handler.slice(handler.indexOf("throw new Error("));
    const placeholders = [...thrown.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
    expect(placeholders).toEqual(["name", "netError"]);
    // No URL, no concatenation, and no `cause` (Playwright prints a cause).
    expect(thrown).not.toMatch(/verifyUrl|\+|\bcause\b/);
    expect(handler).toContain("/net::ERR_[A-Z_]+/.exec(String(error))?.[0]");
  });

  it("fills password fields only through fillSecret, whose error withholds the value", () => {
    const spec = read("tests/e2e/auth-journeys.spec.ts");
    // Playwright's call log quotes a fill's value; the journey's generated
    // password is not a registered (masked) secret.
    // Every fill in the spec is an email fill (a masked secret) or the single
    // fill inside fillSecret; no other way of typing text is used.
    const fills = spec.match(/\.fill\([^,)]*/g) ?? [];
    expect(fills.filter((f) => f !== '.fill("#email"' && f !== ".fill(selector")).toEqual([]);
    expect(fills.filter((f) => f === ".fill(selector")).toHaveLength(1);
    expect(spec).not.toMatch(/\.type\(|pressSequentially\(|keyboard\.(type|insertText)\(/);
    expect(spec.match(/fillSecret\(page, "#password", /g)).toHaveLength(2);
    const helper = spec.slice(spec.indexOf("async function fillSecret("));
    expect(helper.indexOf("throw new Error(")).toBeGreaterThan(-1);
    const thrown = helper.slice(helper.indexOf("throw new Error("), helper.indexOf("\n}"));
    const placeholders = [...thrown.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]);
    expect(placeholders).toEqual(["selector", "name"]);
    expect(thrown).not.toMatch(/value\}|\+|\bcause\b/);
  });
});
