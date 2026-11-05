# Voice AI disclosure and recording notice: audit

Code base: `origin/main` at `40f71ae7`, and draft PR #335 at `98f97d49`. Sources read 2026-11-05,
mostly through a summarising fetch tool. **This is an engineering audit for counsel to review, not
legal advice.** No call was placed, so everything about what a caller actually hears is unverified.

## Summary

- **Today's `main` doesn't guarantee a spoken notice in any language.** The notice is only an
  instruction to the model, and the owner's greeting is spoken before the model runs.
- **Arabic is worse:** Arabic assistants get that instruction in English, and nothing fixed in Arabic
  exists on `main`.
- **#335 fixes the order and the language, and should go to counsel first.** It doesn't settle three
  things: whether recording starts before the notice, what the notice must say, and what a caller who
  objects can do.
- **The AI Act duty appears to be in force already.** The Commission's FAQ says Art. 50 applies from
  2 August 2026, and its guidelines name a spoken statement at the start for telephony. If any real
  caller is reaching these assistants now, this is a current exposure rather than a launch task.

## What a caller gets today

| Step            | On `main`                                                                                              | Evidence                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| First words     | The owner's free-text greeting, with no notice. Vapi speaks `firstMessage` without running the model   | `src/server/integrations/vapi.ts:120`, `services/voice.ts:338`             |
| AI notice       | A prompt instruction the model may skip or paraphrase, in Finnish for FI and **English for AR and EN** | `src/server/services/voice.ts:326-329`                                     |
| Recording       | Requested through a top-level field that Vapi's schema doesn't define. It works through Vapi's default | `vapi.ts:143`; Vapi OpenAPI: `artifactPlan.recordingEnabled` defaults true |
| Transcript      | Stored in `VoiceCall.transcript`, then summarised by Haiku                                             | `webhook/route.ts:496`, `post-call/route.ts:200-217`                       |
| Language chosen | One language per assistant, set by the owner. No caller detection                                      | `vapi.ts:134-138`, `validators/voice.ts:26`                                |
| Caller objects  | No path. No prompt instruction, tool or control exists for it                                          | `prompts/voice.ts`, `validators/voice.ts:9-14`                             |

## What the sources say

| Question                 | Source says                                                                                                                                                                                                 | Weight                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| When to disclose AI      | "at the latest at the time of the first interaction" (AI Act Art. 50(5)). For telephony: "explicit spoken statements at the beginning of the interaction", with "periodic reminders in longer interactions" | Statute; Commission guidelines C(2026) 5054, non-binding, ¶37                       |
| Who it binds             | Art. 50(1) is a provider duty, so it falls on how Syveka builds the system                                                                                                                                  | Statute                                                                             |
| On whose behalf          | Agents disclose their nature and "the person on whose behalf they are acting"                                                                                                                               | Guidelines ¶31, via a secondary copy                                                |
| Date                     | Art. 50 "applies as from 2 August 2026". The grace period to 2 December 2026 covers only Art. 50(2)                                                                                                         | Commission FAQ. Reg. 2026/1744 full text not read                                   |
| Finland: recording       | "Customers need to be informed of the recording before the company starts recording their calls." "A simple mention on the website will not suffice."                                                       | Deputy Ombudsman 2020 (release says "not final"; appeal outcome not found); TSV FAQ |
| Finland: consent         | The TSV FAQ frames it as a legal basis plus a duty to inform. It doesn't state a consent requirement                                                                                                        | Regulator FAQ                                                                       |
| What the notice contains | The first layer "should generally convey" purposes, controller identity and rights, with the rest available by other means                                                                                  | WP260 rev.01 ¶38                                                                    |
| Language                 | A translation "should be provided where the controller targets data subjects speaking those languages". No general language rule found in Art. 50                                                           | WP260 ¶13 (paragraph number unconfirmed)                                            |
| Objection                | Under legitimate interests the caller may object "at any time", and the right must be flagged by the first communication                                                                                    | GDPR Art. 21, via a secondary copy                                                  |
| Gulf                     | Consent appears to be the default under UAE and Saudi data law. Sources on recording conflict, and no authority on business service calls was found                                                         | **Low confidence**                                                                  |

