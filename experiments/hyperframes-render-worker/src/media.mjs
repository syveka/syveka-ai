import { execFile } from "node:child_process";
import {
  closeSync,
  constants,
  createWriteStream,
  fstatSync,
  openSync,
  createReadStream,
} from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { WorkerError } from "./errors.mjs";
import { COMPOSITION_SECONDS, FPS } from "./constants.mjs";

const run = promisify(execFile);

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_VIDEO_SECONDS = 60;
const MAX_SOURCE_DIMENSION = 4096;
const MAX_OUTPUT_DIMENSION = 1920;
const FFMPEG_TIMEOUT_MS = 60_000;
const FFPROBE_TIMEOUT_MS = 15_000;

const QUIET = ["-hide_banner", "-loglevel", "error"];
/**
 * Input options. No demuxer may follow a reference out of the file, and only the formats and
 * codecs we accept can be opened. Format probing runs before the allowlist is applied, so this
 * narrows the decoders a crafted file can reach; it doesn't remove all parsing of that file.
 */
const LOCKED_INPUT = [
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  "mov,png_pipe,jpeg_pipe,webp_pipe,image2",
  "-codec_whitelist",
  "h264,hevc,vp9,av1,png,mjpeg,webp",
];
/** SIGKILL: a process stuck in a crafted file may ignore a polite signal. */
const KILL = { killSignal: /** @type {const} */ ("SIGKILL"), maxBuffer: 1024 * 1024 };

/**
 * The first bytes decide the format, whatever the extension claims. SVG can never match.
 * @param {Buffer} header
 */
export function sniffMediaType(header) {
  if (header.length < 12) return null;
  const ascii = (/** @type {number} */ start, /** @type {number} */ end) =>
    header.subarray(start, end).toString("latin1");
  if (header[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return "jpeg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp") return "mp4";
  return null;
}

/**
 * Copies the input to scratch space through one file descriptor, then validates only the copy.
 * The input directory belongs to the host, which could swap a file between a check and a use:
 * here there is only one open, it refuses symlinks, and it can't block on a FIFO.
 *
 * @param {string} path
 * @param {string} copyPath
 * @param {number} maxBytes
 */
async function copyInput(path, copyPath, maxBytes) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    throw new WorkerError(code === "ENOENT" ? "media_not_found" : "invalid_media");
  }
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) {
    closeSync(fd);
    throw new WorkerError("invalid_media");
  }
  let copied = 0;
  const capped = new Transform({
    transform(chunk, _encoding, done) {
      copied += chunk.length;
      // The file could still grow after fstat, so the limit applies to what is actually read.
      if (copied > maxBytes) done(new WorkerError("invalid_media"));
      else done(null, chunk);
    },
  });
  // autoClose, with `fd`: the stream owns the descriptor from here on.
  await pipeline(
    createReadStream("", { fd, autoClose: true }),
    capped,
    createWriteStream(copyPath),
  );
}

/** @param {string} path */
function readHeader(path) {
  const fd = openSync(path, "r");
  return new Promise((resolve, reject) => {
    const chunks = [];
    createReadStream("", { fd, start: 0, end: 11, autoClose: true })
      .on("data", (chunk) => chunks.push(chunk))
      .on("error", reject)
      .on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** @param {string} path */
async function probe(path) {
  try {
    const { stdout } = await run(
      "ffprobe",
      [
        ...QUIET,
        ...LOCKED_INPUT,
        "-print_format",
        "json",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height",
        path,
      ],
      { ...KILL, timeout: FFPROBE_TIMEOUT_MS },
    );
    return JSON.parse(stdout);
  } catch {
    throw new WorkerError("invalid_media");
  }
}

/**
 * Validates one input and re-encodes it into the job's scratch directory. The browser only ever
 * opens the re-encoded copy, so polyglot files, metadata and extra streams don't reach it.
 *
 * A video is always exactly the composition's length. A shorter clip holds its last frame, since
 * Kling clips default to 5 seconds and templates run for 10.
 *
 * @param {{ inputDir: string, file: string, kind: "image" | "video", outputPath: string, scratchDir: string }} args
 */
export async function normalizeMedia({ inputDir, file, kind, outputPath, scratchDir }) {
  const copy = join(scratchDir, `input-${kind}`);
  try {
    await copyInput(
      join(inputDir, file),
      copy,
      kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES,
    );

    const sniffed = sniffMediaType(await readHeader(copy));
    const matchesKind =
      kind === "video" ? sniffed === "mp4" : ["png", "jpeg", "webp"].includes(sniffed ?? "");
    if (!matchesKind) throw new WorkerError("invalid_media");

    const { streams = [], format = {} } = await probe(copy);
    const video = streams.find((/** @type {any} */ stream) => stream.codec_type === "video");
    if (!video || !(video.width > 0) || !(video.height > 0)) throw new WorkerError("invalid_media");
    if (video.width > MAX_SOURCE_DIMENSION || video.height > MAX_SOURCE_DIMENSION) {
      throw new WorkerError("invalid_media");
    }
    if (kind === "video") {
      const seconds = Number(format.duration);
      if (!(seconds > 0) || seconds > MAX_VIDEO_SECONDS) throw new WorkerError("invalid_media");
    }

    // Even dimensions, which yuv420p requires, and never larger than any output needs.
    const shrink = `min(1\\,min(${MAX_OUTPUT_DIMENSION}/iw\\,${MAX_OUTPUT_DIMENSION}/ih))`;
    const fitted = `scale=trunc(iw*${shrink}/2)*2:trunc(ih*${shrink}/2)*2`;
    const encode =
      kind === "video"
        ? [
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-dn",
            "-map_metadata",
            "-1",
            "-vf",
            `tpad=stop_mode=clone:stop_duration=${COMPOSITION_SECONDS},${fitted}`,
            // Enforced on the output: a file's own duration metadata can't be trusted.
            "-t",
            String(COMPOSITION_SECONDS),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
            "-pix_fmt",
            "yuv420p",
            "-r",
            String(FPS),
            // A keyframe per frame: the renderer seeks to every frame, and long GOPs make that slow.
            "-g",
            "1",
            "-movflags",
            "+faststart",
          ]
        : ["-map", "0:v:0", "-frames:v", "1", "-map_metadata", "-1", "-vf", fitted, "-c:v", "png"];
    try {
      await run(
        "ffmpeg",
        [...QUIET, ...LOCKED_INPUT, "-nostdin", "-y", "-i", copy, ...encode, outputPath],
        { ...KILL, timeout: FFMPEG_TIMEOUT_MS },
      );
    } catch (error) {
      if (/** @type {any} */ (error).killed) throw new WorkerError("render_timeout");
      throw new WorkerError("invalid_media");
    }
  } finally {
    await rm(copy, { force: true });
  }
}
