// Hologram-style scenes, modelled on the owner's reference clip (photoreal office, glowing assistant
// figure, floating glass cards). `footage` plays that clip's frames; `holo` is a motion-graphics
// rendition of the same idea for shots that have no footage.
const CLIP = []; let clipP = null; const CLIP_N = 239;
function loadClip() {
  if (clipP) return;
  clipP = Promise.all(Array.from({ length: CLIP_N }, (_, i) => { const im = new Image(); im.src = `work/clip/${String(i + 1).padStart(4, '0')}.jpg`; CLIP[i] = im; return im.decode().catch(() => {}); }));
  (window.PRELOAD = window.PRELOAD || []).push(clipP);
}
const DRAMA = T('Kuvitteellinen kohtaus', 'Dramatization', 'مشهد تمثيلي');
SCENES.footage = (c, el, p) => {
  loadClip();
  const cv = h('canvas', { width: 1080, height: 1920, style: 'position:absolute;inset:0;width:1080px;height:1920px' }), g = cv.getContext('2d');
  c.tick(t => { const k = Math.max(0, Math.min(1, t / c.dur)), i = Math.max(0, Math.min(CLIP_N - 1, Math.round(p.from + (p.to - p.from) * k))), im = CLIP[i]; if (im && im.naturalWidth) g.drawImage(im, 0, 0, 1080, 1920); });
  const wrap = h('div', 'fill', cv); c.drift(wrap, `scale(${p.z0 || 1.04})`, `scale(${p.z1 || 1.1})`);
  el.append(wrap, h('div', { class: 'fill', style: 'background:linear-gradient(180deg,rgba(3,6,20,.82) 0%,rgba(3,6,20,.15) 26%,rgba(3,6,20,0) 45%)' }));
  const b = h('div', { class: 'concept', style: 'top:286px' }, DRAMA); c.an(b, K.fade, .4, .5); el.append(b);
  if (p.hook) el.append(headline(c, p.hook, 370, .3, { size: 92 }));
};

const HOLO_BODY = 'M100 70C80 70 62 80 58 100L44 200C42 212 56 214 58 204L70 130L72 230L64 440C63 456 84 456 86 440L98 260L102 260L114 440C116 456 137 456 136 440L128 230L130 130L142 204C144 214 158 212 156 200L142 100C138 80 120 70 100 70Z';
SCENES.holo = (c, el, p) => {
  el.append(h('div', { class: 'bg', style: 'background:linear-gradient(180deg,#0b1434 0%,#070b20 55%,#03040c 100%)' }));
  [[-40, 300], [250, 250], [560, 300], [860, 260]].forEach((w, i) => el.append(h('div', { class: 'abs', style: `left:${w[0]}px;top:230px;width:${w[1]}px;height:900px;background:linear-gradient(180deg,rgba(147,197,253,.32),rgba(99,102,241,.10) 70%,transparent);filter:blur(34px);opacity:${.5 + (i % 2) * .25}` })));
  el.append(h('div', { class: 'abs', style: 'left:-200px;top:1290px;width:1480px;height:520px;border-radius:50%;background:radial-gradient(ellipse,rgba(148,163,184,.20),rgba(15,23,42,0) 68%)' }));
  dots(c, el, 22, p.seed || 17);
  [520, 380, 250].forEach((s, i) => { const r = at(540, 1330, h('div', { style: `width:${s}px;height:${s * .26}px;border-radius:50%;border:2px solid rgba(165,180,252,${.3 + i * .22});box-shadow:0 0 40px rgba(129,140,248,.45)` })); c.an(r.firstChild, [{ transform: 'scale(.86)', opacity: .5 }, { transform: 'scale(1.05)', opacity: 1 }, { transform: 'scale(.86)', opacity: .5 }], i * .25, 2.6, 'ease-in-out', 'both'); c.an(r, K.fade, .2 + i * .1, .6); el.append(r); });
  const svg = `<svg viewBox="0 0 200 470" style="width:100%;height:100%;overflow:visible"><defs><linearGradient id="hg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e0e7ff" stop-opacity=".55"/><stop offset=".5" stop-color="#818cf8" stop-opacity=".22"/><stop offset="1" stop-color="#60a5fa" stop-opacity=".40"/></linearGradient></defs><circle cx="100" cy="36" r="27" fill="url(#hg)" stroke="#c7d2fe" stroke-width="2.4"/><path d="${HOLO_BODY}" fill="url(#hg)" stroke="#c7d2fe" stroke-width="2.4" stroke-linejoin="round"/><path d="M62 150Q100 170 138 150M66 190Q100 210 134 190M70 300Q84 310 96 300M104 300Q116 310 130 300" fill="none" stroke="#e0e7ff" stroke-width="1.2" opacity=".6"/></svg>`;
  const fig = h('div', { style: 'width:330px;height:776px;filter:drop-shadow(0 0 14px rgba(165,180,252,.95)) drop-shadow(0 0 46px rgba(99,102,241,.75))', html: svg });
  c.an(fig, [{ opacity: 0, transform: 'scaleY(.02) translateY(380px)' }, { opacity: 1, transform: 'scaleY(1.04) translateY(0)', offset: .55 }, { opacity: .55, transform: 'scaleY(1)', offset: .7 }, { opacity: 1, transform: 'scaleY(1)' }], p.at ?? .3, .9, 'ease-out');
  const scan = h('div', { style: 'position:absolute;left:-30px;right:-30px;top:0;height:10px;background:linear-gradient(90deg,transparent,#e0e7ff,transparent);box-shadow:0 0 30px 8px rgba(165,180,252,.8);opacity:.85' });
  c.an(scan, [{ transform: 'translateY(0)' }, { transform: 'translateY(776px)' }, { transform: 'translateY(0)' }], 1.0, 3.6, 'ease-in-out');
  const fw = at(540, 930, h('div', { style: 'position:relative' }, fig, scan)); c.an(fw.firstChild, [{ translate: '0 0' }, { translate: '0 -14px' }, { translate: '0 0' }], 1.2, 3.2, 'ease-in-out');
  el.append(fw);
  (p.cards || []).forEach((k, i) => {
    const left = i % 2 === 0, row = Math.floor(i / 2), x = (left !== RTL) ? 205 : 875, y = 600 + row * 210;
    const card = h('div', { class: 'row', style: 'width:340px;padding:22px 22px;gap:16px;border-radius:26px;background:rgba(255,255,255,.12);border:1.5px solid rgba(255,255,255,.34);box-shadow:0 20px 50px rgba(2,6,23,.5),inset 0 1px 0 rgba(255,255,255,.3)' }, st(icon(k[0], 62), 'color:#1e3a8a;background:rgba(255,255,255,.92);border-radius:18px;padding:13px'), h('div', { style: 'min-width:0' }, h('div', { style: `font:700 ${RTL ? 27 : 28}px/1.2 var(--ui);color:#fff` }, k[1]), k[2] ? h('div', { style: 'font:500 21px/1.3 var(--ui);color:rgba(226,232,255,.75);margin-top:4px' }, k[2]) : null));
    const w = at(x, y, card);
    c.an(card, [{ opacity: 0, transform: `translateX(${x < 540 ? 150 : -150}px) scale(.6)` }, { opacity: 1, transform: 'none' }], (p.cardsAt ?? 1.3) + i * .22, .55, 'cubic-bezier(.3,1.3,.5,1)');
    c.an(w, [{ translate: '0 0' }, { translate: '0 -10px' }, { translate: '0 0' }], i * .3, 3 + (i % 3) * .4, 'ease-in-out');
    el.append(w);
  });
  if (p.hook) el.append(headline(c, p.hook, 330, .2, { size: 84 }));
};

