# EF Studio Lab — Premium Video Advertising Campaign: Report

## 1. Result in one paragraph

36 finished vertical video ads (12 concepts × Finnish, English, Arabic) were rendered, encoded and
verified locally. **Zero Higgsfield credits were spent and no paid service was used.** Because no
zero-credit generation option exists from this workspace, the ads are premium motion-graphics films
(typography, 3D device mock-ups, interface concepts, original synthesized score), not photoreal
footage. The five storyboards carry the full live-action direction and ready-to-use generation
prompts for a later photoreal version.

## 2. Zero-credit verification

Every Higgsfield cost was preflighted with the tool's own `get_cost` dry run (which submits no job).

| Operation checked | Quoted cost | Decision |
|---|---|---|
| GPT Image 2.6, 9:16, default quality | 0.25 credits | not used |
| GPT Image 2.6, 9:16, 2k high | 2.75 credits | not used |
| Nano Banana Pro, 9:16, 2k | 2 credits | not used |
| Seedance 2.0 video, 5 s, 720p | 22.5 credits | not used |
| Seed Audio voice-over | 0.1 credits | not used |
| Any model with the unlimited allowance | refused: "unlimited generations are not available" from this client | not available |

- Balance before work: **10 credits** (Ultra plan). No generation, upscale, voice or render job was submitted.
- The earlier 0-credit generations in the account history were made from a surface where the
  unlimited allowance applies; that allowance is not offered to this session.
- Voice-over was therefore replaced by burned-in captions plus SRT subtitle files, as the brief allows.

## 3. What was produced

| Folder | Contents |
|---|---|
| `BRAND/` | Supplied logo (untouched), end-card crop, colours, typography, usage rules |
| `STORYBOARDS/` | 5 cinematic storyboards (`storyboard-1…5.md`) each with a frame strip (`…-frames.jpg`), camera, light, sound, text in 3 languages and generation prompts |
| `AD01/ … AD12/` | 3 MP4s (FI/EN/AR), 3 SRT subtitle files, 3 thumbnails, `script.md`, `production-notes.md` |
| `FINAL-EXPORTS/` | All 36 MP4s in one place |
| `CAMPAIGN-REPORT/` | This report and `export-verification.md` (ffprobe results per file) |
| `_PIPELINE/` | The complete source that renders everything (`./build.sh`) — editable copy in `js/ads.js` |

### The 12 ads

| Ad | Concept | Storyboard | Opening hook (FI) |
|---|---|---|---|
| AD01 | Missed customer inquiries | 1 | Kuinka moni asiakas jäi tänään ilman vastausta? |
| AD02 | Modern website transformation | 2 | Onko yrityksesi verkkosivusto ajan tasalla? |
| AD03 | AI customer assistant (concept) | 3 | Entä jos asiakaspalvelusi voisi auttaa myös työajan jälkeen? |
| AD04 | Beauty salon digital experience | 4 | Kampaamosi ensivaikutelma syntyy jo ennen ovea. |
| AD05 | Automotive workshop automation | 4 | Kädet öljyssä. Puhelin soi taas. |
| AD06 | Cleaning company lead management | 4 | Tarjouspyyntö tuli tiistaina. Kuka vastasi siihen? |
| AD07 | Moving company digital booking | 4 | Muuttopäivä lähestyy. Asiakas haluaa varata nyt. |
| AD08 | Restaurant customer experience | 4 | Nälkäinen asiakas päättää sekunneissa. |
| AD09 | Business owner saving time | 3 | Päivässä on 24 tuntia. Mihin sinun menevät? |
| AD10 | Professional website showcase | 2 | Sivustosi on yrityksesi käyntikortti. Ja se on auki aina. |
| AD11 | Premium brand film | 5 | Yrityksesi. Fiksummin. |
| AD12 | Direct response: request a consultation | 4 | Yrittäjä, pysähdy hetkeksi. |

Each ad has its own hook, scene modules, compositions, colour world and transitions; no scene module
is reused between ads except the shared end card and a generic statement card (AD05/AD06, different
icon, colour and copy).

## 4. Technical specification (verified)

- 1080×1920 (9:16), 30 fps, H.264 High profile, yuv420p, BT.709, MP4 with fast-start
- Duration 26.2–27.8 s
- Audio AAC 48 kHz stereo 192 kb/s, normalised to about −16 LUFS
- Per-file ffprobe results: `export-verification.md`

## 5. Honest-advertising review

No EF Studio Lab website, service list or contact detail could be found or verified (a web search
for the business name returned nothing), so the copy was written to stay inside what the brief itself
states: a Finnish digital-solutions and AI-automation business.

