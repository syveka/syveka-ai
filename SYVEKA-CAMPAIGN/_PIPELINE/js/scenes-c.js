// Syveka-specific scenes. The end card shows the supplied Syveka AI logo as pixels (cropped from the
// supplied banner, see ../BRAND); it is never redrawn.
Object.assign(IC, {
  doc: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  users: '<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="9" r="2.6"/><path d="M17 14.2a5 5 0 0 1 4.5 5.3"/>',
  shield: '<path d="M12 3l8 3v6c0 4.6-3.3 8-8 9-4.7-1-8-4.4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  building: '<path d="M4 21V5l8-2v18M12 9l8 2v10M2 21h20M7 8h2M7 12h2M7 16h2M15 14h2M15 18h2"/>',
  funnel: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
});

SCENES.end = (c, el, p, ad) => {
  el.append(h('div', { class: 'bg', style: 'background:radial-gradient(ellipse 90% 55% at 50% 32%,#0a1650 0%,#050a26 55%,#02030f 100%)' }));
  dots(c, el, 30, 6);
  const logo = h('div', { class: 'abs', style: 'left:20px;top:300px;width:1040px;height:616px' }, h('img', { src: '../BRAND/Syveka-logo-endcard-crop.png', style: 'width:100%;height:100%;display:block' }));
  c.an(logo, [{ opacity: 0, transform: 'scale(.92)', filter: 'blur(14px) brightness(1.5)' }, { opacity: 1, transform: 'scale(1)', filter: 'blur(0) brightness(1)' }], .15, 1.1, 'ease-out');
  c.an(logo.firstChild, K.zoom(1, 1.03), 0, c.dur, 'linear');
  const tag = h('div', 'end-tag', L(ad.tagline)); c.an(tag, K.up(30), 1.1, .7);
  const cta = h('div', 'end-cta', h('span', 'btn', L(ad.cta), st(icon('arrow', 40), RTL ? 'transform:scaleX(-1)' : '')));
  c.an(cta, K.pop, 1.6, .6);
  const note = h('div', 'end-note', CONTACT || L(ad.soon ? SOON_NOTE : PILOT_NOTE)); c.an(note, K.fade, 2.05, .6);
  el.append(logo, tag, cta, note);
};

// Question → typed answer → source chip. The assistant answers from the business's own data.
SCENES.chatQA = (c, el, p) => {
  el.append(bg(c, 'blue', { grid: true, glow: [[240, 250, 600, '#3d6cff', .4]] }));
  const orb = h('div', { style: 'width:170px;height:170px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff 0,#bcd3ff 14%,#5b8cff 44%,#1a2a7a 80%);box-shadow:0 0 100px rgba(91,140,255,.7)' });
  c.an(orb, [{ transform: 'scale(.9)' }, { transform: 'scale(1.06)' }, { transform: 'scale(.9)' }, { transform: 'scale(1.06)' }], 0, c.dur + .5, 'ease-in-out');
  el.append(at(540, 490, orb));
  const q = h('div', { class: 'bubble me', style: 'font-size:36px;padding:28px 34px;max-width:84%' }, p.q), a = h('div', { class: 'bubble', style: 'font-size:36px;padding:28px 34px;max-width:88%;min-height:96px' }); typer(c, a, p.a, 1.5, 1.7);
  c.an(q, K.pop, .5, .45); c.an(a, K.fade, 1.4, .15);
  const kids = [q, a];
  if (p.src) { const s = h('div', { class: 'tag', style: 'align-self:flex-start;font-size:26px;padding:12px 24px;display:inline-flex;gap:12px;align-items:center' }, icon(p.srcIcon || 'doc', 32), p.src); c.an(s, K.pop, 3.4, .4); kids.push(s); }
  el.append(col(80, 660, 920, 30, kids));
};

