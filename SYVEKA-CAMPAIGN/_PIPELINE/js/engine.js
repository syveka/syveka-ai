// EF Studio Lab campaign — deterministic motion-graphics engine.
// Every animation is a paused Web Animation that seek(t) positions explicitly,
// so each frame renders identically regardless of machine speed.
const Q = new URLSearchParams(location.search);
let LANG = Q.get('lang') || 'fi';
const ADID = Q.get('ad') || 'G01';
const RTL = LANG === 'ar';
document.documentElement.lang = LANG;
document.documentElement.dir = RTL ? 'rtl' : 'ltr';

const EASE = 'cubic-bezier(.2,.75,.2,1)';
const EIO = 'cubic-bezier(.65,0,.35,1)';

function L(x) {
  if (x && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Node) && 'fi' in x) return x[LANG];
  return x;
}
function h(tag, a, ...kids) {
  const el = document.createElement(tag);
  if (typeof a === 'string') el.className = a;
  else if (a) for (const k in a) {
    if (k === 'class') el.className = a[k];
    else if (k === 'style') el.style.cssText = a[k];
    else if (k === 'html') el.innerHTML = a[k];
    else el.setAttribute(k, a[k]);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : document.createTextNode(String(L(k))));
  return el;
}
const st = (el, css) => { el.style.cssText += ';' + css; return el; };

const K = {
  fade: [{ opacity: 0 }, { opacity: 1 }],
  out: [{ opacity: 1 }, { opacity: 0 }],
  up: (y = 50) => [{ opacity: 0, transform: `translateY(${y}px)` }, { opacity: 1, transform: 'translateY(0)' }],
  down: (y = 50) => [{ opacity: 0, transform: `translateY(${-y}px)` }, { opacity: 1, transform: 'translateY(0)' }],
  side: (x = 80) => [{ opacity: 0, transform: `translateX(${x}px)` }, { opacity: 1, transform: 'translateX(0)' }],
  pop: [{ opacity: 0, transform: 'scale(.72)' }, { opacity: 1, transform: 'scale(1.05)', offset: .65 }, { opacity: 1, transform: 'scale(1)' }],
  zoom: (a = 1.12, b = 1) => [{ transform: `scale(${a})` }, { transform: `scale(${b})` }],
  draw: [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
};

function mkCtx(dur) {
  const c = { dur, anims: [], ticks: [] };
  c.an = (el, kf, at = 0, d = .7, ease = EASE, fill = 'both') => {
    const a = el.animate(kf, { duration: Math.max(1, d * 1000), delay: at * 1000, fill, easing: ease });
    a.pause(); c.anims.push(a); return el;
  };
  // exit animations must not back-fill, or they would override the entrance
  c.out = (el, kf, at, d = .4, ease = 'ease-in') => c.an(el, kf, at, d, ease, 'forwards');
  c.tick = f => c.ticks.push(f);
  // staggered children
  c.stag = (els, kf, at = 0, step = .1, d = .6, ease = EASE) => els.forEach((e, i) => c.an(e, kf, at + i * step, d, ease));
  // slow continuous drift over the whole scene (camera feel)
  c.drift = (el, from, to) => c.an(el, [{ transform: from }, { transform: to }], 0, dur + .8, 'linear');
  return c;
}

// --- text helpers -----------------------------------------------------------
// Headline with word-by-word rise. *asterisks* mark gold emphasis.
function headline(c, text, top, at = .2, opts = {}) {
  const el = h('div', 'hl'); el.style.top = top + 'px';
  if (opts.size) el.style.fontSize = (RTL ? opts.size * .8 : opts.size * .86) + 'px';
  let i = 0;
  String(L(text)).split('\n').forEach((line, li) => {
    if (li) el.append(h('br'));
    let gold = false;
    line.split(/(\*)/).forEach(part => {
      if (part === '*') { gold = !gold; return; }
      part.split(/(\s+)/).forEach(w => {
        if (!w) return;
        if (/^\s+$/.test(w)) { el.append(' '); return; }
        const s = h('span', 'w'); const inner = gold ? h('em', null, w) : document.createTextNode(w); s.append(inner);
        c.an(s, [{ opacity: 0, transform: 'translateY(46px)', filter: 'blur(10px)' }, { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }], at + i * (opts.step || .085), .7);
        el.append(s); i++;
      });
    });
  });
  if (opts.out !== false) c.out(el, [{ opacity: 1 }, { opacity: 0 }], (opts.outAt ?? c.dur - .1), .35);
  return el;
}
function caption(c, text, o = {}) {
  if (!text) return null;
  const el = h('div', 'cap' + (o.dark ? ' dark' : ''), h('span', 'rule'), L(text));
  if (o.bottom) el.style.bottom = o.bottom + 'px';
  c.an(el, K.up(26), o.at ?? .45, .55);
  c.out(el, K.out, c.dur - .2, .3);
  return el;
}
function typer(c, el, text, at, d) {
  const s = Array.from(String(L(text)));
  c.tick(t => { const n = Math.max(0, Math.min(s.length, Math.floor((t - at) / d * s.length))); el.textContent = s.slice(0, n).join('') || '​'; });
  return el;
}
const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));
const ease3 = t => { t = Math.max(0, Math.min(1, t)); return 1 - Math.pow(1 - t, 3); };