## Review of PR #335

It merges cleanly with current `origin/main`. Its source change is correct as far as it goes.

**What it gets right:**

- A fixed notice is spoken first, in the assistant's language, and can't be skipped by the model.
- `firstMessageInterruptionsEnabled: false` means the notice can't be cut off. Both fields it sets
  exist in Vapi's schema.
- Recording moves to the documented field, keeping any dashboard options.
- It says plainly that consent wasn't decided, and that existing assistants keep the old config until
  they're re-synced.

**What it leaves open:**

| #   | Gap                                                                                                                                                                                                                          | Severity | Who decides             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------- |
| 1   | **Recording may start before the notice.** Vapi's docs don't say when recording starts relative to `firstMessage`. Finland's guidance says inform before recording, and #335 leaves recording on from the start              | High     | Counsel; test call      |
| 2   | **The notice names no business and no purpose.** It doesn't say on whose behalf the AI acts, or why the call is recorded. The owner's greeting may name the business, but nothing requires it, and it comes after the notice | High     | Counsel                 |
| 3   | **No path for a caller who objects.** Vapi's live control has "no pause action", so recording can't be stopped mid-call                                                                                                      | High     | Counsel, product        |
| 4   | **Arabic wording is unreviewed and addresses one gender.** "أنت تتحدث" is masculine singular                                                                                                                                 | Medium   | Native speaker, counsel |
| 5   | **Language mismatch.** A Finnish assistant answering an Arabic speaker gives only a Finnish notice, and the reverse                                                                                                          | Medium   | Counsel, product        |
| 6   | **No reminder.** Calls run up to 15 minutes, and the guidelines mention reminders in longer interactions                                                                                                                     | Low      | Counsel                 |
| 7   | **Human transfer.** Whether recording continues after `transferCall`, and whether the employee has been told, is unaddressed                                                                                                 | Medium   | Counsel; test call      |
| 8   | **Unknown Arabic pronunciation.** No one has heard `ar-SA-ZariyahNeural` say this line                                                                                                                                       | Medium   | Test call               |

The PR's stated "regression proof" and test results are from its own branch. They weren't re-run for
this audit against current `main`.

## Options for the recording timing

| Option                                                                            | Effect                                                                                                               | Cost and limits                                                                                                                |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **A. Recording off by default (recommended to put to counsel first)**             | No audio recording, so the timing question goes away for audio. Nothing else needs it: post-call uses the transcript | The recording playback in call details stops. Transcripts remain personal data and still need a notice                         |
| B. Notice in a first Vapi assistant with `recordingEnabled: false`, then hand off | Docs say recording "Pauses when `recordingEnabled: false` assistant is active" in a squad                            | Needs squads and a test call. Adds a hand-off and complexity. Whether transcription also stops isn't documented                |
| C. Vapi `recordingConsentPlan`                                                    | "Call recording only begins after consent is granted", with `stay-on-line` or `verbal`                               | Page is headed "Enterprise only". Message language isn't documented. Hanging up counts as refusal. Transcripts' gating unknown |
| D. Keep recording on and accept seconds of overlap                                | Simplest                                                                                                             | Contradicts the Finnish guidance if recording does start first. Not recommended without counsel's explicit acceptance          |

Option A is the smallest change and has the most certain legal effect, and it reduces how much data
Vapi holds. The owner may want recordings for quality review, in which case a tenant-level opt-in
with option B or C can follow later.

## Proposed notice wording: for counsel and a native reviewer only

These are drafts to react to, not approved text. `{business}` is the tenant's name. They assume option
A, so they speak of transcription rather than recording. If recording stays on, add it back.

