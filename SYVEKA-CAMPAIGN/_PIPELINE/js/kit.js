// Reusable visual components.
const SOON = { fi: 'Tulossa · havainnekuva', en: 'Coming soon · concept', ar: 'قريباً · صورة توضيحية' };
const CONCEPT = { fi: 'Havainnekuva', en: 'Concept visual', ar: 'صورة توضيحية' };

const IC = {
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  chat: '<path d="M4 5h16v11H10l-5 4v-4H4z"/>',
  cal: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8 3v4M16 3v4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  scissors: '<circle cx="6" cy="6.5" r="2.6"/><circle cx="6" cy="17.5" r="2.6"/><path d="M8.2 8L20 17.5M8.2 16L20 6.5"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  sparkle: '<path d="M11 3l1.9 5.6L18.5 10.5l-5.6 1.9L11 18l-1.9-5.6L3.5 10.5l5.6-1.9z"/><path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/>',
  box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  cloche: '<path d="M3 18.5h18"/><path d="M5 18.5a7 7 0 0 1 14 0"/><path d="M12 9V7.2M10.6 7.2h2.8"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><circle cx="12" cy="12" r="7"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M4.9 19.1l2.2-2.2M16.9 7.1l2.2-2.2"/>',
  van: '<path d="M2 7h11v9.5H2z"/><path d="M13 10h4l3.5 3.2v3.3H13z"/><circle cx="6.3" cy="17.3" r="1.9"/><circle cx="16.6" cy="17.3" r="1.9"/>',
  pin: '<path d="M12 21s-6-6.2-6-11a6 6 0 0 1 12 0c0 4.8-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
  note: '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5"/>',
  bolt: '<path d="M13 2L5 14h6l-1 8 8-12h-6z"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M16 16l5 5"/>',
  web: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h18M6 6.8h.01M8.5 6.8h.01"/>',
  ai: '<path d="M12 3l2.2 6.3L20.5 12l-6.3 2.2L12 21l-2.2-6.8L3.5 12l6.3-2.7z"/>',
  list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  menu: '<path d="M6 3v8M4 3v4a2 2 0 0 0 4 0V3M6 11v10M17 3c-2 0-3 2.5-3 5.5s1 4 3 4V21M17 3v18"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  brain: '<circle cx="12" cy="9" r="5.5"/><path d="M8.5 20a3.5 3.5 0 0 1 7 0M12 14.5V17"/>',
};
function icon(name, size = 48, cls = '') {
  const e = h('span', { class: 'ico ' + cls, style: `width:${size}px;height:${size}px`, html: `<svg viewBox="0 0 24 24">${IC[name]}</svg>` });
  return e;
}
// Large line-art icon whose strokes draw themselves in.
function drawIcon(c, name, size, at = .2, d = 1.4, color = 'var(--gold)') {
  const e = h('span', { class: 'ico line-draw', style: `width:${size}px;height:${size}px;color:${color}`, html: `<svg viewBox="0 0 24 24" style="stroke-width:.7">${IC[name]}</svg>` });
  [...e.querySelectorAll('path,circle,rect')].forEach((p, i) => { p.setAttribute('pathLength', 1); c.an(p, K.draw, at + i * .18, d, EIO); });
  return e;
}
function badge(name, cls = '') { const b = icon(name, 76, 'badge ' + cls); return b; }

