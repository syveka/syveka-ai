# Haiku 5.5 for voice: compatibility and savings

Code base: `origin/main` at `40f71ae7`. Sources read 2026-11-05. **No model was changed or called.**

**Conclusion: worth a controlled test, not a straight swap.** Vapi accepts the id, and the savings are
real but modest. Two things must be checked first: whether Vapi's calls succeed at all, and whether
the summary job would break if it moved too.

## Savings

Estimated with the assumptions in `pricing-and-profitability.md`, plus Anthropic's statement that Haiku
5.5 uses about 30% more tokens for the same text.

|                    | Haiku 4.5 | Haiku 5.5 |
| ------------------ | --------- | --------- |
| Input per million  | $1.00     | $0.10     |
| Output per million | $5.00     | $0.50     |
| Per call minute    | $0.0130   | $0.0017   |

| Minutes a month | Saving a month |
| --------------- | -------------- |
| 1,000           | $11            |
| 10,000          | $113           |
| 100,000         | $1,131         |

This lowers the per-minute cost from about $0.0776 to $0.0663, or about 15%. These prices apply to
prompts up to 100,000 tokens, which voice calls stay well under. Adaptive thinking isn't priced in: its
tokens would reduce the saving, and the amount is unknown.

## Compatibility

| Check                      | Finding                                                                                                                                                                                                          | Status                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Vapi allows the id         | `AnthropicModel.model` in Vapi's OpenAPI includes both `claude-haiku-5-5` and `claude-haiku-4-5-20251001`                                                                                                        | **Verified**                                                                              |
| Temperature                | Anthropic: omit `temperature`, because it returns 400 on API version 2026-10-21, and on earlier versions when non-default. Vapi's schema says "Default is 0.5". The code sends none, so Vapi's default may apply | **Blocking unknown.** Whether Vapi omits it wasn't found. A single test call answers this |
| Thinking                   | Adaptive thinking is on by default, and its tokens count toward `max_tokens`. Vapi's `thinking` field only accepts `enabled` with a budget, which returns 400 on this model. Leave it unset                      | **Unknown latency cost.** Extra thinking directly delays a caller's reply                 |
| Tool calling               | Thinking blocks must be passed back unmodified with tool results. Vapi does this on Syveka's behalf, so it can't be checked in the repo                                                                          | **Test:** a booking call                                                                  |
| Refusals                   | New `stop_reason: "refusal"`, with no server-side fallback. How Vapi handles it wasn't found                                                                                                                     | Test if reachable                                                                         |
| Retirement pressure        | Haiku 4.5 is active with no retirement date. Haiku 5.5 is not retired before 7 October 2027. So there's no urgency                                                                                               | **Verified**                                                                              |
| Syveka's router            | `routeModel("voice").model` feeds `vapi.ts:126`. `tests/unit/vapi-language-config.test.ts` pins the current id, which would need a deliberate update                                                             | **Verified**                                                                              |
| Finnish and Arabic quality | Untested. No evidence either way for tool-heavy phone turns                                                                                                                                                      | **Test**                                                                                  |

## The trap in moving other routes

Keep this to the `voice` route. The Vapi path doesn't use the same code as Syveka's direct Anthropic
calls.

`src/app/api/v1/jobs/post-call/route.ts:221` reads `res.content[0]` and treats anything other than text
as empty. Anthropic's migration guide says to select content by `type`, since thinking blocks can come
first. If the `summary` route moved to Haiku 5.5 without a fix, calls could silently lose their summary
and CRM activity, logged only as `invalid_response`. The same review would apply to the other users of
`routeModel("summary")`, and the installed SDK (`@anthropic-ai/sdk ^0.39.0`) would need checking.

## Test plan, once approved

**Free, before any call:** read Vapi's docs or ask its support whether `temperature` is omitted for this
model. The change itself is one line plus a test update, on its own branch.

**Paid, staging only, as a phase of `phone-call-test-plan.md`:** use one test assistant in Finnish and
one in Arabic. About 20 calls of 3 minutes is about $4.62.

| Measure                                       | Pass                                                        |
| --------------------------------------------- | ----------------------------------------------------------- |
| Call starts and the model replies             | Every call. Any 400 from the model stops the test           |
| Time from end of caller speech to reply       | No worse than Haiku 4.5's baseline by more than 200 ms      |
| Booking and contact tools                     | Same success rate as the baseline, with no duplicate writes |
| Slots offered only from the availability tool | Every call                                                  |
| Arabic and Finnish replies                    | Native reviewer rates them at least as good as baseline     |
| Real cost per minute, from `costCents`        | Lower than baseline                                         |

**Rollback:** revert the router line and re-sync assistants. There's no data change.

Don't run this until a Haiku 4.5 baseline exists, or the comparison means nothing.

## Sources

[Vapi OpenAPI](https://api.vapi.ai/api-json),
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing),
[Haiku 5.5 overview](https://platform.claude.com/docs/en/models/haiku-5-5/overview),
[migration guide](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide),
[deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations).
