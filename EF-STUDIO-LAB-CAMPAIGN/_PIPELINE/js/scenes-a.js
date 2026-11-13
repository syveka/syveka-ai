// Scene library, part A (shared + AD01–AD03). Each scene: (c, el, p, ad) → fills el.
const SCENES = {};
const T = (fi, en, ar) => ({ fi, en, ar });

// ---------- shared: end card with the official logo (image, never redrawn) ----------
SCENES.end = (c, el, p, ad) => {
  el.append(h('div', 'bg bg-black'));
  const halo = h('div', { class: 'abs', style: 'left:50%;top:710px;width:1100px;height:1100px;margin:-550px 0 0 -550px;border-radius:50%;background:radial-gradient(circle,rgba(201,167,105,.20) 0%,rgba(201,167,105,.05) 42%,transparent 66%)' });
  c.an(halo, [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1)' }], .1, 1.6, 'ease-out');
  const logo = h('div', 'end-logo', h('img', { src: '../BRAND/EF-logo-endcard-crop.png' }));
  c.an(logo, [{ opacity: 0, transform: 'scale(.9)', filter: 'blur(14px) brightness(1.6)' }, { opacity: 1, transform: 'scale(1)', filter: 'blur(0) brightness(1)' }], .15, 1.1, 'ease-out');
  c.an(logo.firstChild, K.zoom(1, 1.035), 0, c.dur, 'linear');
  const sweep = h('div', { class: 'abs', style: 'left:0;top:330px;width:1080px;height:760px;overflow:hidden;-webkit-mask-image:radial-gradient(circle 372px at 540px 380px,#000 96%,transparent 100%)' }, h('div', { style: 'position:absolute;top:-100px;left:0;width:150px;height:960px;background:linear-gradient(90deg,transparent,rgba(255,240,205,.20),transparent);transform:rotate(18deg)' }));
  c.an(sweep.firstChild, [{ transform: 'translateX(-200px) rotate(18deg)' }, { transform: 'translateX(1200px) rotate(18deg)' }], .9, 1.3, 'ease-in-out');
  const desc = h('div', 'end-desc', h('span', 'kicker', T('Digiratkaisut · Tekoälyautomaatio', 'Digital solutions · AI automation', 'حلول رقمية · أتمتة بالذكاء الاصطناعي')));
  c.an(desc, K.up(20), 1.0, .6);
  const tag = h('div', 'end-tag', L(ad.tagline)); c.an(tag, K.up(30), 1.25, .7);
  const cta = h('div', 'end-cta', h('span', 'btn', L(ad.cta), st(icon('arrow', 40), RTL ? 'transform:scaleX(-1)' : '')));
  c.an(cta, K.pop, 1.75, .6);
  c.an(cta.firstChild, [{ boxShadow: '0 18px 50px rgba(201,167,105,.30),inset 0 1px 0 rgba(255,255,255,.5)' }, { boxShadow: '0 18px 80px rgba(201,167,105,.65),inset 0 1px 0 rgba(255,255,255,.5)' }, { boxShadow: '0 18px 50px rgba(201,167,105,.30),inset 0 1px 0 rgba(255,255,255,.5)' }], 2.4, 1.6, 'ease-in-out');
  el.append(halo, logo, sweep, desc, tag, cta);
  if (CONTACT) { const ct = h('div', 'end-contact', CONTACT); c.an(ct, K.fade, 2.1, .5); el.append(ct); }
  else if (ad.note) { const n = h('div', 'end-note', L(ad.note)); c.an(n, K.fade, 2.2, .6); el.append(n); }
};

// ---------- generic big statement ----------
SCENES.statement = (c, el, p) => {
  el.append(bg(c, p.bg || 'ink', { beam: true, dots: 26, seed: p.seed || 3 }));
  if (p.icon) { const ic = drawIcon(c, p.icon, 300, .1, 1.5); el.append(at(540, 560, ic)); c.an(ic, [{ transform: 'rotate(0deg)' }, { transform: `rotate(${p.spin || 0}deg)` }], 0, c.dur, 'linear'); }
  el.append(headline(c, p.text, p.top || 800, .35, { size: p.size || 104 }));
};

// =====================================================================
// AD01 — missed inquiries
// =====================================================================
SCENES.storm = (c, el, p) => {
  el.append(bg(c, 'ink', { glow: [[-200, 200, 700, '#7a1f1f', .35], [600, 1100, 700, '#3b2a10', .5]] }));
  const N = [['phone', T('Vastaamaton puhelu', 'Missed call', 'مكالمة فائتة'), T('2 min sitten', '2 min ago', 'قبل دقيقتين')], ['mail', T('Uusi sähköposti', 'New email', 'بريد إلكتروني جديد'), T('Tarjouspyyntö', 'Quote request', 'طلب عرض سعر')], ['chat', T('Uusi viesti', 'New message', 'رسالة جديدة'), T('”Onko teillä aikoja?”', '“Any openings?”', '«هل لديكم مواعيد؟»')], ['phone', T('Vastaamaton puhelu', 'Missed call', 'مكالمة فائتة'), T('juuri nyt', 'just now', 'الآن')], ['mail', T('Uusi sähköposti', 'New email', 'بريد إلكتروني جديد'), T('Kysymys hinnoista', 'A question about prices', 'سؤال عن الأسعار')], ['chat', T('Uusi viesti', 'New message', 'رسالة جديدة'), T('”Voisitteko soittaa?”', '“Could you call me?”', '«هل يمكنكم الاتصال بي؟»')], ['cal', T('Ajanvarauskysely', 'Booking inquiry', 'استفسار عن حجز'), T('odottaa vastausta', 'waiting for a reply', 'بانتظار الرد')]];
  const wrap = h('div', 'fill');
  N.forEach((n, i) => {
    const card = h('div', { class: 'card row', style: 'width:800px' }, badge(n[0], i % 3 === 0 ? '' : ''), h('div', null, h('div', 't1', n[1]), h('div', 't2', n[2])));
    const rot = [-3, 2, -1.5, 3, -2.5, 1.5, -1][i], x = [520, 560, 530, 555, 525, 550, 540][i];
    const w = at(x, 400 + i * 132, card, `rotate:${rot}deg`);
    c.an(w, [{ opacity: 0, transform: 'translate(-50%,-50%) translateY(-260px) scale(1.15)' }, { opacity: 1, transform: 'translate(-50%,-50%) translateY(0) scale(1)' }], .15 + i * .22, .45, 'cubic-bezier(.3,1.4,.5,1)');
    c.an(card, [{ transform: 'translateX(0)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(7px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(0)' }], .6 + i * .22, .35, 'linear');
    wrap.append(w);
  });
  c.an(wrap, [{ opacity: 1, filter: 'blur(0px)', transform: 'scale(1)' }, { opacity: .22, filter: 'blur(9px)', transform: 'scale(1.06)' }], 2.0, .7, 'ease-in-out');
  el.append(wrap, headline(c, p.hook, 640, 2.15, { size: 100 }));
};

SCENES.chatWait = (c, el, p) => {
  el.append(bg(c, 'ink', { glow: [[500, 300, 800, '#1b2a4a', .5]] }));
  const time = h('div', { style: 'font:600 26px Inter;color:#8b8b93;text-align:center;padding:92px 0 10px;direction:ltr' }, '14:02');
  const head = h('div', { class: 'row', style: 'padding:18px 30px;border-bottom:1px solid #e9e9ee' }, st(icon('user', 60), 'background:#e7e2d8;border-radius:50%;padding:12px;color:#8a7a5c'), h('div', null, h('div', { style: 'font:700 30px var(--ui);color:#16161a' }, T('Yritys', 'Business', 'الشركة')), h('div', { style: 'font:500 22px var(--ui);color:#9a9aa2' }, T('Vastaa yleensä… joskus', 'Usually replies… eventually', 'يردّ عادةً… في وقت ما'))));
  const b1 = h('div', 'bubble me', p.msg1), s1 = h('div', { style: 'align-self:flex-end;font:500 21px var(--ui);color:#9a9aa2;margin-top:-8px' }, T('Toimitettu', 'Delivered', 'تم التسليم'));
  const b2 = h('div', 'bubble me', p.msg2);
  const s2 = h('div', { style: 'align-self:center;font:600 24px var(--ui);color:#d5483c;background:#fdecea;border-radius:30px;padding:12px 26px;margin-top:26px' }, T('Ei vastausta', 'No reply', 'لا يوجد رد'));
  const body = h('div', { style: 'display:flex;flex-direction:column;gap:20px;padding:34px 28px' }, b1, s1, b2, s2);
  const scr = h('div', { style: 'height:100%;background:#fff' }, time, head, body);
  c.an(b1, K.pop, .5, .4); c.an(s1, K.fade, 1.0, .3); c.an(b2, K.pop, 2.3, .4); c.an(s2, K.pop, 3.2, .45);
  c.tick(t => { const m = Math.floor(lerp(14 * 60 + 2, 18 * 60 + 47, ease3((t - 1.1) / 2.0))); time.textContent = String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); });
  const ph = phone(scr), w = h('div', { class: 'abs p3d', style: 'left:240px;top:330px' }, ph);
  c.an(ph, [{ transform: 'rotateY(-16deg) rotateX(6deg) scale(.84)' }, { transform: 'rotateY(-4deg) rotateX(2deg) scale(.9)' }], 0, c.dur + .5, 'ease-out');
  el.append(w);
};

