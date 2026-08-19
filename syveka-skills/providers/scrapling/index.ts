import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateUrl } from "./url-policy.js";
import { applySizeCap } from "./size-cap.js";
import { buildDockerArgs } from "./docker-args.js";
import type { Provider } from "../types.js";
import type { ProviderResult } from "../../schemas/index.js";

/**
 * Real Scrapling provider for the `web.research` capability.
 *
 * Isolation: every fetch runs inside a fresh, disposable Docker container
 * (the official `ghcr.io/d4vinci/scrapling` image, pinned by digest - the
 * exact image verified in docs/skills/SECURITY_REVIEW.md's smoke test),
 * never as a subprocess on the host directly. The container has all Linux
 * capabilities dropped, no new privileges, and a memory/CPU ceiling - so
 * even a worst-case Scrapling bug or a hostile page cannot spawn host
 * processes or consume unbounded resources, and (via `--rm`) leaves no
 * residue after each call. `--network bridge` (never `host`) means the
 * container never shares the host's network namespace.
 *
 * NOT read-only: a `--read-only` root filesystem was attempted and
 * rejected during this milestone's real-Docker verification - this
 * specific image's own entrypoint (`uv run scrapling`) rebuilds its local
 * editable package install on every single invocation and fails outright
 * without a writable `/app`. Real container filesystem writes are still
 * fully contained: nothing outside the container survives past `--rm`
 * except the one scratch directory explicitly bind-mounted at `/app/out`,
 * which only ever receives the one expected output file this code reads
 * back. This is a documented, deliberate tradeoff, not an oversight -
 * see docs/skills/scrapling-integration.md for the full isolation design
 * and why full read-only rootfs remains a real limitation to revisit
 * (e.g. by rebuilding a custom image that pre-installs the package instead
 * of relying on `uv run`'s runtime rebuild).
 *
 * Scope for this milestone (see the "Permissions" section of the task
 * brief): plain public-page HTTP extraction only, via Scrapling's `get`
 * command (the curl_cffi-backed HTTP engine, NOT the browser-based
 * fetch/stealthy-fetch tools). This is the exact case where Scrapling's
 * own `follow_redirects="safe"` (verified in the source during the
 * original review) actually applies. No stealth mode, no Cloudflare
 * bypass, no cookies, no proxies, no browser automation - those all stay
 * disabled per the brief and would need their own separate review and
 * explicit owner approval before ever being wired in here.
 *
 * SSRF: the target URL is validated by providers/scrapling/url-policy.ts
 * (real DNS resolution + IP range checks) BEFORE the container is ever
 * started - a rejected URL never reaches Docker or the network at all.
 */

const DOCKER_IMAGE =
  "ghcr.io/d4vinci/scrapling@sha256:48f5938fff7c0684e11995f5cdc6497ce13d9ab0d914e58e9ff5f2055099d284";
const SCRAPLING_VERSION = "0.4.14";
const SCRAPLING_COMMIT = "5d213a2d4764002bfc4fed33c32fe09fa8b0bf7f";

const FETCH_TIMEOUT_MS = 30_000;
const DOCKER_HARD_TIMEOUT_MS = FETCH_TIMEOUT_MS + 15_000; // outer safety margin over Scrapling's own timeout
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB cap on extracted content
const OUTPUT_FILENAME = "output.md";

function execFileAsync(
  command: string,
  args: string[],
  options: { timeout: number },
): Promise<{ stdout: string; stderr: string; error: Error | null }> {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "", error });
    });
  });
}

export async function isDockerAvailable(): Promise<boolean> {
  const { error } = await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], {
    timeout: 5_000,
  });
  return error === null;
}

export interface ScraplingResearchInput {
  url: string;
  cssSelector?: string;
}

