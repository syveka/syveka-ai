import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const helper = fileURLToPath(
  new URL("../../.claude/skills/syveka-context/scripts/check-served-sha.mjs", import.meta.url),
);
const guard = fileURLToPath(
  new URL("../../.claude/skills/syveka-context/scripts/prod-guard.mjs", import.meta.url),
);

function probe(origin, healthy = true, expected = "-") {
  const mock = `globalThis.fetch = async (url) => {
    if (url.href !== 'https://example.invalid/api/health') throw new Error('unexpected URL');
    return { status: ${healthy ? 200 : 503}, json: async () => ({status: '${healthy ? "healthy" : "degraded"}', build: '${"a".repeat(40)}', checks: {}}) };
  };`;
  return spawnSync(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(mock)}`, helper, expected, origin],
    { encoding: "utf8" },
  );
}

for (const origin of [
  "https://fake-user:FAKE_SENTINEL@example.invalid",
  "malformed-FAKE_SENTINEL",
  "file:///FAKE_SENTINEL",
]) {
  test(`reject unsafe input without echoing it: ${origin.split(":")[0]}`, () => {
    const result = probe(origin);
    assert.equal(result.status, 1);
    assert.ok(!`${result.stdout}${result.stderr}`.includes("FAKE_SENTINEL"));
    assert.ok(!`${result.stdout}${result.stderr}`.includes("fake-user"));
  });
}

test("strips path, query and fragment before probing or reporting", () => {
  const result = probe("https://example.invalid/FAKE_SENTINEL?token=FAKE_SENTINEL#FAKE_SENTINEL");
  assert.equal(result.status, 0);
  assert.ok(!result.stdout.includes("FAKE_SENTINEL"));
});

test("healthy matching SHA passes", () => {
  assert.equal(probe("https://example.invalid", true, "a".repeat(40)).status, 0);
});

test("mismatched SHA fails", () => {
  assert.equal(probe("https://example.invalid", true, "b".repeat(40)).status, 1);
});

test("report-only mode still fails on unhealthy response", () => {
  assert.equal(probe("https://example.invalid", false).status, 1);
});

for (const tool of [
  "mcp__github__merge_pull_request",
  "mcp__codex_apps__github_merge_pull_request",
  "mcp__codex_apps__github_enable_auto_merge",
  "mcp__codex_apps__github_delete_file",
  "mcp__codex_apps__github_update_ref",
  "mcp__codex_apps__github_create_commit",
  "mcp__codex_apps__github_create_tree",
  "mcp__codex_apps__github_create_blob",
]) {
  test(`blocks inert protected-tool payload: ${tool}`, () => {
    const result = spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ tool_name: tool, tool_input: {} }),
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
  });
}

test("allows read-only connector payload", () => {
  const result = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({
      tool_name: "mcp__codex_apps__github_fetch_file",
      tool_input: {},
    }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
});
