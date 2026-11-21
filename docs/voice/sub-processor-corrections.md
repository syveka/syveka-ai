# Sub-processor list: proposed corrections for legal approval

**Draft for counsel. Nothing here has been published, and the live legal pages haven't been changed.**
Code base: `origin/main` at `40f71ae7`. Vendor pages read 2026-11-05, some only partially rendered.
This list comes from the code. It can't show which integrations are switched on in production, or
which contracts exist. Those columns are for the owner to fill in.

## What's wrong today

The live text is in `src/app/[locale]/(marketing)/legal/[doc]/page.tsx:7-20`. The file itself calls
it "Placeholder copy", and `docs/pilot-data-requests-runbook.md:186-191` already warns not to present
it as complete.

1. **Voice providers are missing.** Deepgram and Azure handle every phone call by default, and
   ElevenLabs can be selected, yet none is named.
2. **"Data is stored in the EU (Frankfurt)" is too broad.** Call recordings sit with Vapi, and Vapi's
   EU region is "available only with the Premier Success Package". The code calls `api.vapi.ai`
   (`vapi.ts:7`), the non-EU endpoint. Resend says stored data is in the US. Anthropic and OpenAI also
   process outside that statement.
3. **The DPA page promises a list it doesn't contain.** It says the list is "described herein" (line
   18), and it isn't.
4. **Other integrations in the code aren't listed:** fal.ai, and Sentry if a DSN is set.

## Proposed list

"Role" is my reading of the data flow, for counsel to confirm. "Via Vapi" means Syveka doesn't call
the vendor directly: the code selects it in the assistant's config, and Vapi calls it.

| Vendor          | Role                                                                      | Personal data                               | Evidence                                | Location found                               | On list today | Proposed                                                          |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------- | -------------------------------------------- | ------------- | ----------------------------------------------------------------- |
| Vapi            | Runs the phone call                                                       | Caller audio, number, transcript, recording | `integrations/vapi.ts`                  | US by default; EU only on Premier            | Yes           | Keep; correct location                                            |
| Deepgram        | Speech to text, via Vapi                                                  | Caller audio                                | `vapi.ts:134-138`                       | EU endpoint exists; which Vapi uses unknown  | **No**        | **Add**                                                           |
| Microsoft Azure | Default text to speech, via Vapi                                          | Reply text, which can hold caller details   | `vapi.ts:77-81`, `vapi.ts:133`          | EU regions exist; which Vapi uses unknown    | **No**        | **Add**                                                           |
| ElevenLabs      | Optional text to speech, via Vapi                                         | Reply text                                  | `vapi.ts:131-132`                       | Not found                                    | **No**        | **Add if offered**                                                |
| Anthropic       | LLM for calls (via Vapi), and chat, summaries and other features (direct) | Transcript, prompts, Business DNA           | `vapi.ts:122`, `post-call/route.ts:209` | Not verified here                            | Yes           | Keep                                                              |
| Cloudflare      | Default recording storage, within Vapi                                    | Recording                                   | Vapi provider-keys page (R2)            | Not found                                    | **No**        | **Name as Vapi's sub-processor, or remove if recording goes off** |
| OpenAI          | Embeddings, transcription, moderation                                     | Text and audio in the chat features         | `integrations/openai.ts`                | Not verified here                            | Yes           | Keep                                                              |
| fal.ai          | Creator Studio media generation                                           | Prompts and any uploaded images             | `integrations/fal.ts`                   | Not found; DPA uses SCCs                     | **No**        | **Add if enabled**                                                |
| Sentry          | Error reporting                                                           | Possibly identifiers in errors              | `src/instrumentation.ts`                | US or Germany, chosen per account            | **No**        | **Add if a DSN is set**                                           |
| Supabase        | Database, auth, storage                                                   | All tenant data                             | `src/server/supabase/`                  | Region not verified here                     | Yes           | Keep; confirm region                                              |
| Vercel          | Hosting                                                                   | Request data                                | `vercel.json:3` (`fra1`)                | Functions pinned to Frankfurt                | Yes           | Keep                                                              |
| Upstash         | Redis, rate limits, job queue                                             | Identifiers, job payloads                   | `integrations/redis.ts`, QStash         | Ireland or Frankfurt available; not verified | Yes           | Keep; confirm region                                              |
| Resend          | Email                                                                     | Addresses and message content               | `integrations/resend.ts`                | Stored data in the US                        | Yes           | Keep; correct location                                            |
| Stripe          | Payments                                                                  | Billing data                                | `integrations/stripe.ts`                | Not verified here                            | Yes           | Keep                                                              |

