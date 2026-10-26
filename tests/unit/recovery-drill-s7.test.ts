import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * s7-verify-disposable.sh applies the one pending migration to the disposable
 * drill project with the real `prisma migrate deploy` and then runs the
 * reviewed verification (release invariants, the unchanged run-rls-check.sh,
 * tenant integrity). These tests run it against fake `docker` and `npx`
 * executables on PATH with fake credentials: nothing connects to a database
 * and no container starts. The fakes log every argument vector and which
 * credential variables they received, so the tests can prove that the
 * password never appears in an argument, a log or the evidence.
 */
const repo = path.join(__dirname, "../..");
const script = path.join(repo, "scripts/recovery-drill/s7-verify-disposable.sh");
const migrationsDir = path.join(repo, "prisma/migrations");
const pendingMigration = "20261014000000_secure_prisma_migrations_table";

const bash = spawnSync("bash", ["-c", "echo $BASH_VERSION"], { encoding: "utf8" });
const hasBash = bash.status === 0 && /^\d/.test(bash.stdout.trim());
const hasTools =
  hasBash &&
  spawnSync("bash", ["-c", "command -v openssl && command -v perl && command -v sha256sum"], {
    encoding: "utf8",
  }).status === 0;

const HOST = "aws-0-eu-west-1.pooler.supabase.com";
const DISPOSABLE = "aaaaaaaaaaaaaaaaaaaa";
const PRODUCTION = "bbbbbbbbbbbbbbbbbbbb";
const STAGING = "cccccccccccccccccccc";
const PASSWORD = "fake-P@ss:w/rd%9";
const PASSWORD_ENCODED = encodeURIComponent(PASSWORD);

const applied31 = fs
  .readdirSync(migrationsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== pendingMigration)
  .map((d) => d.name)
  .sort();

const FAKE_DOCKER = String.raw`#!/usr/bin/env bash
# Fake docker: logs argv and received credential variable names; answers psql.
printf 'ARGV %s\n' "$*" >> "$FAKE_DIR/docker.log"
case "$1" in
  version|rm) exit 0 ;;
  image) exit 0 ;;
  run) echo fake-container-id; exit 0 ;;
  exec) ;;
  *) exit 0 ;;
esac
shift
names=''
while [ $# -gt 0 ]; do
  case "$1" in
    -i) shift ;;
    -e) names="$names $2"; shift 2 ;;
    *) break ;;
  esac
done
printf 'ENV%s pgpassword_set=%s\n' "$names" "$([ -n "${"$"}{PGPASSWORD:-}" ] && echo yes || echo no)" >> "$FAKE_DIR/docker.log"
shift  # container
[ "$1" = psql ] || exit 0
shift
sql=''; stdin=0
while [ $# -gt 0 ]; do
  case "$1" in
    -c|-Atqc) sql=$2; shift 2 ;;
    -f) [ "$2" = - ] && stdin=1; shift 2 ;;
    *) shift ;;
  esac
done
input=''
[ "$stdin" = 1 ] && input=$(cat)
state=$(cat "$FAKE_DIR/state")
case "$sql" in
  *"current_setting('server_version')"*) echo "$FAKE_VERSION|postgres|1|62|5"; exit 0 ;;
  *"select migration_name from public._prisma_migrations"*)
    cat "$FAKE_DIR/applied31"; [ "$state" = applied ] && echo "${pendingMigration}"; exit 0 ;;
  *"where finished_at is null or rolled_back_at is not null"*)
    [ "$state" = failed ] && echo 1 || echo 0; exit 0 ;;
  *"select 1"*) echo 1; exit 0 ;;
  *"count(*)"*) echo 0; exit 0 ;;
esac
case "$input" in
  *"with carried as"*)
    cat "$FAKE_DIR/rows"
    [ "$state" = applied ] && echo "rows|public._prisma_migrations|32" || echo "rows|public._prisma_migrations|31"
    exit 0 ;;
  *"ALL STAGING RELEASE INVARIANTS PASSED"*)
    echo "NOTICE:  ALL STAGING RELEASE INVARIANTS PASSED" >&2; exit "$FAKE_INVARIANTS_RC" ;;
  *"ASSERTIONS PASSED"*) echo "NOTICE:  ALL FAKE ASSERTIONS PASSED" >&2; exit 0 ;;
esac
exit 0
`;

const FAKE_NPX = String.raw`#!/usr/bin/env bash
# Fake npx: logs argv and whether the URLs arrived through the environment.
printf 'ARGV %s\n' "$*" >> "$FAKE_DIR/npx.log"
printf 'ENV database_url_set=%s direct_url_set=%s url_has_encoded_password=%s\n' \
  "$([ -n "${"$"}{DATABASE_URL:-}" ] && echo yes || echo no)" \
  "$([ -n "${"$"}{DIRECT_URL:-}" ] && echo yes || echo no)" \
  "$(case "${"$"}{DATABASE_URL:-}" in *"$FAKE_PW_ENCODED"*) echo yes ;; *) echo no ;; esac)" >> "$FAKE_DIR/npx.log"
case "$*" in
  *"migrate deploy"*)
    if [ "$FAKE_MIGRATE_RC" != 0 ]; then
      echo "Error: P1001 cannot reach $DATABASE_URL (password $FAKE_PW)"; exit "$FAKE_MIGRATE_RC"
    fi
    echo applied > "$FAKE_DIR/state"
    echo "Datasource db: PostgreSQL database postgres at $PGHOST:5432"
    echo "All migrations have been successfully applied."; exit 0 ;;
  *"migrate status"*)
    if [ "$(cat "$FAKE_DIR/state")" = applied ]; then echo "Database schema is up to date!"; exit 0; fi
    echo "Following migration have not yet been applied"; exit 1 ;;
esac
exit 0
`;

