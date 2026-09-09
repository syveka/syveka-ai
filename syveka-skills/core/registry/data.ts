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
    id: "composio",
    name: "Composio",
    capability: "integration.gateway",
    provider: "composio",
    source: "https://github.com/ComposioHQ/composio",
    // Verified directly against the ComposioHQ/composio GitHub repo during this review
    // (2026-09-07): MIT.
    license: "MIT",
    // CONDITIONAL, not TRUSTED: well-governed, permissively licensed, official MCP endpoint -
    // but its entire purpose is holding OAuth grants and executing authenticated actions
    // against third-party apps (Gmail, Calendar, Drive, Slack, GitHub, CRMs, "1000+
    // toolkits") on a tenant's behalf, which is a fundamentally higher-trust-requirement
    // shape than a read-only fetch or a local render.
    trust_level: "CONDITIONAL",
    // HIGH: this is a candidate integration GATEWAY, not one reviewed action. It would hold
    // per-tenant OAuth credentials and execute real external actions (send email, create
    // calendar events, write to a CRM, etc.) - squarely in HIGH_RISK_ACTIONS territory
    // (credentials.access, message.send.external) per policies/risk-classification.ts. No
    // milestone here narrows that to one low-risk action the way Scrapling's Milestone 2
    // narrowed to plain-HTTP-only - see docs/skills/composio-integration.md.
    risk_level: "HIGH",
    // REVIEW, not APPROVED/EXPERIMENTAL: not routable (core/registry/index.ts
    // eligibleForRouting) until the conditions in docs/skills/composio-integration.md are
    // independently reviewed and signed off - least-privilege OAuth scoping, explicit
    // tenant/user identity binding, no cross-tenant credential reuse, a GDPR and privacy review,
    // and a completed PoC (Phase 7) demonstrating audited, revocable, tenant-isolated access.
    status: "REVIEW",
    // REFERENCE: studied and documented only. providers/composio/index.ts exists but is an
    // honest always-unavailable stub (createUnavailableStubProvider), same shape as
    // shadcn-mcp/twentyfirst-dev/claude-video above - no OAuth app registered, no live
    // connection, no PoC executed against a real account.
    integration_state: "REFERENCE",
    supported_agents: ["claude-code", "codex", "gemini-cli"],
    permissions: ["network:egress", "credentials:oauth:third_party", "action:execute:external"],
    network_access: true,
    filesystem_access: false,
    scripts: false,
    hooks: false,
    dependencies: [],
    credential_requirements: ["api_key", "oauth_per_connected_app"],
    approval_required: true,
    installation_scope: "none",
    last_reviewed: "2026-09-07",
    last_updated: "2026-09-07",
    security_notes:
      "P1/EXPERIMENTAL candidate integration gateway, not a standing dependency. Official " +
      "repo re-confirmed MIT-licensed and offers a hosted MCP endpoint (works with Claude, " +
      "Cursor, and other MCP clients) plus per-session OAuth handling for connected " +
      "third-party apps - real capability, not vaporware. Held at REVIEW because none of the " +
      "following exist yet, all required before any production use: least-privilege OAuth " +
      "scope review per connected app, explicit tenant/user identity binding (never a " +
      "client-supplied org id - see CLAUDE.md Sec.4), a guarantee against cross-tenant " +
      "credential reuse, secret/token handling proven to never reach prompts/logs/source " +
      "control, human confirmation before any destructive/high-impact external action, an " +
      "audit trail for every external action taken, a safe token lifecycle (issuance, " +
      "rotation, revocation), a GDPR and privacy review (Composio is a US-based third party " +
      "sitting between Syveka and tenant-connected accounts), explicit vendor-lock-in " +
      "awareness, and a native Syveka fallback path for any integration this would replace " +
      "that Syveka already implements natively (e.g. Google/Microsoft Calendar - see " +
      "src/server/integrations/calendar/). See docs/skills/composio-integration.md for the " +
      "full evaluation, the USE/DO-NOT-USE rules, and the PoC design.",
  },
  {
    id: "perplexity",
    name: "Perplexity API (Agent/Search/Router/Embeddings)",
    capability: "research.cited",
    provider: "perplexity",
    source: "https://docs.perplexity.ai",
    // Hosted commercial API, not an open-source project - there is no OSI license to cite.
    // Verified directly against docs.perplexity.ai during this review (2026-09-07).
    license: "Proprietary (hosted API - Perplexity AI, Inc. commercial terms, not open-source)",
    // CONDITIONAL: official, well-documented, key-authenticated API from a known vendor, but
    // every query sent to it leaves Syveka's infrastructure to a third-party AI provider.
    trust_level: "CONDITIONAL",
    // MEDIUM, not HIGH: read-only research (no OAuth, no write access to any tenant or
    // third-party system, no destructive capability) - but query text can carry business-
    // context wording, so it falls under policies/risk-classification.ts's
    // "tool.generate.external" MEDIUM category, not LOW, until a data-minimization review
    // confirms exactly what leaves Syveka in a query.
    risk_level: "MEDIUM",
    // REVIEW: not routable yet. Held pending a provisioned API key, a data-minimization
    // review of what query text is allowed to leave Syveka, and the benchmark PoC (Phase 8)
    // comparing it against the existing web.research (Scrapling) pipeline before any product
    // surface (e.g. Business DNA enrichment) is allowed to call it.
    status: "REVIEW",
    // REFERENCE: studied and documented only. providers/perplexity/index.ts exists but is an
    // honest always-unavailable stub, same shape as shadcn-mcp/twentyfirst-dev/claude-video -
    // no API key provisioned, no live call made.
    integration_state: "REFERENCE",
    supported_agents: ["claude-code", "codex", "gemini-cli"],
    permissions: ["network:egress"],
    network_access: true,
    filesystem_access: false,
    scripts: false,
    hooks: false,
    dependencies: [],
    credential_requirements: ["api_key"],
    approval_required: true,
    installation_scope: "none",
    last_reviewed: "2026-09-07",
    last_updated: "2026-09-07",
    security_notes:
      "P2/optional research provider - never the default model, never a standing dependency. " +
      "Re-confirmed against docs.perplexity.ai (2026-09-07): the Agent/Search APIs return " +
      "web-grounded answers with built-in citations, authenticated via a Bearer API key " +
      "(PERPLEXITY_API_KEY, not provisioned in this repo/.env.example - see " +
      "docs/skills/perplexity-research-integration.md); no first-party MCP server offering " +
      "was found as of this review, so a real integration would be a direct HTTP client, not " +
      "an MCP session (contrast Composio/Scrapling above). Pricing combines per-request " +
      "search fees with token costs (cost-aware call budgeting required before production " +
      "use - see docs/skills/perplexity-research-integration.md 'Cost awareness'). Distinct " +
      "capability from `web.research` (Scrapling): this returns an AI-synthesized, cited " +
      "answer to a research question, not raw fetched/extracted page content - complementary, " +
      "not a duplicate (same reasoning pattern as chrome-devtools-mcp vs. Playwright above), " +
      "so this is not a repeat of the Firecrawl REJECTED-for-duplication finding. Sensitive or " +
      "private tenant data must never be included in a query sent to this third-party " +
      "provider; citations/sources must be preserved end-to-end wherever a result is surfaced; " +
      "outputs must be visibly separated from Syveka's own authoritative Business DNA data, " +
      "never merged in silently. See docs/skills/perplexity-research-integration.md for the " +
      "full evaluation, the USE/DO-NOT-USE rules, and the benchmark PoC design.",
  },
  {
    id: "voice-summary",
    name: "Voice Call Summary",
    capability: "voice.summarize",
    provider: "voice-summary",
    source: "docs/skills/voice-call-summary.md",
    // First-party Skill definition, not a third-party project - no OSI license to cite. A real
    // implementation would depend on an external AI vendor (see risk_level below), but the
    // Skill contract itself (schema, provider interface, registry entry) is Syveka's own.
    license:
      "N/A (first-party Skill; a real provider implementation would depend on a licensed AI vendor)",
    // CONDITIONAL: a real provider would send call-transcript text (potential PII) to an
    // external AI vendor for summarization - same trust category as perplexity/composio above,
    // not TRUSTED (unlike local-test-runner/git-diff, which never leave this machine).
    trust_level: "CONDITIONAL",
    // MEDIUM: read-only summarization (no destructive action, no OAuth, no write access to any
    // tenant/production system from within this Skill), but transcript text can carry
    // personally identifiable caller information - see
    // policies/risk-classification.ts's "voice.summarize.external" MEDIUM entry, added
    // alongside this registry row.
    risk_level: "MEDIUM",
    // REVIEW: not routable. No live provider connection exists yet - see integration_state.
    // The root app's own production call-summary pipeline
    // (src/app/api/v1/jobs/post-call/route.ts) already calls Anthropic directly today and is
    // NOT routed through this Skill; wiring that connection here is future work, tracked in
    // docs/skills/voice-call-summary.md, not this milestone.
    status: "REVIEW",
    // REFERENCE: providers/voice-summary/index.ts exists but is an honest always-unavailable
    // stub, same shape as composio/perplexity/shadcn-mcp above - no LLM call wired up, no API
    // key provisioned. providers/voice-summary/deterministic-test-provider.ts is a separate,
    // test-only, never-registered provider used solely by
    // evals/voice-call-summary.test.ts to prove the Skill's own contract (schema validation,
    // permission evaluation, evidence, verification, audit) end-to-end without a live/paid call.
    integration_state: "REFERENCE",
    supported_agents: ["claude-code", "codex", "gemini-cli"],
    permissions: ["network:egress"],
    network_access: true,
    filesystem_access: false,
    scripts: false,
    hooks: false,
    dependencies: [],
    credential_requirements: ["api_key"],
    approval_required: true,
    installation_scope: "none",
    last_reviewed: "2026-09-08",
    last_updated: "2026-09-08",
    security_notes:
      "First real Syveka Skill built end-to-end against this repo's Skill architecture " +
      "(registry/routing, schema validation, permission/risk evaluation, provider execution " +
      "boundary, evidence/verification, audit) - the milestone this entry documents is proving " +
      "that architecture works, not shipping a live call-summarization connection. Input " +
      "(providers/voice-summary/schema.ts) is a caller-supplied transcript + safe correlation " +
      "id + optional language/duration metadata, .strict()-validated with no field capable of " +
      "carrying provider credentials/configuration. Output distinguishes observed transcript " +
      "facts (keyFacts) from a derived summary (summary/callerIntent/actionItems) from " +
      "explicitly-flagged uncertain information (uncertain) - never merged. Transcript content " +
      "is treated as data, never as instructions (evals/voice-call-summary.test.ts includes an " +
      "injection-payload adversarial case, mirroring evals/untrusted-web-content.test.ts's " +
      "existing pattern); audit records and error messages never include raw transcript text, " +
      "only safe identifiers (callId, urgency, confidence, followUpRequired). verify() " +
      "correctly resolves a successful run to UNVERIFIED, not COMPLETE - a summary's factual " +
      "accuracy cannot be independently confirmed by this system from the evidence types " +
      "currently defined (core/evidence/index.ts's STRONG_EVIDENCE_TYPES has no category for " +
      "AI-generated interpretive output), matching this product's own anti-sycophancy " +
      "principle (docs/security-model.md) rather than being treated as a gap to paper over. " +
      "What remains before promotion past REVIEW/REFERENCE: a real provider implementation " +
      "(an actual AI vendor call), a data-minimization review of exactly what transcript " +
      "content is sent externally, and a decision on whether/how this Skill should relate to " +
      "the root app's existing, independent, already-in-production call-summary pipeline " +
      "(src/app/api/v1/jobs/post-call/route.ts) rather than duplicating it. See " +
      "docs/skills/voice-call-summary.md for the full Skill contract and this milestone's " +
      "evidence trail.",
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
