// Scene library, part B (AD04–AD12).
const col = (x, y, w, gap, ...kids) => h('div', { class: 'abs', style: `left:${x}px;top:${y}px;width:${w}px;display:flex;flex-direction:column;gap:${gap}px` }, ...kids);
const press = (c, el, t) => c.an(el, [{ transform: 'scale(1)' }, { transform: 'scale(.92)' }, { transform: 'scale(1.05)' }, { transform: 'scale(1)' }], t, .5);
function tapDot(c, x, y, t) {
  const e = h('div', { class: 'abs', style: `left:${x - 45}px;top:${y - 45}px;width:90px;height:90px;border-radius:50%;background:rgba(255,255,255,.3);border:2px solid rgba(255,255,255,.8)` });
  c.an(e, [{ opacity: 0, transform: 'translate(120px,220px) scale(1.2)' }, { opacity: 1, transform: 'translate(0,0) scale(1)', offset: .6 }, { opacity: 1, transform: 'scale(.7)', offset: .75 }, { opacity: 0, transform: 'scale(1.5)' }], t - .6, 1.0, 'ease-out');
  return e;
}
function inLang(l, fn) { const keep = LANG; LANG = l; const r = fn(); LANG = keep; r.dir = l === 'ar' ? 'rtl' : 'ltr'; r.lang = l; return r; }