type Scenario = {
  state?: "pending" | "applied" | "failed";
  user?: string;
  expectedRef?: string;
  migratePhrase?: string;
  migrateRc?: number;
  invariantsRc?: number;
  s6Result?: string;
  version?: string;
};

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

function run(s: Scenario = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "s7-test-"));
  temps.push(root);
  const fake = path.join(root, "fake");
  const restore = path.join(root, "restore-remote-20261026T000000Z");
  fs.mkdirSync(fake);
  fs.mkdirSync(restore);
  fs.writeFileSync(path.join(fake, "docker"), FAKE_DOCKER, { mode: 0o755 });
  fs.writeFileSync(path.join(fake, "npx"), FAKE_NPX, { mode: 0o755 });
  fs.writeFileSync(path.join(fake, "state"), (s.state ?? "pending") + "\n");
  fs.writeFileSync(path.join(fake, "applied31"), applied31.join("\n") + "\n");
  const rows = "rows|auth.users|5\nrows|public.organizations|3\n";
  fs.writeFileSync(path.join(fake, "rows"), rows);
  fs.writeFileSync(
    path.join(restore, "evidence-20261026T000000Z.txt"),
    `s6_ts=20261026T000000Z mode=remote include_storage_metadata=1\n${s.s6Result ?? "S6_RESULT=PASS out=x"}\n`,
  );
  fs.writeFileSync(
    path.join(restore, "rowcounts-destination.txt"),
    rows + "rows|public._prisma_migrations|31\n",
  );

  const answers = [
    HOST,
    s.expectedRef ?? DISPOSABLE,
    PRODUCTION,
    STAGING,
    s.user ?? `postgres.${DISPOSABLE}`,
    PASSWORD,
    "VERIFY DISPOSABLE",
    s.migratePhrase ?? "APPLY MIGRATION TO DISPOSABLE",
  ].join("\n");
  const result = spawnSync("bash", [script, restore], {
    input: answers + "\n",
    encoding: "utf8",
    timeout: 240_000,
    env: {
      ...process.env,
      PATH: `${fake}${path.delimiter}${process.env.PATH}`,
      FAKE_DIR: fake.replace(/\\/g, "/"),
      FAKE_VERSION: s.version ?? "17.11.0.003",
      FAKE_MIGRATE_RC: String(s.migrateRc ?? 0),
      FAKE_INVARIANTS_RC: String(s.invariantsRc ?? 0),
      FAKE_PW: PASSWORD,
      FAKE_PW_ENCODED: PASSWORD_ENCODED,
      PGPASSWORD: "",
    },
  });
  const readIf = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "");
  const verifyDir = fs.readdirSync(restore).find((n) => n.startsWith("verify-"));
  const kept = verifyDir
    ? fs
        .readdirSync(path.join(restore, verifyDir))
        .filter((n) => !n.startsWith(".shim"))
        .map((n) => readIf(path.join(restore, verifyDir, n)))
        .join("\n")
    : "";
  return {
    status: result.status,
    out: (result.stdout ?? "") + (result.stderr ?? ""),
    dockerLog: readIf(path.join(fake, "docker.log")),
    npxLog: readIf(path.join(fake, "npx.log")),
    kept,
  };
}

const secrets = [PASSWORD, PASSWORD_ENCODED];

