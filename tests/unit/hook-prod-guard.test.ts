import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOOK_PATH = path.join(
  REPO_ROOT,
  ".claude",
  "skills",
  "syveka-context",
  "scripts",
  "prod-guard.mjs",
);

function runHook(payload: Record<string, unknown>) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ cwd: REPO_ROOT, ...payload }),
    encoding: "utf8",
  });
  return { status: result.status, stderr: result.stderr };
}

function bash(command: string) {
  return runHook({ tool_name: "Bash", tool_input: { command } });
}

describe("prod-guard skill hook", () => {
  it.each([
    "vercel --prod",
    "vercel deploy --prebuilt",
    "npx vercel@latest promote https://x.vercel.app",
    "vercel rollback dpl_123",
    "vercel alias set a.vercel.app syveka.com",
    "vercel env add OPENAI_API_KEY production",
    "vercel env rm FOO preview",
    "vercel env pull .env.local",
    "npx prisma migrate deploy",
    "prisma migrate reset --force",
    "npx prisma migrate resolve --applied 001",
    "npx prisma db push",
    "npm run db:migrate",
    "npm run db:seed",
    "supabase db push",
    "supabase secrets set FOO=bar",
    'psql "$DIRECT_URL" -c "DELETE FROM organization_members WHERE 1=1"',
    'psql "$DIRECT_URL" -c "update users set email = 1"',
    'psql "$DIRECT_URL" -f prisma/migrations/001/migration.sql',
    "git push --force origin feature",
    "git push -f origin feature",
    "git push origin +feature",
    "git push origin main",
    "git push origin --delete feature",
    "git reset --hard origin/main",
    "git clean -fdx",
    "git branch -D old",
    "gh pr merge 12 --squash",
    "gh workflow run deploy.yml",
    "gh secret set FOO",
    "gh api -X DELETE repos/syveka/syveka-ai/git/refs/heads/x",
    "curl -X POST https://api.vercel.com/v10/projects/x/env -d '{}'",
    "printenv",
    "env",
    'echo "$DATABASE_URL"',
    "echo $SUPABASE_SERVICE_ROLE_KEY",
    "printenv OPENAI_API_KEY",
    "cat .env",
    "cat .env.local",
    "ls && vercel --prod",
  ])("blocks %s", (command) => {
    const { status, stderr } = bash(command);
    expect(status).toBe(2);
    expect(stderr).toContain("prod-guard");
  });

  it.each([
    "git status",
    "git log -5 --oneline",
    "git diff origin/main...HEAD",
    "git push -u origin claude/feature-branch",
    "vercel ls",
    "vercel inspect https://syveka.com",
    "vercel logs https://x.vercel.app",
    "vercel alias ls",
    "vercel env ls",
    "npx prisma migrate status",
    "npx prisma validate",
    "npx prisma generate",
    "npm run migrations:check",
    'psql "$DIRECT_URL" -c "select count(*) from organizations"',
    'psql "$DIRECT_URL" -f prisma/sql/006_legacy_baseline_preflight.sql',
    'psql "$DIRECT_URL" -f tests/staging/release-invariants.sql',
    "curl -s https://syveka-ai-staging.vercel.app/api/health",
    'echo "${#DATABASE_URL}"',
    "echo $HOME",
    "cat .env.example",
    "gh pr view 12",
    "gh run list",
    `git commit -F - <<'EOF'\nfix: explain why vercel --prod and git push --force are blocked\nEOF`,
    "npm test",
  ])("allows %s", (command) => {
    expect(bash(command).status).toBe(0);
  });

  it("blocks merging and dispatching through the GitHub MCP tools", () => {
    for (const tool of [
      "mcp__github__merge_pull_request",
      "mcp__github__enable_pr_auto_merge",
      "mcp__github__actions_run_trigger",
    ]) {
      expect(runHook({ tool_name: tool, tool_input: {} }).status).toBe(2);
    }
  });

  it("allows read-only GitHub MCP tools", () => {
    expect(runHook({ tool_name: "mcp__github__pull_request_read", tool_input: {} }).status).toBe(0);
  });

  it("fails open on unparsable input", () => {
    const result = spawnSync(process.execPath, [HOOK_PATH], {
      input: "not json",
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
  });
});
