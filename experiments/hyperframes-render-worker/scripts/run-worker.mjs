/**
 * Starts one render job in the worker container. This is the only supported way to run the
 * image: the isolation flags live here, and the unit tests pin them.
 *
 * Usage: node scripts/run-worker.mjs <job.json> <inputDir> <outputDir>
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkerOutputReader } from "./read-output.mjs";

export const IMAGE = "syveka-hyperframes-render-worker:dev";
/** Far above a full job's measured 5 minutes, and far below its worst case of an hour and a half. */
export const JOB_DEADLINE_MS = 30 * 60 * 1000;
const FORCE_STOP_MS = 30 * 1000;

/** Where credentials commonly live. A convenience check: production needs a fixed jobs root. */
const CREDENTIAL_FOLDER =
  /[\\/](\.(claude|codex|grok|ssh|aws|config|gnupg|docker|kube|azure)|appdata)([\\/]|$)/i;

/**
 * The input mount must be a specific directory: not a home directory or anything above one, not a
 * credentials folder, and nothing that could add `--mount` options. The path is resolved first, so
 * a link to the home directory counts as the home directory.
 * @param {string} path
 * @param {string} [home]
 */
export function assertSafeMountPath(path, home = homedir()) {
  if (!isAbsolute(path) || /[,"'\n\r]/.test(path)) throw new Error("unsafe_mount_path");
  if (path.startsWith("\\\\")) throw new Error("unsafe_mount_path");
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // Not there yet: docker will report that itself, and the lexical checks still apply.
  }
  for (const candidate of [path, real]) {
    if (CREDENTIAL_FOLDER.test(candidate)) throw new Error("unsafe_mount_path");
    const fromHome = relative(resolve(candidate).toLowerCase(), resolve(home).toLowerCase());
    // Empty: it is the home directory. No `..` prefix: the home directory is inside it.
    if (fromHome === "" || !(fromHome.startsWith("..") || isAbsolute(fromHome))) {
      throw new Error("unsafe_mount_path");
    }
  }
}

/**
 * @param {{ inputDir: string, name?: string, cpus?: string, memory?: string }} options
 * @returns {string[]}
 */
export function buildDockerArgs({ inputDir, name, cpus = "4", memory = "3g" }) {
  assertSafeMountPath(inputDir);
  return [
    "run",
    "--rm",
    "--interactive",
    ...(name ? [`--name=${name}`] : []),
    // A real PID 1: killed Chrome processes are reaped, not left as zombies that use up the
    // process limit and make a later render in the same job fail.
    "--init",
    // Output travels over stdout: Docker's default log driver would also store it on the host,
    // with no size limit, so a hostile stream could fill the disk through the logs.
    "--log-driver=none",
    // Enforced by the kernel: telemetry, CDN and font fetches have no route, whatever the CLI does.
    "--network=none",
    "--read-only",
    // Held in memory, so it shares the --memory limit below rather than adding to it.
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=3g",
    "--user=10001:10001",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--cpus=${cpus}`,
    `--memory=${memory}`,
    // Equal to --memory: no swap, so a runaway render is killed instead of thrashing the host.
    `--memory-swap=${memory}`,
    // Counts threads. A render peaks near 290, and Chrome aborts if it can't start one.
    "--pids-limit=512",
    "--shm-size=512m",
    "--ulimit=nofile=4096:4096",
    // 1, not 0. WSL pipes crash dumps to the host, which ignores a limit of 0 and wrote 500 MB
    // per Chrome crash to the user's temp folder until the disk filled. The kernel skips piped
    // dumps when the limit is exactly 1, and a file dump can't fit in one byte.
    "--ulimit=core=1",
    // The only mount, read-only. Nothing in the container can write to the host: results come
    // back over stdout. Never a home directory, so no agent credentials exist inside.
    `--mount=type=bind,source=${inputDir},target=/input,readonly`,
    IMAGE,
  ];
}

/**
 * Runs a job and resolves with its verified result. The deadline is enforced from outside the
 * container, so it holds even if everything inside has stopped cooperating.
 * @param {{ job: Buffer, inputDir: string, outputDir: string, memory?: string, deadlineMs?: number }} options
 */
export function runWorker({ job, inputDir, outputDir, memory, deadlineMs = JOB_DEADLINE_MS }) {
  mkdirSync(outputDir, { recursive: true });
  const name = `syveka-render-${randomBytes(6).toString("hex")}`;
  const args = buildDockerArgs({ inputDir, name, memory });
  let expectedRenders = null;
  try {
    expectedRenders = JSON.parse(job.toString("utf8")).renders?.length ?? null;
  } catch {
    // The worker rejects it and reports why.
  }
  // Job content travels on stdin, so it never appears in a process list. stderr is dropped.
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "ignore"] });
  const reader = new WorkerOutputReader(outputDir);
  return new Promise((done) => {
    let finished = false;
    let killed = false;
    /** @type {NodeJS.Timeout | undefined} */
    let forceStop;
    /** @param {{ ok: boolean, error?: { code: string } } & Record<string, unknown>} outcome */
    const finish = (outcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(forceStop);
      done(outcome);
    };
    const killContainer = () => {
      if (killed) return;
      killed = true;
      spawn("docker", ["kill", name], { stdio: "ignore" }).on("error", () => undefined);
    };
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      killContainer();
      // If the kill or the daemon is stuck, the caller is still told, within a bounded time.
      forceStop = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ ok: false, error: { code: "job_deadline_exceeded" } });
      }, FORCE_STOP_MS);
    }, deadlineMs);
    child.stdout.on("data", (chunk) => {
      reader.push(chunk);
      // A stream that broke the rules gets no more chances to write.
      if (reader.failure) killContainer();
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(job);
    child.on("error", () => finish({ ok: false, error: { code: "docker_unavailable" } }));
    child.on("close", () => {
      finish(
        timedOut
          ? { ok: false, error: { code: "job_deadline_exceeded" } }
          : reader.finish(expectedRenders),
      );
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [jobPath, inputDir, outputDir] = process.argv.slice(2);
  if (!jobPath || !inputDir || !outputDir) {
    process.stderr.write("usage: run-worker.mjs <job.json> <inputDir> <outputDir>\n");
    process.exit(2);
  }
  const result = await runWorker({
    job: readFileSync(jobPath),
    inputDir: resolve(inputDir),
    outputDir: resolve(outputDir),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