// ---------------- AD04 / AD08 set pieces ----------------
SCENES.setpiece = (c, el, p) => {
  el.append(bg(c, p.bg, { dots: 24, seed: 9, beam: true }));
  if (p.shape === 'arch') {
    const arch = h('div', { style: 'width:460px;height:700px;border-radius:230px 230px 18px 18px;border:3px solid var(--gold);background:linear-gradient(180deg,rgba(255,220,200,.20),rgba(255,220,200,.03));box-shadow:0 0 120px rgba(233,180,150,.25),inset 0 0 80px rgba(255,220,200,.10)' });
    c.an(arch, [{ opacity: 0, transform: 'scale(.9) translateY(40px)' }, { opacity: 1, transform: 'none' }], .1, 1.2);
    const shine = h('div', { style: 'position:absolute;left:60px;top:90px;width:26px;height:420px;border-radius:20px;background:linear-gradient(180deg,rgba(255,255,255,.35),transparent);transform:rotate(8deg)' }); arch.style.position = 'relative'; arch.append(shine);
    el.append(at(540, 1080, arch));
  } else {
    [620, 470, 330].forEach((s, i) => { const r = h('div', { style: `width:${s}px;height:${s}px;border-radius:50%;border:${i ? 1.5 : 3}px solid rgba(59,130,246,${1 - i * .3});background:${i === 2 ? 'radial-gradient(circle,rgba(59,130,246,.22),transparent 70%)' : 'none'}` }); c.an(r, [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1)' }], .1 + i * .15, 1); el.append(at(540, 1090, r)); });
  }
  el.append(at(540, 1090, drawIcon(c, p.icon, 250, .5, 1.5)), headline(c, p.hook, 330, .3, { size: 88 }));
};
SCENES.search = (c, el, p) => {
  el.append(bg(c, p.bg || 'ink', { glow: [[500, 300, 700, '#3b82f6', .18]] }));
  const qt = h('span', { style: 'font:500 30px var(--ui);color:#1b1712' }); typer(c, qt, p.q, .7, 1.1);
  const bar = h('div', { class: 'row', style: 'margin:110px 26px 26px;height:86px;border-radius:44px;background:#f0eee9;padding:0 28px;gap:16px;color:#8a8174' }, icon('search', 38), qt);
  const res = [0, 1, 2].map(i => { const r = h('div', { style: `margin:0 26px 22px;border-radius:28px;padding:26px;background:#fff;border:${i ? '1px solid #eee' : '3px solid #3b82f6'};box-shadow:0 10px 30px rgba(0,0,0,.06)` }, h('div', { class: 'row', style: 'gap:18px;margin-bottom:16px' }, h('div', { style: `width:76px;height:76px;border-radius:20px;background:${i ? '#e9e6e0' : 'linear-gradient(160deg,#c98a7c,#5a2c38)'}` }), h('div', { style: 'flex:1' }, i ? sk('70%', 'height:22px;margin-bottom:12px') : h('div', { style: 'font:700 30px var(--ui);color:#1b1712;margin-bottom:6px' }, SITE.salon.name), sk('45%'))), sk('100%', 'margin-bottom:10px'), sk('82%')); c.an(r, K.up(40), 2.0 + i * .18, .5); return r; });
  press(c, res[0], 3.2);
  const ph = phone(h('div', { style: 'height:100%;background:#fafaf8' }, bar, res)), w = h('div', { class: 'abs p3d', style: 'left:240px;top:330px' }, ph);
  c.an(ph, [{ transform: 'rotateY(12deg) rotateX(5deg) scale(.86)' }, { transform: 'rotateY(3deg) rotateX(2deg) scale(.9)' }], 0, c.dur + .5, 'ease-out');
  el.append(w, tapDot(c, 540, 760, 3.2));
};
SCENES.sitePhone = (c, el, p) => {
  el.append(bg(c, p.bg || 'ink', { dots: 20, beam: true }));
  const s = site(p.site), ph = phone(s), w = h('div', { class: 'abs p3d', style: 'left:240px;top:310px' }, ph), k = p.tilt || 1;
  c.an(ph, [{ opacity: 0, transform: `translateY(160px) rotateY(${-20 * k}deg) rotateX(10deg) scale(.82)` }, { opacity: 1, transform: `translateY(0) rotateY(${-9 * k}deg) rotateX(3deg) scale(.9)` }], .1, 1.2);
  c.an(s, [{ transform: 'translateY(0)' }, { transform: 'translateY(-150px)' }], 1.6, 2.6, 'ease-in-out');
  el.append(w);
};
SCENES.booking = (c, el, p) => {
  el.append(bg(c, p.bg || 'ink', { glow: [[100, 400, 700, '#3b82f6', .18]] }));
  const days = [T('Ma', 'Mon', 'الإثنين'), T('Ti', 'Tue', 'الثلاثاء'), T('Ke', 'Wed', 'الأربعاء'), T('To', 'Thu', 'الخميس'), T('Pe', 'Fri', 'الجمعة')].map((d, i) => { const e = h('div', { style: `flex:1;text-align:center;padding:18px 0;border-radius:20px;font:600 ${RTL ? 19 : 25}px var(--ui);background:#f1eee8;color:#1b1712` }, d); if (i === 3) c.an(e, [{ background: '#f1eee8', color: '#1b1712' }, { background: '#1b1712', color: '#fff' }], 1.0, .25); return e; });
  const slots = ['10:00', '11:30', '13:00', '14:30', '16:00', '17:30'].map((s, i) => { const e = h('div', { style: 'text-align:center;padding:24px 0;border-radius:22px;font:600 30px Inter;border:2px solid #e4dfd6;color:#1b1712;direction:ltr' }, s); if (i === 3) c.an(e, [{ background: '#fff', borderColor: '#e4dfd6' }, { background: '#dbeafe', borderColor: '#3b82f6' }], 1.6, .25); return e; });
  const btn = h('div', { style: 'margin:34px 28px 0;text-align:center;padding:28px;border-radius:44px;background:#1b1712;color:#fff;font:700 29px var(--ui)' }, T('Lähetä varauspyyntö', 'Send booking request', 'إرسال طلب الحجز')); press(c, btn, 2.9);
  const ok = h('div', { style: 'position:absolute;inset:0;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;color:#1b1712;font:700 38px var(--ui)' }, st(icon('check', 150), 'color:#fff;background:linear-gradient(135deg,#60a5fa,#1840b4);border-radius:50%;padding:36px'), T('Pyyntö lähetetty', 'Request sent', 'تم إرسال الطلب'));
  c.an(ok, K.fade, 3.3, .35); c.an(ok.firstChild, K.pop, 3.4, .5);
  const scr = h('div', { style: 'position:relative;height:100%;background:#fff' }, h('div', { style: 'padding:110px 28px 26px;font:700 44px var(--display);color:#1b1712' }, T('Varaa aika', 'Book a time', 'احجز موعداً')), h('div', { style: 'display:flex;gap:10px;padding:0 28px' }, days), h('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:30px 28px 0' }, slots), btn, ok);
  const ph = phone(scr), w = h('div', { class: 'abs p3d', style: 'left:240px;top:310px' }, ph);
  c.an(ph, [{ transform: 'rotateY(-10deg) rotateX(4deg) scale(.86)' }, { transform: 'rotateY(4deg) rotateX(2deg) scale(.9)' }], 0, c.dur + .5, 'ease-out');
  el.append(w);
};
SCENES.quiet = (c, el, p) => {
  el.append(bg(c, p.bg || 'warm', { dots: 30, seed: 4, glow: [[240, 400, 700, '#3b82f6', .2]] }));
  const ic = at(540, 800, drawIcon(c, p.icon, 420, .1, 1.6, 'rgba(59,130,246,.55)')); el.append(ic);
  const card = h('div', { class: 'card row', style: 'width:820px' }, badge('cal'), h('div', { style: 'flex:1' }, h('div', 't1', p.text), h('div', 't2', p.sub)), h('span', 'tag', T('Uusi', 'New', 'جديد')));
  const w = at(540, 1180, card); c.an(card, [{ opacity: 0, transform: 'translateY(60px) scale(.94)' }, { opacity: 1, transform: 'none' }], 1.2, .7); el.append(w);
};

// ---------------- AD05 workshop ----------------
SCENES.ringing = (c, el, p) => {
  el.append(bg(c, 'steel', { grid: true, glow: [[-100, 900, 700, '#3b82f6', .3]] }));
  el.append(at(250, 1220, drawIcon(c, p.icon || 'wrench', 360, .2, 1.6, 'rgba(59,130,246,.5)')));
  const scr = h('div', { style: 'height:100%;background:linear-gradient(180deg,#10202c,#0a1016);display:flex;flex-direction:column;align-items:center;color:#fff' }, h('div', { style: 'margin-top:230px;font:500 30px var(--ui);opacity:.7' }, T('Saapuva puhelu', 'Incoming call', 'مكالمة واردة')), h('div', { style: 'margin-top:16px;font:600 54px var(--ui)' }, T('Asiakas', 'Customer', 'عميل')), st(icon('phone', 150), 'margin-top:420px;background:#2fbf71;border-radius:50%;padding:40px;color:#fff;box-shadow:0 0 0 24px rgba(47,191,113,.2),0 0 0 54px rgba(47,191,113,.1)'));
  const ph = phone(scr), w = h('div', { class: 'abs p3d', style: 'left:420px;top:780px' }, ph); ph.style.zoom = .62;
  c.an(ph, [{ transform: 'rotateZ(8deg) rotateY(-14deg)' }, { transform: 'rotateZ(5deg) rotateY(-8deg)' }], 0, c.dur + .5);
  const sh = [{ translate: '0 0' }, { translate: '-9px 2px' }, { translate: '9px -2px' }, { translate: '-9px 2px' }, { translate: '9px -2px' }, { translate: '-6px 0' }, { translate: '6px 0' }, { translate: '0 0' }];
  c.an(w, sh, .9, .7, 'linear'); c.out(w, sh, 2.3, .7, 'linear');
  el.append(w, headline(c, p.hook, 330, .25, { size: 92 }));
};
SCENES.channels = (c, el) => {
  el.append(bg(c, 'steel', { glow: [[500, 300, 700, '#7a1f1f', .3]] }));
  const items = [['phone', T('Puhelu', 'Phone call', 'مكالمة'), T('”Ehtisittekö vaihtaa renkaat?”', '“Could you fit in a tyre change?”', '«هل يمكنكم تبديل الإطارات؟»'), -520, -5, 300], ['mail', T('Sähköposti', 'Email', 'بريد إلكتروني'), T('Tarjouspyyntö: jarruremontti', 'Quote request: brake repair', 'طلب عرض سعر: إصلاح المكابح'), 520, 4, 560], ['chat', T('Viesti', 'Message', 'رسالة'), T('”Milloin olisi huoltoaika?”', '“When could I book a service?”', '«متى يمكن حجز موعد صيانة؟»'), -520, -3, 820], ['note', T('Muistilappu', 'Sticky note', 'ملاحظة ورقية'), T('Soita takaisin!', 'Call back!', 'عاود الاتصال!'), 520, 6, 1080]];
  items.forEach((it, i) => {
    const card = h('div', { class: 'card row', style: 'width:800px' }, badge(it[0]), h('div', null, h('div', 't2', it[1]), h('div', 't1', it[2])));
    const w = at(540 + (i % 2 ? 40 : -40), 520 + i * 230, card, `rotate:${it[4]}deg`);
    c.an(w, [{ opacity: 0, transform: `translate(-50%,-50%) translateX(${it[3]}px)` }, { opacity: 1, transform: 'translate(-50%,-50%)' }], .3 + i * .5, .5, 'cubic-bezier(.3,1.3,.5,1)');
    el.append(w);
  });
};
SCENES.form = (c, el, p) => {
  el.append(bg(c, p.bg || 'steel', { dots: 16, glow: [[200, 300, 700, '#3b82f6', .18]] }));
  const flds = p.fields.map((f, i) => { const v = h('div', { style: 'font:600 34px var(--ui);color:#1b1712;min-height:44px' }); typer(c, v, f[1], .6 + i * .9, .6); const box = h('div', { style: 'border:2px solid #e2ddd3;border-radius:22px;padding:18px 26px;background:#faf8f4' }, h('div', { style: 'font:500 22px var(--ui);color:#8a8174;margin-bottom:6px' }, f[0]), v); c.an(box, [{ borderColor: '#e2ddd3' }, { borderColor: '#3b82f6' }, { borderColor: '#e2ddd3' }], .5 + i * .9, .9); return box; });
  const btn = h('div', { style: 'text-align:center;padding:28px;border-radius:44px;background:var(--goldgrad);color:#ffffff;font:700 32px var(--ui);margin-top:8px' }, p.btn); press(c, btn, 3.5);
  const card = h('div', { class: 'card light', style: 'width:840px;padding:44px;display:flex;flex-direction:column;gap:22px' }, h('div', { class: 'row' }, st(icon(p.icon || 'wrench', 54), 'color:#1840b4'), h('div', { style: 'font:700 46px var(--display)' }, p.title)), flds, btn);
  const w = h('div', { class: 'abs p3d', style: 'left:120px;top:400px' }, card);
  c.an(card, [{ opacity: 0, transform: 'rotateX(20deg) translateY(120px)' }, { opacity: 1, transform: 'rotateX(3deg)' }], .1, .9);
  el.append(w);
};
SCENES.queue = (c, el) => {
  el.append(bg(c, 'steel', { grid: true, glow: [[300, 300, 700, '#3b82f6', .2]] }));
  const rows = [[T('Määräaikaishuolto', 'Scheduled service', 'صيانة دورية'), 'ABC-123', T('Uusi', 'New', 'جديد'), ''], [T('Renkaanvaihto', 'Tyre change', 'تبديل الإطارات'), 'XYZ-456', T('Aika ehdotettu', 'Time proposed', 'تم اقتراح موعد'), 'b'], [T('Jarruremontti', 'Brake repair', 'إصلاح المكابح'), 'KLM-789', T('Tarjous lähetetty', 'Quote sent', 'أُرسل العرض'), 'g']];
  const list = col(90, 420, 900, 24, rows.map((r, i) => { const card = h('div', 'card row', h('div', { style: 'width:64px;height:64px;border-radius:50%;background:var(--goldgrad);color:#ffffff;font:700 32px Inter;display:flex;align-items:center;justify-content:center;flex:none' }, i + 1), h('div', { style: 'flex:1' }, h('div', 't1', r[0]), h('div', { class: 't2', style: 'direction:ltr;text-align:start' }, r[1])), h('span', 'tag ' + r[3], r[2])); c.an(card, K.up(60), .5 + i * .4, .6); return card; }));
  const rem = h('div', { class: 'card row', style: 'border-color:rgba(59,130,246,.6);background:rgba(18,30,60,.95);width:780px' }, st(badge('bell'), 'background:var(--goldgrad);color:#ffffff'), h('div', null, h('div', 't2', T('Muistutus', 'Reminder', 'تذكير')), h('div', 't1', T('Soita asiakkaalle: ABC-123', 'Call the customer: ABC-123', 'اتصل بالعميل: ABC-123'))));
  c.an(rem, [{ opacity: 0, transform: 'translateY(-50px) scale(.9)' }, { opacity: 1, transform: 'none' }], 2.8, .5, 'cubic-bezier(.3,1.5,.5,1)');
  c.an(rem.firstChild, [{ rotate: '0deg' }, { rotate: '-16deg' }, { rotate: '14deg' }, { rotate: '-8deg' }, { rotate: '0deg' }], 3.0, .6, 'linear');
  el.append(list, at(540, 1130, rem));
};

// ---------------- AD06 cleaning leads ----------------
const NOTE_C = ['#ffe58a', '#ffc2d1', '#bfe3ff', '#c9f2c7', '#ffd9a8'];
function sticky(i, txt, w = 250) { return h('div', { style: `width:${w}px;height:${w}px;background:${NOTE_C[i % 5]};padding:26px;box-shadow:0 18px 30px rgba(0,0,0,.35);font:600 ${RTL ? 30 : 34}px/1.25 var(--ui);color:#33301f;display:flex;flex-direction:column;gap:14px` }, txt ? h('div', null, txt) : null, h('div', { style: 'height:6px;border-radius:3px;background:rgba(0,0,0,.18);width:86%' }), h('div', { style: 'height:6px;border-radius:3px;background:rgba(0,0,0,.18);width:60%' }), txt ? null : h('div', { style: 'height:6px;border-radius:3px;background:rgba(0,0,0,.18);width:74%' })); }
SCENES.notes = (c, el, p) => {
  el.append(bg(c, 'fresh', { glow: [[500, 900, 700, '#2e8f86', .3]] }));
  const txt = [T('Ti: tarjous?', 'Tue: quote?', 'الثلاثاء: عرض سعر؟'), null, T('Soita!', 'Call!', 'اتصل!'), null, T('Ikkunat – hinta?', 'Windows — price?', 'النوافذ — السعر؟'), null];
  const pos = [[250, 900, -8], [560, 860, 5], [850, 930, -4], [330, 1190, 6], [640, 1180, -6], [880, 1230, 9]];
  pos.forEach((q, i) => { const n = at(q[0], q[1], sticky(i, txt[i]), `rotate:${q[2]}deg`); c.an(n, [{ opacity: 0, transform: 'translate(-50%,-50%) translateY(-200px) scale(1.2)' }, { opacity: 1, transform: 'translate(-50%,-50%)' }], .2 + i * .16, .45, 'cubic-bezier(.3,1.3,.5,1)'); el.append(n); });
  el.append(headline(c, p.hook, 330, .9, { size: 84 }));
};
SCENES.scatter = (c, el) => {
  el.append(bg(c, 'fresh', { dots: 14 }));
  const z = [['mail', T('Sähköposti', 'Email', 'البريد'), 260, 560], ['note', T('Muistilaput', 'Sticky notes', 'الملاحظات'), 800, 760], ['brain', T('Oma muisti', 'Your memory', 'الذاكرة'), 330, 1060]];
  z.forEach((q, i) => {
    const b = h('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:16px' }, st(icon(q[0], 150), 'color:var(--gold);background:rgba(59,130,246,.1);border-radius:50%;padding:36px;border:1.5px solid rgba(59,130,246,.4)'), h('div', 't1', q[1]));
    const w = at(q[2], q[3], b); c.an(b, K.pop, .2 + i * .35, .5); el.append(w);
    [0, 1].forEach(j => { const chip = h('div', { class: 'card', style: 'padding:14px 22px;border-radius:18px;width:200px' }, sk('100%', 'background:rgba(255,255,255,.25);margin-bottom:10px'), sk('60%', 'background:rgba(255,255,255,.15)')); const cw = at(q[2] + (j ? 190 : -170) * (i === 1 ? -1 : 1) + (i === 1 ? -20 : 20), q[3] + (j ? 150 : -120), chip); const lost = (i + j) % 2 === 1; c.an(chip, lost ? [{ opacity: 0, transform: 'none' }, { opacity: 1, transform: 'none', offset: .15 }, { opacity: 1, transform: 'none', offset: .55 }, { opacity: 0, transform: 'translateY(160px) rotate(14deg)' }] : [{ opacity: 0 }, { opacity: 1, offset: .15 }, { opacity: 1 }], .7 + i * .3 + j * .2, 3.4, 'ease-in'); el.append(cw); });
  });
};
SCENES.gather = (c, el) => {
  el.append(bg(c, 'fresh', { beam: true, glow: [[240, 500, 600, '#3b82f6', .2]] }));
  const frame = h('div', { style: 'width:820px;height:760px;border-radius:40px;border:3px solid var(--gold);background:rgba(10,24,28,.6);box-shadow:0 0 100px rgba(59,130,246,.2)' });
  c.an(frame, [{ opacity: 0, transform: 'scale(.8)' }, { opacity: 1, transform: 'scale(1)' }], .2, .8); el.append(at(540, 830, frame));
  const r = rng(5);
  for (let i = 0; i < 6; i++) { const tx = 320 + (i % 2) * 440, ty = 600 + Math.floor(i / 2) * 230, x0 = (r() - .5) * 1700, y0 = (r() - .5) * 2200; const card = h('div', { class: 'card', style: 'width:340px;padding:24px;border-radius:24px' }, h('div', { class: 'row', style: 'gap:14px;margin-bottom:14px' }, st(icon(['mail', 'note', 'chat', 'phone', 'mail', 'note'][i], 40), 'color:var(--gold)'), sk('60%', 'background:rgba(255,255,255,.3);height:18px')), sk('100%', 'background:rgba(255,255,255,.14);margin-bottom:10px'), sk('70%', 'background:rgba(255,255,255,.14)')); const w = at(tx, ty, card); c.an(w, [{ opacity: 0, transform: `translate(-50%,-50%) translate(${x0}px,${y0}px) rotate(${(r() - .5) * 80}deg)` }, { opacity: 1, transform: 'translate(-50%,-50%)' }], .6 + i * .22, .9, EIO); el.append(w); }
};
SCENES.kanban = (c, el) => {
  el.append(bg(c, 'fresh', { glow: [[200, 300, 700, '#3b82f6', .15]] }));
  const cols = [[T('Uusi', 'New', 'جديد'), ''], [T('Tarjottu', 'Quoted', 'تم التسعير'), 'b'], [T('Sovittu', 'Booked', 'مؤكَّد'), 'g']];
  const X = RTL ? [884, 540, 196] : [196, 540, 884];
  cols.forEach((k, i) => { const cl = h('div', { style: 'width:324px;height:900px;border-radius:30px;background:rgba(255,255,255,.04);border:1px solid var(--line);padding:22px 0;text-align:center' }, h('span', 'tag ' + k[1], k[0])); c.an(cl, K.up(60), .15 + i * .15, .6); el.append(at(X[i], 860, cl)); });
  const mk = (t, s) => h('div', { class: 'card', style: 'width:292px;padding:22px;border-radius:22px' }, h('div', { style: `font:600 ${RTL ? 24 : 25}px/1.25 var(--ui);margin-bottom:8px` }, t), h('div', { style: 'font:500 20px var(--ui);color:var(--mute)' }, s));
  const cards = [[T('Kotisiivous', 'Home cleaning', 'تنظيف منزلي'), T('Kysely verkosta', 'Web inquiry', 'طلب من الموقع'), 0, 0, null], [T('Toimistosiivous', 'Office cleaning', 'تنظيف مكاتب'), T('Tarjouspyyntö', 'Quote request', 'طلب عرض سعر'), 0, 1, [1, 1.6]], [T('Ikkunanpesu', 'Window cleaning', 'تنظيف النوافذ'), T('Tarjous lähetetty', 'Quote sent', 'أُرسل العرض'), 1, 1, [2, 2.6]], [T('Muuttosiivous', 'Move-out cleaning', 'تنظيف عند الانتقال'), T('Aika sovittu', 'Time agreed', 'تم تحديد الموعد'), 2, 0, null], [T('Porrassiivous', 'Stairwell cleaning', 'تنظيف الدرج'), T('Kysely puhelimitse', 'Phone inquiry', 'طلب هاتفي'), 0, 2, null]];
  cards.forEach((k, i) => { const y = 600 + k[3] * 170, w = at(X[k[2]], y, mk(k[0], k[1])); c.an(w.firstChild, K.pop, .6 + i * .12, .45); if (k[4]) { const dx = X[k[4][0]] - X[k[2]], ny = 600 + (k[4][0] === 2 ? 1 : 0) * 170 - y; c.out(w, [{ transform: 'translate(-50%,-50%)' }, { transform: `translate(-50%,-50%) translate(${dx * .5}px,${ny * .5 - 60}px) rotate(${dx > 0 ? 5 : -5}deg) scale(1.08)`, offset: .5 }, { transform: `translate(-50%,-50%) translate(${dx}px,${ny}px)` }], k[4][1], .7, EIO); w.style.zIndex = 5; } el.append(w); });
};

// ---------------- AD07 moving ----------------
SCENES.calendar = (c, el, p) => {
  el.append(bg(c, 'ink', { glow: [[500, 900, 700, '#27407a', .4]], dots: 16 }));
  const cells = []; for (let i = 0; i < 35; i++) { const d = i - 2, on = d === 14; const e = h('div', { style: `position:relative;height:104px;display:flex;align-items:center;justify-content:center;font:${on ? 700 : 500} 34px Inter;color:${d < 1 || d > 30 ? '#c9c3b8' : '#1b1712'}` }, d < 1 ? 31 + d : d > 30 ? d - 30 : d); if (on) { const r = h('div', { style: 'position:absolute;inset:8px 22px;border-radius:50%;border:5px solid #3b82f6;box-shadow:0 0 30px rgba(59,130,246,.6)' }); c.an(r, [{ opacity: 0, transform: 'scale(2)' }, { opacity: 1, transform: 'scale(1)' }], 1.4, .45, 'cubic-bezier(.3,1.5,.5,1)'); c.an(r, [{ boxShadow: '0 0 0 0 rgba(59,130,246,.6)' }, { boxShadow: '0 0 0 34px rgba(59,130,246,0)' }], 2.0, 1.2, 'ease-out'); e.append(r); } cells.push(e); }
  const card = h('div', { class: 'card light', style: 'width:840px;padding:34px' }, h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:14px' }, h('div', { style: 'font:700 46px var(--display)' }, T('Kesäkuu', 'June', 'يونيو')), st(icon('cal', 60), 'color:#1840b4')), h('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);direction:ltr' }, cells));
  const w = h('div', { class: 'abs p3d', style: 'left:120px;top:760px' }, card); c.an(card, [{ opacity: 0, transform: 'rotateX(26deg) translateY(120px)' }, { opacity: 1, transform: 'rotateX(8deg)' }], .15, 1);
  el.append(w, headline(c, p.hook, 330, .3, { size: 84 }));
};
SCENES.phoneTag = (c, el) => {
  el.append(bg(c, 'ink', { glow: [[100, 300, 600, '#7a1f1f', .3]] }));
  const A = at(220, 620, st(icon('phone', 190), 'color:var(--gold);border:2px solid rgba(59,130,246,.5);border-radius:50%;padding:46px')), B = at(860, 620, st(icon('phone', 190), 'color:#a9c9ff;border:2px solid rgba(111,168,255,.5);border-radius:50%;padding:46px'));
  el.append(A, B);
  [0, 1, 2].forEach(i => { const dir = i % 2 ? -1 : 1, e = at(540, 620, st(icon('x', 70), 'color:#ff8a80;background:#2a1414;border-radius:50%;padding:14px')); c.an(e, [{ opacity: 0, transform: `translate(-50%,-50%) translateX(${-230 * dir}px)` }, { opacity: 1, transform: `translate(-50%,-50%) translateX(${-120 * dir}px) translateY(-70px)`, offset: .3 }, { opacity: 1, transform: `translate(-50%,-50%) translateX(${200 * dir}px)`, offset: .8 }, { opacity: 0, transform: `translate(-50%,-50%) translateX(${230 * dir}px) scale(1.6)` }], .3 + i * 1.2, 1.1, 'ease-in-out'); el.append(e); const tgt = i % 2 ? A : B; c.out(tgt.firstChild, [{ rotate: '0deg' }, { rotate: '-12deg' }, { rotate: '12deg' }, { rotate: '0deg' }], 1.1 + i * 1.2, .3, 'linear'); });
  const msgs = [T('Soititko?', 'Did you call?', 'هل اتصلت؟'), T('Joo, yritin tavoittaa…', 'Yes, I tried to reach you…', 'نعم، حاولت الوصول إليك…'), T('Mikä päivä kävisi?', 'Which day works?', 'أي يوم يناسبك؟'), T('Palaan asiaan!', "I'll get back to you!", 'سأعود إليك!')];
  el.append(col(110, 860, 860, 18, msgs.map((m, i) => { const b = h('div', 'bubble' + (i % 2 ? ' me' : ''), m); c.an(b, K.pop, 1.0 + i * .65, .4); return b; })));
};
SCENES.stepper = (c, el) => {
  el.append(bg(c, 'ink', { grid: true, glow: [[300, 300, 700, '#27407a', .4]] }));
  const F = [['pin', T('Mistä', 'From', 'من'), T('Tampere', 'Tampere', 'تامبيري')], ['pin', T('Minne', 'To', 'إلى'), T('Helsinki', 'Helsinki', 'هلسنكي')], ['cal', T('Milloin', 'When', 'متى'), T('La 14.6.', 'Sat 14 June', 'السبت 14 يونيو')]];
  const rows = F.map((f, i) => { const v = h('div', { style: 'font:600 40px var(--ui);color:#1b1712;min-height:52px' }); typer(c, v, f[2], .5 + i, .55); const ic = st(icon(f[0], 64), 'color:#fff;background:linear-gradient(135deg,#60a5fa,#1840b4);border-radius:50%;padding:14px'); c.an(ic, K.pop, .3 + i, .4); return h('div', { class: 'row', style: 'gap:28px;padding:26px 0' }, ic, h('div', { style: 'flex:1;border-bottom:2px solid #e2ddd3;padding-bottom:18px' }, h('div', { style: 'font:500 24px var(--ui);color:#8a8174' }, f[1]), v)); });
  const card = h('div', { class: 'card light', style: 'position:relative;width:840px;padding:40px 44px' }, h('div', { style: 'font:700 46px var(--display);margin-bottom:8px' }, T('Muuttovaraus', 'Moving booking', 'حجز نقل')), rows);
  const ln = h('div', { style: `position:absolute;${RTL ? 'right' : 'left'}:74px;top:206px;width:4px;height:330px;background:repeating-linear-gradient(180deg,#3b82f6 0 10px,transparent 10px 20px);transform-origin:top` }); c.an(ln, [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], .6, 2, 'linear'); card.append(ln);
  const w = h('div', { class: 'abs p3d', style: 'left:120px;top:440px' }, card); c.an(card, [{ opacity: 0, transform: 'rotateY(-16deg) translateX(100px)' }, { opacity: 1, transform: 'rotateY(-3deg)' }], .1, .9); el.append(w);
};
SCENES.requestCard = (c, el) => {
  el.append(bg(c, 'ink', { glow: [[300, 300, 700, '#3b82f6', .2]], dots: 16 }));
  const R = [[T('Reitti', 'Route', 'المسار'), T('Tampere → Helsinki', 'Tampere → Helsinki', 'تامبيري ← هلسنكي')], [T('Päivä', 'Date', 'التاريخ'), T('La 14.6.', 'Sat 14 June', 'السبت 14 يونيو')], [T('Asunto', 'Home', 'المسكن'), T('Kaksio, 3. kerros', '1-bedroom, 3rd floor', 'غرفتان، الطابق الثالث')]];
  const btn = h('span', { class: 'btn', style: 'font-size:32px;padding:24px 50px;margin-top:30px' }, T('Vahvista', 'Confirm', 'تأكيد')); press(c, btn, 2.6);
  const tg = h('span', 'tag', T('Uusi', 'New', 'جديد')), tg2 = h('span', { class: 'tag g', style: 'position:absolute;inset-inline-end:44px;top:52px' }, T('Vahvistettu', 'Confirmed', 'مؤكَّد'));
  c.out(tg, K.out, 2.85, .15); c.an(tg2, K.pop, 2.95, .4);
  const card = h('div', { class: 'card', style: 'position:relative;width:860px;padding:40px 44px' }, h('div', { class: 'row', style: 'margin-bottom:10px' }, badge('van'), h('div', { class: 't1', style: 'flex:1;font-size:40px' }, T('Varauspyyntö', 'Booking request', 'طلب حجز')), tg), tg2, R.map((r, i) => { const e = h('div', { style: 'display:flex;justify-content:space-between;gap:20px;padding:22px 0;border-bottom:1px solid rgba(255,255,255,.08)' }, h('span', 't2', r[0]), h('span', 't1', r[1])); c.an(e, K.up(24), .6 + i * .25, .5); return e; }), btn);
  const w = h('div', { class: 'abs p3d', style: 'left:110px;top:430px' }, card); c.an(card, [{ opacity: 0, transform: 'scale(.86) rotateX(14deg)' }, { opacity: 1, transform: 'none' }], .1, .8); el.append(w);
};
SCENES.route = (c, el) => {
  el.append(bg(c, 'ink', { grid: true, glow: [[100, 200, 700, '#27407a', .4], [500, 900, 600, '#3b82f6', .2]] }));
  const s = h('div', { class: 'abs', style: 'left:0;top:300px;width:1080px;height:1100px', html: '<svg viewBox="0 0 1080 1100" style="width:100%;height:100%"><path id="rt" d="M250 880 C 250 620, 560 700, 560 480 S 820 380, 830 190" fill="none" stroke="#3b82f6" stroke-width="7" stroke-linecap="round" stroke-dasharray="1" pathLength="1"/></svg>' });
  c.an(s.querySelector('path'), K.draw, .3, 2.6, 'ease-in-out'); el.append(s);
  const pin = (x, y, t, lab) => { const e = at(x, y, h('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:8px' }, st(icon('pin', 110), 'color:var(--gold-hi)'), h('div', 't1', lab))); c.an(e.firstChild, K.pop, t, .5); return e; };
  el.append(pin(250, 1200, .2, T('Tampere', 'Tampere', 'تامبيري')), pin(830, 440, 2.6, T('Helsinki', 'Helsinki', 'هلسنكي')));
  const van = h('div', { class: 'abs', style: 'left:0;top:300px;width:120px;height:120px;margin:-60px;offset-path:path("M250 880 C 250 620, 560 700, 560 480 S 820 380, 830 190");offset-rotate:0deg' }, st(icon('van', 120), 'color:#ffffff;background:var(--goldgrad);border-radius:50%;padding:24px;box-shadow:0 0 50px rgba(59,130,246,.6)'));
  c.an(van, [{ offsetDistance: '0%' }, { offsetDistance: '88%' }], .3, 2.6, 'ease-in-out'); el.append(van);
};

// ---------------- AD08 restaurant ----------------
SCENES.questions = (c, el, p) => {
  el.append(bg(c, 'wine', { dots: 20, glow: [[400, 300, 700, '#60a5fa', .15]] }));
  p.qs.forEach((q, i) => { const b = h('div', { style: `padding:40px 54px;border-radius:60px;font:600 ${RTL ? 54 : 64}px var(--display);${i === 1 ? 'background:var(--goldgrad);color:#ffffff' : 'background:#f5f0e7;color:#1b1712'};border-end-${i % 2 ? 'end' : 'start'}-radius:12px;box-shadow:0 30px 60px rgba(0,0,0,.4);white-space:nowrap` }, q); const w = at(i % 2 ? 620 : 460, 520 + i * 290, b, `rotate:${[-3, 2, -2][i]}deg`); c.an(b, [{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'scale(1.08)', offset: .7 }, { opacity: 1, transform: 'scale(1)' }], .3 + i * .9, .5); el.append(w); });
};
SCENES.trio = (c, el) => {
  el.append(bg(c, 'wine', { glow: [[300, 300, 700, '#60a5fa', .15]] }));
  const I = [['menu', T('Menu', 'Menu', 'قائمة الطعام'), T('Aina ajan tasalla', 'Always up to date', 'محدَّثة دائماً')], ['clock', T('Aukioloajat', 'Opening hours', 'ساعات العمل'), T('Tänään 16–23', 'Today 16–23', 'اليوم 16–23')], ['cal', T('Pöytävaraus', 'Table booking', 'حجز طاولة'), T('Lähetä pyyntö verkossa', 'Send a request online', 'أرسل طلبك عبر الموقع')]];
  el.append(col(110, 430, 860, 34, I.map((k, i) => { const card = h('div', { class: 'card row', style: 'padding:40px;gap:32px' }, st(icon(k[0], 110), 'color:var(--gold);background:rgba(59,130,246,.12);border-radius:30px;padding:24px'), h('div', null, h('div', { style: `font:600 ${RTL ? 46 : 56}px var(--display)` }, k[1]), h('div', 't2', k[2]))); c.an(card, K.up(70), .2 + i * .2, .6); c.an(card, [{ borderColor: 'rgba(255,255,255,.09)', scale: '1' }, { borderColor: '#3b82f6', scale: '1.04', offset: .3 }, { borderColor: '#3b82f6', scale: '1.04', offset: .7 }, { borderColor: 'rgba(255,255,255,.09)', scale: '1' }], .9 + i * .9, 1.0, 'ease-in-out', 'none'); return card; })));
};
SCENES.evening = (c, el) => {
  el.append(bg(c, 'wine'));
  const r = rng(31); for (let i = 0; i < 26; i++) { const s = 60 + r() * 200, e = h('div', { class: 'abs', style: `left:${r() * 1080 - s / 2}px;top:${260 + r() * 900}px;width:${s}px;height:${s}px;border-radius:50%;background:radial-gradient(circle,rgba(255,${170 + r() * 60 | 0},${80 + r() * 60 | 0},.5),transparent 70%);filter:blur(${6 + r() * 14}px)` }); c.an(e, [{ opacity: .2, transform: 'translateY(0)' }, { opacity: .9, transform: 'translateY(-20px)' }, { opacity: .35, transform: 'translateY(-40px)' }], r() * -2, c.dur + 3, 'ease-in-out'); el.append(e); }
  el.append(at(540, 780, drawIcon(c, 'cloche', 380, .2, 1.6, '#bfdbfe')));
};

// ---------------- AD09 time ----------------
SCENES.ring24 = (c, el, p) => {
  el.append(bg(c, p.free ? 'warm' : 'ink', { dots: p.free ? 30 : 12, glow: [[240, 600, 600, '#3b82f6', p.free ? .25 : .12]] }));
  const R = 330, cy = p.free ? 800 : 1060, routine = [8, 9, 10, 12, 13, 15, 16, 18, 19, 20];
  for (let i = 0; i < 24; i++) { const a = i * 15 - 90, on = routine.includes(i); const seg = h('div', { class: 'abs', style: `left:540px;top:${cy}px;width:62px;height:26px;margin:-13px -31px;border-radius:13px;background:rgba(255,255,255,.14);transform:rotate(${a}deg) translateX(${R}px) rotate(90deg)` });
    if (p.free) { if (on) c.an(seg, [{ background: '#b4483c' }, { background: '#3b82f6', boxShadow: '0 0 30px rgba(59,130,246,.8)' }], .5 + routine.indexOf(i) * .14, .5); }
    else if (on) c.an(seg, [{ background: 'rgba(255,255,255,.14)' }, { background: '#b4483c' }], 1.2 + routine.indexOf(i) * .18, .3);
    c.an(seg, K.fade, i * .02, .3); el.append(seg); }
  const mid = h('div', { style: 'text-align:center' }, h('div', { style: 'font:300 170px Inter;letter-spacing:-6px;direction:ltr' }, '24', h('span', { style: 'font-size:70px;color:var(--gold)' }, 'h')), h('div', { class: 't2', style: 'margin-top:-10px' }, p.free ? T('Aikaa olennaiseen', 'Time for what matters', 'وقت لما يهمّ') : T('Rutiinit', 'Routine', 'الروتين')));
  if (!p.free) { mid.lastChild.style.color = '#ff9d92'; c.an(mid.lastChild, K.fade, 1.4, .5); } else { mid.lastChild.style.color = 'var(--gold-hi)'; }
  el.append(at(540, cy, mid)); if (p.hook) el.append(headline(c, p.hook, 330, .3, { size: 86 }));
};
SCENES.repeat = (c, el) => {
  el.append(bg(c, 'ink', { glow: [[500, 300, 700, '#7a1f1f', .25]] }));
  const labels = [T('Vastaus: aukioloajat', 'Reply: opening hours', 'ردّ: ساعات العمل'), T('Kirjaus: uusi asiakas', 'Entry: new customer', 'إدخال: عميل جديد'), T('Vahvistus: varaus', 'Confirmation: booking', 'تأكيد: حجز')];
  for (let i = 0; i < 9; i++) { const k = i % 3, card = h('div', { class: 'card row', style: 'width:760px' }, badge(['chat', 'list', 'cal'][k]), h('div', { class: 't1', style: 'flex:1' }, labels[k]), h('span', { class: 'tag r', style: 'direction:ltr' }, '×' + (Math.floor(i / 3) + 1) * (k + 2))); const w = at(540 + (Math.floor(i / 3) - 1) * 26, 480 + k * 250 + Math.floor(i / 3) * 34, card, `rotate:${(Math.floor(i / 3) - 1) * 2.5}deg`); c.an(w, [{ opacity: 0, transform: 'translate(-50%,-50%) scale(1.3)' }, { opacity: 1, transform: 'translate(-50%,-50%)' }], .3 + i * .32, .3, 'ease-out'); el.append(w); }
};
SCENES.automate = (c, el) => {
  el.append(bg(c, 'ink', { grid: true, glow: [[240, 500, 600, '#3b82f6', .25]] }));
  const node = h('div', { style: 'width:250px;height:250px;border-radius:50%;background:var(--goldgrad);display:flex;align-items:center;justify-content:center;color:#ffffff;box-shadow:0 0 120px rgba(59,130,246,.6)' }, icon('bolt', 130));
  c.an(node, K.pop, .2, .6); c.an(node, [{ boxShadow: '0 0 60px rgba(59,130,246,.4)' }, { boxShadow: '0 0 160px rgba(59,130,246,.9)' }, { boxShadow: '0 0 60px rgba(59,130,246,.4)' }], 1, 1.4, 'ease-in-out', 'none');
  [0, 1, 2].forEach(i => { const card = h('div', { class: 'card row', style: 'width:300px;padding:20px;border-radius:22px;gap:14px' }, st(icon(['chat', 'list', 'cal'][i], 44), 'color:var(--gold)'), sk('120px', 'background:rgba(255,255,255,.25)')); const w = at(540, 800, card); const x = (i - 1) * 330; c.an(w, [{ opacity: 0, transform: `translate(-50%,-50%) translate(${x}px,-430px)` }, { opacity: 1, transform: `translate(-50%,-50%) translate(${x}px,-380px)`, offset: .25 }, { opacity: 1, transform: `translate(-50%,-50%) translate(${x * .4}px,-200px) scale(.8)`, offset: .7 }, { opacity: 0, transform: 'translate(-50%,-50%) scale(.2)' }], .5 + i * .3, 1.7, 'ease-in'); el.append(w);
    const done = h('div', { class: 'card row', style: 'width:300px;padding:20px;border-radius:22px;gap:14px;border-color:rgba(110,210,160,.5)' }, st(icon('check', 44), 'color:#9be3c0'), h('span', { style: 'font:600 24px var(--ui)' }, T('Hoidettu', 'Done', 'تم'))); const w2 = at(540, 800, done); c.an(w2, [{ opacity: 0, transform: 'translate(-50%,-50%) scale(.2)' }, { opacity: 1, transform: `translate(-50%,-50%) translate(${x}px,360px)` }], 2.3 + i * .25, .7, EASE); el.append(w2); });
  el.append(at(540, 800, node));
};
SCENES.blueprint = (c, el) => {
  el.append(bg(c, 'ink', { grid: true }));
  const rows = [T('Yhteydenottojen kirjaus', 'Logging inquiries', 'تسجيل الطلبات'), T('Vahvistusviestit', 'Confirmation messages', 'رسائل التأكيد'), T('Seurantamuistutukset', 'Follow-up reminders', 'تذكيرات المتابعة')];
  const bar = h('div', { style: 'height:22px;border-radius:11px;background:var(--goldgrad);transform-origin:' + (RTL ? 'right' : 'left') }); c.an(bar, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], 2.4, 1.8, 'ease-in-out');
  const card = h('div', { class: 'card', style: 'width:860px;padding:44px' }, h('div', { class: 'kicker', style: 'margin-bottom:22px' }, T('Kartoitus', 'Assessment', 'التقييم')), rows.map((r, i) => { const ck = st(icon('check', 54), 'color:#ffffff;background:var(--goldgrad);border-radius:16px;padding:8px'); c.an(ck, K.pop, .6 + i * .5, .4); const e = h('div', { class: 'row', style: 'padding:26px 0;border-bottom:1px solid rgba(255,255,255,.08)' }, h('div', { style: 'position:relative;width:54px;height:54px;border-radius:16px;border:2px solid rgba(255,255,255,.3)' }, st(ck, 'position:absolute;inset:-2px')), h('div', { class: 't1', style: 'font-size:38px' }, r)); c.an(e, K.up(30), .2 + i * .15, .5); return e; }), h('div', { class: 'kicker', style: 'margin:36px 0 18px' }, T('Toteutus', 'Build', 'التنفيذ')), h('div', { style: 'height:22px;border-radius:11px;background:rgba(255,255,255,.1);overflow:hidden' }, bar));
  el.append(at(540, 830, card));
};

