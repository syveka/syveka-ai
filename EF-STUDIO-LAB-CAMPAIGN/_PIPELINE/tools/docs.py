"""Generates subtitles, scripts, production notes, storyboards, thumbnails and the verification report
from the same metadata the videos are rendered from. Run after the videos exist: python3 tools/docs.py"""
import json, os, subprocess, glob
HERE = os.path.dirname(os.path.abspath(__file__)); PIPE = os.path.dirname(HERE); ROOT = os.path.dirname(PIPE)
subprocess.run(['node', 'render.mjs', '--meta', 'work/meta.json'], cwd=PIPE, check=True)
M = json.load(open(f'{PIPE}/work/meta.json'))
LN = {'fi': 'Finnish', 'en': 'English', 'ar': 'Arabic (Modern Standard)'}
def tc(t):
    ms = int(round(t * 1000)); return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'
def w(path, txt):
    os.makedirs(os.path.dirname(path), exist_ok=True); open(path, 'w', encoding='utf-8').write(txt)

MOOD = {'tension': 'restrained minor pads that lift into a brighter progression at the solution', 'bright': 'optimistic major progression, light pulse', 'future': 'cool suspended chords with a glassy arpeggio', 'warm': 'slow warm major-seventh pads, soft plucks', 'drive': 'steady driving pulse with soft kick', 'luxe': 'slow, deep cinematic pads with sparse bell tones'}
CONCEPT = {
 'AD01': ('Problem → solution. Notifications pile up, a customer waits in vain, then scattered inquiries converge into one organised workflow.', 'No claim that any specific product is live; the workflow screen is labelled as a concept visual.'),
 'AD02': ('Before / after. A dated website frustrates a mobile visitor, a gold scan-line transforms it into a modern responsive design.', 'Site designs are illustrative concepts with generic words ("Yritys / Company"), not client work.'),
 'AD03': ('After-hours inquiry handled by an AI assistant concept, ready for the owner in the morning.', 'AI assistant is shown strictly as a concept ("can", "what if"); end card states solutions are designed case by case.'),
 'AD04': ('Salon: the first impression happens on the phone — search, a beautiful site, a booking request.', 'Booking flow is a concept visual; wording is "booking request", not a promise of a specific booking engine.'),
 'AD05': ('Workshop: the phone interrupts the work; one online form and a simple queue bring order.', 'Registration numbers are obvious placeholders (ABC-123). Automation shown as concept.'),
 'AD06': ('Cleaning company: leads live in email, sticky notes and memory — gathered into one board.', 'Kanban board is a concept visual; no customer names or results are shown.'),
 'AD07': ('Moving company: phone tag replaced by a from/to/when booking request.', 'Cities are illustrative. Booking request is a concept visual.'),
 'AD08': ('Restaurant: a hungry guest asks three questions; a good site answers all of them at once.', 'Opening hours shown are placeholder UI text inside a concept visual.'),
 'AD09': ('The owner\'s time: routine eats the day; repetitive tasks can often be automated.', 'Deliberately contains no hour or percentage figures — no quantified time-saving claim is made.'),
 'AD10': ('Website showcase: business card flips into a site; structure, design, responsive, multilingual.', 'All designs are concept visuals. Multilingual claim is supported by this trilingual campaign itself.'),
 'AD11': ('Brand film: spark → connections → four capability words → one ecosystem → "Your business. Smarter."', 'Pure brand statement; no feature, customer or result claims.'),
 'AD13': ('Website service explainer: what is included (design, online booking, WhatsApp contact, multilingual), responsive devices, one real active reference and the trades served.', 'Facts come from the owner\'s own portfolio page: Kyytipro Oy is shown there as an active project with website, booking, WhatsApp and responsive tags. Earlier projects are referred to only by trade, because the portfolio marks them as no longer online. The device scene is a concept visual, not the Kyytipro site.'),
 'AD14': ('AI service explainer: what can be built (assistant, automation, organisation, reminders), an automation visual, a three-step way of working, and the owner staying in charge.', 'AI appears in the business header ("Web · AI · Growth") but no AI project is shown in the portfolio, so every capability is phrased as something that can be built, screens are concept visuals, and the end card says solutions are designed case by case.'),
 'AD15': ('Growth service explainer: growth starts with being easy to reach; three questions, the customer path, three steps, CTA.', 'Growth appears in the business header but its scope was not specified. The ad makes no traffic, ranking, lead or revenue promise and names no channel (no SEO or advertising claim); the bar graphic carries no figures.'),
 'AD12': ('Direct response: three pain questions, one conversation, three simple steps, a tap on the CTA.', 'No "free" or "no obligation" promise is made because consultation terms were not verified.'),
}
for ad in sorted(M):
    d = f'{ROOT}/{ad}'
    for l in ('fi', 'en', 'ar'):
        m = M[ad][l]; cues = []
        for s in m['scenes']:
            txt = s['cap'] if s['type'] != 'end' else f"{m['tagline']}\n{m['cta']}"
            if txt: cues.append((s['start'] + (.35 if s['type'] != 'end' else 1.2), s['end'] - .1, txt))
        w(f'{d}/EF-Studio-Lab_{ad}_{l.upper()}.srt', ''.join(f'{i + 1}\n{tc(a)} --> {tc(b)}\n{t}\n\n' for i, (a, b, t) in enumerate(cues)))
    fi, en, ar = M[ad]['fi'], M[ad]['en'], M[ad]['ar']
    s = f"# {ad} — {en['title']}\n\nFI: **{fi['title']}** · AR: **{ar['title']}**\n\nDuration {en['total']:.1f} s · 1080×1920 · 30 fps · no voice-over (on-screen copy + original score)\n\n"
    for l, m in (('fi', fi), ('en', en), ('ar', ar)):
        s += f"## {LN[l]}\n\n| # | Time | On-screen line |\n|---|---|---|\n"
        for i, sc in enumerate(m['scenes']):
            line = sc['cap'] if sc['type'] != 'end' else f"{m['tagline']} — [{m['cta']}]"
            s += f"| {i + 1} | {sc['start']:.1f}–{sc['end']:.1f} s | {line} |\n"
        s += '\n'
    w(f'{d}/script.md', s)
    n = f"# {ad} — production notes\n\n**Concept.** {CONCEPT[ad][0]}\n\n**Storyboard foundation.** Storyboard {en['board']} (see `../STORYBOARDS/`).\n\n**Honest-advertising note.** {CONCEPT[ad][1]}\n\n## Scene timeline\n\n| # | Time | Scene module | Transition in | Sound cues |\n|---|---|---|---|---|\n"
    for i, sc in enumerate(en['scenes']):
        n += f"| {i + 1} | {sc['start']:.1f}–{sc['end']:.1f} s | `{sc['type']}` | {sc['tr'] if i else 'fade from black'} | {', '.join(sc['sfx']) or '—'} |\n"
    n += f"\n**Score.** Mood `{en['music']}`: {MOOD[en['music']]}. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.\n\n**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).\n\n**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.\n\n**Re-render.** `cd _PIPELINE && ./build.sh {ad} fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.\n\n**Files.** `EF-Studio-Lab_{ad}_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.\n"
    w(f'{d}/production-notes.md', n)
    for l in ('fi', 'en', 'ar'):
        sc0 = en['scenes'][0]; t = sc0['start'] + (sc0['end'] - sc0['start']) * .8
        if ad == 'AD11': t = en['scenes'][4]['start'] + 2.6
        td = f'{PIPE}/work/thumb/{ad}_{l}'; subprocess.run(['rm', '-rf', td]); subprocess.run(['node', 'render.mjs', ad, l, '--stills', td, f'{t:.2f}'], cwd=PIPE, check=True, capture_output=True)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', glob.glob(td + '/*.png')[0], '-q:v', '2', f'{d}/thumbnail_{l.upper()}.jpg'], check=True)

# ---------------- storyboards ----------------
SB = json.load(open(f'{HERE}/storyboards.json', encoding='utf-8'))
for b in SB:
    k = b['n']; s = f"# Storyboard {k} — {b['title']}\n\n**Theme:** {b['theme']}  \n**Visual direction:** {b['look']}  \n**Format:** 9:16, 1080×1920, {b['dur']}  \n**Hook:** FI “{b['hook'][0]}” · EN “{b['hook'][1]}” · AR “{b['hook'][2]}”  \n**Ads built on this board:** {b['ads']}\n\n![board](storyboard-{k}-frames.jpg)\n\n*Frames above are taken from the rendered zero-credit motion-graphics cut. The live-action direction below is the full cinematic version, ready to shoot or generate when a budget is available.*\n\n"
    for i, sc in enumerate(b['scenes']):
        s += f"## Scene {i + 1} · {sc['t']} — {sc['name']}\n\n- **Action:** {sc['action']}\n- **Camera:** {sc['cam']}\n- **Light & colour:** {sc['light']}\n- **Sound:** {sc['sound']}\n- **On-screen text:** {sc['text']}\n- **Transition out:** {sc['tr']}\n- **Zero-credit cut:** {sc['mg']}\n- **Generation prompt (image-to-video, 9:16):** `{sc['prompt']}`\n\n"
    s += f"## End card\n\nOfficial EF Studio Lab logo (supplied file, unaltered) on black, soft gold halo and a single light sweep. Tagline: “{b['tag']}”. Gold CTA button. 4.6–5.0 s.\n\n## Honesty guardrails for this board\n\n{b['honest']}\n"
    w(f'{ROOT}/STORYBOARDS/storyboard-{k}.md', s)
    fr = []; td = f'{PIPE}/work/sb/{k}'; subprocess.run(['rm', '-rf', td]); os.makedirs(td)
    for j, (ad, idx) in enumerate(b['frames']):
        sc = M[ad]['fi']['scenes'][idx]; t = sc['start'] + (sc['end'] - sc['start']) * .72
        subprocess.run(['node', 'render.mjs', ad, 'fi', '--stills', f'{td}/{j}', f'{t:.2f}'], cwd=PIPE, check=True, capture_output=True)
        os.rename(glob.glob(f'{td}/{j}/*.png')[0], f'{td}/f{j}.png')
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', f'{td}/f%d.png', '-vf', f'scale=540:960,tile={len(b["frames"])}x1:padding=12:color=0x111111', '-frames:v', '1', '-q:v', '2', f'{ROOT}/STORYBOARDS/storyboard-{k}-frames.jpg'], check=True)

# ---------------- verification ----------------
rows = []; ok = 0
for f in sorted(glob.glob(f'{ROOT}/FINAL-EXPORTS/*.mp4')):
    p = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', f], capture_output=True, text=True).stdout)
    v = next(x for x in p['streams'] if x['codec_type'] == 'video'); a = next((x for x in p['streams'] if x['codec_type'] == 'audio'), None)
    dur = float(p['format']['duration']); good = v['codec_name'] == 'h264' and v['width'] == 1080 and v['height'] == 1920 and v['r_frame_rate'] == '30/1' and 20 <= dur <= 30 and a and a['codec_name'] == 'aac' and v['pix_fmt'] == 'yuv420p'
    ok += bool(good); rows.append(f"| {os.path.basename(f)} | {v['width']}×{v['height']} | {v['codec_name']}/{v['pix_fmt']} | {v['r_frame_rate']} | {dur:.2f} s | {a['codec_name'] if a else 'NONE'} {a.get('sample_rate','') if a else ''} | {int(p['format']['size']) / 1e6:.1f} MB | {'PASS' if good else 'FAIL'} |")
w(f'{ROOT}/CAMPAIGN-REPORT/export-verification.md', f"# Export verification (ffprobe)\n\n{ok} of {len(rows)} files pass: H.264, yuv420p, 1080×1920, 30 fps, 20–30 s, AAC audio.\n\n| File | Size | Video | FPS | Duration | Audio | Bytes | Result |\n|---|---|---|---|---|---|---|---|\n" + '\n'.join(rows) + '\n')
print('docs done;', ok, 'of', len(rows), 'exports pass')
