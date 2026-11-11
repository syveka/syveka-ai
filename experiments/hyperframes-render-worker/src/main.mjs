import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { COMPOSITION_SECONDS, FPS } from "./constants.mjs";
import { WorkerError, toErrorResult } from "./errors.mjs";
import { runHyperframes } from "./hyperframes.mjs";
import { normalizeMedia } from "./media.mjs";
import { writeProject } from "./project.mjs";
import { ASPECT_DIMENSIONS, parseJob } from "./schema.mjs";

const run = promisify(execFile);

const INPUT_DIR = "/input";
const WORK_ROOT = "/tmp";
const MAX_JOB_BYTES = 256 * 1024;
const CHECK_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 150_000;
/** A crashed Chrome is often transient, so a render gets one more attempt before failing. */
const RENDER_ATTEMPTS = 2;

/** @param {string} path @returns {Promise<string>} */
function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** Cgroup v2 counters, so usage is measured by the kernel rather than estimated. */
function readCgroupUsage() {
  const read = (/** @type {string} */ file) => {
    try {
      return readFileSync(`/sys/fs/cgroup/${file}`, "utf8");
    } catch {
      return null;
    }
  };
  const peak = read("memory.peak");
  const pidsPeak = read("pids.peak");
  const pidsCurrent = read("pids.current");
  const cpu = read("cpu.stat")?.match(/usage_usec (\d+)/)?.[1];
  return {
    memoryPeakBytes: peak ? Number(peak) : null,
    pidsPeak: pidsPeak ? Number(pidsPeak) : null,
    pidsCurrent: pidsCurrent ? Number(pidsCurrent) : null,
    cpuSeconds: cpu ? Number(cpu) / 1e6 : null,
  };
}

/**
 * The file must be what was asked for, whatever the renderer reported.
 * @param {string} path
 * @param {keyof typeof ASPECT_DIMENSIONS} aspectRatio
 */
async function verifyOutput(path, aspectRatio) {
  const { stdout } = await run(
    "ffprobe",
    [
      "-protocol_whitelist",
      "file",
      "-hide_banner",
      "-loglevel",
      "error",
      "-print_format",
      "json",
      "-select_streams",
      "v:0",
      "-show_entries",
      "format=duration:stream=codec_name,pix_fmt,width,height,avg_frame_rate,nb_frames",
      path,
    ],
    { timeout: 30_000, killSignal: "SIGKILL" },
  ).catch(() => {
    throw new WorkerError("output_invalid");
  });
  const { streams = [], format = {} } = JSON.parse(stdout);
  const video = streams[0];
  const expected = ASPECT_DIMENSIONS[aspectRatio];
  const frames = Number(video?.nb_frames);
  if (
    video?.codec_name !== "h264" ||
    video.pix_fmt !== "yuv420p" ||
    video.width !== expected.width ||
    video.height !== expected.height ||
    video.avg_frame_rate !== `${FPS}/1` ||
    frames !== COMPOSITION_SECONDS * FPS
  ) {
    throw new WorkerError("output_invalid");
  }
  return {
    codec: video.codec_name,
    pixelFormat: video.pix_fmt,
    width: video.width,
    height: video.height,
    fps: FPS,
    durationSeconds: Number(format.duration),
    frames,
  };
}

/**
 * Sends a finished file to the host: a header line, then exactly that many bytes. The host doesn't
 * trust this stream (see read-output.mjs), and no directory on the host is writable from here.
 * @param {string} name
 * @param {string} path
 */
async function sendFile(name, path) {
  process.stdout.write(`FILE ${name} ${statSync(path).size}\n`);
  await pipeline(createReadStream(path), process.stdout, { end: false });
}

/**
 * @param {any} spec
 * @param {string} outputName
 */
