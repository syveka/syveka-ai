# Syveka — Video Advertising Campaign: Report

## 1. Result

36 vertical video ads: 3 general ads and 9 service ads, each in Finnish, English and Arabic.
Produced locally with the same free pipeline as the EF Studio Lab campaign (headless Chromium, ffmpeg,
open-licence fonts, a score synthesized in code). No Higgsfield credits and no paid service were used.
Per-file technical results are in `export-verification.md`.

## 2. The ads

| Ad | Type | Subject | Hook (EN) |
|---|---|---|---|
| G01 | General | Brand film | The AI assistant that knows your business. |
| G02 | General | Scattered → one workspace | Messages, bookings, questions. All in different places. |
| G03 | General | Pilot invitation | Do you run a small business in Finland? |
| S01 | Service | AI assistant | Ask about your business. Get an answer. |
| S02 | Service | Knowledge base | Guides, price lists, policies. Who remembers it all? |
| S03 | Service | Business profile | Tell it about your business once. |
| S04 | Service | CRM: contacts | Customer details on notes, in email and in your head? |
| S05 | Service | Deals pipeline | What stage are your deals at? |
| S06 | Service | Calendar | A full week. Room for one more? |
| S07 | Service | Booking page | Bookings without the phone tag. |
| S08 | Service | Team and roles | Who sees what? |
| S09 | Service | Three languages | Finnish. English. Arabic. |

Each ad folder holds three MP4s, three SRT files, three thumbnails, `script.md` and `production-notes.md`.
`FINAL-EXPORTS/` holds all 36 MP4s.

## 3. Which services are advertised, and why only these

The repository's newest readiness documents (`docs/free-pilot-launch-runbook.md`,
`docs/commercial-readiness/`) define the current offer as a **controlled free pilot** and list what may
and may not be promised. The ads follow that list.

**Advertised (in the pilot):** AI chat assistant · knowledge base · business profile · CRM contacts ·
deals pipeline · calendar · public booking link · team, roles and audit log · Finnish / English / Arabic.

**Deliberately not advertised:**

| Not in any ad | Reason found in the repository |
|---|---|
| Voice AI / phone answering | Built but not active; pilot docs forbid promising it |
| Workflows / automation | Deferred from first launch; cannot be activated on the pilot plan |
| Inbox, WhatsApp, SMS | Not active; backend stubs only |
| Creator Studio (AI images, image-to-video) | Disabled by feature flag |
| Website-building service | Planned only |
| Booking widget embedded on the customer's own site | Does not exist; embedding is blocked by security headers. Ads say "booking link" |
| Prices, plans, discounts | Pilot rule: no price or upgrade path |
| "GDPR compliant", uptime, support times | Explicitly forbidden claims |
| External calendar sync, CSV import, e-mail confirmations | Not verified or not built |

No customers, testimonials, statistics or results appear. Names in the mock-ups ("Anna K.") are placeholders.

## 4. Decisions made, for you to confirm

1. **No contact address on the end cards.** The repository uses `syveka.ai` addresses, while your
   account e-mail and earlier voice-overs use `syveka.com`. I did not guess. Set `CONTACT` in
   `_PIPELINE/js/ads.js` and run `./build.sh` to add it to all 36.
2. **No logo.** The product has no logo file; its navigation shows the name as text. The end card
   therefore sets "Syveka AI" in type and invents no symbol. Supply a logo and it can replace the wordmark.
3. **CTA is "Ask about the pilot"**, with the note "Free pilot phase · limited number of businesses".
   This matches the documented hand-picked pilot rather than the landing page's open "Start free".
4. **Interface scenes are illustrations**, labelled as concept visuals. They are not screenshots, so
   details differ from the real screens.
5. **Pipeline stage names** in S05 are illustrative, not the product's six default stages.

## 5. Found while checking the facts (outside this campaign)

The public site currently promises more than the pilot documents allow. Nothing was changed, because
this is product copy outside the scope of the ad work:

- `marketing.heroSubtitle` (all three languages) advertises a voice assistant and automations.
- The public pricing page shows €29 / €79 plans and voice minutes.
- The landing-page chat bot's product facts present voice, shared inbox, calendar connection and
  automations as current features.

## 6. Limits of the verification

- The music was synthesized in code and checked by measurement only; nobody has listened to it.
- Finnish and Arabic copy was written directly in each language; a native proofread is recommended
  before paid distribution.
- No voice-over: captions are burned in and SRT files are provided.

## 7. Re-render

```
cd SYVEKA-CAMPAIGN/_PIPELINE
./build.sh            # everything
./build.sh S07 ar     # one export
```