// ---------------- AD10 showcase ----------------
SCENES.bizcard = (c, el, p) => {
  el.append(bg(c, 'ink', { beam: true, dots: 20 }));
  const front = h('div', { style: 'position:absolute;inset:0;border-radius:28px;background:linear-gradient(135deg,#1c1c22,#0e0e12);border:2px solid rgba(59,130,246,.6);padding:50px;backface-visibility:hidden;display:flex;flex-direction:column;justify-content:space-between;box-shadow:0 50px 100px rgba(0,0,0,.6)' }, h('div', { style: 'font:700 56px var(--display)', class: 'gold' }, T('Yrityksesi', 'Your business', 'شركتك')), h('div', null, sk('50%', 'background:rgba(59,130,246,.5);margin-bottom:14px'), sk('36%', 'background:rgba(255,255,255,.2);margin-bottom:14px'), sk('42%', 'background:rgba(255,255,255,.2)')));
  const s = site('biz', false, { heroH: 300 }); s.style.zoom = .82;
  const back = h('div', { style: 'position:absolute;inset:0;border-radius:28px;overflow:hidden;backface-visibility:hidden;transform:rotateY(180deg);box-shadow:0 50px 100px rgba(0,0,0,.6)' }, s);
  const card = h('div', { style: 'position:relative;width:820px;height:470px;transform-style:preserve-3d' }, front, back);
  c.an(card, [{ transform: 'rotateY(-24deg) rotateX(16deg) scale(.8)' }, { transform: 'rotateY(-12deg) rotateX(8deg) scale(.92)', offset: .25 }, { transform: 'rotateY(-12deg) rotateX(8deg) scale(.92)', offset: .5 }, { transform: 'rotateY(172deg) rotateX(4deg) scale(1.02)', offset: .82 }, { transform: 'rotateY(180deg) rotateX(0deg) scale(1.05)' }], .1, 4.2, 'ease-in-out');
  const cw = h('div', { class: 'abs p3d', style: 'left:130px;top:880px' }, card); c.an(cw, K.fade, .1, .7);
  el.append(cw, headline(c, p.hook, 330, .3, { size: 82 }));
};
SCENES.wire = (c, el, p) => {
  el.append(bg(c, 'ink', { grid: true, glow: [[240, 400, 600, p.styled ? '#3b82f6' : '#27407a', .25]] }));
  const W = 'border:3px dashed rgba(59,130,246,.75);border-radius:20px;background:rgba(59,130,246,.06)';
  const blocks = [h('div', { style: `height:70px;${W}` }), h('div', { style: `height:430px;${W}` }), h('div', { style: 'display:flex;gap:16px' }, h('div', { style: `flex:1;height:200px;${W}` }), h('div', { style: `flex:1;height:200px;${W}` })), h('div', { style: `height:150px;${W}` }), h('div', { style: `height:90px;${W}` })];
  const wf = h('div', { style: 'position:absolute;inset:0;background:#101014;padding:90px 22px 22px;display:flex;flex-direction:column;gap:16px' }, blocks);
  const holder = h('div', { style: 'position:relative;width:568px;height:1208px' }, wf);
  if (p.styled) { const s = site('biz'); st(s, 'position:absolute;inset:0'); c.an(s, [{ clipPath: 'circle(0% at 50% 40%)' }, { clipPath: 'circle(130% at 50% 40%)' }], .3, 1.6, EIO); holder.append(s); }
  else blocks.forEach((b, i) => c.an(b, [{ opacity: 0, transform: 'scale(.8) translateY(40px)' }, { opacity: 1, transform: 'none' }], .3 + i * .4, .5, 'cubic-bezier(.3,1.4,.5,1)'));
  const ph = phone(holder), w = h('div', { class: 'abs p3d', style: 'left:240px;top:310px' }, ph);
  c.an(ph, p.styled ? [{ transform: 'rotateY(-6deg) scale(.9)' }, { transform: 'rotateY(8deg) scale(.92)' }] : [{ transform: 'rotateY(10deg) scale(.86)' }, { transform: 'rotateY(-6deg) scale(.9)' }], 0, c.dur + .5, 'ease-in-out');
  el.append(w);
};
SCENES.responsive = (c, el) => {
  el.append(bg(c, 'ink', { dots: 20, glow: [[100, 200, 800, '#3b82f6', .15], [500, 1000, 700, '#27407a', .3]] }));
  const br = browser(site('biz', false, { heroH: 300 }), 'www.yritys.example', 520), b = h('div', { class: 'abs p3d', style: 'left:70px;top:380px' }, br);
  c.an(br, [{ opacity: 0, transform: 'translateY(-120px) rotateX(-14deg)' }, { opacity: 1, transform: 'rotateX(4deg)' }], .2, 1);
  const tab = h('div', { style: 'width:760px;height:1000px;border-radius:50px;background:#0c0c0f;padding:22px;box-shadow:0 0 0 2px #3a3a42,0 50px 100px rgba(0,0,0,.6);zoom:.56' }, h('div', { style: 'width:100%;height:100%;border-radius:30px;overflow:hidden' }, site('biz', false, { heroH: 420 })));
  const t = h('div', { class: 'abs p3d', style: 'left:90px;top:860px' }, tab); c.an(tab, [{ opacity: 0, transform: 'translateX(-200px) rotateY(24deg)' }, { opacity: 1, transform: 'rotateY(10deg)' }], .7, 1);
  const ph = phone(site('biz'), .5), pw = h('div', { class: 'abs p3d', style: 'left:660px;top:800px' }, ph); c.an(ph, [{ opacity: 0, transform: 'translateX(200px) rotateY(-28deg)' }, { opacity: 1, transform: 'rotateY(-12deg)' }], 1.2, 1);
  el.append(b, t, pw);
};
SCENES.langSwitch = (c, el) => {
  el.append(bg(c, 'ink', { beam: true, glow: [[240, 400, 600, '#3b82f6', .2]] }));
  const order = ['fi', 'en', 'ar'], holder = h('div', { style: 'position:relative;width:568px;height:1208px' });
  order.forEach((l, i) => { const s = inLang(l, () => site('biz')); st(s, 'position:absolute;inset:0'); if (i) c.an(s, [{ opacity: 0, transform: 'scale(1.04)' }, { opacity: 1, transform: 'none' }], i * 1.3, .4); holder.append(s); });
  const pill = h('div', { style: 'position:relative;display:flex;width:480px;height:96px;border-radius:48px;background:rgba(28,28,34,.95);border:1px solid rgba(59,130,246,.5);direction:ltr;box-shadow:0 20px 50px rgba(0,0,0,.5)' });
  const knob = h('div', { style: 'position:absolute;left:8px;top:8px;width:154px;height:80px;border-radius:40px;background:var(--goldgrad)' }); pill.append(knob);
  c.an(knob, [{ transform: 'translateX(0)' }, { transform: 'translateX(155px)' }], 1.3, .35, EIO); c.out(knob, [{ transform: 'translateX(155px)' }, { transform: 'translateX(310px)' }], 2.6, .35, EIO);
  ['FI', 'EN', 'AR'].forEach((t, i) => { const e = h('div', { style: 'position:relative;flex:1;display:flex;align-items:center;justify-content:center;font:700 32px Inter;color:#fff' }, t); c.tick(tt => { const act = tt < 1.45 ? 0 : tt < 2.75 ? 1 : 2; e.style.color = act === i ? '#ffffff' : '#fff'; }); pill.append(e); });
  const ph = phone(holder), w = h('div', { class: 'abs p3d', style: 'left:240px;top:420px' }, ph); ph.style.zoom = .8; w.style.left = '300px';
  c.an(ph, [{ transform: 'rotateY(-8deg)' }, { transform: 'rotateY(8deg)' }], 0, c.dur + .5, 'ease-in-out');
  el.append(w, at(540, 370, pill));
};

