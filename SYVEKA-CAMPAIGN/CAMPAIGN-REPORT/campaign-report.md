# Syveka — Video Advertising Campaign: Report

## 1. Result

102 vertical video ads: 34 concepts, each in Finnish, English and Arabic. 30 are the requested set
(general, per-service, per-trade and future-service ads) and 4 are in the hologram style of the supplied
reference clip. Produced locally with free tools (headless Chromium, ffmpeg, open-licence fonts, a score
synthesized in code). No Higgsfield credits and no paid service were used; the unlimited allowance is
not offered to this session, so nothing was generated there. Per-file results: `export-verification.md`.

## 2. The ads

| Group | IDs | What they are |
|---|---|---|
| General | G01–G06 | Brand film, scattered → one workspace, pilot invitation, "AI Business Operating System" overview, a day with Syveka, "you decide" |
| Services in the pilot | S01–S10 | AI assistant, knowledge base, business profile, contacts, deals pipeline, calendar, booking page, team and roles, three languages, profile from your website |
| By trade | V01–V04 | Salons, auto workshops, cleaning companies, solo entrepreneurs (built only from pilot modules) |
| Future services | F01–F10 | Voice assistant, automations, shared inbox, messaging channels, content studio (images), content studio (video and social), websites, analytics, calendar sync, booking reminders |
| Hologram style | H01–H04 | H01–H02 use the supplied reference clip; H03–H04 are motion-graphics renditions |

Each ad folder holds three MP4s, three SRT files, three thumbnails, `script.md` and `production-notes.md`.
`FINAL-EXPORTS/` holds all 102 MP4s. `HOLOGRAM-STYLE/prompt-pack.md` has ready prompts for generating
more photoreal footage where the unlimited allowance works.

### Future-service ads (F01–F10) are teasers, not offers

They were made because they will be needed later. To keep them honest today, every scene carries a
"Coming soon · concept" badge, the end card says "Coming soon — not yet available", the button says
"Ask us more", and the copy uses conditional wording ("could", "planned"). Publish them only as teasers.
Remove the badge and re-render when a service actually launches (`soon: true` in `_PIPELINE/js/ads2.js`).

### Logo

The end card uses the supplied Syveka AI banner as pixels (cropped to the logo and tagline, see `BRAND/`).
It is not redrawn. The gradient accent in the ads follows the logo's blue-to-violet.

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
   `_PIPELINE/js/ads.js` and run `./build.sh` to add it to all of them.
2. **Logo.** The end card now uses the logo you supplied.
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