SCENES.funnel = (c, el, p) => {
  el.append(bg(c, 'ink', { grid: true, glow: [[240, 420, 600, '#3b2a10', .6]] }));
  const r = rng(11), kinds = ['phone', 'mail', 'chat', 'cal', 'mail', 'chat', 'phone', 'chat', 'mail'];
  kinds.forEach((k, i) => {
    const x0 = 120 + r() * 840, y0 = 380 + r() * 860, e = at(540, 800, badge(k));
    c.an(e, [{ opacity: 0, transform: `translate(-50%,-50%) translate(${x0 - 540}px,${y0 - 800}px) rotate(${(r() - .5) * 50}deg) scale(1.25)` }, { opacity: 1, transform: `translate(-50%,-50%) translate(${x0 - 540}px,${y0 - 800}px) rotate(${(r() - .5) * 30}deg) scale(1.25)`, offset: .18 }, { opacity: 1, transform: `translate(-50%,-50%) translate(${(x0 - 540) * .9}px,${(y0 - 800) * .9 - 30}px) rotate(0deg) scale(1.2)`, offset: .5 }, { opacity: 0, transform: 'translate(-50%,-50%) translate(0,0) scale(.3)' }], .05 + i * .06, 2.6, 'cubic-bezier(.6,0,.4,1)');
    el.append(e);
  });
  const ring = (sz, a, d) => { const e = at(540, 800, h('div', { style: `width:${sz}px;height:${sz}px;border-radius:50%;border:2px solid rgba(201,167,105,.55)` })); c.an(e.firstChild, [{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'scale(.8)', offset: .3 }, { opacity: 0, transform: 'scale(1.5)' }], a, d, 'ease-out'); return e; };
  el.append(ring(420, 2.2, 1.6), ring(640, 2.5, 1.8), ring(860, 2.8, 2));
  const core = at(540, 800, h('div', { style: 'width:230px;height:230px;border-radius:50%;background:var(--goldgrad);display:flex;align-items:center;justify-content:center;color:#1a1408;box-shadow:0 0 120px rgba(201,167,105,.6)' }, icon('ai', 120)));
  c.an(core.firstChild, [{ opacity: 0, transform: 'scale(0)' }, { opacity: 1, transform: 'scale(1.12)', offset: .7 }, { opacity: 1, transform: 'scale(1)' }], 2.0, .7);
  el.append(core);
};