// ---------------- AD11 brand film ----------------
SCENES.spark = (c, el) => {
  el.append(h('div', 'bg bg-black'));
  const pt = h('div', { style: 'width:14px;height:14px;border-radius:50%;background:#e0edff;box-shadow:0 0 40px 14px rgba(147,197,253,.9),0 0 160px 60px rgba(59,130,246,.5)' });
  c.an(pt, [{ opacity: 0, transform: 'scale(0)' }, { opacity: 1, transform: 'scale(1)', offset: .3 }, { opacity: 1, transform: 'scale(1.6)', offset: .6 }, { opacity: 1, transform: 'scale(1)' }], .25, 1.6, 'ease-out');
  const ln = h('div', { style: 'width:900px;height:3px;background:linear-gradient(90deg,transparent,#bfdbfe 30%,#fff 50%,#bfdbfe 70%,transparent);box-shadow:0 0 30px rgba(147,197,253,.8)' });
  c.an(ln, [{ transform: 'scaleX(0)', opacity: 0 }, { transform: 'scaleX(1)', opacity: 1 }], 1.5, 1.6, EIO);
  const fl = h('div', { style: 'width:1200px;height:500px;border-radius:50%;background:radial-gradient(ellipse,rgba(59,130,246,.28),transparent 65%)' }); c.an(fl, [{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'scale(1)' }], 1.6, 2, 'ease-out');
  el.append(at(540, 820, fl), at(540, 820, ln), at(540, 820, pt));
};
SCENES.network = (c, el) => {
  el.append(h('div', 'bg bg-black'));
  const r = rng(77), P = []; for (let i = 0; i < 16; i++) P.push([110 + r() * 860, 360 + r() * 900]);
  let lines = ''; const E = []; P.forEach((a, i) => { const near = P.map((b, j) => [Math.hypot(a[0] - b[0], a[1] - b[1]), j]).filter(x => x[1] !== i).sort((x, y) => x[0] - y[0]).slice(0, 2); near.forEach(n => { if (!E.some(e => e[0] === n[1] && e[1] === i)) E.push([i, n[1]]); }); });
  E.forEach(e => lines += `<line x1="${P[e[0]][0]}" y1="${P[e[0]][1]}" x2="${P[e[1]][0]}" y2="${P[e[1]][1]}" stroke="#3b82f6" stroke-width="2" pathLength="1" stroke-dasharray="1" opacity=".8"/>`);
  const s = h('div', { class: 'fill', html: `<svg viewBox="0 0 1080 1920" style="width:100%;height:100%;filter:drop-shadow(0 0 8px rgba(59,130,246,.8))">${lines}</svg>` });
  [...s.querySelectorAll('line')].forEach((l, i) => c.an(l, K.draw, .4 + i * .11, .8, 'ease-out')); el.append(s);
  P.forEach((p, i) => { const d = at(p[0], p[1], h('div', { style: `width:${14 + (i % 3) * 8}px;height:${14 + (i % 3) * 8}px;border-radius:50%;background:#e0edff;box-shadow:0 0 30px 8px rgba(147,197,253,.8)` })); c.an(d.firstChild, K.pop, .1 + i * .1, .5); el.append(d); });
  c.drift(s, 'scale(1)', 'scale(1.1)');
};
SCENES.montage = (c, el, p) => {
  const B = ['ink', 'blue', 'night', 'steel'], seg = c.dur / 4;
  p.words.forEach((w, i) => {
    const layer = h('div', 'fill', h('div', 'bg bg-' + B[i]), h('div', 'beam'));
    const ic = at(540, 720, st(icon(w[0], 420), 'color:var(--gold)')); ic.firstChild.firstChild.style.strokeWidth = .9;
    const word = h('div', { class: 'hl', style: `top:1010px;font-size:${RTL ? 92 : 124}px` }, h('span', 'gold', w[1]));
    layer.append(ic, word);
    c.an(layer, [{ opacity: 0 }, { opacity: 1 }], i * seg, .001, 'linear');
    if (i < 3) c.out(layer, [{ opacity: 1 }, { opacity: 0 }], (i + 1) * seg, .001, 'linear');
    c.an(ic, [{ transform: 'translate(-50%,-50%) scale(1.6)', filter: 'blur(20px)', opacity: 0 }, { transform: 'translate(-50%,-50%) scale(1)', filter: 'blur(0)', opacity: 1, offset: .3 }, { transform: 'translate(-50%,-50%) scale(.94)', filter: 'blur(0)', opacity: 1 }], i * seg, seg, 'ease-out');
    c.an(word, [{ opacity: 0, transform: 'translateY(60px)', letterSpacing: RTL ? '0px' : '14px' }, { opacity: 1, transform: 'none', letterSpacing: '0px', offset: .35 }, { opacity: 1, transform: 'none', letterSpacing: RTL ? '0px' : '2px' }], i * seg + .08, seg - .08, 'ease-out');
    c.an(layer.children[1], [{ transform: 'translateX(-900px) rotate(24deg)' }, { transform: 'translateX(700px) rotate(24deg)' }], i * seg, seg, 'ease-out');
    el.append(layer);
  });
};
SCENES.ecosystem = (c, el) => {
  el.append(bg(c, 'ink', { dots: 40, seed: 12, glow: [[240, 500, 600, '#3b82f6', .25]] }));
  const cy = 820;
  [300, 520, 760].forEach((s, i) => { const r = h('div', { style: `width:${s}px;height:${s}px;border-radius:50%;border:1.5px solid rgba(59,130,246,${.6 - i * .15})` }); c.an(r, [{ opacity: 0, transform: 'scale(.4)' }, { opacity: 1, transform: 'scale(1)' }], .1 + i * .2, 1); el.append(at(540, cy, r)); });
  ['web', 'chat', 'ai', 'bolt'].forEach((k, i) => { const arm = h('div', { class: 'abs', style: `left:540px;top:${cy}px;width:0;height:0` }); const b = st(badge(k), `position:absolute;left:${(i % 2 ? 380 : 260) - 55}px;top:-55px;width:110px;height:110px;border-radius:50%;background:#0b1226;border:2px solid var(--gold);padding:26px`); const a0 = i * 90 + 20; c.an(arm, [{ transform: `rotate(${a0}deg)` }, { transform: `rotate(${a0 + 150}deg)` }], 0, c.dur + .5, 'ease-out'); c.an(b, [{ transform: `rotate(${-a0}deg) scale(0)` }, { transform: `rotate(${-a0 - 30}deg) scale(1)`, offset: .2 }, { transform: `rotate(${-a0 - 150}deg) scale(1)` }], 0, c.dur + .5, 'ease-out'); arm.append(b); el.append(arm); });
  const core = h('div', { style: 'width:190px;height:190px;border-radius:50%;background:var(--goldgrad);box-shadow:0 0 140px rgba(59,130,246,.7)' }); c.an(core, K.pop, .2, .8); el.append(at(540, cy, core));
};
SCENES.bigtype = (c, el, p) => {
  el.append(h('div', 'bg bg-black'), h('div', 'beam'));
  const a = h('div', { class: 'hl', style: `top:640px;font-size:${RTL ? 110 : 136}px` }, p.a), b = h('div', { class: 'hl', style: `top:${RTL ? 830 : 800}px;font-size:${RTL ? 130 : 170}px` }, h('span', 'gold', p.b));
  c.an(a, [{ opacity: 0, transform: 'translateY(50px)', filter: 'blur(14px)' }, { opacity: 1, transform: 'none', filter: 'blur(0)' }], .15, .7);
  c.an(b, [{ opacity: 0, transform: 'scale(1.5)', filter: 'blur(24px)' }, { opacity: 1, transform: 'scale(1)', filter: 'blur(0)' }], 1.1, .8);
  const wrap = h('div', 'fill', a, b); c.drift(wrap, 'scale(1)', 'scale(1.06)'); el.append(wrap);
};