function bg(c, kind, o = {}) {
  const b = h('div', 'bg bg-' + kind);
  if (o.glow) for (const g of o.glow) { const e = h('div', { class: 'glow', style: `width:${g[2]}px;height:${g[2]}px;left:${g[0]}px;top:${g[1]}px;background:${g[3]};opacity:${g[4] ?? .5}` }); c.an(e, [{ transform: 'translate(0,0)' }, { transform: `translate(${g[5] ?? 60}px,${g[6] ?? -40}px)` }], 0, c.dur + 1, 'ease-in-out'); b.append(e); }
  if (o.grid) b.append(h('div', 'grid'));
  if (o.beam) { const e = h('div', 'beam'); c.an(e, [{ transform: 'translateX(-900px) rotate(24deg)' }, { transform: 'translateX(700px) rotate(24deg)' }], o.beamAt ?? 0, o.beamDur ?? c.dur + 1, 'ease-in-out'); b.append(e); }
  if (o.dots) dots(c, b, o.dots, o.seed || 7);
  return b;
}
function rng(seed) { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; }
function dots(c, parent, n, seed) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    const sz = 2 + r() * 5, x = r() * 1200, y = r() * 2040, dy = -(80 + r() * 260), dx = (r() - .5) * 120, o = .15 + r() * .5;
    const d = h('div', { class: 'dot', style: `width:${sz}px;height:${sz}px;left:${x}px;top:${y}px;opacity:${o};filter:blur(${r() < .3 ? 2 : 0}px)` });
    c.an(d, [{ transform: 'translate(0,0)' }, { transform: `translate(${dx}px,${dy}px)` }], 0, c.dur + 1, 'linear');
    parent.append(d);
  }
}
function phone(content, scale = 1) {
  const p = h('div', 'phone', h('div', 'notch'), h('div', 'screen', content), h('div', 'glare'));
  if (scale !== 1) p.style.zoom = scale;
  return p;
}
function browser(content, url, hgt = 640, w = 940) {
  const b = h('div', 'browser', h('div', 'bar', h('b'), h('b'), h('b'), h('div', 'url', url)), st(h('div', 'view', content), `height:${hgt}px`));
  b.style.width = w + 'px';
  return b;
}
// absolute-positioned wrapper centred at (x,y)
function at(x, y, child, extra = '') { return h('div', { class: 'abs', style: `left:${x}px;top:${y}px;transform:translate(-50%,-50%);${extra}` }, child); }

