import { describe, expect, it } from "vitest";
import { renderClaudeCodeSkillMd } from "../adapters/claude-code/index.js";
import { renderCodexManifest } from "../adapters/codex/index.js";
import { renderGeminiManifest } from "../adapters/gemini/index.js";
import { describedCapabilities } from "../adapters/shared-capability-list.js";
import { listRegistry } from "../core/registry/index.js";

describe("model portability: adapters share one source of truth", () => {
  it("every adapter's rendered capability list traces back to the same registry data", () => {
    const shared = describedCapabilities();
    const registry = listRegistry();
    expect(shared).toHaveLength(registry.length);
    for (const entry of registry) {
      expect(shared).toContainEqual({
        capability: entry.capability,
        provider: entry.provider,
        status: entry.status,
      });
    }
  });

  it("the Claude Code SKILL.md lists every approved capability from the shared source", () => {
    const skillMd = renderClaudeCodeSkillMd();
    const approved = describedCapabilities().filter((c) => c.status === "APPROVED");
    for (const cap of approved) {
      expect(skillMd).toContain(cap.capability);
    }
  });

  it("the Codex and Gemini manifests both embed the exact same capability JSON (format-only translation, same content)", () => {
    const codex = renderCodexManifest();
    const gemini = renderGeminiManifest();
    expect(JSON.parse(codex.capabilities)).toEqual(JSON.parse(gemini.capabilities));
    expect(JSON.parse(codex.capabilities)).toEqual(describedCapabilities());
  });

  it("no adapter defines capabilities that don't exist in the registry (no duplicated/drifted business logic)", () => {
    const registryCapabilities = new Set(listRegistry().map((e) => e.capability));
    const codexCaps = JSON.parse(renderCodexManifest().capabilities) as { capability: string }[];
    for (const c of codexCaps) {
      expect(registryCapabilities.has(c.capability)).toBe(true);
    }
  });
});