// ---------------- AD12 direct response ----------------
SCENES.city = (c, el, p) => {
  el.append(bg(c, 'night', { dots: 40, seed: 2, glow: [[100, 500, 800, '#2f7f8f', .35, 120, -30], [500, 300, 700, '#5a3f8a', .3, -100, 40]] }));
  const r = rng(8); let b = '', wn = ''; let x = -20;
  while (x < 1100) { const w = 60 + r() * 90, hh = 160 + r() * 330; b += `<rect x="${x}" y="${700 - hh}" width="${w}" height="${hh}" fill="#070b1a"/>`; for (let yy = 700 - hh + 24; yy < 680; yy += 38) for (let xx = x + 14; xx < x + w - 18; xx += 28) if (r() < .42) wn += `<rect class="wn" x="${xx}" y="${yy}" width="12" height="18" fill="#F3D9A0"/>`; x += w + 4; }
  b += '<path d="M470 700V330h30v-60l40-70 40 70v60h30v370z" fill="#070b1a"/><circle cx="540" cy="250" r="54" fill="#070b1a"/><rect x="536" y="140" width="8" height="70" fill="#070b1a"/>';
  const s = h('div', { class: 'abs', style: 'left:0;top:780px;width:1080px;height:700px', html: `<svg viewBox="0 0 1080 700" style="width:100%;height:100%">${b}${wn}</svg>` });
  [...s.querySelectorAll('.wn')].forEach((w, i) => c.an(w, K.fade, .3 + r() * 2.6, .25));
  const water = h('div', { class: 'abs', style: 'left:0;top:1478px;width:1080px;height:442px;background:linear-gradient(180deg,#0a1230,#04060f)' });
  c.drift(s, 'scale(1.06)', 'scale(1)'); el.append(s, water, headline(c, p.hook, 350, .3, { size: 110 }));
};
SCENES.checklist = (c, el, p) => {
  el.append(bg(c, 'ink', { glow: [[400, 300, 700, '#7a1f1f', .2]], dots: 14 }));
  el.append(col(80, 470, 920, 110, p.qs.map((q, i) => { const ln = h('div', { style: `height:4px;border-radius:2px;background:var(--goldgrad);margin-top:26px;transform-origin:${RTL ? 'right' : 'left'}` }); c.an(ln, [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], .8 + i * 1.1, .6, EIO); const row = h('div', null, h('div', { class: 'row', style: 'gap:34px' }, st(icon(q[0], 140), 'color:var(--gold);background:rgba(59,130,246,.12);border-radius:36px;padding:32px'), h('div', { style: `font:600 ${RTL ? 60 : 70}px/1.15 var(--display);flex:1` }, q[1])), ln); c.an(row, [{ opacity: 0, transform: `translateX(${RTL ? 120 : -120}px)` }, { opacity: 1, transform: 'none' }], .4 + i * 1.1, .55); return row; })));
};
SCENES.convo = (c, el, p) => {
  el.append(bg(c, 'warm', { dots: 20, glow: [[300, 400, 700, '#3b82f6', .2]] }));
  const mk = (t, me) => h('div', { class: 'bubble' + (me ? ' gold' : ''), style: `max-width:86%;font-size:42px;padding:36px 44px;border-radius:50px;${me ? 'align-self:flex-end;border-end-end-radius:10px;border-end-start-radius:50px' : 'border-end-start-radius:10px'};box-shadow:0 30px 60px rgba(0,0,0,.4)` }, t);
  const a = mk(p.a, false), b = mk(p.b, true); c.an(a, K.pop, .5, .5); c.an(b, K.pop, 1.8, .5);
  el.append(col(80, 480, 920, 50, a, b));
};
SCENES.steps = (c, el, p) => {
  el.append(bg(c, 'ink', { grid: true, glow: [[200, 300, 700, '#3b82f6', .18]] }));
  el.append(goldLine(c, RTL ? 918 : 159, 550, 620, .5, 2.2, true));
  el.append(col(100, 470, 880, 150, p.steps.map((s, i) => { const n = h('div', { style: 'width:120px;height:120px;border-radius:50%;background:var(--goldgrad);color:#ffffff;font:700 58px Inter;display:flex;align-items:center;justify-content:center;flex:none;box-shadow:0 0 0 12px #0b0b0e,0 0 60px rgba(59,130,246,.4);position:relative;z-index:2' }, i + 1); c.an(n, K.pop, .4 + i * .9, .5); const t = h('div', { style: `font:600 ${RTL ? 54 : 62}px/1.15 var(--display)` }, s); c.an(t, K.side(RTL ? -60 : 60), .55 + i * .9, .6); return h('div', { class: 'row', style: 'gap:40px' }, n, t); })));
};
SCENES.ctaTap = (c, el, p) => {
  el.append(bg(c, 'ink', { beam: true, dots: 34, seed: 14, glow: [[240, 500, 600, '#3b82f6', .3]] }));
  [0, 1, 2].forEach(i => { const r = h('div', { style: 'width:760px;height:220px;border-radius:110px;border:2px solid rgba(59,130,246,.7)' }); c.an(r, [{ opacity: 0, transform: 'scale(1)' }, { opacity: .9, transform: 'scale(1.05)', offset: .1 }, { opacity: 0, transform: 'scale(1.6,2.4)' }], 1.8 + i * .28, 1.4, 'ease-out'); el.append(at(540, 800, r)); });
  const btn = h('span', { class: 'btn', style: `font-size:${RTL ? 60 : 56}px;padding:54px 80px` }, p.btn); c.an(btn, K.pop, .25, .7); press(c, btn, 1.7);
  el.append(at(540, 800, btn), tapDot(c, 640, 840, 1.7));
};

