import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every page under (superadmin) must call requireSuperadminPage(): it is the
 * only place a denied visit to the platform admin area is logged
 * (superadmin_access_denied). The layout redirects without a trace, so a page
 * without the guard would be a silent probe target.
 */
const groupDir = path.join(__dirname, "../../src/app/[locale]/(superadmin)");

function pages(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return pages(full);
    return entry.name === "page.tsx" ? [full] : [];
  });
}

describe("(superadmin) pages", () => {
  const files = pages(groupDir);

  it("finds the admin pages", () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files.map((file) => [path.relative(groupDir, file).split(path.sep).join("/"), file]))(
    "%s awaits requireSuperadminPage()",
    (_name, file) => {
      const source = fs.readFileSync(file, "utf8");
      expect(source).toMatch(/from "@\/server\/auth\/page-guard"/);
      expect(source).toMatch(/await requireSuperadminPage\(\)/);
    },
  );
});