// Generic detail card: title, tag, key/value rows, optional confirm button that flips the tag.
SCENES.rowsCard = (c, el, p) => {
  el.append(bg(c, p.bg || 'ink', { glow: [[300, 300, 700, '#3b82f6', .22]], dots: 16 }));
  const tg = h('span', 'tag ' + (p.tagCls || ''), p.tag), head = h('div', { class: 'row', style: 'margin-bottom:12px' }, badge(p.icon), h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 't1', style: 'font-size:40px' }, p.title), p.sub ? h('div', 't2', p.sub) : null), tg);
  const card = h('div', { class: 'card', style: 'position:relative;width:880px;padding:42px 44px' }, head, p.rows.map((r, i) => { const e = h('div', { style: 'display:flex;justify-content:space-between;gap:24px;padding:24px 0;border-bottom:1px solid rgba(255,255,255,.08)' }, h('span', 't2', r[0]), h('span', { class: 't1', style: 'text-align:end' }, r[1])); c.an(e, K.up(24), .6 + i * .25, .5); return e; }));
  if (p.btn) { const b = h('span', { class: 'btn', style: 'font-size:32px;padding:24px 50px;margin-top:32px' }, p.btn); press(c, b, 2.9); card.append(b); const t2 = h('span', { class: 'tag g', style: 'position:absolute;inset-inline-end:44px;top:58px' }, p.done); c.out(tg, K.out, 3.15, .15); c.an(t2, K.pop, 3.25, .4); card.append(t2); }
  const w = h('div', { class: 'abs p3d', style: 'left:100px;top:420px' }, card); c.an(card, [{ opacity: 0, transform: 'rotateX(20deg) translateY(120px)' }, { opacity: 1, transform: 'rotateX(3deg)' }], .15, .9); el.append(w);
};

// Documents flow into the knowledge core.
SCENES.docsIn = (c, el, p) => {
  el.append(bg(c, 'ink', { grid: true, glow: [[240, 600, 620, '#3b82f6', .3]] }));
  const P = [[230, 520], [850, 560], [250, 1180], [840, 1150]];
  p.items.forEach((it, i) => { const chip = h('div', { class: 'card row', style: 'padding:26px 32px;gap:18px;border-radius:26px' }, st(icon(it[0], 56), 'color:var(--gold)'), h('span', { class: 't1', style: 'white-space:nowrap' }, it[1])); const w = at(540, 850, chip); const dx = P[i][0] - 540, dy = P[i][1] - 850; c.an(w, [{ opacity: 0, transform: `translate(-50%,-50%) translate(${dx * 1.5}px,${dy * 1.5}px)` }, { opacity: 1, transform: `translate(-50%,-50%) translate(${dx}px,${dy}px)`, offset: .2 }, { opacity: 1, transform: `translate(-50%,-50%) translate(${dx}px,${dy}px)`, offset: .55 }, { opacity: 0, transform: 'translate(-50%,-50%) scale(.3)' }], .2 + i * .25, 3.0, EIO); el.append(w); });
  const core = h('div', { style: 'width:250px;height:250px;border-radius:50%;background:var(--goldgrad);display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 0 120px rgba(59,130,246,.6)' }, icon('ai', 130));
  c.an(core, K.pop, .2, .6); c.an(core, [{ boxShadow: '0 0 60px rgba(59,130,246,.4)' }, { boxShadow: '0 0 200px rgba(59,130,246,1)' }, { boxShadow: '0 0 90px rgba(59,130,246,.6)' }], 2.9, 1.2, 'ease-out', 'none');
  [420, 620].forEach((s, i) => { const r = at(540, 850, h('div', { style: `width:${s}px;height:${s}px;border-radius:50%;border:2px solid rgba(59,130,246,.6)` })); c.an(r.firstChild, [{ opacity: 0, transform: 'scale(.5)' }, { opacity: 1, transform: 'scale(.9)', offset: .3 }, { opacity: 0, transform: 'scale(1.5)' }], 3.0 + i * .25, 1.4, 'ease-out'); el.append(r); });
  el.append(at(540, 850, core));
};