// ----- website mockups (illustrative concept designs, generic business words only) -----
const SITE = {
  salon: { name: { fi: 'Kampaamo', en: 'Salon', ar: 'صالون' }, hero: 'h-salon', h: { fi: 'Kauneutta\nkiireettä.', en: 'Beauty,\nunhurried.', ar: 'جمال\nبلا استعجال.' }, p: { fi: 'Hiukset · Värit · Kampaukset', en: 'Cuts · Colour · Styling', ar: 'قصّ · صبغ · تصفيف' }, cta: { fi: 'Varaa aika', en: 'Book a time', ar: 'احجز موعداً' }, sec: { fi: 'Palvelut', en: 'Services', ar: 'الخدمات' }, items: [{ fi: 'Hiustenleikkaus', en: 'Haircut', ar: 'قصّ الشعر' }, { fi: 'Värjäys', en: 'Colouring', ar: 'صبغ الشعر' }, { fi: 'Juhlakampaus', en: 'Occasion styling', ar: 'تسريحة مناسبات' }] },
  resto: { name: { fi: 'Ravintola', en: 'Restaurant', ar: 'مطعم' }, hero: 'h-resto', h: { fi: 'Tervetuloa\npöytään.', en: 'Welcome\nto the table.', ar: 'أهلاً بكم\nإلى مائدتنا.' }, p: { fi: 'Avoinna tänään 16–23', en: 'Open today 16–23', ar: 'مفتوح اليوم 16–23' }, cta: { fi: 'Varaa pöytä', en: 'Reserve a table', ar: 'احجز طاولة' }, sec: { fi: 'Menu', en: 'Menu', ar: 'قائمة الطعام' }, items: [{ fi: 'Alkuruoat', en: 'Starters', ar: 'المقبلات' }, { fi: 'Pääruoat', en: 'Mains', ar: 'الأطباق الرئيسية' }, { fi: 'Jälkiruoat', en: 'Desserts', ar: 'الحلويات' }] },
  biz: { name: { fi: 'Yritys', en: 'Company', ar: 'شركتك' }, hero: 'h-biz', h: { fi: 'Palvelua,\njohon luotetaan.', en: 'Service\nyou can trust.', ar: 'خدمة\nتستحق الثقة.' }, p: { fi: 'Paikallinen · Ammattitaitoinen', en: 'Local · Professional', ar: 'محلي · محترف' }, cta: { fi: 'Ota yhteyttä', en: 'Contact us', ar: 'تواصل معنا' }, sec: { fi: 'Palvelut', en: 'Services', ar: 'الخدمات' }, items: [{ fi: 'Palvelu yksi', en: 'Service one', ar: 'الخدمة الأولى' }, { fi: 'Palvelu kaksi', en: 'Service two', ar: 'الخدمة الثانية' }, { fi: 'Palvelu kolme', en: 'Service three', ar: 'الخدمة الثالثة' }] },
};
const SITE_MN = [{ fi: 'Palvelut', en: 'Services', ar: 'الخدمات' }, { fi: 'Meistä', en: 'About', ar: 'من نحن' }, { fi: 'Yhteys', en: 'Contact', ar: 'اتصل بنا' }];
function site(kind, mobile = true, o = {}) {
  const d = SITE[kind];
  const hero = h('div', 'hero ' + d.hero, h('div', 'hx', h('h2', { html: L(d.h).replace('\n', '<br>') }), h('p', null, d.p), h('span', 'cta', d.cta)));
  const sec = h('div', 'sec', h('h3', null, d.sec), d.items.map(it => h('div', 'li', h('span', null, it), h('span', null, '›'))));
  const s = h('div', 'site', h('div', 'nav', h('span', 'lg', d.name), mobile ? h('div', 'burger') : h('div', 'mn', SITE_MN.map(m => h('span', null, m)))), hero, sec);
  if (!mobile) { hero.style.height = (o.heroH || 380) + 'px'; }
  s._hero = hero; s._sec = sec; s._cta = hero.querySelector('.cta');
  return s;
}
const OLD = {
  h: { fi: 'Tervetuloa kotisivuillemme!!', en: 'Welcome to our homepage!!', ar: '!!مرحباً بكم في موقعنا' },
  nav: { fi: 'ETUSIVU | YRITYS | HINNASTO | LINKIT | VIERASKIRJA', en: 'HOME | COMPANY | PRICES | LINKS | GUESTBOOK', ar: 'الرئيسية | الشركة | الأسعار | روابط | سجل الزوار' },
  p: { fi: 'Yrityksemme on palvellut asiakkaita jo vuosia. Lisätietoja saat soittamalla tai lähettämällä faksin. Sivut on optimoitu 800x600 näytölle.', en: 'Our company has served customers for years. For more information please call or send a fax. Best viewed at 800x600.', ar: 'تخدم شركتنا عملاءها منذ سنوات. لمزيد من المعلومات اتصل بنا أو أرسل فاكساً. أفضل عرض بدقة 800x600.' },
  l: { fi: 'Klikkaa tästä nähdäksesi hinnaston (PDF)', en: 'Click here to view price list (PDF)', ar: 'اضغط هنا لعرض قائمة الأسعار (PDF)' },
  u: { fi: 'Sivut päivitetty: 12.3.2009', en: 'Last updated: 12.3.2009', ar: 'آخر تحديث: 12.3.2009' },
  v: { fi: 'Kävijöitä:', en: 'Visitors:', ar: 'الزوار:' },
};
function oldSite() {
  return h('div', 'old', h('div', 'navt', OLD.nav), h('h1', null, OLD.h), h('p', null, OLD.p), h('div', 'box', h('a', null, OLD.l), h('br'), h('br'), OLD.p), h('p', null, h('a', null, OLD.l)), h('div', 'box', OLD.u, h('br'), OLD.v, ' ', h('span', 'cnt', '004512')), h('p', null, OLD.p), h('p', null, h('a', null, OLD.l)));
}
function sk(w, extra = '') { return h('div', { class: 'sk', style: `width:${w};${extra}` }); }
function goldLine(c, x, y, w, at_ = .3, d = .8, vertical = false) {
  const e = h('div', { class: 'abs', style: `left:${x}px;top:${y}px;width:${vertical ? 3 : w}px;height:${vertical ? w : 3}px;background:var(--goldgrad);border-radius:2px;transform-origin:${vertical ? 'top' : (RTL ? 'right' : 'left')}` });
  c.an(e, [{ transform: vertical ? 'scaleY(0)' : 'scaleX(0)' }, { transform: 'none' }], at_, d, EIO);
  return e;
}