- No customers, testimonials, revenue, statistics, guarantees, prices, integrations or "free /
  no-obligation" promises appear anywhere.
- Every interface screen is a concept visual and is labelled *Havainnekuva / Concept visual / صورة توضيحية*.
- The AI assistant (AD03) is phrased as possibility ("can", "what if") and its end card says solutions
  are designed case by case.
- AD09 makes no quantified time-saving claim.
- Businesses shown are generic ("Kampaamo", "Yritys"); none is presented as a client.
- **No contact detail is shown on the end cards**, because none was verified. Set `CONTACT` at the top
  of `_PIPELINE/js/ads.js` to a real URL, phone or email and run `./build.sh` to add it to all 36 ads.

**Please confirm before publishing:** that EF Studio Lab actually offers website design, customer-inquiry
workflows, booking-request forms and AI/automation builds as depicted. Any ad whose service is not yet
offered should be held back or relabelled as "coming soon".

## 6. Things that need your attention

1. **Logo wordmark.** The supplied logo reads "EFstudioLad", not "EF Studio Lab". It was used exactly
   as supplied. If that is a typo in the artwork, supply a corrected master and re-render.
2. **Logo resolution.** The supplied files are small profile-picture screenshots; the end card is
   slightly soft. A vector or high-resolution master will fix it.
3. **Music was not auditioned by ear.** The score is original and synthesized in code; levels, peaks
   and spectrum were checked by measurement, but nobody has listened to it. Please listen to a few
   ads before publishing; the tracks can be swapped by replacing `_PIPELINE/work/audio/ADxx.wav`.
4. **Copy review.** Finnish and Arabic copy was written natively rather than translated literally,
   but a native-speaker proofread before paid distribution is recommended.
5. **Previous Higgsfield assets were not downloaded.** This environment's network blocks the
   Higgsfield media host, so the 12 earlier clips listed below could not be saved here. Nothing was
   deleted or changed. **Download them from Higgsfield before the subscription ends** if you want to keep them.

## 7. Existing Higgsfield videos still to be saved by you

All under `https://d8j0ntlcm91z4.cloudfront.net/user_3IKcTQQGvEPxmHUuiowj5HDH4IF/`:

| Clip | File |
|---|---|
| Salon — mirror reveal, laughter | `hf_20261112_132217_9a2aac00-0590-456f-8b97-bd05517475ed.mp4` |
| Living room — relieved smile | `hf_20261112_131748_168f7aa7-adc5-430e-a762-e2b0e70e116f.mp4` |
| Living room — waiting, disappointed | `hf_20261112_130648_06ac35ae-a26e-4ed7-ad8e-d5f10418ccdf.mp4` |
| Salon — phone buzzing on marble | `hf_20261112_130223_f194251f-b208-4654-a618-dcaba4087e61.mp4` |
| Serum bottle product orbit | `hf_20261111_204204_1145d052-b5d7-463f-90c8-954576ca2bfc.mp4` |
| Salon owner — relieved at phone | `hf_20261111_202045_a080eabe-c2ab-48d0-979b-0c5de1dc975d.mp4` |
| Salon counter — sticky notes top-down | `hf_20261111_201333_051ce99d-3a1c-4425-b158-8f9eaf4204f1.mp4` |
| Helsinki bistro — host on phone | `hf_20261111_123157_464f9622-df60-470b-b16e-33cb6ba0176f.mp4` |
| Auto workshop — phone on tool cabinet | `hf_20261111_122508_93d81500-7e20-4f64-b727-2d6d4a7729cf.mp4` |
| Salon owner — two phones, overwhelmed | `hf_20261111_122028_23218d8e-efd6-4674-8f13-f2279ed4b31b.mp4` |
| Dental clinic — phone at reception | `hf_20261111_121616_7646ddab-7544-4b87-b3ee-155bf409002d.mp4` |
| Salon — opening dolly shot | `hf_20261111_111850_893b0c4d-6505-49b4-8bf3-c372893b83c8.mp4` |

These clips match storyboards 1 and 4 closely (salon, workshop, bistro, waiting customer). Once saved,
they can be cut into AD01, AD04, AD05 and AD08 as photoreal opening shots at no cost.

## 8. How to change and re-render

```
cd EF-STUDIO-LAB-CAMPAIGN/_PIPELINE
./build.sh              # everything (about 35 minutes on 4 cores)
./build.sh AD03 ar      # one export
```

Requirements: Node with Playwright/Chromium, ffmpeg, Python 3 with numpy and scipy. No network, no accounts.