SCENES.sorted = (c, el, p) => {
  el.append(bg(c, 'ink', { glow: [[300, 200, 700, '#3b2a10', .5]], dots: 14 }));
  const rows = [['cal', T('Ajanvarauskysely', 'Booking inquiry', 'استفسار عن حجز'), T('Verkkolomake', 'Web form', 'نموذج الموقع'), T('Uusi', 'New', 'جديد'), ''], ['mail', T('Tarjouspyyntö', 'Quote request', 'طلب عرض سعر'), T('Sähköposti', 'Email', 'بريد إلكتروني'), T('Myynti', 'Sales', 'المبيعات'), 'b'], ['phone', T('Soittopyyntö', 'Callback request', 'طلب معاودة الاتصال'), T('Puhelu', 'Phone', 'هاتف'), T('Tänään', 'Today', 'اليوم'), 'g'], ['chat', T('Kysymys aukioloajoista', 'Opening-hours question', 'سؤال عن ساعات العمل'), T('Viesti', 'Message', 'رسالة'), T('Vastattu', 'Answered', 'تم الرد'), 'g']];
  const col = h('div', { class: 'abs', style: 'left:90px;top:400px;width:900px;display:flex;flex-direction:column;gap:26px' });
  rows.forEach((r, i) => {
    const ck = st(icon('check', 44), 'color:#9be3c0;margin-inline-start:auto');
    const tg = h('span', 'tag ' + r[4], r[3]);
    const card = h('div', 'card row', badge(r[0]), h('div', { style: 'flex:1;min-width:0' }, h('div', 't1', r[1]), h('div', 't2', r[2])), tg, ck);
    c.an(card, [{ opacity: 0, transform: `translateX(${RTL ? -1 : 1}00px) scale(.96)` }, { opacity: 1, transform: 'none' }], .25 + i * .32, .6);
    c.an(tg, K.pop, .9 + i * .32, .4); c.an(ck, K.pop, 2.3 + i * .25, .4);
    col.append(card);
  });
  el.append(goldLine(c, RTL ? 1012 : 64, 400, 800, .2, 1.6, true), col);
};

