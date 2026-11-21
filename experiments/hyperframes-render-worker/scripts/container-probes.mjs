/**
 * Runs inside the worker image under the real isolation flags and tries to break out of them.
 * Prints one JSON line per probe. Started by scripts/run-probes.mjs; never part of a render.
 */
import { spawn, spawnSync } from "node:child_process";
import dns from "node:dns/promises";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { runHyperframes } from "/app/src/hyperframes.mjs";
import { normalizeMedia } from "/app/src/media.mjs";
import { writeProject } from "/app/src/project.mjs";

let failures = 0;

const PROBE_SPEC = {
  template: "product-ad",
  language: "en",
  aspectRatio: "9:16",
  brand: "Probe",
  headline: "Probe",
  callToAction: "Probe",
  colors: { background: "#000000", text: "#ffffff", accent: "#ffffff", accentText: "#000000" },
};

const processNames = () =>
  readdirSync("/proc")
    .filter((entry) => /^\d+$/.test(entry))
    .map((pid) => {
      try {
        return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      } catch {
        return "";
      }
    });

/**
 * @param {string} name
 * @param {boolean} passed
 * @param {string} [detail]
 */
function report(name, passed, detail = "") {
  if (!passed) failures++;
  process.stdout.write(`${JSON.stringify({ probe: name, passed, detail })}\n`);
}

/** @param {() => Promise<unknown>} action */
async function refused(action) {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
}

/** @param {string} host @param {number} port */
function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 3000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

// Network: enforced by --network=none, whatever the code inside tries.
report(
  "https request fails",
  await refused(() => fetch("https://example.com", { signal: AbortSignal.timeout(5000) })),
);
report("dns lookup fails", await refused(() => dns.lookup("example.com")));
report("telemetry host unreachable", await refused(() => dns.lookup("us.i.posthog.com")));
report("direct ip connection fails", !(await canConnect("1.1.1.1", 443)));
report("docker host unreachable", !(await canConnect("host.docker.internal", 2375)));
const interfaces = readFileSync("/proc/net/dev", "utf8")
  .split("\n")
  .slice(2)
  .map((line) => line.split(":")[0]?.trim())
  .filter(Boolean);
report("only the loopback interface exists", interfaces.join() === "lo", interfaces.join());

// Identity and privileges.
report("runs as uid 10001", process.getuid?.() === 10001);
const capabilities = readFileSync("/proc/self/status", "utf8").match(/CapEff:\s*([0-9a-f]+)/)?.[1];
report("holds no capabilities", Number.parseInt(capabilities ?? "1", 16) === 0, capabilities);
const noNewPrivs = readFileSync("/proc/self/status", "utf8").match(/NoNewPrivs:\s*(\d)/)?.[1];
report("no-new-privileges is set", noNewPrivs === "1");

// Filesystem.
report("no output directory is mounted", !existsSync("/output"));
for (const path of ["/app/src/main.mjs", "/etc/passwd", "/usr/local/bin/x", "/input/x"]) {
  report(`can't write ${path}`, await refused(async () => writeFileSync(path, "x")));
}
const tmpExec = spawnSync("sh", ["-c", "cp /bin/true /tmp/t && /tmp/t"]);
report("/tmp refuses execution", tmpExec.status !== 0);

// Credentials and secrets.
report("this user has no home directory", !existsSync("/home/renderer"));
const envNames = Object.keys(process.env);
const secretLike = envNames.filter((name) => /key|token|secret|password|credential/i.test(name));
report("no secret-like environment variables", secretLike.length === 0, secretLike.join());
report("docker socket absent", !existsSync("/var/run/docker.sock"));

// Removed tools and CLI commands.
for (const tool of ["curl", "wget", "npm", "npx", "corepack"]) {
  const found = spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
  report(`${tool} is absent`, !found);
}
const CLI = "/app/node_modules/hyperframes/bin/hyperframes.mjs";
for (const command of [
  "usage",
  "auth",
  "login",
  "publish",
  "cloud",
  "lambda",
  "billing",
  "upgrade",
  "init",
]) {
  const run = spawnSync(process.execPath, [CLI, command], { encoding: "utf8", timeout: 30000 });
  const stderr = run.stderr ?? "";
  // Exit status alone isn't enough: the module must be gone, not just unhappy with its input.
  const removed = /Cannot find module|Unknown command/i.test(`${stderr}${run.stdout}`);
  report(`hyperframes ${command} is unavailable`, removed, stderr.split("\n")[0]?.slice(0, 80));
}
// By content, not by name: HyperFrames' own `gsapParser` chunks only read scripts that use GSAP.
const vendored = spawnSync(
  "sh",
  [
    "-c",
    "grep -rlE 'Copyright 2008-[0-9]+, GreenSock|GSAP [0-9]+[.][0-9]+[.][0-9]+' /app | head -5",
  ],
  { encoding: "utf8" },
);
report(
  "no copy of GSAP in the image",
  vendored.status === 0 && vendored.stdout.trim() === "",
  vendored.stdout.trim(),
);

