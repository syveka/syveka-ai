# Syveka Master Skill — Provider Model

## The interface

Every provider - first-party or third-party-wrapping - implements `providers/types.ts`'s
`Provider`:

```ts
interface Provider {
  id: string;
  isAvailable(): Promise<boolean> | boolean;
  execute(input: Record<string, unknown>): Promise<ProviderResult>;
}
```

`ProviderResult.status` is `"SUCCESS" | "FAILURE" | "UNAVAILABLE"` - a closed set. There is no
fourth option that means "sort of worked" or "probably fine." A provider either did the work and
can prove it, failed and can say why, or wasn't available and says so honestly.

## Real vs. stub providers in this MVP

| Provider                | Real or stub | Why                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `local-test-runner`     | **Real**     | Runs an actual command via `execFile` (fixed argv, never a shell string) and captures real stdout/stderr as evidence                                                                                                                                                                                     |
| `git-diff`              | **Real**     | Runs actual `git diff`/`git diff --stat`                                                                                                                                                                                                                                                                 |
| `skill-registry-lookup` | **Real**     | Searches the actual in-memory registry, which itself traces back to `docs/skills/SECURITY_REVIEW.md`                                                                                                                                                                                                     |
| `shadcn-mcp`            | Stub         | No live MCP session configured in this environment; registry status REVIEW (not independently reviewed for this MVP)                                                                                                                                                                                     |
| `twentyfirst-dev`       | Stub         | Metered/remote-generation service requiring an API key and owner approval before any live use                                                                                                                                                                                                            |
| `scrapling`             | **Real**     | Milestone 2: real Docker-isolated provider (`providers/scrapling/`), gated by a real SSRF/URL policy, live-tested against real Docker + real network - 5/5 passing (`evals/scrapling-live.test.ts`). See `docs/skills/scrapling-integration.md` "Milestone 2" for the two real bugs live testing caught. |
| `claude-video`          | Stub         | Registry status REVIEW - never independently reviewed in the Skills Lab work so far                                                                                                                                                                                                                      |

A stub provider (`providers/unavailable-stub.ts`) always returns `isAvailable() === false` and
`execute()` returning `{status: "UNAVAILABLE", ...}`. It never pretends to succeed and then fails
later - see `docs/mvp.md`'s failure-handling section and `evals/provider-availability.test.ts`.

## Why this matters for the demos

Two of the three MVP demos (`examples/demo-ui-improvement`, `examples/demo-skill-discovery`)
deliberately exercise stub/no-match paths rather than fabricated successes - see `docs/mvp.md`
"Demo results" for why that is itself the point being demonstrated, not a shortfall.

## Provider abstraction and replaceability

Nothing in `core/` ever imports a provider module directly - the orchestrator receives a
`providerMap: Record<string, Provider>` from its caller and only ever looks up providers by the
string `provider` field recorded in a matched `RegistryEntry`. Swapping Scrapling for a different
crawler, or shadcn for a different component registry, means:

1. Add/change a registry entry's `provider` field and metadata.
2. Provide (or swap) the `Provider` implementation under that id in the caller's `providerMap`.
3. Nothing in `core/` changes.

This is the concrete mechanism behind the product brief's requirement: "Syveka owns the capability
abstraction. Third parties are replaceable providers."

## Connecting a real external provider

Scrapling has already gone through this path in full - see `providers/scrapling/` and
`docs/skills/scrapling-integration.md`'s "Milestone 2" section for the worked example, including
two real bugs (`--read-only` incompatible with the image's entrypoint; an external test service
that stopped behaving as documented) that only live testing caught. The same path remains open for
`shadcn-mcp`, `twentyfirst-dev`, or `claude-video`:

1. Complete or re-confirm its security review (`docs/skills/SECURITY_REVIEW.md` pattern) - and
   re-confirm it's still current for the exact version being wired, not just trusted from memory
   (Scrapling's version/commit was re-checked against the live GitHub API before any code was
   written this milestone).
2. Implement a real `Provider` (an MCP client call, an HTTP call, or a subprocess call) in place
   of `createUnavailableStubProvider(...)`.
3. Keep `integration_state` honest at every step (`INSTALLED` once code exists but is untested,
   `CONNECTED` once manually run once, `VERIFIED` only once automated evals actually exercise the
   live path and pass) - see `docs/skills-registry.md` "Integration state vs. review status." Do
   not jump straight to `VERIFIED`.
4. Add an eval proving the new provider reports `UNAVAILABLE` correctly when its connection is
   actually down (not just when it's happy-path successful) - see
   `evals/provider-availability.test.ts` for the pattern to follow, and
   `evals/scrapling-provider.test.ts` for a fuller worked example including SSRF/policy rejection.
5. If the provider can access external/untrusted content, add prompt-injection evals proving that
   content cannot escalate beyond inert evidence - see `evals/scrapling-prompt-injection.test.ts`.

`shadcn-mcp`, `twentyfirst-dev`, and `claude-video` have not been moved past `REFERENCE` - see
`docs/mvp.md`'s explicit non-goals for what remains undone.
