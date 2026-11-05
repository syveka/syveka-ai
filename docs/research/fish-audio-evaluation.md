# Fish Audio evaluation: independent re-check

**Status (2026-11-05):** this document adds to the full evaluation in
[docs/voice/fish-audio-evaluation.md](../voice/fish-audio-evaluation.md), written in draft PR #395.
It records a second, independent reading of the sources, what that changed, and what the stacked
branch added to the pilot. Read that document first for the method and the complete analysis.

**Recommendation: keep Fish Audio experimental. Do not replace the current text-to-speech, and do
not send it customer data.** The reason is data protection and unproven quality, not cost or code.

This is engineering analysis, not legal advice. Legal pages were read through an extraction tool,
so counsel should read the originals.

## What the second reading confirmed

Read from primary sources on 2026-11-05.

| Finding                                                                                                                     | Source                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Standard terms allow training: "Usage Data and Content may be used to develop, train, or enhance" AI models                 | [Terms](https://fish.audio/terms/)                                                                                                   |
| "By default your data stays in the United States"; inference in the US and Tokyo                                            | [Enterprise](https://fish.audio/enterprise)                                                                                          |
| No DPA or sub-processor list found. `fish.audio/dpa` returns 404. Zero retention is on enterprise contracts only            | [Enterprise](https://fish.audio/enterprise), [Models](https://docs.fish.audio/developer-guide/models-pricing/models-overview.md)     |
| Managed phone numbers are US and Canada only. BYO SIP is "the only way to use non-US/CA numbers"                            | [Numbers](https://docs.fish.audio/agents/telephony/phone-numbers.md), [BYO SIP](https://docs.fish.audio/agents/telephony/byo-sip.md) |
| Fish Agents is in public beta. Realtime speech recognition is in preview                                                    | [Agents](https://docs.fish.audio/agents/overview.md), [Realtime STT](https://docs.fish.audio/features/speech-to-text/realtime.md)    |
| Fish isn't a native Vapi voice provider (schema only partly read). Vapi's custom voice route is the only path               | [Vapi custom TTS](https://docs.vapi.ai/customization/custom-voices/custom-tts)                                                       |
| Community licence caps commercial use at USD 500,000 annual revenue. S2-Pro weights need a separate commercial licence      | [Licence](https://github.com/fishaudio/fish-speech/blob/main/LICENSE), [S2-Pro](https://huggingface.co/fishaudio/s2-pro)             |
| Finnish and Arabic are documented for the Agents platform and realtime STT. **Quality in either language is not evidenced** | [Voice and language](https://docs.fish.audio/agents/build/voice-language.md)                                                         |

## What it changed

| Topic                  | #395 said                                       | Re-check found                                                                                                                                                                              | Effect                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fish Agents price      | ~$0.083/min, derived; official rate "not found" | **$0.06/min all-in with basic LLMs (promotional)**, phone +$0.01, none on BYO SIP, number $1.20/month ([pricing](https://docs.fish.audio/agents/pricing.md))                                | Option C falls from about $0.098 to **$0.0707/min** with carrier inbound. It is cheaper than today's stack on paper. The rate is promotional, so this doesn't clear the blockers |
| GPU cost               | Estimated $2/hour                               | AWS g5.xlarge (24 GB) lists $1.067/hour in eu-north-1 and $1.258 in eu-central-1 ([AWS](https://aws.amazon.com/ec2/instance-types/g5/)). It fits S2-Pro's minimum only; Drama 3 needs 48 GB | Self-hosting's fixed cost is lower than #395 showed, and it still loses at every volume. The licence blocks it first                                                             |
| EU processing          | "Not found"                                     | The partner SLNG offers an `eu` region for S2.1 Pro only ([SLNG](https://docs.fish.audio/developer-guide/integrations/slng.md)). SLNG's own DPA and residency terms were **not checked**    | A possible route worth one question. It adds a second processor and doesn't answer the training clause                                                                           |
| Hosted-service wording | "Needs a lawyer"                                | The licence excepts "an assistant's spoken replies", and customers of your own generally available product needn't meet the threshold                                                       | Possibly friendlier than it looked. Still a question for counsel, and S2.1-Pro weights weren't found                                                                             |
| fish-speech release    | v3.0.0-beta, 2026-10-13                         | Both true: that is the latest pre-release. The latest **stable** release is v1.5.1, 2025-05-31                                                                                              | The open-source project has had no stable release in over 17 months                                                                                                              |

Everything else in #395's Fish findings held.

## Documented support is not tested performance

| Capability                       | Documented                                                       | Tested here                                    |
| -------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| TTS streaming (REST, WebSocket)  | Yes                                                              | Adapter against mocked `fetch` only            |
| Latency                          | Vendor: ~500 ms normal, ~300 ms balanced, ~100 ms S2-Pro on H200 | **Not tested.** No real call was made          |
| Speech recognition               | Realtime preview, `fi` and `ar` listed                           | Not tested                                     |
| WebRTC, interruption, tool calls | Fish Agent SDK (LiveKit), `session.interrupt()`, client tools    | Not tested. The SDK has 1 star and is at 0.3.0 |
| Voice cloning                    | Requires ownership or consent                                    | Not tested                                     |
| Finnish and Arabic quality       | Languages listed; no dialects listed                             | **Not tested, and nobody has listened to it**  |
| Telephone connectivity           | BYO SIP over TCP for Finland                                     | Not tested                                     |

## What this branch added to the pilot

The pilot in #395 proved the integration boundary. Compared with this mission's requirements it
had three gaps, which this branch closes without touching production voice code.

| Gap                   | Added                                                                                                                                                                                                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scripted caller only  | `callerText`: a typed caller turn, standing in for speech recognition. A keyword match picks which fixed, scripted tool call runs. The text never becomes a tool argument, so injected instructions can trigger the mock booking but can't change its contents                                        |
| No usage tracking     | Per-organization counts of turns, characters, UTF-8 bytes and audio seconds, with list-price estimates: zero for the mock and the free model, unknown where no price is recorded, and failed turns kept apart as an upper bound. `GET` on the pilot route returns only the session's own organization |
| No latency aggregates | First-audio percentiles, with mock and real timings stored apart so a mock delay can't be read as provider latency                                                                                                                                                                                    |

**Still not a voice conversation.** There is no microphone input, speech recognition or LLM, and
the audio is a test tone. Real speech recognition and real synthesis both need a key and paid or
approved calls, so those parts are **BLOCKED** on your approval. **No voice quality or latency claim
can be made from this pilot.** The page has also never been opened in a browser, because it needs a
local Supabase and Redis.

## Production readiness

| Question                          | Answer            | Evidence                                                                                                                                                   |
| --------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Replace the existing TTS?      | **No**            | Terms allow training, US and Tokyo processing, no DPA found. TTS is about 6% of call cost, and Fish costs slightly more than Azure                         |
| 2. Supplement the existing TTS?   | **Not yet**       | Only worthwhile if it sounds clearly better in Finnish or Arabic, which nobody has measured. It would also add a server of ours to every call's audio path |
| 3. Power browser voice chat?      | **No**            | The SDK talks only to agents hosted by Fish, so it inherits the same data blockers. Beta, 1 star. The browser pilot already exists without it              |
| 4. Remain an experimental option? | **Yes, this one** | One listening test on synthetic text is cheap and answers the only open upside. `s2.1-pro-free` is documented as free through 2026-11-30                   |
| 5. Be rejected?                   | **Not outright**  | Reject Fish Agents and self-hosting for phone calls now. Keep Fish TTS open until the listening test and a written answer on the DPA and training          |

## Blockers

- **Paid or authenticated API access:** needed for any real audio. Not attempted.
- **Written answers from Fish:** DPA, sub-processors, EU processing, no-training commitment, the
  S2.1-Pro language list.
- **Native FI and AR listeners:** needed for any quality judgement. The pilot's lines haven't been
  reviewed by native speakers.
- **Real +358 baseline calls:** nothing in the repo measures today's stack on a real call either, so
  there is nothing yet to compare a provider against.
