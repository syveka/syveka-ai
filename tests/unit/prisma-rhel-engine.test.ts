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

describe("Prisma Rust-free client (no native query engine binary)", () => {
  it("uses the prisma-client generator with engineType=client and no binaryTargets", () => {
    const block = generatorClientBlock();
    expect(block).toMatch(/provider\s*=\s*"prisma-client"/);
    expect(block).toMatch(/engineType\s*=\s*"client"/);
    expect(block).not.toMatch(/binaryTargets/);
  });

  it("wires a build-artifact verification step into the staging workflow, after the build and before deploy", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8").replace(/\r\n?/g, "\n");
    expect(workflow).toContain("node scripts/verify-prisma-engine.mjs");
    const buildIdx = workflow.indexOf("- name: Production build");
    const verifyIdx = workflow.indexOf("scripts/verify-prisma-engine.mjs");
    const deployIdx = workflow.indexOf("- name: Deploy staging application");
    expect(buildIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(buildIdx);
    expect(deployIdx).toBeGreaterThan(verifyIdx);
  });

  describe("scripts/verify-prisma-engine.mjs", () => {
    it("passes when the traced manifest has no native query engine binary", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "prisma-engine-ok-"));
      const nftPath = path.join(dir, "route.js.nft.json");
      writeFileSync(
        nftPath,
        JSON.stringify({
          files: [
            "../../../../../node_modules/@prisma/client/runtime/client.js",
            "../../../../../node_modules/@prisma/client/runtime/query_compiler_bg.postgresql.wasm-base64.js",
          ],
        }),
      );
      try {
        const result = runVerifyScript(nftPath);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("no native query engine binary present");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails closed when a native query engine binary is present in the manifest", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "prisma-engine-regressed-"));
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
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("native Prisma query engine binary is present");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("also fails closed for a Windows-style native engine binary", () => {
      const dir = mkdtempSync(path.join(tmpdir(), "prisma-engine-windows-"));
      const nftPath = path.join(dir, "route.js.nft.json");
      writeFileSync(
        nftPath,
        JSON.stringify({
          files: ["../../../../../node_modules/.prisma/client/query_engine-windows.dll.node"],
        }),
      );
      try {
        const result = runVerifyScript(nftPath);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain("native Prisma query engine binary is present");
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
