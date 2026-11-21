import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { WorkerError } from "./errors.mjs";

const CLI = "/app/node_modules/hyperframes/bin/hyperframes.mjs";
const WORKER_UID = 10001;

/**
 * The only commands the worker can run. The child gets a fixed argument list, no shell and a
 * minimal environment: no job text reaches argv, and nothing the container was started with
 * is inherited.
 */
const COMMANDS = {
  check: (/** @type {string} */ projectDir) => ["check", projectDir, "--json"],
  render: (
    /** @type {string} */ projectDir,
    /** @type {string} */ outputPath,
    /** @type {number} */ fps,
  ) => [
    "render",
    projectDir,
    "--output",
    outputPath,
    "--fps",
    String(fps),
    "--format",
    "mp4",
    "--workers",
    "3",
    "--quiet",
  ],
};

/**
 * Telemetry and update variables are a second layer; `--network none` and the deleted CLI
 * modules are what actually stop those paths.
 * @param {string} home A per-job directory, since the CLI writes state under HOME.
 */
export function childEnvironment(home) {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    TMPDIR: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: home,
    NODE_ENV: "production",
    HYPERFRAMES_NO_TELEMETRY: "1",
    DO_NOT_TRACK: "1",
    HYPERFRAMES_SKIP_SKILLS: "1",
    HYPERFRAMES_BROWSER_PATH: "/usr/local/bin/chrome-headless-shell",
    PRODUCER_HEADLESS_SHELL_PATH: "/usr/local/bin/chrome-headless-shell",
    CONTAINER: "true",
    LANG: "C.UTF-8",
  };
}

/** A sweep of every process is only safe where this worker is the only thing running. */
function isInsideWorkerContainer() {
  return process.getuid?.() === WORKER_UID && process.ppid <= 1;
}

/**
 * Kills everything in the container except its init process and this worker, until nothing is
 * left. The renderer starts Chrome in a session of its own, so killing its process group misses
 * it, and each render would leave about 80 threads behind until a later render ran out. A
 * container runs one job, one command at a time, so anything else still here is a leftover.
 */
export function killLeftoverProcesses() {
  if (!isInsideWorkerContainer()) return;
  for (let pass = 0; pass < 5; pass++) {
    let found = false;
    for (const entry of readdirSync("/proc")) {
      const pid = Number(entry);
      if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
      try {
        process.kill(pid, "SIGKILL");
        found = true;
      } catch {
        // Already gone.
      }
    }
    if (!found) return;
  }
}

/**
 * @param {"check" | "render"} command
 * @param {any[]} args
 * @param {{ home: string, timeoutMs: number }} options
 * @returns {Promise<{ code: number | null, stdout: string }>}
 */
export function runHyperframes(command, args, { home, timeoutMs }) {
  const build = COMMANDS[command];
  if (!build) throw new WorkerError("internal_error");
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI, .../** @type {(...a: any[]) => string[]} */ (build)(...args)],
      { env: childEnvironment(home), cwd: home, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 2_000_000) stdout += chunk;
    });
    // Drained, not kept: renderer stderr can carry paths and job text, and is never surfaced.
    child.stderr.resume();
    // Rejects on its own timer: a stray process holding the pipe open would stop `close` firing.
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      killLeftoverProcesses();
      reject(new WorkerError("render_timeout"));
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      settled = true;
      reject(new WorkerError("render_failed"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // Once settled, the next command may already be running, and this sweep would kill it.
      if (settled) return;
      settled = true;
      killLeftoverProcesses();
      resolve({ code, stdout });
    });
  });
}