// Malicious media, against the real validator and the real ffmpeg.
const dir = "/tmp/media";
const scratchDir = "/tmp/media-scratch";
mkdirSync(dir);
mkdirSync(scratchDir);
const ffmpeg = (/** @type {string[]} */ ...args) =>
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: dir });
ffmpeg("-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", "good.png");
ffmpeg("-f", "lavfi", "-i", "color=c=red:s=64x64:r=30:d=1", "-c:v", "libx264", "good.mp4");
ffmpeg("-f", "lavfi", "-i", "color=c=red:s=5000x100", "-frames:v", "1", "huge-dims.png");
ffmpeg("-f", "lavfi", "-i", "color=c=red:s=16x16:r=5:d=70", "-c:v", "libx264", "too-long.mp4");
const good = readFileSync(join(dir, "good.png"));
writeFileSync(join(dir, "svg-as.png"), '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
writeFileSync(join(dir, "html-as.png"), "<!doctype html><script>fetch('//x')</script>");
writeFileSync(join(dir, "hls-as.mp4"), "#EXTM3U\n#EXTINF:1,\nhttp://example.com/a.ts\n");
writeFileSync(join(dir, "empty.png"), "");
writeFileSync(join(dir, "truncated.png"), good.subarray(0, 40));
writeFileSync(
  join(dir, "fake-header.png"),
  Buffer.concat([good.subarray(0, 12), Buffer.alloc(99)]),
);
writeFileSync(join(dir, "fake-ftyp.mp4"), Buffer.from("0000ftypisom\u0000\u0000garbage garbage"));
symlinkSync("/etc/passwd", join(dir, "link.png"));

for (const [file, kind] of /** @type {const} */ ([
  ["svg-as.png", "image"],
  ["html-as.png", "image"],
  ["hls-as.mp4", "video"],
  ["empty.png", "image"],
  ["truncated.png", "image"],
  ["fake-header.png", "image"],
  ["fake-ftyp.mp4", "video"],
  ["link.png", "image"],
  ["huge-dims.png", "image"],
  ["too-long.mp4", "video"],
  ["good.mp4", "image"],
  ["good.png", "video"],
  ["missing.png", "image"],
])) {
  const outcome = await normalizeMedia({
    inputDir: dir,
    file,
    kind,
    outputPath: join(dir, `out-${file}.png`),
    scratchDir,
  }).then(
    () => "accepted",
    (error) => error.code,
  );
  report(`rejects ${file} as ${kind}`, outcome !== "accepted", outcome);
}

// A polyglot: valid image bytes with a page appended. It may be accepted, but the output must
// be a clean re-encode that no longer contains the payload.
writeFileSync(
  join(dir, "polyglot.png"),
  Buffer.concat([good, Buffer.from("<script>alert('payload')</script>")]),
);
const polyglotOut = join(dir, "polyglot-out.png");
await normalizeMedia({
  inputDir: dir,
  file: "polyglot.png",
  kind: "image",
  outputPath: polyglotOut,
  scratchDir,
});
report(
  "re-encoding strips a polyglot's payload",
  !readFileSync(polyglotOut).toString("latin1").includes("payload"),
);
// The clean inputs still work, so the rejections above aren't a broken validator.
const cleanOut = join(dir, "clean-out.mp4");
await normalizeMedia({
  inputDir: dir,
  file: "good.mp4",
  kind: "video",
  outputPath: cleanOut,
  scratchDir,
});
report("accepts a clean video", readFileSync(cleanOut).length > 0);
// A one-second clip is held to the composition's length, and an odd size is made even.
ffmpeg(
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=65x65:r=30:d=1",
  "-c:v",
  "libx264",
  "-pix_fmt",
  "yuv444p",
  "short-odd.mp4",
);
const heldOut = join(dir, "held-out.mp4");
await normalizeMedia({
  inputDir: dir,
  file: "short-odd.mp4",
  kind: "video",
  outputPath: heldOut,
  scratchDir,
});
const held = spawnSync(
  "ffprobe",
  [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height,nb_frames",
    "-of",
    "csv=p=0",
    heldOut,
  ],
  { encoding: "utf8" },
);
report(
  "a short clip is held to 10 seconds, at even dimensions",
  held.stdout.trim() === "64,64,300",
  held.stdout.trim(),
);
// Opening must not block forever if the host swaps a file for a named pipe.
spawnSync("mkfifo", [join(dir, "fifo.png")]);
const fifoOutcome = await Promise.race([
  normalizeMedia({
    inputDir: dir,
    file: "fifo.png",
    kind: "image",
    outputPath: join(dir, "f.png"),
    scratchDir,
  }).then(
    () => "accepted",
    (error) => error.code,
  ),
  new Promise((resolve) => setTimeout(() => resolve("blocked"), 5000)),
]);
report(
  "a named pipe is refused without blocking",
  fifoOutcome === "invalid_media",
  String(fifoOutcome),
);

// A finished command leaves nothing running.
{
  const finishedHome = "/tmp/finished-home";
  mkdirSync(finishedHome);
  const project2 = "/tmp/finished-project";
  writeProject({ spec: PROBE_SPEC, projectDir: project2, hasLogo: false });
  await runHyperframes("check", [project2], { home: finishedHome, timeoutMs: 120_000 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  const left = processNames().filter((name) => /chrome|ffmpeg|hyperframes/.test(name));
  report("a finished command leaves no Chrome behind", left.length === 0, left.join() || "none");
  const zombies = readdirSync("/proc").filter((entry) => {
    if (!/^\d+$/.test(entry)) return false;
    try {
      return /^State:\s+Z/m.test(readFileSync(`/proc/${entry}/status`, "utf8"));
    } catch {
      return false;
    }
  });
  report(
    "killed processes are reaped, not left as zombies",
    zombies.length === 0,
    String(zombies.length),
  );
}

// A render past its deadline is killed, Chrome included.
const home = "/tmp/timeout-home";
const project = "/tmp/timeout-project";
mkdirSync(home);
writeProject({ spec: PROBE_SPEC, projectDir: project, hasLogo: false });

const renderProcesses = () =>
  processNames().filter((name) => /chrome|ffmpeg|hyperframes/.test(name));

let sawChrome = false;
const watcher = setInterval(() => {
  sawChrome ||= renderProcesses().some((name) => name.includes("chrome"));
}, 200);
const startedAt = performance.now();
const timeoutOutcome = await runHyperframes("render", [project, "/tmp/never.mp4", 30], {
  home,
  timeoutMs: 15_000,
}).then(
  () => "finished",
  (error) => error.code,
);
clearInterval(watcher);
await new Promise((resolve) => setTimeout(resolve, 1000));
const survivors = renderProcesses();
report(
  "a render past its deadline is killed, with Chrome",
  timeoutOutcome === "render_timeout" &&
    sawChrome &&
    survivors.length === 0 &&
    performance.now() - startedAt < 20_000,
  `${timeoutOutcome}, chrome seen: ${sawChrome}, survivors: ${survivors.join() || "none"}`,
);

// A crash must not reach the host's crash handler. RLIMIT_CORE of 1 is what stops a piped dump.
const coreLimit = readFileSync("/proc/self/limits", "utf8").match(
  /Max core file size\s+(\d+)/,
)?.[1];
report("crash dumps are disabled", coreLimit === "1", coreLimit);

// Process limit: spawning stops at --pids-limit instead of exhausting the host.
const pidsMax = readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim();
const children = [];
let spawned = 0;
let spawnRefused = false;
for (let i = 0; i < 700 && !spawnRefused; i++) {
  await new Promise((resolve) => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    child.once("spawn", () => {
      children.push(child);
      spawned++;
      resolve(undefined);
    });
    child.once("error", () => {
      spawnRefused = true;
      resolve(undefined);
    });
  });
}
for (const child of children) child.kill("SIGKILL");
report(
  "the kernel refuses processes past the limit",
  pidsMax === "512" && spawnRefused && spawned < 512,
  `pids.max ${pidsMax}, spawned ${spawned} before refusal`,
);

process.stdout.write(`${JSON.stringify({ summary: true, failures })}\n`);
process.exitCode = failures === 0 ? 0 : 1;
