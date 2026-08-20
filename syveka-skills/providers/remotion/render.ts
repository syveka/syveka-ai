import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import {
  ensureBrowser,
  makeCancelSignal,
  renderMedia,
  selectComposition,
} from "@remotion/renderer";
import {
  SYVEKA_INTRO_DURATION_IN_FRAMES,
  SYVEKA_INTRO_FPS,
  SYVEKA_INTRO_HEIGHT,
  SYVEKA_INTRO_WIDTH,
} from "./composition/SyvekaIntro.js";
import type { RemotionRenderInput } from "./input-schema.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY_POINT = path.join(__dirname, "composition", "entry.ts");

const RENDER_HARD_TIMEOUT_MS = 60_000;
const OUTPUT_FILENAME = "output.mp4";

export interface RenderSuccess {
  outputPath: string;
  compositionId: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  durationSeconds: number;
  codec: string;
  fileSizeBytes: number;
  renderTimeMs: number;
  renderedAt: string;
}

export type RenderFailureReason =
  | "chromium_unavailable"
  | "render_timeout"
  | "invalid_composition"
  | "missing_asset"
  | "filesystem_error"
  | "process_crash"
  | "unknown";

export interface RenderFailure {
  reason: RenderFailureReason;
  message: string;
  detail?: string;
}

export type RenderOutcome =
  { ok: true; result: RenderSuccess } | { ok: false; failure: RenderFailure };

// Bundling (webpack/esbuild) is the expensive, purely-deterministic-given-
// fixed-source-files part of a render - reused across calls in the same
// process instead of redone per render. Only ever built from this
// package's own reviewed composition/entry.ts, never from caller input.
let cachedServeUrlPromise: Promise<string> | null = null;
function getServeUrl(): Promise<string> {
  if (!cachedServeUrlPromise) {
    cachedServeUrlPromise = bundle({ entryPoint: ENTRY_POINT }).catch((err) => {
      cachedServeUrlPromise = null; // allow retry on a later call rather than caching a permanent failure
      throw err;
    });
  }
  return cachedServeUrlPromise;
}

/**
 * Whether the local Chromium binary Remotion needs is actually available in
 * this environment - checked explicitly and honestly (never assumed) before
 * a render is attempted, matching the same "isAvailable() reflects reality"
 * contract providers/scrapling/index.ts uses for Docker.
 */
export async function isChromiumAvailable(): Promise<boolean> {
  try {
    await ensureBrowser();
    return true;
  } catch {
    return false;
  }
}

// @remotion/renderer's own isUserCancelledRender()/cancelErrorMessages are
// not re-exported from the package's main entry point (only from an
// internal submodule) - matching the exact string it checks for internally
// (see node_modules/@remotion/renderer/dist/make-cancel-signal.js) rather
// than depending on an unexported internal.
const CANCEL_MESSAGE_FRAGMENTS = ["got cancelled"];

/** Exported so evals/remotion-provider.test.ts can unit-test every classification branch directly, without needing a real Chromium/render failure to reach each one. */
export function classifyRenderError(err: unknown): RenderFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (CANCEL_MESSAGE_FRAGMENTS.some((f) => message.includes(f))) {
    return {
      reason: "render_timeout",
      message: "render exceeded the hard timeout ceiling and was cancelled",
    };
  }
  if (
    /chromium|chrome|browser|executable/i.test(message) &&
    /not found|failed to launch|ENOENT/i.test(message)
  ) {
    return {
      reason: "chromium_unavailable",
      message: "Chromium is not available in this environment",
      detail: message,
    };
  }
  if (/composition.*not found|no composition with id|could not find/i.test(message)) {
    return {
      reason: "invalid_composition",
      message: "the requested composition id is not registered",
      detail: message,
    };
  }
  if (
    /ENOENT|no such file|asset|could not be found/i.test(message) &&
    /\.(png|jpe?g|mp3|mp4|wav|svg|woff2?)/i.test(message)
  ) {
    return {
      reason: "missing_asset",
      message: "a referenced asset could not be found",
      detail: message,
    };
  }
  if (/EACCES|EROFS|ENOSPC|ENOENT|EPERM/.test(message)) {
    return {
      reason: "filesystem_error",
      message: "a filesystem operation failed during render",
      detail: message,
    };
  }
  if (/crashed|segfault|signal|exited with code/i.test(message)) {
    return { reason: "process_crash", message: "the render process crashed", detail: message };
  }
  return { reason: "unknown", message: "render failed", detail: message };
}

