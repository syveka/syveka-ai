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

| Provider                | Real or stub | Why                                                                                                                                                                                                    |
| ----------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `local-test-runner`     | **Real**     | Runs an actual command via `execFile` (fixed argv, never a shell string) and captures real stdout/stderr as evidence                                                                                   |
| `git-diff`              | **Real**     | Runs actual `git diff`/`git diff --stat`                                                                                                                                                               |
| `skill-registry-lookup` | **Real**     | Searches the actual in-memory registry, which itself traces back to `docs/skills/SECURITY_REVIEW.md`                                                                                                   |
| `shadcn-mcp`            | Stub         | No live MCP session configured in this environment; registry status REVIEW (not independently reviewed for this MVP)                                                                                   |
| `twentyfirst-dev`       | Stub         | Metered/remote-generation service requiring an API key and owner approval before any live use                                                                                                          |
| `scrapling`             | Stub         | **Passed** security review (`docs/skills/SECURITY_REVIEW.md`, PASS WITH CONDITIONS) but was deliberately never installed - review passing and being wired up as a live dependency are different events |
| `claude-video`          | Stub         | Registry status REVIEW - never independently reviewed in the Skills Lab work so far                                                                                                                    |

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

## Connecting a real external provider (future work, not done here)

To move `scrapling`, `shadcn-mcp`, `twentyfirst-dev`, or `claude-video` from stub to real:

1. Complete or re-confirm its security review (`docs/skills/SECURITY_REVIEW.md` pattern).
2. Implement a real `Provider` (an MCP client call, an HTTP call, or a subprocess call) in place
   of `createUnavailableStubProvider(...)`.
3. Update its registry entry's `status` to `APPROVED` only once (1) and (2) are both true - not
   before.
4. Add an eval proving the new provider reports `UNAVAILABLE` correctly when its connection is
   actually down (not just when it's happy-path successful) - see
   `evals/provider-availability.test.ts` for the pattern to follow.

None of this was done as part of this MVP - see `docs/mvp.md`'s explicit non-goals.