// ---------------- AD13 website service (facts taken from the owner's own portfolio page) ----------------
SCENES.svcHook = (c, el, p) => {
  el.append(bg(c, 'ink', { beam: true, dots: 22, glow: [[300, 900, 700, '#27407a', .35]] }));
  const d = site('biz', false, { heroH: 330 }), br = browser(d, 'www.yritys.example', 560), w = h('div', { class: 'abs p3d', style: 'left:70px;top:790px' }, br);
  c.an(br, [{ opacity: 0, transform: 'translateY(200px) rotateX(22deg) scale(.9)' }, { opacity: 1, transform: 'rotateX(6deg) rotateY(-4deg)' }], .5, 1.2);
  c.an(d, [{ transform: 'translateY(0)' }, { transform: 'translateY(-110px)' }], 1.9, 2.4, 'ease-in-out');
  el.append(w, headline(c, p.hook, 330, .25, { size: 88 }));
};
SCENES.features = (c, el, p) => {
  el.append(bg(c, 'ink', { grid: true, glow: [[240, 400, 600, '#3b82f6', .2]] }));
  const g = h('div', { class: 'abs', style: 'left:80px;top:420px;width:920px;display:grid;grid-template-columns:1fr 1fr;gap:34px' });
  p.items.forEach((it, i) => { const card = h('div', { class: 'card', style: 'padding:44px 34px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:24px;min-height:400px;justify-content:center' }, st(icon(it[0], 130), 'color:#ffffff;background:var(--goldgrad);border-radius:36px;padding:30px;box-shadow:0 0 60px rgba(59,130,246,.35)'), h('div', { style: `font:600 ${RTL ? 40 : 46}px/1.2 var(--display)` }, it[1]), h('div', 't2', it[2])); c.an(card, [{ opacity: 0, transform: 'translateY(80px) scale(.9)' }, { opacity: 1, transform: 'none' }], .25 + i * .32, .6, 'cubic-bezier(.3,1.3,.5,1)'); g.append(card); });
  el.append(g);
};
SCENES.refCard = (c, el, p) => {
  el.append(bg(c, 'blue', { dots: 20, glow: [[200, 300, 700, '#3b82f6', .22]] }));
  const tags = h('div', { style: 'display:flex;flex-wrap:wrap;gap:16px;margin-top:34px' }, p.tags.map((t, i) => { const e = h('span', { class: 'tag', style: 'font-size:28px;padding:12px 26px;display:inline-flex;gap:12px;align-items:center' }, icon(t[0], 34), t[1]); c.an(e, K.pop, 1.5 + i * .25, .4); return e; }));
  const card = h('div', { class: 'card', style: 'width:900px;padding:50px' }, h('div', { class: 'row', style: 'margin-bottom:26px' }, h('span', 'kicker', p.kicker), h('span', { class: 'tag g', style: 'margin-inline-start:auto;font-size:26px' }, p.status)), h('div', { class: 'row', style: 'gap:30px' }, st(icon('van', 130), 'color:var(--gold);background:rgba(59,130,246,.12);border-radius:34px;padding:26px'), h('div', { style: 'font:700 76px var(--display);direction:ltr' }, 'Kyytipro Oy')), h('div', { style: 'font:500 36px/1.45 var(--ui);color:var(--mute);margin-top:30px' }, p.desc), tags);
  const w = h('div', { class: 'abs p3d', style: 'left:90px;top:420px' }, card); c.an(card, [{ opacity: 0, transform: 'rotateX(18deg) translateY(120px)' }, { opacity: 1, transform: 'rotateX(2deg)' }], .15, .9); el.append(w);
};
SCENES.sectors = (c, el, p) => {
  el.append(bg(c, 'ink', { dots: 24, beam: true }));
  const k = h('div', { class: 'abs kicker', style: 'left:0;right:0;top:400px;text-align:center' }, p.kicker); c.an(k, K.fade, .2, .5);
  const many = p.items.length > 4;
  el.append(k, col(110, 500, 860, many ? 20 : 34, p.items.map((it, i) => { const row = h('div', { class: 'card row', style: `padding:${many ? 22 : 36}px 40px;gap:32px` }, st(icon(it[0], 100), 'color:var(--gold);background:rgba(59,130,246,.12);border-radius:28px;padding:22px'), h('div', { style: `font:600 ${RTL ? 46 : 54}px/1.15 var(--display)` }, it[1])); c.an(row, [{ opacity: 0, transform: `translateX(${(i % 2 ? 1 : -1) * 140}px)` }, { opacity: 1, transform: 'none' }], .35 + i * .35, .6); return row; })));
};