describe.runIf(hasTools)("s7-verify-disposable.sh (fake docker and npx, no database)", () => {
  it("refuses a production or staging target before any container or connection", () => {
    for (const s of [
      { user: `postgres.${PRODUCTION}` },
      { user: `postgres.${STAGING}` },
      { expectedRef: PRODUCTION, user: `postgres.${PRODUCTION}` },
    ]) {
      const r = run(s);
      expect(r.status).toBe(2);
      expect(r.out).toContain("STOP: target identity rejected");
      expect(r.dockerLog).not.toMatch(/^ARGV (run|exec)/m);
      expect(r.npxLog).toBe("");
    }
  }, 240_000);

  it("refuses an s6 restore that did not pass, before asking anything", () => {
    const r = run({ s6Result: "S6_RESULT=STOP stage=verify-rowcounts reason: x" });
    expect(r.status).toBe(2);
    expect(r.out).toContain("does not record S6_RESULT=PASS");
    expect(r.dockerLog).not.toMatch(/^ARGV (run|exec)/m);
  }, 240_000);

  it("applies the pending migration with the real prisma migrate deploy, then verifies, without leaking credentials", () => {
    const r = run();
    expect(r.out).toContain("S7_RESULT=PASS");
    expect(r.status).toBe(0);
    expect(r.npxLog).toMatch(/^ARGV --no-install prisma migrate deploy$/m);
    expect(r.npxLog).toMatch(/^ARGV --no-install prisma migrate status$/m);
    expect(r.npxLog).toContain(
      "database_url_set=yes direct_url_set=yes url_has_encoded_password=yes",
    );
    expect(r.dockerLog).toContain("pgpassword_set=yes");
    for (const suite of ["iso", "cal", "dna"]) expect(r.out).toContain(`rls_${suite}=PASS`);
    for (const secret of secrets) {
      expect(r.dockerLog).not.toContain(secret);
      expect(
        r.npxLog
          .split("\n")
          .filter((l) => l.startsWith("ARGV"))
          .join("\n"),
      ).not.toContain(secret);
      expect(r.kept).not.toContain(secret);
      expect(r.out).not.toContain(secret);
    }
    expect(r.kept).not.toContain(HOST);
    expect(r.kept).not.toContain(`postgres.${DISPOSABLE}`);
    expect(r.kept).not.toContain("::add-mask::");
  }, 240_000);

  it("does not run migrate deploy without the run-time migration phrase, and reports data remains", () => {
    const r = run({ migratePhrase: "no" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("migration not authorized at run time");
    expect(r.out).toContain(
      "DATA REMAINS — OWNER CLEANUP REQUIRED (failed stage: migration-state)",
    );
    expect(r.npxLog).not.toContain("migrate deploy");
  }, 240_000);

  it("on a repeat run skips migrate deploy and still verifies", () => {
    const r = run({ state: "applied" });
    expect(r.out).toContain("migrate_deploy=SKIPPED");
    expect(r.out).toContain("S7_RESULT=PASS");
    expect(r.status).toBe(0);
    expect(r.npxLog).not.toContain("migrate deploy");
  }, 240_000);

  it("stops on a previously failed migration without retrying or resolving it", () => {
    const r = run({ state: "failed" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("failed or rolled-back migration");
    expect(r.npxLog).toBe("");
  }, 240_000);

  it("reports a failed migrate deploy as DATA REMAINS and redacts the password from its output", () => {
    const r = run({ migrateRc: 1 });
    expect(r.status).toBe(1);
    expect(r.out).toContain("S7_RESULT=STOP stage=migrate-deploy");
    expect(r.out).toContain("DATA REMAINS — OWNER CLEANUP REQUIRED (failed stage: migrate-deploy)");
    expect(r.kept).toContain("[redacted]");
    for (const secret of secrets) {
      expect(r.kept).not.toContain(secret);
      expect(r.out).not.toContain(secret);
    }
  }, 240_000);

  it("stops after the migration when the release invariants fail", () => {
    const r = run({ invariantsRc: 3 });
    expect(r.status).toBe(1);
    expect(r.out).toContain(
      "DATA REMAINS — OWNER CLEANUP REQUIRED (failed stage: verify-invariants)",
    );
  }, 240_000);

  it("refuses a destination that is not the 17.11 disposable server, with nothing written", () => {
    const r = run({ version: "17.6.1.155" });
    expect(r.status).toBe(1);
    expect(r.out).toContain("is not 17.11.x");
    expect(r.npxLog).toBe("");
  }, 240_000);
});

describe("s7-verify-disposable.sh design", () => {
  const text = fs.readFileSync(script, "utf8");

  it("passes the database URL only through child environments, never as an argument", () => {
    for (const line of text.split("\n").filter((l) => l.includes("S7_DB_URL"))) {
      expect(line).toMatch(
        /S7_DB_URL=\$\(build_url|DATABASE_URL="\$S7_DB_URL" DIRECT_URL="\$S7_DB_URL" npx|unset /,
      );
    }
    expect(text).not.toMatch(/env DATABASE_URL|--url|db execute/);
  });

  it("uses the real prisma migrate deploy and never writes _prisma_migrations itself", () => {
    expect(text).toContain("npx --no-install prisma migrate deploy");
    expect(text).not.toMatch(
      /insert into public\._prisma_migrations|migrate resolve|migration\.sql/i,
    );
  });

  it("reuses the unchanged RLS runner with the staging-release.yml arguments", () => {
    const workflow = fs.readFileSync(
      path.join(repo, ".github/workflows/staging-release.yml"),
      "utf8",
    );
    for (const prefix of ["iso", "cal", "dna"]) {
      const args = workflow.match(new RegExp(`run-rls-check\\.sh ${prefix} ([^\\n]+)`))![1]!.trim();
      expect(text).toContain(`run_rls ${prefix} ${args}`);
    }
  });

  it("starts one client container, without mounts, ports or credentials", () => {
    const runs = text.split("\n").filter((l) => /^\s*docker run /.test(l));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain('"$CLIENT_IMG" sleep infinity');
    expect(runs[0]).not.toMatch(/\s(-p|--publish|-v|--volume|--mount|-e)\s/);
  });
});