SCENES.contacts = (c, el, p) => {
  el.append(bg(c, 'ink', { glow: [[100, 300, 700, '#3b82f6', .22]] }));
  const qt = h('span', { style: 'font:500 32px var(--ui);color:#1b1712' }); typer(c, qt, p.search, 2.4, .7);
  const bar = h('div', { class: 'row', style: 'height:88px;border-radius:44px;background:#f1f5f9;padding:0 30px;gap:16px;color:#64748b;margin-bottom:10px' }, icon('search', 38), qt);
  const rows = p.rows.map((r, i) => { const e = h('div', { class: 'row', style: 'padding:24px 0;border-bottom:1px solid #e2e8f0;gap:22px' }, h('div', { style: `width:76px;height:76px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font:700 30px Inter;color:#fff;background:${['#1840b4', '#0f766e', '#7c3aed', '#b45309'][i]};direction:ltr` }, r[0]), h('div', { style: 'flex:1;min-width:0' }, h('div', { style: 'font:600 34px var(--ui);color:#0f172a' }, r[1]), h('div', { style: 'font:500 25px var(--ui);color:#64748b' }, r[2])), h('span', { style: `font:600 23px var(--ui);padding:8px 20px;border-radius:30px;white-space:nowrap;${r[4] ? 'background:#dcfce7;color:#166534' : 'background:#dbeafe;color:#1e40af'}` }, r[3])); c.an(e, K.up(30), .5 + i * .22, .5); if (p.keep != null && i !== p.keep) c.out(e, [{ opacity: 1 }, { opacity: .18 }], 3.0, .4); return e; });
  const card = h('div', { class: 'card light', style: 'width:880px;padding:40px 44px' }, h('div', { style: 'font:700 44px var(--display);color:#0f172a;margin-bottom:22px' }, p.title), bar, rows);
  const w = h('div', { class: 'abs p3d', style: 'left:100px;top:400px' }, card); c.an(card, [{ opacity: 0, transform: 'rotateY(-14deg) translateX(100px)' }, { opacity: 1, transform: 'rotateY(-2deg)' }], .1, .9); el.append(w);
};