### Probably not sub-processors: for counsel to confirm

| Vendor                  | Why                                                                                                                                                | Evidence                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Twilio                  | The tenant supplies its own Twilio credentials, so the tenant holds the contract. It becomes Syveka's sub-processor if Syveka ever manages numbers | `services/voice.ts:268-282`      |
| Google, Microsoft Graph | A tenant connects its own calendar at its own direction                                                                                            | `integrations/calendar/`         |
| Meta                    | A tenant connects its own social accounts                                                                                                          | `integrations/meta/`             |
| Langfuse                | Only environment settings exist; no use was found in `src/`                                                                                        | `src/env.ts`                     |
| Composio                | Only a key-check script                                                                                                                            | `scripts/verify-composio-key.ts` |
| Soniox, Fish Audio      | Not used in production. The Fish pilot on #395 is unmerged and sends nothing without a flag                                                        | Repo search                      |

## Unknowns the owner must resolve

| Question                                                                                   | Why it matters                                                                                                                                                                                                             | How                                             |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Does the Vapi account use Vapi's own keys, or Syveka's, for Deepgram, Azure and Anthropic? | With Vapi's keys, they're Vapi's sub-processors. With Syveka's, they're Syveka's directly. Vapi's docs don't state this per provider                                                                                       | Read the Vapi dashboard                         |
| Is there a signed DPA with Vapi?                                                           | Its terms incorporate one. An undated forum post says otherwise for the EU                                                                                                                                                 | Ask Vapi                                        |
| Does Vapi's list include Deepgram and ElevenLabs?                                          | Its list [partly rendered](https://security.vapi.ai/item/subprocessors), showing Azure, OpenAI, Cloudflare, Supabase, Groq, Databricks, Soniox and WorkOS. Others moved to an "Optional Providers" page that didn't render | Ask Vapi                                        |
| Which Vapi plan does Syveka hold, and does it allow EU hosting?                            | Decides the location statement, and raw-data retention (14, 30 or 180 days)                                                                                                                                                | Dashboard, Vapi                                 |
| Are Sentry and fal.ai on in production?                                                    | Decides whether they are listed                                                                                                                                                                                            | Read environment settings, without changing any |
| Which regions do the Supabase and Upstash projects use?                                    | Decides whether "Frankfurt" can stay                                                                                                                                                                                       | Dashboards                                      |

## Proposed text for counsel to edit

**Privacy page, replacing the current sentences:**

> Syveka AI stores its primary application data in the EU (\[region to confirm\]). Some service
> providers process data outside the EU, under the safeguards described in the list of
> sub-processors. For AI phone calls, caller audio, transcripts and any recordings are processed by
> our voice providers, which may be located in the United States. The current list of sub-processors
> is at \[link\]. Contact: privacy@syveka.ai.

**DPA page:** replace "described herein" with a link to the list, plus the notice period and objection
route for changes, which Art. 28(2) GDPR requires to be addressed.

**The list itself:** one table on one page, with vendor, purpose, data and location. FI, EN and AR
versions are needed under the charter's product standard, and counsel should say which version
prevails.

## Vendors' own lists, for counsel's checks

[Vapi](https://security.vapi.ai/item/subprocessors), [Sentry](https://sentry.io/legal/subprocessors/),
[fal.ai](https://trust.fal.ai/subprocessors),
[Upstash](https://upstash.com/static/trust/subprocessors.pdf),
[Resend](https://resend.com/legal/subprocessors), [Supabase](https://supabase.com/legal/subprocessors),
[Vercel](https://security.vercel.com/subprocessors),
[Langfuse](https://clickhouse.com/legal/agreements/langfuse-subprocessors).