// ---------------- AD14 AI service / AD15 growth service ----------------
SCENES.aiHook = (c, el, p) => {
  el.append(bg(c, 'blue', { grid: true, dots: 26, seed: 19, glow: [[240, 800, 600, '#3d6cff', .45]] }));
  const orb = h('div', { style: 'width:300px;height:300px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff 0,#bcd3ff 14%,#5b8cff 44%,#1a2a7a 80%);box-shadow:0 0 160px rgba(91,140,255,.75),inset 0 0 50px rgba(255,255,255,.4)' });
  c.an(orb, [{ transform: 'scale(.2)', opacity: 0 }, { transform: 'scale(1.05)', opacity: 1, offset: .3 }, { transform: 'scale(.95)', opacity: 1, offset: .65 }, { transform: 'scale(1.04)', opacity: 1 }], .2, c.dur, 'ease-in-out');
  [420, 560, 720].forEach((s, i) => { const r = at(540, 1130, h('div', { style: `width:${s}px;height:${s}px;border-radius:50%;border:1.5px solid rgba(59,130,246,${.75 - i * .2});border-top-color:transparent;border-right-color:transparent` })); c.an(r.firstChild, [{ transform: 'rotate(0deg)' }, { transform: `rotate(${i % 2 ? -220 : 260}deg)` }], 0, c.dur + .5, 'linear'); el.append(r); });
  el.append(at(540, 1130, orb), headline(c, p.hook, 330, .3, { size: 88 }));
};
SCENES.growHook = (c, el, p) => {
  el.append(bg(c, 'ink', { beam: true, dots: 26, seed: 23, glow: [[300, 900, 700, '#3b82f6', .22]] }));
  const H = [150, 230, 320, 430, 560];
  H.forEach((hh, i) => { const b = h('div', { class: 'abs', style: `left:${200 + i * 144}px;top:${1400 - hh}px;width:104px;height:${hh}px;border-radius:18px 18px 4px 4px;background:linear-gradient(180deg,#bfdbfe,#1840b4);transform-origin:bottom;opacity:${.45 + i * .14}` }); c.an(b, [{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], .5 + i * .22, .8, EASE); el.append(b); });
  el.append(goldLine(c, 160, 1404, 760, .3, 1));
  el.append(headline(c, p.hook, 330, .3, { size: 88 }));
};
