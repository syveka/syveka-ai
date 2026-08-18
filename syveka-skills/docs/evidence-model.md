# Syveka Master Skill — Evidence Model

## The core rule

> "Security issue fixed." — bad.
>
> "Security issue fixed. Evidence: regression test added, test failed before the fix, test passes
> after the fix, targeted suite passes, diff reviewed, no unrelated files changed." — good.

This document specifies how "good" is enforced mechanically, not just requested politely.

## Evidence types (`schemas/index.ts` `evidenceItemSchema`)

| Type               | Strong? | Examples                                                       |
| ------------------ | ------- | -------------------------------------------------------------- |
| `test`             | Yes     | A real test run's pass/fail output                             |
| `build`            | Yes     | A real build's success/failure                                 |
| `ci_check`         | Yes     | A CI job's result                                              |
| `diff`             | Yes     | A real code diff                                               |
| `database_query`   | Yes     | A real query result (e.g. registry search)                     |
| `log`              | No      | Free-text log output - context, not proof                      |
| `screenshot`       | No      | Visual evidence - useful, but not machine-checkable on its own |
| `artifact`         | No      | A generated file's existence, without content verification     |
| `source_reference` | No      | A citation/URL - useful for citing, not for proving            |

"Strong" vs "weak" is not a judgment about honesty - a screenshot is real and useful. It's a
judgment about whether the evidence type is independently checkable by something other than the
agent's own narration of it. See `core/evidence/index.ts`'s `STRONG_EVIDENCE_TYPES`.

## Sufficiency rule

`evaluateSufficiency(bundle)`:

1. Zero evidence items -> insufficient. A bare claim is not proof.
2. Only weak-type items -> insufficient. Weak evidence is real context, not proof of correctness.
3. At least one strong-type item -> sufficient.

This is deliberately a low bar in one direction (one strong item is enough - this MVP does not
require, say, both a test AND a diff) and a hard bar in the other (zero strong items is never
enough, no matter how many weak items pile up). See `evals/evidence-sufficiency.test.ts`.

## Verification rule

`verify({ evidence, providerOutcome, userAssertsComplete? })`:

1. `providerOutcome === "FAILURE"` -> `FAILED`, regardless of evidence. The work didn't succeed;
   no amount of surrounding evidence changes that.
2. `providerOutcome === "UNAVAILABLE"` -> `UNVERIFIED`. Nothing ran, so nothing can be verified.
3. `providerOutcome === "SUCCESS"` and evidence insufficient -> `UNVERIFIED`.
4. `providerOutcome === "SUCCESS"` and evidence sufficient -> `VERIFIED`.

`userAssertsComplete` is accepted as a parameter specifically so a caller (or an eval) can pass
`true` and confirm it changes nothing - see `core/verification/index.ts`'s doc comment and
`evals/anti-sycophancy.test.ts`'s "produces the identical result whether or not
userAssertsComplete is set" test. This is the anti-sycophancy contract made mechanical: not "the
agent has been instructed to resist pressure," but "the function has no code path that reads
pressure as an input."

## Facts vs. assumptions vs. hypotheses

This MVP does not implement a separate typed distinction for these three categories in the
schema layer - that's a documented gap, not a silent one (see `docs/mvp.md`). In practice, the
distinction is enforced structurally by the evidence-type system above: a `test`/`diff`/`ci_check`
item is a **fact** (something happened, independently checkable); a `log`/`source_reference` item
is closer to an **assumption or observation** (someone/something reported this, unverified); and
anything not backed by _any_ evidence item is a **hypothesis** the verification engine will never
promote to `VERIFIED` on its own.

## Reversal resistance

Per the product brief: "do not reverse a validated conclusion merely because someone disagrees."
Because `verify()`'s output is a pure function of `{evidence, providerOutcome}` and nothing else,
there is no way to call it twice with the same evidence and providerOutcome and get a different
answer because a user pushed back between calls. Re-verifying after new evidence is legitimate
(new test run, new diff); re-verifying with the _same_ evidence and a different desired outcome is
not something this function's signature even allows.

## What this model does not claim

- It does not detect a _fabricated_ test result (a provider that lies about `SUCCESS`). That's a
  provider-trust problem, addressed by the registry/security-review layer
  (`docs/security-model.md`), not the evidence model.
- It does not grade evidence _quality_ beyond strong/weak (e.g. it does not distinguish a
  thorough test suite from a single trivial assertion). A future iteration could add evidence
  weighting - out of scope for this MVP, see `docs/mvp.md`.
