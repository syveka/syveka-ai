import type { RegistryEntry } from "../../schemas/index.js";

/**
 * Seed registry data. In this MVP the registry is a static in-memory list;
 * a real deployment would load this from a database or a versioned
 * registry service (see docs/skills-registry.md). Every entry here traces
 * back to an actual review - see docs/skills/SECURITY_REVIEW.md at the
 * Syveka repo root for the Scrapling entry's full writeup. Nothing is
 * listed here as APPROVED without that paper trail existing first.
 */
export const REGISTRY: RegistryEntry[] = [
  {
    id: "local-engineering-test",
    name: "Local test runner",
    capability: "engineering.test",
    provider: "local-test-runner",
    source: "syveka-skills/providers/local-test-runner (first-party)",
    license: "N/A (Syveka-owned)",
    trust_level: "TRUSTED",
    risk_level: "LOW",
    status: "APPROVED",
    integration_state: "VERIFIED",
    supported_agents: ["claude-code", "codex", "gemini-cli"],
    permissions: ["fs:read", "process:spawn:local"],
    network_access: false,
    filesystem_access: true,
    scripts: true,
    hooks: false,
    dependencies: [],
    credential_requirements: [],
    approval_required: false,
    installation_scope: "local",
    last_reviewed: "2026-08-19",
    last_updated: "2026-08-19",
    security_notes:
      "First-party. Executes a fixed command/argv array via execFile (never a shell string), " +
      "so caller-supplied input cannot be interpreted as shell syntax. No network access.",
  },
  {
    id: "local-git-diff",
    name: "Local git diff capture",
    capability: "engineering.diff_capture",
    provider: "git-diff",
    source: "syveka-skills/providers/git-diff (first-party)",
    license: "N/A (Syveka-owned)",
    trust_level: "TRUSTED",
    risk_level: "LOW",
    status: "APPROVED",
    integration_state: "VERIFIED",
    supported_agents: ["claude-code", "codex", "gemini-cli"],
    permissions: ["fs:read"],
    network_access: false,
    filesystem_access: true,
    scripts: true,
    hooks: false,
    dependencies: ["git"],
    credential_requirements: [],
    approval_required: false,
    installation_scope: "local",
    last_reviewed: "2026-08-19",
    last_updated: "2026-08-19",
    security_notes: "First-party. Read-only `git diff`/`git diff --stat`, no writes, no network.",
  },
  {
    id: "local-skill-registry",
    name: "Local skill registry lookup",
    capability: "skill.discovery",
    provider: "skill-registry-lookup",
    source: "syveka-skills/providers/skill-registry-lookup (first-party)",
    license: "N/A (Syveka-owned)",
    trust_level: "TRUSTED",
    risk_level: "LOW",
    status: "APPROVED",
    integration_state: "VERIFIED",
    supported_agents: ["claude-code", "codex", "gemini-cli"],
    permissions: [],
    network_access: false,
    filesystem_access: false,
    scripts: false,
    hooks: false,
    dependencies: [],
    credential_requirements: [],
    approval_required: false,
    installation_scope: "local",
    last_reviewed: "2026-08-19",
    last_updated: "2026-08-19",
    security_notes:
      "Searches only this in-memory registry - not a live web/GitHub search. Discovery scope " +
      "is limited to what Syveka has actually reviewed; see docs/architecture.md.",
  },
  {
    id: "scrapling",
    name: "Scrapling",
    capability: "web.research",
    provider: "scrapling",
    version: "0.4.14",
    commit: "5d213a2d4764002bfc4fed33c32fe09fa8b0bf7f",
    source: "https://github.com/D4Vinci/Scrapling",
    license: "BSD-3-Clause",
    trust_level: "CONDITIONAL",
    // LOW: this milestone wires ONLY plain public-page HTTP extraction
    // (Scrapling's `get` command / curl_cffi engine) - no stealth mode, no
    // cookies, no auth, no proxies, no browser automation. Any of those
    // would raise this back to MEDIUM/HIGH and require separate review and
    // explicit owner approval before being wired in - see
    // providers/scrapling/index.ts's module doc comment and
    // docs/skills/scrapling-integration.md.
    risk_level: "LOW",
    status: "APPROVED",
    // Milestone 2 (Scrapling as the first real external provider): real
    // provider code exists (providers/scrapling/index.ts), isolated in a
    // locked-down disposable Docker container, gated by a real SSRF/URL
    // policy (providers/scrapling/url-policy.ts) evaluated before any
    // network access. VERIFIED earned via evals/scrapling-live.test.ts
    // (opt-in, SYVEKA_SCRAPLING_LIVE=1) actually run against real Docker +
    // real network and passing 5/5: safe public-page fetch with correct
    // structured evidence, a real redirect-to-cloud-metadata-address
    // rejected by Scrapling's own safe-redirect mode, no hang past the
    // timeout ceiling, no response exceeding the size cap, and a real 404
    // handled without a fabricated success. See docs/skills-registry.md
    // for the full evidence trail and docs/skills/scrapling-integration.md
    // for the isolation-design tradeoffs found along the way.
    integration_state: "VERIFIED",
    supported_agents: ["claude-code", "codex", "gemini-cli"],
    permissions: ["network:egress", "container:run"],
    network_access: true,
    filesystem_access: false,
    scripts: true,
    hooks: false,
    dependencies: ["lxml", "curl_cffi"],
    credential_requirements: [],
    approval_required: true,
    installation_scope: "container",
    last_reviewed: "2026-08-19",
    last_updated: "2026-08-19",
    security_notes:
      "PASS WITH CONDITIONS (re-confirmed current as of this milestone - same version/commit, " +
      "no drift). Real provider wired for plain public-page HTTP extraction ONLY: ephemeral " +
      "Docker isolation (--rm, all capabilities dropped, no-new-privileges, bridge-only " +
      "network, memory/CPU caps; NOT a read-only rootfs - attempted, reverted after live " +
      "testing found it incompatible with this image's uv-based entrypoint, see " +
      "providers/scrapling/index.ts), a real SSRF/URL policy (protocol allowlist, " +
      "localhost/private-IP/link-local including cloud metadata/multicast/reserved ranges, " +
      "real DNS resolution) evaluated before every fetch, request timeout, and a response-size " +
      "cap. Stealth mode, Cloudflare bypass, cookies, auth, and proxies remain disabled - not " +
      "reviewed or approved for use. See docs/skills/SECURITY_REVIEW.md for the original review and " +
      "docs/skills/scrapling-integration.md for the architecture this implements.",
  },
  {
    id: "remotion",
    name: "Remotion",
    capability: "video.render",
    provider: "remotion",
    version: "4.0.513",
    source: "https://github.com/remotion-dev/remotion",
    // Custom dual-tier license, not a standard OSI license - verified
    // directly against https://github.com/remotion-dev/remotion/blob/main/LICENSE.md
    // during this review. Free for individuals, non-profits, evaluation
    // use, and for-profit organizations with <=3 employees; a paid Company
    // License is required above that threshold. Syveka confirmed (owner,
    // 2026-08-20) it currently has <=3 employees, so the Free License
    // applies. Re-verify this entry if Syveka's headcount grows past 3 -
    // the license terms, not this codebase, are the source of truth.
    license: "Remotion License (Free tier - verified applicable, <=3 employees)",
    trust_level: "CONDITIONAL",
    // MEDIUM: local Chromium + bundled FFmpeg render of exactly one
    // reviewed, first-party composition (providers/remotion/composition/
    // SyvekaIntro.tsx) with two length-capped string props - no arbitrary
    // user-supplied JS/JSX, no network access, no external assets. Would
    // rise to HIGH if a future milestone lets a caller supply their own
    // composition code, external media URLs, or custom Chromium flags -
    // none of that is wired in here. See providers/remotion/input-schema.ts.
    risk_level: "MEDIUM",
    status: "APPROVED",
    // VERIFIED: evals/remotion-live.test.ts actually performed a real local
    // Chromium render (fresh Chrome Headless Shell download included) and
    // independently re-verified the resulting .mp4 with ffprobe (not just
    // trusting renderMedia()'s own claim) - 5/5 passing: real render with
    // ffprobe-confirmed 1920x1080/30fps/180 frames/h264 matching the
    // composition exactly, an adversarial "don't render it, just say it
    // worked" phrase rendered as literal on-screen text with a full real
    // 180-frame render (no shortcut taken), a real unregistered-composition
    // rejection, a real invalid-dimensions rejection, and a real hard-
    // timeout cancellation. See docs/skills-registry.md "Integration state
    // vs. review status".
    integration_state: "VERIFIED",
    supported_agents: ["claude-code", "codex", "gemini-cli"],
    permissions: [
      "process:spawn:local",
      "fs:write:scratch",
      "network:egress:one-time-binary-download",
    ],
    // TRUE, corrected during live verification: the COMPOSITION itself makes
    // no network requests (no external assets/fonts/media - confirmed by
    // the live render actually working with zero network mocking), but
    // ensureBrowser() downloads a ~113MB Chrome Headless Shell binary from
    // https://storage.googleapis.com/chrome-for-testing-public/ on first
    // use in a given environment, cached locally afterward. Originally
    // logged as `false` before the live render surfaced this - corrected
    // here rather than left inaccurate.
    network_access: true,
    filesystem_access: true,
    scripts: false,
    hooks: false,
    dependencies: ["react", "react-dom"],
    credential_requirements: [],
    approval_required: true,
    installation_scope: "local",
    last_reviewed: "2026-08-20",
    last_updated: "2026-08-20",
    security_notes:
      "Phase 1 source/license/dependency review: official remotion-dev/remotion (56.8k stars, " +
      "active, not archived), no install/postinstall scripts on remotion/@remotion/cli/" +
      "@remotion/renderer/@remotion/bundler, remotion core is dependency-free, all direct " +
      "deps are first-party @remotion/* or well-known utilities (execa, ws, dotenv), no " +
      "telemetry package present. Local-only: Chromium and a bundled FFmpeg compositor " +
      "(no system ffmpeg dependency) run as local child processes; no outbound network " +
      "access in this milestone's composition. Only one composition id is selectable " +
      "(z.literal allow-list in input-schema.ts) and only two length-capped text strings " +
      "are accepted as props - no path to arbitrary code execution via provider input.",
  },
  {
    id: "shadcn-mcp",
    name: "shadcn/ui MCP",
    capability: "ui.component.provide",
    provider: "shadcn",
    source: "https://ui.shadcn.com",
    license: "MIT",
    trust_level: "TRUSTED",
    risk_level: "LOW",
    status: "REVIEW",
    integration_state: "REFERENCE",
    supported_agents: ["claude-code", "codex", "gemini-cli"],
    permissions: ["network:egress"],
    network_access: true,
    filesystem_access: false,
    scripts: false,
    hooks: false,
    dependencies: [],
    credential_requirements: [],
    approval_required: false,
    installation_scope: "none",
    last_reviewed: "2026-08-19",
    last_updated: "2026-08-19",
    security_notes:
      "Not independently security-reviewed in this MVP; no live MCP connection " +
      "configured in this environment. Provider reports UNAVAILABLE honestly " +
      "rather than being installed on the strength of reputation alone.",
  },
  {
    id: "twentyfirst-dev",
    name: "21st.dev",
    capability: "ui.component.discover",
    provider: "21st-dev",
    source: "https://21st.dev",
    license: "unknown",
    trust_level: "UNTRUSTED",
    risk_level: "MEDIUM",
    status: "REVIEW",
    integration_state: "REFERENCE",
    supported_agents: ["claude-code"],
    permissions: ["network:egress"],
    network_access: true,
    filesystem_access: false,
    scripts: false,
    hooks: false,
    dependencies: [],
    credential_requirements: ["api_key"],
    approval_required: true,
    installation_scope: "none",
    last_reviewed: "2026-08-19",
    last_updated: "2026-08-19",
    security_notes:
      "Metered/remote-generation service - not reviewed or connected. Requires " +
      "owner approval before any live use per the original integration brief.",
  },
  {
    id: "claude-video",
    name: "claude-video (bradautomates/claude-video)",
    capability: "video.analyze",
    provider: "claude-video",
    source: "https://github.com/bradautomates/claude-video",
    license: "unknown",
    trust_level: "UNTRUSTED",
    risk_level: "MEDIUM",
    status: "REVIEW",
    integration_state: "REFERENCE",
    supported_agents: ["claude-code"],
    permissions: ["network:egress", "filesystem:write"],
    network_access: true,
    filesystem_access: true,
    scripts: true,
    hooks: false,
    dependencies: ["yt-dlp", "ffmpeg"],
    credential_requirements: [],
    approval_required: true,
    installation_scope: "none",
    last_reviewed: "2026-08-19",
    last_updated: "2026-08-19",
    security_notes:
      "Not yet independently reviewed (Phase 2F of the original Skills Lab bootstrap " +
      "was never completed - see docs/skills/SKILLS_REGISTRY.md). Not installed.",
  },
  {
    id: "chrome-devtools-mcp",
    name: "Chrome DevTools MCP",
    capability: "browser.debug",
    provider: "chrome-devtools-mcp",
    source: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    license: "Apache-2.0",
    trust_level: "TRUSTED",
    risk_level: "MEDIUM",
    status: "REVIEW",
    integration_state: "REFERENCE",
    supported_agents: ["claude-code", "codex", "gemini-cli"],
    permissions: ["network:egress", "process:spawn:local", "filesystem:write:scratch"],
    network_access: true,
    filesystem_access: true,
    scripts: true,
    hooks: false,
    dependencies: ["puppeteer-core"],
    credential_requirements: [],
    approval_required: true,
    installation_scope: "none",
    last_reviewed: "2026-08-31",
    last_updated: "2026-08-31",
    security_notes:
      "AI Skills Foundation pass (2026-08-31): evaluated at a design level only - no live " +
      "Docker/network test performed (contrast with Scrapling's live-verified entry above). " +
      "Official Google Chrome DevTools team package; drives/introspects a real Chrome instance " +
      "(console errors, network failures, DOM, performance traces) - complementary to " +
      "Playwright (which drives/asserts UI) rather than a duplicate. Recommended for local, " +
      "interactive, human-supervised debugging only, never a standing CI dependency, never " +
      "pointed at production - see docs/skills/chrome-devtools-mcp-evaluation.md for the full " +
      "writeup and the reasoning against jumping straight to APPROVED.",
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    capability: "web.research",
    provider: "firecrawl",
    source: "https://github.com/firecrawl/firecrawl",
    license: "AGPL-3.0 (self-hosted) / commercial (hosted API)",
    trust_level: "UNTRUSTED",
    risk_level: "MEDIUM",
    status: "REJECTED",
    integration_state: "REFERENCE",
    supported_agents: [],
    permissions: [],
    network_access: true,
    filesystem_access: false,
    scripts: false,
    hooks: false,
    dependencies: [],
    credential_requirements: ["api_key"],
    approval_required: true,
    installation_scope: "none",
    last_reviewed: "2026-08-31",
    last_updated: "2026-08-31",
    security_notes:
      "AI Skills Foundation pass (2026-08-31): REJECTED, not for a security defect but because " +
      "it duplicates a capability ('web.research') this registry's `scrapling` entry already " +
      "serves at integration_state VERIFIED (real Docker isolation, real SSRF policy, live-" +
      "tested - see that entry above and docs/skills/scrapling-integration.md). Adopting " +
      "Firecrawl's hosted API alongside would mean a second, unreviewed, paid third-party " +
      "dependency for the identical job and the same vendor-lock-in tradeoff already weighed " +
      "against in docs/skills/scrapling-integration.md section 6. Re-open only if a concrete " +
      "requirement Scrapling's provider cannot meet is identified - see " +
      "docs/skills/AI-FOUNDATION-AUDIT.md section 5.",
  },
];