SCENES.weekView = (c, el, p) => {
  el.append(bg(c, 'ink', { glow: [[400, 300, 700, '#3b82f6', .22]], dots: 12 }));
  const cols = p.days.map((d, i) => h('div', { style: 'flex:1;position:relative;border-inline-start:1px solid #e2e8f0;height:760px' }, h('div', { style: `text-align:center;font:600 ${RTL ? 21 : 26}px var(--ui);color:#64748b;padding:16px 0;border-bottom:1px solid #e2e8f0` }, d)));
  p.events.forEach((e, i) => { const b = h('div', { style: `position:absolute;left:8px;right:8px;top:${70 + e[1]}px;height:${e[2]}px;border-radius:14px;padding:12px;font:600 ${RTL ? 19 : 21}px/1.2 var(--ui);color:#fff;background:${e[4] ? 'linear-gradient(135deg,#3b82f6,#1840b4)' : '#94a3b8'};overflow:hidden` }, e[3]); c.an(b, [{ opacity: 0, transform: 'scale(.7)' }, { opacity: 1, transform: 'scale(1)' }], .7 + i * .3, .4, 'cubic-bezier(.3,1.5,.5,1)'); cols[e[0]].append(b); });
  const card = h('div', { class: 'card light', style: 'width:920px;padding:30px 26px' }, h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:14px;padding:0 10px' }, h('div', { style: 'font:700 42px var(--display);color:#0f172a' }, p.title), st(icon('cal', 54), 'color:#1840b4')), h('div', { style: 'display:flex' }, cols));
  const w = h('div', { class: 'abs p3d', style: 'left:80px;top:400px' }, card); c.an(card, [{ opacity: 0, transform: 'rotateX(22deg) translateY(120px)' }, { opacity: 1, transform: 'rotateX(4deg)' }], .1, .9); el.append(w);
};

SCENES.linkShare = (c, el, p) => {
  el.append(bg(c, 'ink', { beam: true, dots: 22, glow: [[240, 500, 620, '#3b82f6', .3]] }));
  const copied = h('span', { style: 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#16a34a;border-radius:40px;color:#fff' }, p.copied); c.an(copied, K.fade, 1.75, .15);
  const btn = h('span', { style: 'position:relative;font:700 28px var(--ui);background:var(--goldgrad);color:#fff;border-radius:40px;padding:18px 34px;white-space:nowrap' }, p.copy, copied); press(c, btn, 1.5);
  const pill = h('div', { class: 'row', style: 'width:900px;padding:20px 22px 20px 34px;border-radius:70px;background:#fff;box-shadow:0 30px 80px rgba(0,0,0,.5);gap:18px;direction:ltr' }, st(icon('link', 46), 'color:#1840b4'), h('span', { style: 'flex:1;font:600 34px Inter;color:#0f172a;white-space:nowrap;overflow:hidden' }, p.url), btn);
  c.an(pill, K.pop, .3, .6); el.append(at(540, 640, pill), tapDot(c, 850, 660, 1.5));
  p.to.forEach((t, i) => { const e = h('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:18px' }, st(icon(t[0], 150), 'color:var(--gold);background:rgba(59,130,246,.12);border:1.5px solid rgba(59,130,246,.45);border-radius:50%;padding:40px'), h('div', 't1', t[1])); const w = at(230 + i * 310, 1080, e); c.an(e, [{ opacity: 0, transform: 'translateY(-200px) scale(.4)' }, { opacity: 1, transform: 'none' }], 2.3 + i * .25, .6, 'cubic-bezier(.3,1.3,.5,1)'); el.append(w); });
};

// The same exchange in Finnish, English and Arabic.
SCENES.triLang = (c, el, p) => {
  el.append(bg(c, 'blue', { dots: 20, glow: [[240, 400, 620, '#3d6cff', .35]] }));
  el.append(col(80, 400, 920, 40, ['fi', 'en', 'ar'].map((l, i) => { const card = inLang(l, () => h('div', { class: 'card', style: `padding:34px 38px;display:flex;flex-direction:column;gap:18px;font-family:${l === 'ar' ? '"Plex Arabic","Inter"' : '"Inter"'},sans-serif` }, h('div', { class: 'row', style: 'gap:16px' }, h('span', { class: 'tag', style: 'font:700 24px Inter;direction:ltr' }, l.toUpperCase()), h('span', { style: 'font-weight:600;font-size:40px' }, p.q)), h('div', { style: 'font-weight:500;font-size:36px;line-height:1.4;color:rgba(243,238,228,.75)' }, p.a))); c.an(card, [{ opacity: 0, transform: `translateX(${i % 2 ? 140 : -140}px)` }, { opacity: 1, transform: 'none' }], .3 + i * .8, .6); return card; })));
};

// Parametrised pipeline board (three visible stages of the sales pipeline).
SCENES.pipeline = (c, el, p) => {
  el.append(bg(c, 'ink', { glow: [[200, 300, 700, '#3b82f6', .2]] }));
  const X = RTL ? [884, 540, 196] : [196, 540, 884];
  p.cols.forEach((k, i) => { const cl = h('div', { style: 'width:324px;height:900px;border-radius:30px;background:rgba(255,255,255,.04);border:1px solid var(--line);padding:22px 0;text-align:center' }, h('span', 'tag ' + ['', 'b', 'g'][i], k)); c.an(cl, K.up(60), .15 + i * .15, .6); el.append(at(X[i], 860, cl)); });
  p.cards.forEach((k, i) => { const y = 600 + k[3] * 170, w = at(X[k[2]], y, h('div', { class: 'card', style: 'width:292px;padding:22px;border-radius:22px' }, h('div', { style: `font:600 ${RTL ? 24 : 25}px/1.25 var(--ui);margin-bottom:8px` }, k[0]), h('div', { style: 'font:500 20px var(--ui);color:var(--mute)' }, k[1]))); c.an(w.firstChild, K.pop, .6 + i * .12, .45); if (k[4]) { const dx = X[k[4][0]] - X[k[2]], ny = 600 + k[4][2] * 170 - y; c.out(w, [{ transform: 'translate(-50%,-50%)' }, { transform: `translate(-50%,-50%) translate(${dx * .5}px,${ny * .5 - 60}px) rotate(${dx > 0 ? 5 : -5}deg) scale(1.08)`, offset: .5 }, { transform: `translate(-50%,-50%) translate(${dx}px,${ny}px)` }], k[4][1], .7, EIO); w.style.zIndex = 5; } el.append(w); });
};
