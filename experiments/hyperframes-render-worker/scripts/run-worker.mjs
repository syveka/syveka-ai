/**
 * Starts one render job in the worker container. This is the only supported way to run the
 * image: the isolation flags live here, and the unit tests pin them.
 *
 * Usage: RENDER_JOBS_ROOT=<dir> node scripts/run-worker.mjs <job.json> <inputDir> <outputDir>
 * <inputDir> must be inside RENDER_JOBS_ROOT.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expectedOutputNames, WorkerOutputReader } from "./read-output.mjs";

export const IMAGE = "syveka-hyperframes-render-worker:dev";
export const CONTAINER_LABEL = "syveka.render-worker=1";
/** Far above a full job's measured 5 minutes, and far below its worst case of an hour and a half. */
export const JOB_DEADLINE_MS = 30 * 60 * 1000;
const FORCE_STOP_MS = 30 * 1000;

/** Where credentials commonly live. A second layer, behind the required jobs root. */
const CREDENTIAL_FOLDER =
  /[\\/](\.(claude|codex|grok|ssh|aws|config|gnupg|docker|kube|azure)|appdata)([\\/]|$)/i;

/** @param {string} path */
function comparable(path) {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
}

/**
 * @param {string} parent
 * @param {string} child
 */
function isInside(parent, child) {
  const fromParent = relative(comparable(parent), comparable(child));
  return !fromParent.startsWith("..") && !isAbsolute(fromParent);
}

/**
 * The input mount must be inside one fixed jobs directory, which fails closed if not configured.
 * It returns the resolved path, and that is what gets mounted, so a link swapped in after this
 * check can't change the mount. Network paths are refused.
 * @param {string} path
 * @param {{ jobsRoot?: string, home?: string }} [options]
 */
export function resolveMountPath(path, { jobsRoot, home = homedir() } = {}) {
  if (!jobsRoot || !isAbsolute(jobsRoot)) throw new Error("unsafe_mount_path");
  if (!isAbsolute(path) || /[,"'\n\r]/.test(path) || /^[\\/]{2}/.test(path)) {
    throw new Error("unsafe_mount_path");
  }
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // Not there yet: docker will report that itself, and the lexical checks still apply.
  }
  if (/[,"'\n\r]/.test(real) || /^[\\/]{2}/.test(real)) throw new Error("unsafe_mount_path");
  let realRoot = jobsRoot;
  try {
    realRoot = realpathSync(jobsRoot);
  } catch {
    // As above.
  }
  if (!isInside(realRoot, real)) throw new Error("unsafe_mount_path");
  // Only below the root: the operator chose the root itself, and it may sit under AppData.
  if (CREDENTIAL_FOLDER.test(`/${relative(realRoot, real)}`)) throw new Error("unsafe_mount_path");
  // The home directory itself, or anything above it, would expose every credential in it.
  if (isInside(real, home)) throw new Error("unsafe_mount_path");
  return real;
}

/**
 * @param {{ inputDir: string, jobsRoot?: string, name?: string, cpus?: string, memory?: string }} options
 * @returns {string[]}
 */
export function buildDockerArgs({
  inputDir,
  jobsRoot = process.env.RENDER_JOBS_ROOT,
  name,
  cpus = "4",
  memory = "3g",
}) {
  const source = resolveMountPath(inputDir, { jobsRoot });
  return [
    "run",
    "--rm",
    "--interactive",
    "--pull=never",
    `--label=${CONTAINER_LABEL}`,
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
    // 1, not 0: WSL pipes crash dumps to the host and ignores a limit of 0. The kernel skips piped
    // dumps at exactly 1. This stops accidental crashes only: code running inside can lower its
    // own soft limit, so a host that pipes dumps needs its own policy (see the architecture doc).
    "--ulimit=core=1",
    // The only mount, read-only. Nothing in the container can write to the host: results come
    // back over stdout. Never a home directory, so no agent credentials exist inside.
    `--mount=type=bind,source=${source},target=/input,readonly`,
    IMAGE,
  ];
}

/**
 * Runs a job and resolves with its verified result. The deadline is enforced from outside the
 * container, so it holds even if everything inside has stopped cooperating. Containers carry a
 * label, so one that outlives this process can be found and removed.
 * @param {{ job: Buffer, inputDir: string, outputDir: string, jobsRoot?: string, memory?: string, deadlineMs?: number, forceStopMs?: number, spawnProcess?: typeof spawn }} options
 */
export function runWorker({
  job,
  inputDir,
  outputDir,
  jobsRoot,
  memory,
  deadlineMs = JOB_DEADLINE_MS,
  forceStopMs = FORCE_STOP_MS,
  spawnProcess = spawn,
}) {
  mkdirSync(outputDir, { recursive: true });
  const name = `syveka-render-${randomBytes(6).toString("hex")}`;
  const args = buildDockerArgs({ inputDir, jobsRoot, name, memory });
  let expectedNames = null;
  try {
    expectedNames = expectedOutputNames(JSON.parse(job.toString("utf8")));
  } catch {
    // The worker rejects it and reports why, and the reader lets nothing succeed.
  }
  const reader = new WorkerOutputReader(outputDir, expectedNames);

  return new Promise((done) => {
    let finished = false;
    /** @type {NodeJS.Timeout | undefined} */
    let deadline;
    /** @type {NodeJS.Timeout | undefined} */
    let forceStop;
    /** @param {{ ok: boolean, error?: { code: string } } & Record<string, unknown>} outcome */
    const finish = (outcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(forceStop);
      if (!outcome.ok && outcome.error) reader.abort();
      done(outcome);
    };

    // A kill can fail, so a later caller may try again unless one already succeeded or is running.
    let killState = /** @type {"none" | "running" | "done"} */ ("none");
    const killContainer = () => {
      if (killState !== "none") return;
      killState = "running";
      const kill = spawnProcess("docker", ["kill", name], { stdio: "ignore" });
      kill.on("error", () => {
        killState = "none";
      });
      kill.on("close", (code) => {
        killState = code === 0 ? "done" : "none";
      });
    };

    let child;
    try {
      // Job content travels on stdin, so it never appears in a process list. stderr is dropped.
      child = spawnProcess("docker", args, { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      finish({ ok: false, error: { code: "docker_unavailable" } });
      return;
    }

    let timedOut = false;
    deadline = setTimeout(() => {
      timedOut = true;
      killContainer();
      // If the kill or the daemon is stuck, the caller is still told, within a bounded time, and
      // told that a container may still be there.
      forceStop = setTimeout(() => {
        killContainer();
        child.kill("SIGKILL");
        finish({ ok: false, error: { code: "container_may_be_running" } });
      }, forceStopMs);
    }, deadlineMs);

    child.on("error", () => finish({ ok: false, error: { code: "docker_unavailable" } }));
    child.stdout?.on("data", (chunk) => {
      reader.push(chunk);
      // A stream that broke the rules gets no more chances to write.
      if (reader.failure) killContainer();
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(job);
    child.on("close", () => {
      finish(timedOut ? { ok: false, error: { code: "job_deadline_exceeded" } } : reader.finish());
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [jobPath, inputDir, outputDir] = process.argv.slice(2);
  if (!jobPath || !inputDir || !outputDir) {
    process.stderr.write(
      "usage: RENDER_JOBS_ROOT=<dir> run-worker.mjs <job.json> <inputDir> <outputDir>\n",
    );
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
