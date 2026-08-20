import { remotionRenderInputSchema } from "./input-schema.js";
import { isChromiumAvailable, renderComposition } from "./render.js";
import type { Provider } from "../types.js";
import type { ProviderResult } from "../../schemas/index.js";

/**
 * Real Remotion provider for the `video.render` capability.
 *
 * Scope for this milestone: rendering ONE reviewed, first-party composition
 * (providers/remotion/composition/SyvekaIntro.tsx) with two bounded text
 * props. There is no code path that lets a caller supply their own
 * React/JSX/JS to render - see input-schema.ts for the exact trust
 * boundary. Composing (deciding what text to show), rendering (Chromium +
 * FFmpeg producing an .mp4), and verifying (see evals/remotion-live.test.ts)
 * are conceptually distinct steps, but this MVP exposes them as a single
 * capability, matching how providers/scrapling/index.ts folds "fetch" and
 * "extract" into one `web.research` call - splitting `video.compose` out as
 * its own separately-routable capability can happen later if a real caller
 * need for "generate composition code without rendering" appears; adding it
 * now would be speculative.
 *
 * Isolation: Chromium and the bundled FFmpeg (via @remotion/renderer, which
 * ships its own compositor binary - no system ffmpeg dependency) run as
 * local child processes, the same trust level as any other local dev
 * tooling in this repo (contrast with providers/scrapling, which needs
 * Docker isolation because it fetches arbitrary, potentially hostile,
 * third-party web pages). The COMPOSITION itself makes no outbound network
 * request (no external fonts, images, or media URLs) - confirmed by the
 * live render actually succeeding with no network mocking. There IS one
 * real network dependency, found during this milestone's live
 * verification and not something to leave undisclosed:
 * @remotion/renderer's ensureBrowser() downloads a Chrome Headless Shell
 * binary (~113MB) from the fixed, hardcoded, Remotion-controlled URL
 * https://storage.googleapis.com/chrome-for-testing-public/ on first use in
 * a given environment, then caches it locally - not an SSRF surface (the
 * URL is not caller-influenced in any way), but real, disclosed network
 * behavior; see core/registry/data.ts's "remotion" entry, corrected to
 * `network_access: true` for exactly this reason. If a future composition
 * needs to load a caller-supplied media URL, that would need its own
 * url-policy review before being wired in, matching
 * providers/scrapling/url-policy.ts.
 */
export function createRemotionProvider(): Provider {
  return {
    id: "remotion",
    isAvailable: () => isChromiumAvailable(),

    async execute(input: Record<string, unknown>): Promise<ProviderResult> {
      const now = () => new Date().toISOString();
      const parsed = remotionRenderInputSchema.safeParse(input);

      if (!parsed.success) {
        return {
          status: "FAILURE",
          message: `invalid render input: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
          evidence: [
            {
              type: "log",
              description: "input validation rejection",
              data: JSON.stringify({
                issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
              }),
              timestamp: now(),
            },
          ],
        };
      }

      if (!(await isChromiumAvailable())) {
        return {
          status: "UNAVAILABLE",
          message:
            "Chromium is not available in this environment - the render boundary this provider requires cannot be established",
          evidence: [],
        };
      }

      const outcome = await renderComposition(parsed.data);

      if (!outcome.ok) {
        return {
          status: "FAILURE",
          message: `render failed (${outcome.failure.reason}): ${outcome.failure.message}`,
          evidence: [
            {
              type: "log",
              description: `render failure - ${outcome.failure.reason}`,
              data: JSON.stringify(outcome.failure).slice(0, 2000),
              timestamp: now(),
            },
          ],
        };
      }

      const { result } = outcome;
      const structured = {
        compositionId: result.compositionId,
        resolution: `${result.width}x${result.height}`,
        fps: result.fps,
        durationInFrames: result.durationInFrames,
        durationSeconds: result.durationSeconds,
        codec: result.codec,
        outputPath: result.outputPath,
        fileSizeBytes: result.fileSizeBytes,
        renderTimeMs: result.renderTimeMs,
        renderedAt: result.renderedAt,
      };

      return {
        status: "SUCCESS",
        message: `rendered ${result.compositionId} (${result.durationSeconds}s, ${result.width}x${result.height}, ${result.fileSizeBytes} bytes) in ${result.renderTimeMs}ms`,
        evidence: [
          {
            // Deliberately WEAK on its own, same reasoning as
            // providers/scrapling/index.ts's source_reference evidence: a
            // file existing on disk is a citation of what happened, not
            // proof the render is actually correct. A completion claim
            // needs a real test that inspects the artifact (see
            // evals/remotion-live.test.ts) to become VERIFIED - see
            // core/evidence/index.ts's STRONG_EVIDENCE_TYPES.
            type: "artifact",
            description: `rendered video artifact at ${result.outputPath}`,
            data: JSON.stringify(structured),
            timestamp: result.renderedAt,
          },
        ],
        data: structured,
      };
    },
  };
}

export const remotionProvider = createRemotionProvider();