- **FI:** "Puhut {business}-yrityksen tekoälyavustajan kanssa. Puhelu muutetaan tekstiksi asiasi
  hoitamista varten. Lisätietoja saat pyytämällä."
- **EN:** "You're speaking with {business}'s AI assistant. This call is transcribed so we can handle
  your request. Ask for more information at any time."
- **AR:** "تتم هذه المكالمة مع مساعد ذكاء اصطناعي تابع لـ{business}. يتم تحويل المكالمة إلى نص لمعالجة طلبك.
  يمكنك طلب مزيد من المعلومات في أي وقت."

The Arabic draft avoids gendered address by making "the call" the subject. Who answers "more
information", and with what text, must be written too. That is the second layer of the notice.

## Proposed fixes, in order

| #   | Fix                                                                                                               | Size     | Needs first                   |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------- |
| 1   | Counsel answers the questions below                                                                               | External | Owner sends                   |
| 2   | Update #335: approved wording, the business name, and the recording decision                                      | 1 day    | 1, and native Arabic review   |
| 3   | Add the second-layer answer and an objection path to the system prompt: offer a human transfer or another channel | 1 day    | 1                             |
| 4   | Arabic summaries in Arabic (`post-call/route.ts:215-217` falls back to English)                                   | 0.5 day  | None; separate PR             |
| 5   | Deploy to staging, re-sync, and verify on real calls (`phone-call-test-plan.md`, on the economics PR)             | 1 day    | 2, owner approval             |
| 6   | Re-sync existing assistants in production                                                                         | 0.5 day  | 5, and separate authorization |

I haven't changed any code here. The fix depends on the wording and recording decisions, and #335
already holds the right mechanism, so a competing branch would only add confusion.

## Questions for counsel

1. Is a spoken notice in the first message enough under Art. 50, given a tenant's business is the
   deployer and Syveka the provider? Must it name the business?
2. If audio recording stays on, may it begin before the notice ends? Does the same apply to live
   transcription, which necessarily starts at once?
3. Which legal basis should tenants use for recording and for transcription, and is objection or
   consent the right model?
4. What must the first spoken layer contain, and where does the second layer live?
5. For a Finnish tenant, must a notice also be given in Swedish or other languages? When does Arabic
   become required?
6. Do tenants in the UAE, Saudi Arabia or Egypt need prior consent? Should those markets stay closed
   until this is answered?
7. Is the 2020 Deputy Ombudsman decision still good law? The appeal outcome wasn't found.
8. Do transferred calls need a separate notice to the caller or the employee?

## Sources

[AI Act Art. 50](https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-50),
[Commission FAQ](https://digital-strategy.ec.europa.eu/en/faqs/transparency-obligations-under-article-50-ai-act),
[Guidelines C(2026) 5054](https://ai-act-service-desk.ec.europa.eu/sites/default/files/2026-07/guidelines_on_the_implementation_of_the_transparency_obligations_for_certain_ai_systems_under_article_50_of_the_ai_act_bzptwqhk0ikg1dtlddap41psfy_131215.pdf),
[WP260 rev.01](https://www.edpb.europa.eu/system/files/documents/2023-09/wp260rev01_en.pdf),
[TSV call-recording FAQ](https://tietosuoja.fi/en/faq-phone-calls),
[Deputy Ombudsman 2020](https://tietosuoja.fi/en/-/deputy-data-protection-ombudsman-customers-need-to-be-told-before-starting-to-record-calls),
[Vapi consent plan](https://docs.vapi.ai/security-and-privacy/recording-consent-plan),
[Vapi call recording](https://docs.vapi.ai/assistants/call-recording),
[Vapi live control](https://docs.vapi.ai/calls/call-features),
[Vapi OpenAPI](https://api.vapi.ai/api-json).

Not found: official text of Rikoslaki 24:5 and the Gulf provisions, any Finnish-language duty for
private businesses, EDPB guidance on a legal basis specific to call recording, and whether Vapi's
consent message supports languages other than the examples' English.