export function createScraplingProvider(): Provider {
  return {
    id: "scrapling",
    isAvailable: () => isDockerAvailable(),

    async execute(input: Record<string, unknown>): Promise<ProviderResult> {
      // The orchestrator's generic call shape is {capability, request} - it
      // has no structured way (yet) to pass a specific url parameter, so a
      // caller may supply `url` explicitly (preferred, e.g. from the demos)
      // or this falls back to extracting the first http(s) URL literally
      // present in the free-text `request`. In real usage, the host LLM
      // agent (which understands the user's actual intent) would supply
      // `url` explicitly; this fallback exists so the deterministic
      // fallback classifier in core/intent/index.ts can still drive an
      // end-to-end demo without a live LLM in the loop.
      const explicitUrl = typeof input.url === "string" ? input.url : undefined;
      const extractedUrl =
        typeof input.request === "string" ? /https?:\/\/\S+/.exec(input.request)?.[0] : undefined;
      const url = explicitUrl ?? extractedUrl;
      const cssSelector = typeof input.cssSelector === "string" ? input.cssSelector : undefined;
      const now = () => new Date().toISOString();

      if (!url) {
        return {
          status: "FAILURE",
          message:
            "web.research requires a url, either as explicit provider input or found in the request text",
          evidence: [],
        };
      }

      // 1. SSRF/network policy - evaluated before anything touches the network.
      const policy = await validateUrl(url);
      if (!policy.allowed) {
        return {
          status: "FAILURE",
          message: `URL rejected by security policy: ${policy.reason}`,
          evidence: [
            {
              type: "log",
              description: "URL policy rejection (SSRF/network policy)",
              data: JSON.stringify({ url, reason: policy.reason }),
              timestamp: now(),
            },
          ],
        };
      }

      // 2. Isolation boundary availability - never assumed, always checked.
      if (!(await isDockerAvailable())) {
        return {
          status: "UNAVAILABLE",
          message:
            "Docker is not available in this environment - the isolation boundary this provider requires cannot be established",
          evidence: [],
        };
      }

      const scratch = await mkdtemp(path.join(tmpdir(), "syveka-scrapling-"));
      try {
        const args = buildDockerArgs({
          image: DOCKER_IMAGE,
          scratchDir: scratch,
          url,
          outputFilename: OUTPUT_FILENAME,
          timeoutSeconds: Math.floor(FETCH_TIMEOUT_MS / 1000),
          cssSelector,
        });

        const { stdout, stderr, error } = await execFileAsync("docker", args, {
          timeout: DOCKER_HARD_TIMEOUT_MS,
        });

        if (error) {
          const timedOut = /timeout|ETIMEDOUT/i.test(error.message);
          return {
            status: "FAILURE",
            message: timedOut
              ? `fetch timed out after ${FETCH_TIMEOUT_MS}ms`
              : `Scrapling container exited with an error: ${error.message}`,
            evidence: [
              {
                type: "log",
                description: "docker run failure",
                data: (stdout + stderr).slice(0, 2000),
                timestamp: now(),
              },
            ],
          };
        }

        const outputPath = path.join(scratch, OUTPUT_FILENAME);
        let fileStat;
        try {
          fileStat = await stat(outputPath);
        } catch {
          return {
            status: "FAILURE",
            message: "Scrapling reported success but produced no output file",
            evidence: [
              {
                type: "log",
                description: "missing output file",
                data: (stdout + stderr).slice(0, 2000),
                timestamp: now(),
              },
            ],
          };
        }

        const raw = await readFile(outputPath, "utf-8");
        const { content: extractedContent, oversized } = applySizeCap(raw, MAX_RESPONSE_BYTES);

        const retrievalTimestamp = now();
        const structured = {
          sourceUrl: url,
          retrievalStatus: oversized ? "truncated" : "success",
          retrievalTimestamp,
          extractedContent,
          extractionMethod: cssSelector
            ? `scrapling-cli-get-http-engine(css_selector="${cssSelector}")`
            : "scrapling-cli-get-http-engine",
          providerIdentity: `scrapling@${SCRAPLING_VERSION} (${SCRAPLING_COMMIT}) via ${DOCKER_IMAGE}`,
        };

        return {
          status: "SUCCESS",
          message: oversized
            ? `fetched ${url} - content exceeded ${MAX_RESPONSE_BYTES} bytes and was truncated`
            : `fetched ${url} (${fileStat.size} bytes)`,
          evidence: [
            {
              // Deliberately WEAK: a fetched page is a citation, not proof
              // of any claim about its content - see docs/evidence-model.md
              // and the task brief's explicit "a successful HTTP fetch
              // alone must NOT mean the research claim is VERIFIED."
              type: "source_reference",
              description: `content fetched from ${url}`,
              data: JSON.stringify(structured).slice(0, MAX_RESPONSE_BYTES),
              timestamp: retrievalTimestamp,
            },
          ],
          data: structured,
        };
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}

export const scraplingProvider = createScraplingProvider();
