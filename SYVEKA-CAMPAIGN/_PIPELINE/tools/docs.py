"""Syveka campaign: subtitles, scripts, production notes, thumbnails and the ffprobe verification table,
all generated from the same metadata the videos are rendered from. Run after the videos exist."""
import json, os, subprocess, glob
HERE = os.path.dirname(os.path.abspath(__file__)); PIPE = os.path.dirname(HERE); ROOT = os.path.dirname(PIPE)
subprocess.run(['node', 'render.mjs', '--meta', 'work/meta.json'], cwd=PIPE, check=True)
M = json.load(open(f'{PIPE}/work/meta.json'))
LN = {'fi': 'Finnish', 'en': 'English', 'ar': 'Arabic (Modern Standard)'}
def tc(t):
    ms = int(round(t * 1000)); return f'{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}'
def w(path, txt):
    os.makedirs(os.path.dirname(path), exist_ok=True); open(path, 'w', encoding='utf-8').write(txt)
BASIS = {
 'G01': 'Hero line is the product\'s own landing-page headline in all three languages. Names only pilot modules (chat, CRM, booking, knowledge base).',
 'G02': 'Describes the pilot package as one workspace. No outcome is quantified.',
 'G03': 'States the documented offer: a free, controlled pilot for a limited number of Finnish businesses. No price or upgrade path is mentioned.',
 'S01': 'Assistant answers from profile, documents and CRM; proposes actions that are saved only after confirmation; says when it cannot confirm. Typed chat only: no voice is shown.',
 'S02': 'Knowledge base accepts PDF, DOCX, notes and URLs and answers with citations.',
 'S03': 'Business profile ("Business DNA") holds services, hours and policies; the assistant can propose profile changes that the user confirms.',
 'S04': 'Contacts, notes and timelines. CSV import is not claimed because it does not exist.',
 'S05': 'Deals on a pipeline board. Stage names shown are illustrative; no monetary values or win rates are shown.',
 'S06': 'Day/week/month views and availability schedules. External calendar sync (Google/Microsoft) is not claimed.',
 'S07': 'Public booking link; guests can cancel or reschedule from a manage link. Described as a link to share, not an embeddable widget (embedding is blocked by the product\'s security headers). Confirmation e-mails are not promised.',
 'S08': 'Five roles (Owner, Admin, Manager, Member, Viewer), audit log, per-organisation data isolation. No compliance claim ("GDPR compliant") is made.',
 'S09': 'Interface in Finnish, English and Arabic with right-to-left layout.',
}
BASIS.update({
 'G04': 'Uses the official tagline. Lists pilot modules as available and content creation, automations, voice and websites explicitly as coming soon.',
 'G05': 'A day built only from pilot modules (calendar, booking link, assistant, CRM). No figures.',
 'G06': 'Confirm-before-act, roles, audit log and per-organisation data separation, as documented. No compliance claim.',
 'S10': 'Business profile can be pre-filled as a preview from the company website and is approved by the user.',
 'V01': 'Salon use case built only from pilot modules.', 'V02': 'Workshop use case built only from pilot modules.',
 'V03': 'Cleaning-company use case built only from pilot modules.', 'V04': 'Solo-entrepreneur use case built only from pilot modules.',
 'H01': 'Uses the owner-supplied reference clip, labelled as a dramatization, followed by pilot-module scenes.',
 'H02': 'Uses the owner-supplied reference clip, labelled as a dramatization, then the documented free-pilot offer.',
 'H03': 'Motion-graphics hologram rendition; claims limited to the typed assistant and confirm-before-act.',
 'H04': 'Motion-graphics hologram rendition; claims limited to the booking link and calendar.',
})
def basis(ad, en):
    if en.get('soon'): return 'FUTURE SERVICE. Not available today. Every scene carries a "Coming soon" badge, the end card says "Coming soon — not yet available", and the copy uses conditional wording. Publish only as a teaser; do not target it as a current offer.'
    return BASIS[ad]
