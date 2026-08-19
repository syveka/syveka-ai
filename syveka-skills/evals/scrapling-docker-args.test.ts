import { describe, expect, it } from "vitest";
import { buildDockerArgs } from "../providers/scrapling/docker-args.js";

/**
 * Deterministic proof of the isolation flags and timeout wiring, without
 * needing a real Docker daemon. Written after discovering during this
 * milestone's real-Docker verification that httpbin.org's own /delay
 * endpoint does not reliably hang in this environment (it returns a fast
 * 503 instead of actually delaying - an external-service behavior this
 * repo doesn't control), which made a live "does it actually time out"
 * test unreliable. This is the deterministic replacement: prove the
 * correct --timeout value and isolation flags are actually constructed,
 * which is the part genuinely under this codebase's control. See
 * docs/skills/scrapling-integration.md for the honest account of both.
 */
describe("Scrapling provider: Docker isolation flags and timeout wiring", () => {
  const base = {
    image: "ghcr.io/d4vinci/scrapling@sha256:test",
    scratchDir: "/tmp/scratch-test",
    url: "https://example.test/",
    outputFilename: "output.md",
    timeoutSeconds: 30,
  };

  it("passes the container-ephemeral flag (--rm)", () => {
    expect(buildDockerArgs(base)).toContain("--rm");
  });

  it("never uses --network host - only bridge", () => {
    const args = buildDockerArgs(base);
    expect(args).toContain("bridge");
    expect(args).not.toContain("host");
  });

  it("drops all Linux capabilities and disables privilege escalation", () => {
    const args = buildDockerArgs(base);
    const capDropIndex = args.indexOf("--cap-drop");
    expect(capDropIndex).toBeGreaterThanOrEqual(0);
    expect(args[capDropIndex + 1]).toBe("ALL");
    expect(args).toContain("no-new-privileges");
  });

  it("applies a memory and CPU ceiling", () => {
    const args = buildDockerArgs(base);
    expect(args).toContain("512m");
    expect(args).toContain("1");
  });

  it("mounts only the scratch output directory, never the full host filesystem", () => {
    const args = buildDockerArgs(base);
    const mount = args.find((a) => a.includes(":/app/out"));
    expect(mount).toBe(`${base.scratchDir}:/app/out`);
  });

  it("passes the exact configured timeout value to Scrapling's own --timeout flag", () => {
    const args10 = buildDockerArgs({ ...base, timeoutSeconds: 10 });
    const idx10 = args10.indexOf("--timeout");
    expect(idx10).toBeGreaterThanOrEqual(0);
    expect(args10[idx10 + 1]).toBe("10");

    const args5 = buildDockerArgs({ ...base, timeoutSeconds: 5 });
    const idx5 = args5.indexOf("--timeout");
    expect(args5[idx5 + 1]).toBe("5");
  });

  it("always passes --ai-targeted (the skill's own documented prompt-injection mitigation)", () => {
    expect(buildDockerArgs(base)).toContain("--ai-targeted");
  });

  it("passes --css-selector only when one is provided, never an empty flag", () => {
    const withSelector = buildDockerArgs({ ...base, cssSelector: ".quote" });
    expect(withSelector).toContain("--css-selector");
    expect(withSelector[withSelector.indexOf("--css-selector") + 1]).toBe(".quote");

    const withoutSelector = buildDockerArgs(base);
    expect(withoutSelector).not.toContain("--css-selector");
  });

  it("passes the exact target URL unmodified (no shell interpolation, no wrapping)", () => {
    const args = buildDockerArgs({ ...base, url: "https://example.test/path?q=1&r=2" });
    expect(args).toContain("https://example.test/path?q=1&r=2");
  });
});
