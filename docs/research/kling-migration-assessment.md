# Kling migration assessment

For the owner and engineers. **No API call was made and nothing was migrated,** by owner decision of
2026-11-05. Code was read on `origin/main` at `40f71ae7`. Vendor facts are from fal's public pages on
2026-11-05, and they describe documented behaviour, not tested behaviour.

**Recommendation: don't migrate yet, but plan for it.** `v2.5-turbo/standard` looks like a config-only
change that's slightly cheaper, and `v3/standard` is a code change that could double cost or add audio.
Approve one small paid test when you're ready. There's no removal date, so this isn't urgent today, but
it could become urgent without notice.

## Current state

| Item               | Value                                                                                               | Evidence                                           |
| ------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Default model      | `fal-ai/kling-video/v2.1/standard/image-to-video`                                                   | `src/server/ai/creator/fal-provider.ts:27`         |
| Override           | `FAL_IMAGE_TO_VIDEO_MODEL`, no code change                                                          | `fal-provider.ts:33`, `src/env.ts:107`             |
| Fields sent        | `prompt`, `image_url`, `duration` as `"5"` or `"10"`                                                | `fal-provider.ts:233-238`                          |
| Fields read        | `video.url`, `video.content_type`                                                                   | `fal-provider.ts:158-160`                          |
| Credits            | 60 base × 2 for fal × duration. The model is ignored, so a price change doesn't change credits      | `src/server/services/creator-credits.ts:29-66`     |
| Recovery           | Status and response URLs and the model are stored per job, so jobs in flight survive a model change | `fal-provider.ts:40-45`, `creator-generations.ts`  |
| Model name check   | Any safely formed model id can be recorded                                                          | `creator-generations.ts:53-62`                     |
| Input URL lifetime | Signed for 600 s. One live 5 s generation took about 71 s                                           | `fal-provider.ts:20`, `docs/creator-studio.md:368` |

**Fal has retired a model on this code before.** v1.5 left the catalog (comment at `fal-provider.ts:24-26`),
and `docs/creator-studio.md:152` still names it.

## Status of the current endpoint

fal's page says: "This endpoint is deprecated. This model is no longer supported." Page data shows
`deprecated:true` and `removed:false`. **It names no date and no successor.** The same page gives two
prices: $0.28 for 5 s plus $0.056/s, and $0.25 plus $0.05/s. Real billing would settle which applies.

## Candidates

| Aspect             | v2.1 standard (current) | v2.5-turbo standard                     | v3 standard                                             |
| ------------------ | ----------------------- | --------------------------------------- | ------------------------------------------------------- |
| Deprecated         | Yes                     | No                                      | No                                                      |
| Image field        | `image_url`             | `image_url`                             | **`start_image_url`**                                   |
| `prompt`           | Required                | Required                                | Optional, or `multi_prompt`, never both                 |
| `duration`         | `"5"`, `"10"`           | `"5"`, `"10"`                           | `"3"` to `"15"`                                         |
| Audio              | None                    | None                                    | **`generate_audio` defaults to true**                   |
| Output `video.url` | Yes                     | Yes                                     | Yes                                                     |
| Listed provider    | Partner                 | fal                                     | Partner                                                 |
| Price for 5 s      | $0.25 or $0.28          | $0.21                                   | $0.42 audio off, $0.63 on (page data also shows `0.14`) |
| Price for 10 s     | $0.50 or $0.56          | $0.42                                   | $0.84 audio off, $1.26 on                               |
| Change needed      | None                    | **Environment variable only, on paper** | **Code**: new field, audio off, new tests               |

fal doesn't call v2.5-turbo the replacement; the match is what the schemas show. Quality and speed are
unknown for all of them, and "turbo" may look different on real footage.

**A naive switch to v3 fails or costs more.** Setting only the environment variable would send
`image_url`, which v3 doesn't list. Fixing just that leaves audio on by default, at 50% more cost, and
adds sound nobody asked for.

## Not known until a paid test

Motion quality, on Syveka's actual kinds of images. Latency, and whether the 600 s signed URL still
suffices at peak. Whether `duration` is honoured exactly, and the real billed amount. Whether the safety
checker, on by default, refuses more or less. How 9:16, 1:1, 4:5 and 16:9 inputs come out.

## Proposed migration, each step separately approved

| Step | Action                                                                                                           | Cost             | Approval                  |
| ---- | ---------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------- |
| 0    | Fix stale docs, and add an alert on fal submission failures                                                      | None             | Normal PR                 |
| 1    | Paid comparison on staging: v2.1 and v2.5-turbo, the same few synthetic images, 5 s and 10 s, four aspect ratios | Under about $10  | **Owner: paid calls**     |
| 2    | Visual review. Record cost, time and failures                                                                    | None             | Owner decides             |
| 3    | Set `FAL_IMAGE_TO_VIDEO_MODEL` on staging only                                                                   | Normal use       | **Owner: staging config** |
| 4    | Set it in production, watch failures and cost for a week                                                         | Slightly cheaper | **Owner: production**     |
| 5    | Change the code default, its test at `tests/unit/fal-provider.test.ts:233`, and the docs                         | None             | Normal PR                 |

Only look at v3 if 2.5-turbo isn't good enough, as a separate code change with audio explicitly off.

**Rollback at steps 3 and 4:** unset the variable and redeploy. Jobs in flight keep their stored URLs.
**That works only while fal still serves v2.1,** so the contingency for a sudden removal is to run step
1 soon enough to know that v2.5-turbo works, before there's any pressure.

**Credit impact:** none automatically, since credits ignore the model. At v2.5-turbo, Syveka's cost per
generation falls by about 16–25%, so margin rises slightly. v3 with audio off costs 50–68% more per
clip than today's, and at that point credits should be reviewed.

## Commercial use

fal's terms have unresolved questions about output ownership and third-party benefit, for this model and
any other. See [legal-questions-for-counsel.md](legal-questions-for-counsel.md). **A migration doesn't
resolve them.** The v2.5-turbo page shows the same "Commercial use" badge with no licence text.
