import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCHEMA_PATH = path.resolve(process.cwd(), "prisma/schema.prisma");
const WORKFLOW_PATH = path.resolve(process.cwd(), ".github/workflows/staging-release.yml");
const VERIFY_SCRIPT = path.resolve(process.cwd(), "scripts/verify-prisma-engine.mjs");

function generatorClientBlock(): string {
  const schema = readFileSync(SCHEMA_PATH, "utf8");
  const match = schema.match(/generator client \{[\s\S]*?\}/);
  if (!match) throw new Error("generator client block not found in prisma/schema.prisma");
  return match[0];
}

function runVerifyScript(nftPath: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [VERIFY_SCRIPT, nftPath], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status: number | null; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("Prisma rhel-openssl-3.0.x engine (Vercel Lambda runtime compatibility)", () => {
  it("declares both native and rhel-openssl-3.0.x in binaryTargets", () => {
    const block = generatorClientBlock();
    const match = block.match(/binaryTargets\s*=\s*\[([^\]]*)\]/);
    if (!match) throw new Error("generator client block must set binaryTargets");
    const targets = match[1]!.split(",").map((t) => t.trim().replace(/^"|"$/g, ""));
    expect(targets).toContain("native");
    expect(targets).toContain("rhel-openssl-3.0.x");
  });

  it("wires a build-artifact verification step into the staging workflow, after the build and before deploy", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8").replace(/\r\n?/g, "\n");
    expect(workflow).toContain("node scripts/verify-prisma-engine.mjs");
    const buildIdx = workflow.indexOf("- name: Production build");
    const verifyIdx = workflow.indexOf(
      "Verify Prisma RHEL query engine is included in build artifacts",
    );
    const deployIdx = workflow.indexOf("- name: Deploy staging application");
    expect(buildIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(buildIdx);
    expect(deployIdx).toBeGreaterThan(verifyIdx);
  });

  describe("scripts/verify-prisma-engine.mjs", () => {
    it("passes when the traced manifest includes the rhel-openssl-3.0.x engine", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "prisma-engine-ok-"));
      const nftPath = path.join(dir, "route.js.nft.json");
      writeFileSync(
        nftPath,
        JSON.stringify({
          files: [
            "../../../../../node_modules/.prisma/client/index.js",
            "../../../../../node_modules/.prisma/client/libquery_engine-rhel-openssl-3.0.x.so.node",
          ],
        }),
      );
      try {
        const result = runVerifyScript(nftPath);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("is present in build artifacts");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails closed when the manifest is missing the rhel-openssl-3.0.x engine", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "prisma-engine-missing-"));
      const nftPath = path.join(dir, "route.js.nft.json");
      writeFileSync(
        nftPath,
        JSON.stringify({
          files: [
            "../../../../../node_modules/.prisma/client/index.js",
            "../../../../../node_modules/.prisma/client/query_engine-windows.dll.node",
          ],
        }),
      );
      try {
        const result = runVerifyScript(nftPath);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("rhel-openssl-3.0.x query engine is missing");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails closed when the manifest file does not exist", () => {
      const result = runVerifyScript(path.join(tmpdir(), "does-not-exist.nft.json"));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("file-tracing manifest not found");
    });
  });
});