// --- scene transitions ------------------------------------------------------
const TR = {
  open: (c, el) => c.an(el, K.fade, 0, .5, 'ease-out'),
  cut: () => {},
  fade: (c, el) => c.an(el, K.fade, 0, .55, 'ease-in-out'),
  up: (c, el) => c.an(el, [{ clipPath: 'inset(100% 0 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], 0, .7, EIO),
  down: (c, el) => c.an(el, [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }], 0, .7, EIO),
  side: (c, el) => c.an(el, [{ clipPath: 'inset(0 0 0 100%)' }, { clipPath: 'inset(0 0 0 0)' }], 0, .7, EIO),
  iris: (c, el) => c.an(el, [{ clipPath: 'circle(0% at 50% 46%)' }, { clipPath: 'circle(120% at 50% 46%)' }], 0, .8, EIO),
  zoom: (c, el) => c.an(el, [{ opacity: 0, transform: 'scale(1.35)', filter: 'blur(18px)' }, { opacity: 1, transform: 'scale(1)', filter: 'blur(0)' }], 0, .65, EASE),
  push: (c, el) => c.an(el, [{ opacity: 0, transform: 'scale(.82)' }, { opacity: 1, transform: 'scale(1)' }], 0, .6, EASE),
  diag: (c, el) => c.an(el, [{ clipPath: 'polygon(0 0,0 0,-40% 100%,-40% 100%)' }, { clipPath: 'polygon(0 0,140% 0,100% 100%,-40% 100%)' }], 0, .75, EIO),
};

// --- player -----------------------------------------------------------------
let SC = [], TOTAL = 0;
function build() {
  const ad = ADS[ADID], stage = document.getElementById('stage');
  if (ad.bug) document.getElementById('brandbug').firstChild.textContent = ad.bug;
  let t = 0;
  ad.scenes.forEach((s, i) => {
    const c = mkCtx(s.d); c.ad = ad; c.i = i;
    const el = h('div', 'scene'); el.style.zIndex = i + 1;
    SCENES[s.t](c, el, s.p || {}, ad);
    if (s.cap) { if (s.capbg !== false) el.append(h('div', 'capbg')); el.append(caption(c, s.cap, s.capo || {})); }
    if ((s.concept || ad.soon) && s.t !== 'end') { const b = h('div', 'concept' + (ad.soon ? ' soon' : ''), ad.soon ? SOON : CONCEPT); c.an(b, K.fade, .5, .5); el.append(b); }
    el.append(h('div', 'vig'));
    (TR[s.tr] || TR[i ? 'fade' : 'open'])(c, el);
    stage.append(el);
    SC.push({ el, c, start: t, end: t + s.d, s }); t += s.d;
  });
  TOTAL = t;
  window.META = { ad: ADID, lang: LANG, total: TOTAL, title: L(ad.title), tagline: L(ad.tagline), cta: L(ad.cta), board: ad.board, music: ad.music, soon: !!ad.soon, kind: ad.kind, scenes: SC.map(x => ({ start: x.start, end: x.end, type: x.s.t, tr: x.s.tr || 'fade', cap: L(x.s.cap) || L(x.s.sub) || '', sfx: x.s.sfx || [] })) };
}
window.seek = t => {
  const bug = document.getElementById('brandbug');
  const endStart = SC[SC.length - 1].start;
  bug.style.opacity = Math.max(0, Math.min(1, (t - .7) / .5, (endStart - .15 - t) / .3)) * .92;
  let top = null;
  for (const x of SC) {
    const vis = t >= x.start - 1e-6 && t < x.end + .85;
    x.el.style.display = vis ? '' : 'none';
    if (!vis) continue;
    if (t < x.end) top = x;
    const lt = t - x.start;
    for (const a of x.c.anims) a.currentTime = lt * 1000;
    for (const f of x.c.ticks) f(lt);
  }
  bug.className = top && top.s.light ? 'dark' : '';
};
window.start = async () => {
  build();
  const fams = ['500 40px Cormorant', '600 40px Cormorant', '700 40px Cormorant', '400 20px Inter', '500 20px Inter', '600 20px Inter', '700 20px Inter', '400 20px "Plex Arabic"', '500 20px "Plex Arabic"', '600 20px "Plex Arabic"', '700 20px "Plex Arabic"', '500 20px Kufi', '700 20px Kufi'];
  await Promise.all(fams.map(f => document.fonts.load(f, 'Aä س')));
  await document.fonts.ready;
  await Promise.all([...document.images].map(i => i.decode().catch(() => {})));
  await Promise.all(window.PRELOAD || []);
  seek(0);
  return window.META;
};