SCENES.calm = (c, el, p) => {
  el.append(bg(c, 'warm', { dots: 30, seed: 5, glow: [[240, 300, 700, '#c9a769', .22]] }));
  [520, 700, 880].forEach((sz, i) => { const e = at(540, 720, h('div', { style: `width:${sz}px;height:${sz}px;border-radius:50%;border:1.5px solid rgba(201,167,105,${.5 - i * .14})` })); c.an(e.firstChild, [{ transform: 'scale(.94)', opacity: .5 }, { transform: 'scale(1.04)', opacity: 1 }, { transform: 'scale(.94)', opacity: .5 }], i * .3, 3.6, 'ease-in-out'); el.append(e); });
  el.append(at(540, 720, drawIcon(c, 'check', 300, .3, .9)));
  const chip = h('div', { class: 'card row', style: 'border-radius:60px;padding:22px 40px' }, st(icon('list', 40), 'color:var(--gold)'), h('span', 't1', p.chip));
  c.an(chip, K.up(30), 1.0, .6); el.append(at(540, 1120, chip, 'white-space:nowrap'));
};

// =====================================================================
// AD02 — website transformation
// =====================================================================
SCENES.oldDesk = (c, el, p) => {
  el.append(bg(c, 'ink', { glow: [[100, 900, 700, '#2a2a10', .5]] }));
  const o = oldSite(); o.style.zoom = 1.25;
  const br = browser(o, 'www.yritys.example', 560), w = h('div', { class: 'abs p3d', style: 'left:70px;top:770px' }, br);
  c.an(br, [{ transform: 'rotateX(14deg) rotateY(-8deg) translateY(80px)', opacity: 0 }, { transform: 'rotateX(6deg) rotateY(-3deg)', opacity: 1 }], .1, 1.2);
  c.an(o, [{ transform: 'translateY(0)' }, { transform: 'translateY(-90px)' }], 1.4, 3, 'ease-in-out');
  el.append(w, headline(c, p.hook, 350, .3, { size: 96 }));
};
SCENES.oldPhone = (c, el, p) => {
  el.append(bg(c, 'ink', { glow: [[500, 300, 700, '#33200f', .5]] }));
  const o = oldSite(); st(o, 'width:1000px;height:2200px;transform-origin:0 0;font-size:30px;padding:120px 24px');
  const holder = h('div', { style: 'width:568px;height:1208px;overflow:hidden;background:#ffffd6;direction:ltr' }, o);
  // pinch-zoom struggle: zoom in, pan around, zoom out
  c.an(o, [{ transform: 'scale(.568) translate(0,0)' }, { transform: 'scale(.568) translate(0,0)', offset: .12 }, { transform: 'scale(1.5) translate(-60px,-90px)', offset: .34 }, { transform: 'scale(1.5) translate(-420px,-140px)', offset: .52 }, { transform: 'scale(1.5) translate(-200px,-420px)', offset: .7 }, { transform: 'scale(.9) translate(-80px,-200px)', offset: .86 }, { transform: 'scale(.568) translate(0,0)' }], 0, c.dur, 'ease-in-out');
  const ph = phone(holder), w = h('div', { class: 'abs p3d', style: 'left:240px;top:300px' }, ph);
  c.an(ph, [{ transform: 'rotateY(14deg) rotateX(4deg) scale(.86)' }, { transform: 'rotateY(6deg) rotateX(2deg) scale(.9)' }], 0, c.dur + .5, 'ease-out');
  // two "fingers"
  const f = (x0, y0, x1, y1) => { const e = h('div', { class: 'abs', style: 'width:84px;height:84px;border-radius:50%;background:rgba(255,255,255,.28);border:2px solid rgba(255,255,255,.7);box-shadow:0 0 30px rgba(255,255,255,.4)' }); c.an(e, [{ opacity: 0, transform: `translate(${x0}px,${y0}px)` }, { opacity: 1, transform: `translate(${x0}px,${y0}px)`, offset: .1 }, { opacity: 1, transform: `translate(${x1}px,${y1}px)`, offset: .34 }, { opacity: 0, transform: `translate(${x1}px,${y1}px)`, offset: .42 }, { opacity: 0, transform: `translate(${x1}px,${y1}px)` }], .2, c.dur, 'ease-in-out'); return e; };
  el.append(w, f(500, 900, 400, 1060), f(560, 840, 680, 660));
  const q = h('div', { class: 'abs', style: 'left:50%;top:330px;font:700 150px var(--display);color:var(--gold);margin-left:300px' }, '?');
  c.an(q, [{ opacity: 0, transform: 'scale(.4) rotate(-20deg)' }, { opacity: 1, transform: 'scale(1) rotate(10deg)' }], 2.2, .5, 'cubic-bezier(.3,1.5,.5,1)'); el.append(q);
};
SCENES.morph = (c, el, p) => {
  el.append(bg(c, 'ink', { beam: true, glow: [[250, 500, 700, '#c9a769', .25]] }));
  const o = oldSite(); st(o, 'position:absolute;inset:0;font-size:12px');
  const n = site(p.site || 'biz'); st(n, 'position:absolute;inset:0');
  const holder = h('div', { style: 'position:relative;width:568px;height:1208px;overflow:hidden' }, o, n);
  c.an(n, [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)' }], 1.0, 1.7, EIO);
  const scan = h('div', { style: 'position:absolute;left:0;right:0;top:0;height:8px;background:var(--goldgrad);box-shadow:0 0 50px 14px rgba(233,208,160,.7);z-index:4' });
  c.an(scan, [{ transform: 'translateY(-10px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1, offset: .04 }, { transform: 'translateY(1200px)', opacity: 1, offset: .96 }, { transform: 'translateY(1215px)', opacity: 0 }], .95, 1.8, EIO);
  holder.append(scan);
  const ph = phone(holder), w = h('div', { class: 'abs p3d', style: 'left:240px;top:290px' }, ph);
  c.an(ph, [{ transform: 'scale(.86) rotateY(0deg)' }, { transform: 'scale(.92) rotateY(-8deg)' }], 0, c.dur + .5, 'ease-in-out');
  el.append(w);
};
SCENES.showcase = (c, el, p) => {
  el.append(bg(c, p.bg || 'ink', { dots: 22, glow: [[100, 200, 800, '#c9a769', .18], [500, 1100, 700, '#27407a', .35]] }));
  const d = site(p.site || 'biz', false, { heroH: 330 }), br = browser(d, 'www.yritys.example', 600);
  const bw = h('div', { class: 'abs p3d', style: 'left:40px;top:420px' }, br);
  c.an(br, [{ opacity: 0, transform: 'translateY(140px) rotateX(18deg) rotateY(10deg) scale(.9)' }, { opacity: 1, transform: 'translateY(0) rotateX(7deg) rotateY(7deg) scale(.96)' }], .2, 1.2);
  c.an(d, [{ transform: 'translateY(0)' }, { transform: 'translateY(-150px)' }], 1.6, 2.6, 'ease-in-out');
  const m = site(p.site || 'biz'), ph = phone(m, .58), pw = h('div', { class: 'abs p3d', style: 'left:640px;top:690px' }, ph);
  c.an(ph, [{ opacity: 0, transform: 'translateY(240px) rotateY(-24deg)' }, { opacity: 1, transform: 'translateY(0) rotateY(-12deg)' }], .7, 1.2);
  c.an(m, [{ transform: 'translateY(0)' }, { transform: 'translateY(-260px)' }], 2.0, 2.4, 'ease-in-out');
  el.append(bw, pw);
};
SCENES.siteClose = (c, el, p) => {
  el.append(bg(c, 'paper'));
  const s = site(p.site || 'biz'); st(s, 'position:absolute;left:0;top:300px;width:1080px;height:1400px;zoom:1.0;background:transparent');
  s.style.zoom = 1.6; st(s, 'left:0;top:170px;width:675px;height:900px');
  c.an(s, [{ transform: 'translateY(40px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], .1, .8);
  const cur = h('div', { class: 'abs', style: 'width:70px;height:70px;border-radius:50%;background:rgba(201,167,105,.35);border:3px solid #b58f4c' });
  const tx = RTL ? 790 : 220, ty = 1115;
  c.an(cur, [{ opacity: 0, transform: `translate(${tx + 300}px,${ty + 420}px)` }, { opacity: 1, transform: `translate(${tx}px,${ty}px)`, offset: .7 }, { opacity: 1, transform: `translate(${tx}px,${ty}px) scale(.7)`, offset: .82 }, { opacity: 1, transform: `translate(${tx}px,${ty}px) scale(1)` }], .9, 1.5, EIO);
  c.an(s._cta, [{ transform: 'scale(1)' }, { transform: 'scale(.93)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], 2.0, .5);
  el.append(s, h('div', { class: 'abs', style: 'left:0;right:0;bottom:0;height:900px;background:linear-gradient(180deg,rgba(241,234,220,0),#f1eadc 45%)' }), cur);
};

// =====================================================================
// AD03 — AI assistant (concept)
// =====================================================================
function clockFace(c, size, h0, h1, t0, t1, color = '#EAD6AA') {
  const f = h('div', { style: `position:relative;width:${size}px;height:${size}px;border-radius:50%;border:3px solid ${color};box-shadow:0 0 80px rgba(201,167,105,.25),inset 0 0 60px rgba(201,167,105,.08)` });
  for (let i = 0; i < 12; i++) f.append(h('div', { style: `position:absolute;left:50%;top:50%;width:${i % 3 ? 3 : 5}px;height:${i % 3 ? 18 : 34}px;background:${color};opacity:${i % 3 ? .5 : 1};transform:translate(-50%,-50%) rotate(${i * 30}deg) translateY(${-size / 2 + 34}px)` }));
  const hh = h('div', { style: `position:absolute;left:50%;bottom:50%;width:8px;height:${size * .25}px;margin-left:-4px;background:${color};border-radius:4px;transform-origin:50% 100%` });
  const mh = h('div', { style: `position:absolute;left:50%;bottom:50%;width:5px;height:${size * .37}px;margin-left:-2.5px;background:${color};border-radius:3px;transform-origin:50% 100%` });
  f.append(hh, mh, h('div', { style: `position:absolute;left:50%;top:50%;width:22px;height:22px;margin:-11px;border-radius:50%;background:${color}` }));
  c.tick(t => { const v = lerp(h0, h1, ease3((t - t0) / (t1 - t0))); hh.style.transform = `rotate(${v * 30}deg)`; mh.style.transform = `rotate(${v * 360}deg)`; });
  f._val = t => lerp(h0, h1, ease3((t - t0) / (t1 - t0)));
  return f;
}
SCENES.closing = (c, el, p) => {
  const b = bg(c, 'blue', { glow: [[200, 300, 800, '#e0a56f', .35]] }); el.append(b);
  const dim = h('div', { class: 'fill', style: 'background:#030512' }); c.an(dim, [{ opacity: 0 }, { opacity: .62 }], 2.4, 1.2, 'ease-in-out'); el.append(dim);
  const cf = clockFace(c, 400, 15.5, 17, .3, 2.3); el.append(at(540, 1050, cf));
  const sign = h('div', { style: 'position:relative;width:420px;height:120px;transform-style:preserve-3d' });
  const face = (txt, col, back) => h('div', { style: `position:absolute;inset:0;border-radius:18px;border:2px solid ${col};color:${col};display:flex;align-items:center;justify-content:center;font:700 44px var(--ui);letter-spacing:${RTL ? 0 : 6}px;text-transform:uppercase;backface-visibility:hidden;background:rgba(6,10,26,.85);${back ? 'transform:rotateX(180deg)' : ''}` }, txt);
  sign.append(face(T('Avoinna', 'Open', 'مفتوح'), '#9be3c0'), face(T('Suljettu', 'Closed', 'مغلق'), '#ffb0a8', true));
  c.an(sign, [{ transform: 'rotateX(0deg)' }, { transform: 'rotateX(180deg)' }], 2.4, .7, EIO);
  el.append(h('div', { class: 'abs p3d', style: 'left:330px;top:1330px' }, sign));
  el.append(headline(c, p.hook, 340, .25, { size: 84 }));
};
SCENES.nightMsg = (c, el, p) => {
  el.append(bg(c, 'night', { dots: 50, seed: 21 }));
  const moon = at(820, 470, st(icon('moon', 170), 'color:#EAD6AA;filter:drop-shadow(0 0 40px rgba(234,214,170,.6))')); c.an(moon, [{ opacity: 0, transform: 'translate(-50%,-50%) translateY(60px)' }, { opacity: 1, transform: 'translate(-50%,-50%)' }], .1, 1.2); el.append(moon);
  const time = h('div', { style: 'font:300 150px "Inter";color:#fff;text-align:center;padding-top:190px;direction:ltr;letter-spacing:-4px' }, '21:14');
  const date = h('div', { style: 'font:500 30px var(--ui);color:rgba(255,255,255,.7);text-align:center' }, T('Tiistai-ilta', 'Tuesday evening', 'مساء الثلاثاء'));
  const nt = h('div', { style: 'margin:70px 24px 0;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.2);border-radius:34px;padding:26px 28px;backdrop-filter:blur(20px)' }, h('div', { class: 'row', style: 'gap:14px;margin-bottom:10px' }, st(icon('chat', 34), 'color:#fff'), h('span', { style: 'font:600 24px var(--ui);color:rgba(255,255,255,.75)' }, T('Uusi viesti', 'New message', 'رسالة جديدة')), h('span', { style: 'font:500 22px var(--ui);color:rgba(255,255,255,.5);margin-inline-start:auto' }, T('nyt', 'now', 'الآن'))), h('div', { style: 'font:500 29px/1.35 var(--ui);color:#fff' }, p.msg));
  c.an(nt, [{ opacity: 0, transform: 'translateY(-70px) scale(.92)' }, { opacity: 1, transform: 'none' }], 1.5, .55, 'cubic-bezier(.3,1.4,.5,1)');
  const scr = h('div', { style: 'height:100%;background:linear-gradient(180deg,#0b1434,#1a2550 60%,#3a2f5a)' }, time, date, nt);
  const ph = phone(scr), w = h('div', { class: 'abs p3d', style: 'left:200px;top:420px' }, ph);
  c.an(ph, [{ transform: 'rotateY(18deg) rotateX(8deg) scale(.8)' }, { transform: 'rotateY(8deg) rotateX(3deg) scale(.86)' }], 0, c.dur + .5, 'ease-out');
  c.an(ph, [{ translate: '0 0' }, { translate: '-6px 0' }, { translate: '6px 0' }, { translate: '-4px 0' }, { translate: '0 0' }], 1.5, .4, 'linear');
  el.append(w);
};
SCENES.aiOrb = (c, el, p) => {
  el.append(bg(c, 'blue', { grid: true, glow: [[240, 250, 600, '#3d6cff', .45], [500, 900, 600, '#c9a769', .2]] }));
  const orb = h('div', { style: 'width:240px;height:240px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff 0,#bcd3ff 14%,#5b8cff 44%,#1a2a7a 80%);box-shadow:0 0 120px rgba(91,140,255,.7),inset 0 0 40px rgba(255,255,255,.4)' });
  c.an(orb, [{ transform: 'scale(.92)' }, { transform: 'scale(1.06)' }, { transform: 'scale(.92)' }, { transform: 'scale(1.06)' }, { transform: 'scale(.92)' }], 0, c.dur + .5, 'ease-in-out');
  [330, 430].forEach((s, i) => { const r = at(540, 520, h('div', { style: `width:${s}px;height:${s}px;border-radius:50%;border:1.5px solid rgba(201,167,105,${.7 - i * .3});border-top-color:transparent;border-left-color:transparent` })); c.an(r.firstChild, [{ transform: 'rotate(0deg)' }, { transform: `rotate(${i ? -280 : 360}deg)` }], 0, c.dur + .5, 'linear'); el.append(r); });
  el.append(at(540, 520, orb));
  const q = h('div', 'bubble', p.q), a = h('div', 'bubble gold'); typer(c, a, p.a, 1.9, 1.6);
  const dots3 = h('div', { class: 'bubble gold', style: 'padding:22px 30px;letter-spacing:6px;font-weight:700' }, '• • •');
  c.an(q, K.pop, .5, .45); c.an(dots3, K.pop, 1.2, .3); c.out(dots3, [{ opacity: 1 }, { opacity: 0, height: 0, padding: 0, margin: '-24px 0 0' }], 1.85, .05);
  c.an(a, [{ opacity: 0 }, { opacity: 1 }], 1.88, .1);
  el.append(h('div', { class: 'abs', style: 'left:90px;top:790px;width:900px;display:flex;flex-direction:column;gap:24px' }, q, dots3, a));
};
SCENES.ticket = (c, el, p) => {
  el.append(bg(c, 'blue', { glow: [[300, 400, 700, '#c9a769', .22]], dots: 18 }));
  const f = (k, v, i) => { const r = h('div', { style: 'display:flex;justify-content:space-between;gap:30px;padding:22px 0;border-bottom:1px solid rgba(255,255,255,.08)' }, h('span', 't2', k), h('span', { class: 't1', style: 'text-align:end' }, v)); c.an(r, K.up(24), .8 + i * .28, .5); return r; };
  const card = h('div', { class: 'card', style: 'width:880px;padding:40px 44px' }, h('div', { class: 'row', style: 'margin-bottom:14px' }, badge('note'), h('div', { style: 'flex:1' }, h('div', { class: 't1', style: 'font-size:40px' }, T('Yhteydenotto kirjattu', 'Inquiry logged', 'تم تسجيل الطلب')), h('div', 't2', T('Tiistai 21:14', 'Tuesday 21:14', 'الثلاثاء 21:14'))), h('span', 'tag b', T('Seurantaan', 'Follow-up', 'للمتابعة'))), p.rows.map((r, i) => f(r[0], r[1], i)));
  const w = h('div', { class: 'abs p3d', style: 'left:100px;top:420px' }, card);
  c.an(card, [{ opacity: 0, transform: 'rotateX(24deg) translateY(120px)' }, { opacity: 1, transform: 'rotateX(4deg) translateY(0)' }], .15, .9);
  el.append(w);
};
SCENES.morning = (c, el, p) => {
  el.append(bg(c, 'dawn'));
  const sun = at(540, 1500, h('div', { style: 'width:900px;height:900px;border-radius:50%;background:radial-gradient(circle,#fff6da 0,#ffd88a 30%,rgba(255,200,120,0) 68%)' })); c.an(sun, [{ transform: 'translate(-50%,-50%) translateY(260px)' }, { transform: 'translate(-50%,-50%) translateY(0)' }], 0, c.dur + .5, 'ease-out'); el.append(sun);
  const btn = h('span', { class: 'btn', style: 'font-size:30px;padding:20px 44px' }, T('Vastaa asiakkaalle', 'Reply to customer', 'الردّ على العميل'));
  const card = h('div', { class: 'card light', style: 'width:860px;padding:40px 44px' }, h('div', { class: 'kicker', style: 'color:#a07c3c;margin-bottom:14px' }, T('Huomenta', 'Good morning', 'صباح الخير')), h('div', { class: 't1', style: 'font-size:44px;margin-bottom:10px' }, T('1 uusi yhteydenotto', '1 new inquiry', 'طلب جديد واحد')), h('div', { class: 't2', style: 'margin-bottom:30px' }, p.sum), btn);
  c.an(card, K.up(80), .3, .8); c.an(btn, [{ transform: 'scale(1)' }, { transform: 'scale(.94)' }, { transform: 'scale(1.05)' }, { transform: 'scale(1)' }], 2.3, .5);
  const time = h('div', { class: 'abs', style: 'left:0;right:0;top:330px;text-align:center;font:300 130px Inter;color:#fff;direction:ltr;letter-spacing:-3px;text-shadow:0 4px 40px rgba(0,0,0,.25)' }, '08:00'); c.an(time, K.fade, .2, .8);
  el.append(time, at(540, 880, card));
};