for ad in sorted(M):
    d = f'{ROOT}/{ad}'
    for l in ('fi', 'en', 'ar'):
        m = M[ad][l]; cues = []
        for s in m['scenes']:
            txt = s['cap'] if s['type'] != 'end' else f"{m['tagline']}\n{m['cta']}"
            if txt: cues.append((s['start'] + (.35 if s['type'] != 'end' else 1.2), s['end'] - .1, txt))
        w(f'{d}/Syveka_{ad}_{l.upper()}.srt', ''.join(f'{i + 1}\n{tc(a)} --> {tc(b)}\n{t}\n\n' for i, (a, b, t) in enumerate(cues)))
    fi, en, ar = M[ad]['fi'], M[ad]['en'], M[ad]['ar']
    s = f"# {ad} — {en['title']}\n\nFI: **{fi['title']}** · AR: **{ar['title']}**\n\nDuration {en['total']:.1f} s · 1080×1920 · 30 fps · no voice-over (on-screen copy + original score)\n\n"
    for l, m in (('fi', fi), ('en', en), ('ar', ar)):
        s += f"## {LN[l]}\n\n| # | Time | On-screen line |\n|---|---|---|\n"
        for i, sc in enumerate(m['scenes']):
            line = sc['cap'] if sc['type'] != 'end' else f"{m['tagline']} — [{m['cta']}]"
            s += f"| {i + 1} | {sc['start']:.1f}–{sc['end']:.1f} s | {line} |\n"
        s += '\n'
    w(f'{d}/script.md', s)
    n = f"# {ad} — production notes\n\n**What this ad claims, and on what basis.** {basis(ad, en)}\n\n## Scene timeline\n\n| # | Time | Scene module | Transition in |\n|---|---|---|---|\n"
    for i, sc in enumerate(en['scenes']):
        n += f"| {i + 1} | {sc['start']:.1f}–{sc['end']:.1f} s | `{sc['type']}` | {sc['tr'] if i else 'fade from black'} |\n"
    n += f"\n**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.\n\n**Score.** Mood `{en['music']}`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.\n\n**Brand.** Syveka has no logo file, so the end card sets the name \"Syveka AI\" in type, as the product's own navigation does. Colours follow the product's primary blue.\n\n**Re-render.** `cd _PIPELINE && ./build.sh {ad} fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.\n"
    w(f'{d}/production-notes.md', n)
    for l in ('fi', 'en', 'ar'):
        sc0 = en['scenes'][0]; t = sc0['start'] + (sc0['end'] - sc0['start']) * .8
        td = f'{PIPE}/work/thumb/{ad}_{l}'; subprocess.run(['rm', '-rf', td]); subprocess.run(['node', 'render.mjs', ad, l, '--stills', td, f'{t:.2f}'], cwd=PIPE, check=True, capture_output=True)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', glob.glob(td + '/*.png')[0], '-q:v', '2', f'{d}/thumbnail_{l.upper()}.jpg'], check=True)
rows = []; ok = 0
for f in sorted(glob.glob(f'{ROOT}/FINAL-EXPORTS/*.mp4')):
    p = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', f], capture_output=True, text=True).stdout)
    v = next(x for x in p['streams'] if x['codec_type'] == 'video'); a = next((x for x in p['streams'] if x['codec_type'] == 'audio'), None)
    dur = float(p['format']['duration']); good = v['codec_name'] == 'h264' and v['width'] == 1080 and v['height'] == 1920 and v['r_frame_rate'] == '30/1' and 20 <= dur <= 30 and a and a['codec_name'] == 'aac' and v['pix_fmt'] == 'yuv420p'
    dec = subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-f', 'null', '-'], capture_output=True, text=True).stderr.strip() == ''
    good = bool(good and dec); ok += good
    rows.append(f"| {os.path.basename(f)} | {v['width']}×{v['height']} | {v['codec_name']}/{v['pix_fmt']} | {v['r_frame_rate']} | {dur:.2f} s | {a['codec_name'] if a else 'NONE'} | {int(p['format']['size']) / 1e6:.1f} MB | {'PASS' if good else 'FAIL'} |")
w(f'{ROOT}/CAMPAIGN-REPORT/export-verification.md', f"# Export verification (ffprobe + full decode)\n\n{ok} of {len(rows)} files pass: H.264, yuv420p, 1080×1920, 30 fps, 20–30 s, AAC audio, decodes without errors.\n\n| File | Size | Video | FPS | Duration | Audio | Bytes | Result |\n|---|---|---|---|---|---|---|---|\n" + '\n'.join(rows) + '\n')
print('docs done;', ok, 'of', len(rows), 'exports pass')
