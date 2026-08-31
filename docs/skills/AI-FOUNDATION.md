# Syveka AI Skills Foundation

Entry point for this foundation pass. Read `AI-FOUNDATION-AUDIT.md` first — it explains what
already existed and why almost everything below is "extend," not "build."

## Architecture (as it actually exists today, not the aspirational diagram)

```
                    APPROVED BUSINESS DNA
                 (src/server/business-dna/context.ts —
                  the ONE read boundary every consumer shares)
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                      │
        ▼                     ▼                      ▼
   MODEL ROUTER          RAG / EMBEDDINGS      TENANT/RBAC/AUDIT
 src/server/ai/router.ts  src/server/ai/rag.ts  permissions.ts, audit.ts,
 (chat/deep/utility/         + openai.ts          tenantDb(orgId) + RLS
  title/sentiment/           embeddings
  summary/draft)
        │
        ├── src/server/integrations/anthropic.ts (streamClaude, tool-use loop)
        ├── src/server/integrations/openai.ts    (embeddings, moderation)
        └── src/server/ai/fallback.ts             (NEW — opt-in scaffolding,
                                                     NOT WIRED into any
                                                     call site yet)
        │
        ▼
  PRODUCT SURFACES: Chat · Voice (Vapi) · Inbox · Booking · CRM · Business DNA
  extraction (RegenerateFromWebsite) · Dashboard summaries
        │
        ▼
  QA / SECURITY: Playwright (tests/e2e/*, incl. NEW business-dna.spec.ts) ·
  vitest unit suite · RLS tests · CI gates (lint/typecheck/build/secret-scan)


SEPARATE SYSTEM — dev-tooling, not product-facing (see AUDIT §1-2):

  AI CODING AGENT (Claude Code / Codex / Gemini CLI)
              │
              ▼
     syveka-skills/ orchestrator (intent → plan → route → permission →
     approve → execute → evidence → verify → report)
              │
     ┌────────┼────────┐
     ▼        ▼         ▼
  REGISTRY  PROVIDERS  ADAPTERS
  (this     (Scrapling  (claude-code /
  pass adds  VERIFIED;   codex / gemini —
  chrome-    shadcn-mcp, one shared
  devtools-  21st.dev,   capability list)
  mcp +      claude-video
  firecrawl  REVIEW;
  entries)   remotion
             VERIFIED)
```

## Roadmap classification (as requested)

**NOW** (this pass delivers specs/foundation for all of these; code where a concrete, safe,
additive change existed):

| Item                             | This pass's contribution                                                                                                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skills Registry                  | Documented existing `syveka-skills/core/registry` in full; added 2 entries                                                                            |
| Subagent foundation              | Documented existing `syveka-skills/core/orchestrator.ts` (no app-level subagent system existed or was needed — see AUDIT §1)                          |
| Model Routing                    | Documented existing `src/server/ai/router.ts`; added `src/server/ai/fallback.ts` (opt-in, tested, unwired)                                            |
| Playwright/browser QA            | Documented existing suite; added `tests/e2e/business-dna.spec.ts` + `tests/e2e/helpers/auth.ts`                                                       |
| Chrome DevTools MCP evaluation   | Full evaluation doc + registry entry (`REVIEW`/`REFERENCE`)                                                                                           |
| Website → Business DNA ingestion | Gap review against Phase 7's 8 rules — 6 met, 1 partial, 1 real (documented, unbuilt) gap                                                             |
| Design Skill Stack               | Full specification for all 6 skills, referencing existing shadcn-mcp/21st.dev/tailwind tokens                                                         |
| Market/Competitor Research Skill | Full specification, reusing the VERIFIED Scrapling `web.research` pipeline                                                                            |
| QA/security foundation           | Ran the full existing eval suite; confirmed no regression; documented one pre-existing, environment-dependent (no Docker in this sandbox) test result |

**NEXT** (specified, not built):

- Syveka Conversations / AI Sales-DM Agent — full architecture spec written
  (`ai-sales-dm-agent-architecture.md`), zero channel code
- Instagram / WhatsApp / Messenger channel integrations
- Human Takeover, AI Follow-up, Comment-to-DM
- Business DNA regenerate-from-website conflict/missing-field indicator (scoped product feature,
  not architecture)

**LATER** (explicitly not touched):

- Autonomous Business Operator, advanced multi-agent workflows, market-map intelligence,
  autonomous marketing workflows, deeper business intelligence

## Where everything lives

| Topic                                          | Document                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Full audit                                     | `docs/skills/AI-FOUNDATION-AUDIT.md`                                            |
| Model routing                                  | `docs/skills/model-routing.md`                                                  |
| Browser QA                                     | `docs/skills/browser-qa.md`                                                     |
| Business DNA ingestion review                  | `docs/skills/business-dna-ingestion-review.md`                                  |
| Design Skill Stack                             | `docs/skills/design-skill-stack.md`                                             |
| Market/Competitor Research                     | `docs/skills/market-research-skill.md`                                          |
| AI Sales/DM Agent architecture                 | `docs/skills/ai-sales-dm-agent-architecture.md`                                 |
| Chrome DevTools MCP evaluation                 | `docs/skills/chrome-devtools-mcp-evaluation.md`                                 |
| Dev-tooling Skills Registry (machine-readable) | `syveka-skills/core/registry/data.ts` + `syveka-skills/docs/skills-registry.md` |
| Dev-tooling Skills Registry (human-readable)   | `docs/skills/SKILLS_REGISTRY.md`                                                |
| Dev-tooling architecture                       | `syveka-skills/docs/architecture.md`                                            |

## Security posture of this pass

- No secret, credential, or production configuration touched.
- No RLS/RBAC/tenant-isolation logic changed (nothing in this pass performs a tenant-scoped
  mutation).
- No new external network dependency added — `chrome-devtools-mcp` and `firecrawl` are registry
  entries only (`REVIEW`/`REJECTED`, `REFERENCE`), not installed packages.
- `src/server/ai/fallback.ts` changes no existing behavior — it's dead code from the app's
  perspective until a future PR adopts it at a specific call site.
- `tests/e2e/business-dna.spec.ts`'s save test writes a real row to whatever E2E account runs it —
  same precedent as the existing "CRM contact create" smoke test.

## Observability

Nothing in this pass adds a new AI call path that needs new observability — `withModelFallback`
is a pure control-flow wrapper with no logging of its own; a future adopting call site should log
through whatever mechanism it already uses (the existing call sites already vary: some via
`audit()`, some via plain request/response). Per-call cost estimation already exists
(`src/server/ai/cost.ts`) and needed no addition here.