export interface RenderOptions {
  /** Test-only escape hatch to exercise Remotion's own dimension validation - never set by the real provider. */
  dimensionOverrideForTesting?: { width: number; height: number };
  /** Test-only override of RENDER_HARD_TIMEOUT_MS, so a real-cancellation test doesn't have to wait 60s - never set by the real provider. */
  hardTimeoutMsForTesting?: number;
}

export async function renderComposition(
  input: RemotionRenderInput,
  options: RenderOptions = {},
): Promise<RenderOutcome> {
  const start = Date.now();

  if (!(await isChromiumAvailable())) {
    return {
      ok: false,
      failure: {
        reason: "chromium_unavailable",
        message: "Chromium is not available in this environment",
      },
    };
  }

  let serveUrl: string;
  try {
    serveUrl = await getServeUrl();
  } catch (err) {
    return { ok: false, failure: classifyRenderError(err) };
  }

  const inputProps = {
    titleText: input.titleText ?? "Syveka AI",
    subtitleText: input.subtitleText ?? "Intelligent Workflows",
  };

  let composition;
  try {
    composition = await selectComposition({ serveUrl, id: input.compositionId, inputProps });
  } catch (err) {
    return { ok: false, failure: classifyRenderError(err) };
  }

  if (options.dimensionOverrideForTesting) {
    composition = {
      ...composition,
      width: options.dimensionOverrideForTesting.width,
      height: options.dimensionOverrideForTesting.height,
    };
  }

  const outputDir = await mkdtemp(path.join(tmpdir(), "syveka-remotion-"));
  const outputPath = path.join(outputDir, OUTPUT_FILENAME);
  // Defense in depth against path traversal, even though outputDir is
  // always our own mkdtemp path and OUTPUT_FILENAME is a fixed constant,
  // never caller input - see providers/scrapling/url-policy.ts for the
  // same "validate even what should be impossible to violate" pattern.
  if (path.relative(outputDir, outputPath).startsWith("..")) {
    return {
      ok: false,
      failure: {
        reason: "filesystem_error",
        message: "resolved output path escaped the scratch directory",
      },
    };
  }

  const hardTimeoutMs = options.hardTimeoutMsForTesting ?? RENDER_HARD_TIMEOUT_MS;
  const { cancelSignal, cancel } = makeCancelSignal();
  const timer = setTimeout(cancel, hardTimeoutMs);

  try {
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: outputPath,
      inputProps,
      cancelSignal,
      timeoutInMilliseconds: 30_000,
    });

    const fileStat = await stat(outputPath);
    return {
      ok: true,
      result: {
        outputPath,
        compositionId: input.compositionId,
        width: composition.width,
        height: composition.height,
        fps: composition.fps,
        durationInFrames: composition.durationInFrames,
        durationSeconds: composition.durationInFrames / composition.fps,
        codec: "h264",
        fileSizeBytes: fileStat.size,
        renderTimeMs: Date.now() - start,
        renderedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    await rm(outputDir, { recursive: true, force: true });
    return { ok: false, failure: classifyRenderError(err) };
  } finally {
    clearTimeout(timer);
  }
}

export const REMOTION_DEFAULTS = {
  compositionId: "syveka-intro" as const,
  width: SYVEKA_INTRO_WIDTH,
  height: SYVEKA_INTRO_HEIGHT,
  fps: SYVEKA_INTRO_FPS,
  durationInFrames: SYVEKA_INTRO_DURATION_IN_FRAMES,
};