async function renderOne(spec, outputName) {
  const workDir = mkdtempSync(join(WORK_ROOT, "render-"));
  const startedAt = performance.now();
  try {
    const projectDir = join(workDir, "project");
    const scratchDir = join(workDir, "scratch");
    mkdirSync(join(projectDir, "assets"), { recursive: true });
    mkdirSync(scratchDir);
    if (spec.logo) {
      await normalizeMedia({
        inputDir: INPUT_DIR,
        file: spec.logo,
        kind: "image",
        outputPath: join(projectDir, "assets", "logo.png"),
        scratchDir,
      });
    }
    if (spec.media) {
      await normalizeMedia({
        inputDir: INPUT_DIR,
        file: spec.media.file,
        kind: spec.media.kind,
        outputPath: join(
          projectDir,
          "assets",
          spec.media.kind === "video" ? "media.mp4" : "media.png",
        ),
        scratchDir,
      });
    }
    writeProject({ spec, projectDir, hasLogo: Boolean(spec.logo) });
    const preparedAt = performance.now();

    const checkHome = join(workDir, "check-home");
    mkdirSync(checkHome);
    const check = await runHyperframes("check", [projectDir], {
      home: checkHome,
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    rmSync(checkHome, { recursive: true, force: true });
    if (check.code !== 0) throw new WorkerError("quality_check_failed");
    const checkedAt = performance.now();

    const scratchOutput = join(scratchDir, "output.mp4");
    let attempts = 0;
    let render;
    do {
      attempts++;
      // Fresh each time: scratch files count against the memory limit, so leftovers from a
      // crashed attempt would leave the retry with less room than the first try had.
      const home = join(workDir, `home-${attempts}`);
      mkdirSync(home);
      rmSync(scratchOutput, { force: true });
      render = await runHyperframes("render", [projectDir, scratchOutput, FPS], {
        home,
        timeoutMs: RENDER_TIMEOUT_MS,
      });
      rmSync(home, { recursive: true, force: true });
    } while (render.code !== 0 && attempts < RENDER_ATTEMPTS);
    if (render.code !== 0) throw new WorkerError("render_failed");
    const renderedAt = performance.now();

    const video = await verifyOutput(scratchOutput, spec.aspectRatio);
    const result = {
      ok: true,
      file: outputName,
      sha256: await sha256(scratchOutput),
      sizeBytes: statSync(scratchOutput).size,
      video,
      timings: {
        prepareMs: Math.round(preparedAt - startedAt),
        checkMs: Math.round(checkedAt - preparedAt),
        renderMs: Math.round(renderedAt - checkedAt),
      },
      attempts,
    };
    await sendFile(outputName, scratchOutput);
    return { ...result, processesAfter: readCgroupUsage().pidsCurrent };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** @param {string} raw */
async function runJob(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new WorkerError("invalid_job");
  }
  const parsed = parseJob(input);
  if (!parsed.ok) throw new WorkerError("invalid_job", { fields: parsed.fields });

  const results = [];
  // One at a time, so a job's memory peak is bounded by one render whatever its size.
  for (const [index, spec] of parsed.job.renders.entries()) {
    const name = `${parsed.job.jobId}-${index}-${spec.template}-${spec.language}-${spec.aspectRatio.replace(":", "x")}.mp4`;
    try {
      results.push({ index, ...(await renderOne(spec, name)) });
    } catch (error) {
      // One failed render doesn't discard the others.
      results.push({ index, ...toErrorResult(error) });
    }
  }
  return {
    ok: results.every((result) => result.ok),
    jobId: parsed.job.jobId,
    results,
    usage: readCgroupUsage(),
  };
}

async function main() {
  const chunks = [];
  let received = 0;
  for await (const chunk of process.stdin) {
    received += chunk.length;
    if (received > MAX_JOB_BYTES) throw new WorkerError("invalid_job");
    chunks.push(chunk);
  }
  const result = await runJob(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stdout.write(`RESULT ${JSON.stringify(toErrorResult(error))}\n`);
    process.exitCode = 1;
  });
}