// ---------------- Syveka Studio: a social post being drafted, captioned and approved ----------------
SCENES.postCard = (c, el, p) => {
  el.append(bg(c, 'ink', { dots: 18, glow: [[100, 300, 700, '#7c3aed', .28], [500, 1000, 600, '#3b82f6', .25]] }));
  const img = h('div', { class: 'h-biz', style: 'position:relative;height:560px;overflow:hidden' }, h('div', { style: 'position:absolute;inset:0;background:linear-gradient(110deg,#1e293b 30%,#475569 50%,#1e293b 70%);background-size:300% 100%' }), at(284, 280, st(icon('sparkle', 150), 'color:#fff;filter:drop-shadow(0 0 30px rgba(255,255,255,.8))')));
  c.an(img.children[0], [{ backgroundPosition: '100% 0', opacity: 1 }, { backgroundPosition: '0% 0', opacity: 1, offset: .8 }, { backgroundPosition: '0% 0', opacity: 0 }], .3, 1.6, 'linear');
  c.an(img.children[1].firstChild, [{ opacity: 0, transform: 'scale(.3) rotate(-40deg)' }, { opacity: 1, transform: 'scale(1) rotate(0deg)' }], 1.6, .6, 'cubic-bezier(.3,1.4,.5,1)');
  const capt = h('div', { style: 'font:500 28px/1.4 var(--ui);color:#0f172a;min-height:120px;padding:22px 26px 0' }); typer(c, capt, p.caption, 2.1, 1.3);
  const t1 = h('span', { style: 'font:700 22px var(--ui);padding:8px 20px;border-radius:30px;background:#e2e8f0;color:#475569' }, p.draft), t2 = h('span', { style: 'position:absolute;inset-inline-end:26px;top:0;font:700 22px var(--ui);padding:8px 20px;border-radius:30px;background:#dcfce7;color:#166534;white-space:nowrap' }, p.approved);
  c.out(t1, K.out, 3.75, .15); c.an(t2, K.pop, 3.85, .4);
  const scr = h('div', { style: 'height:100%;background:#fff' }, h('div', { class: 'row', style: 'padding:96px 26px 20px;gap:16px' }, h('div', { style: 'width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#7dd3fc,#3b82f6,#7c3aed)' }), h('div', { style: 'font:700 28px var(--ui);color:#0f172a' }, p.name)), img, capt, h('div', { style: 'position:relative;display:flex;justify-content:flex-end;padding:20px 26px 0' }, t1, t2));
  const ph = phone(scr), w = h('div', { class: 'abs p3d', style: 'left:240px;top:310px' }, ph);
  c.an(ph, [{ transform: 'rotateY(-12deg) rotateX(5deg) scale(.86)' }, { transform: 'rotateY(5deg) rotateX(2deg) scale(.9)' }], 0, c.dur + .5, 'ease-out');
  el.append(w);
};
