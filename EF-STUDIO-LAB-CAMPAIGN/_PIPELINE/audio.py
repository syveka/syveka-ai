"""Original synthesized score + sound design for each ad (no samples, no third-party audio).
Everything is generated from oscillators and noise with numpy/scipy, so the result is wholly owned
by the campaign and carries no licensing obligations.
Usage: python3 audio.py work/meta.json work/audio
"""
import json, sys, os
import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve
from scipy.io import wavfile

SR = 48000
A4 = 440.0
def hz(n): return A4 * 2 ** ((n - 69) / 12)
def env(n, a=.01, r=.2):
    e = np.ones(n); na, nr = max(1, int(a * SR)), max(1, int(r * SR))
    na, nr = min(na, n), min(nr, n)
    e[:na] *= np.linspace(0, 1, na); e[-nr:] *= np.linspace(1, 0, nr); return e
def lp(x, f, order=2): return sosfilt(butter(order, f, 'low', fs=SR, output='sos'), x)
def hp(x, f, order=2): return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)
def bp(x, lo, hi): return sosfilt(butter(2, [lo, hi], 'band', fs=SR, output='sos'), x)
def tt(d): return np.arange(int(d * SR)) / SR
def add(buf, x, t, g=1.0, pan=0.0):
    i = int(t * SR)
    if i >= buf.shape[1] or i < 0: return
    x = x[: buf.shape[1] - i]
    buf[0, i:i + len(x)] += x * g * (1 - max(0, pan)); buf[1, i:i + len(x)] += x * g * (1 + min(0, pan))

RNG = np.random.default_rng(42)
def noise(d): return RNG.standard_normal(int(d * SR))

# ---------- instruments ----------
def pad(notes, d):
    t = tt(d); x = np.zeros_like(t)
    for n in notes:
        f = hz(n)
        for det in (-.35, 0, .35):
            ff = f * 2 ** (det / 100)
            x += np.sin(2 * np.pi * ff * t) + .35 * np.sin(2 * np.pi * 2 * ff * t + 1) + .15 * np.sin(2 * np.pi * 3 * ff * t + 2)
    x = lp(x, 2400) * (1 + .12 * np.sin(2 * np.pi * .23 * t))
    return x * env(len(t), min(1.2, d * .4), min(1.4, d * .4)) / (len(notes) * 4)
def pluck(n, d=.9, bright=1.0):
    t = tt(d); f = hz(n)
    x = np.sin(2 * np.pi * f * t) + .5 * bright * np.sin(2 * np.pi * 2 * f * t) * np.exp(-t * 9) + .25 * bright * np.sin(2 * np.pi * 3 * f * t) * np.exp(-t * 14)
    return x * np.exp(-t * 5.5) * env(len(t), .004, .05) * .5
def bass(n, d):
    t = tt(d); f = hz(n)
    return (np.sin(2 * np.pi * f * t) + .25 * np.sin(2 * np.pi * 2 * f * t)) * env(len(t), .02, .25) * .5
def kick():
    t = tt(.35); f = 48 + 90 * np.exp(-t * 28)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 11) * .9
def hat(): return hp(noise(.05), 7000) * np.exp(-tt(.05) * 90) * .12

# ---------- sound effects ----------
def sfx(name):
    if name == 'ding':
        t = tt(.7); return (np.sin(2 * np.pi * 1318 * t) * np.exp(-t * 9) + .7 * np.sin(2 * np.pi * 1760 * (t - .11).clip(0)) * np.exp(-(t - .11).clip(0) * 8) * (t > .11)) * .22
    if name == 'pop':
        t = tt(.09); f = 380 + 520 * t / .09; return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(len(t), .003, .05) * .3
    if name == 'tick':
        t = tt(.05); return (np.sin(2 * np.pi * 2100 * t) * np.exp(-t * 120) + hp(noise(.05), 4000) * np.exp(-t * 160) * .4) * .22
    if name == 'type':
        x = np.zeros(int(.7 * SR)); tk = sfx('tick') * .6
        for k in range(8):
            i = int((k * .075 + RNG.uniform(0, .012)) * SR); x[i:i + len(tk)] += tk[: len(x) - i]
        return x
    if name == 'rise':
        d = 1.6; t = tt(d); n = noise(d); out = np.zeros_like(t); seg = 8
        for k in range(seg):
            a, b = int(k * len(t) / seg), int((k + 1) * len(t) / seg); f = 300 * (12 ** (k / seg)); out[a:b] = bp(n, f, f * 1.9)[a:b]
        return lp(out, 9000) * (t / d) ** 2.2 * env(len(t), .05, .12) * .30
    if name == 'whoosh':
        d = .7; t = tt(d); return bp(noise(d), 500, 3800) * np.sin(np.pi * t / d) ** 2 * .07
    if name == 'chime':
        t = tt(2.6); x = np.zeros_like(t)
        for f, g in ((1046.5, 1), (1568, .6), (2093, .45), (2637, .25)):
            x += g * np.sin(2 * np.pi * f * t + 1.6 * np.sin(2 * np.pi * f * 1.41 * t) * np.exp(-t * 6)) * np.exp(-t * 2.4)
        return x * env(len(t), .004, .4) * .14
    if name == 'ring':
        t = tt(.62); return (np.sin(2 * np.pi * 440 * t) + np.sin(2 * np.pi * 480 * t)) * (np.sin(2 * np.pi * 22 * t) > 0) * env(len(t), .01, .05) * .07
    if name == 'boom':
        t = tt(2.4); f = 38 + 60 * np.exp(-t * 9)
        return (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 1.9) + lp(noise(2.4), 260) * np.exp(-t * 5) * .5) * .75
    if name == 'hit':
        t = tt(.5); f = 55 + 120 * np.exp(-t * 30)
        return (np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9) * .8 + hp(noise(.5), 3000) * np.exp(-t * 40) * .12)
    raise KeyError(name)

# ---------- moods: (bpm, [chords as midi notes], arp pattern, flags) ----------
MOODS = {
    'tension': dict(bpm=92, dark=[[45, 57, 60, 64], [41, 57, 60, 65]], lift=[[48, 60, 64, 67], [43, 59, 62, 67], [45, 60, 64, 69], [41, 60, 65, 69]], kick=False),
    'bright':  dict(bpm=104, dark=[[50, 62, 65, 69], [46, 62, 65, 70]], lift=[[50, 62, 66, 69], [45, 61, 64, 69], [47, 62, 66, 71], [43, 62, 67, 71]], kick=True),
    'future':  dict(bpm=98, dark=[[40, 59, 64, 66], [36, 60, 64, 67]], lift=[[40, 59, 64, 67], [45, 60, 64, 69], [36, 60, 64, 67], [38, 62, 66, 69]], kick=False),
    'warm':    dict(bpm=84, dark=[[41, 60, 64, 69], [38, 62, 65, 69]], lift=[[41, 60, 65, 69], [46, 62, 65, 70], [43, 62, 67, 70], [48, 60, 64, 67]], kick=False),
    'drive':   dict(bpm=112, dark=[[40, 59, 64, 67], [40, 60, 64, 67]], lift=[[40, 59, 64, 68], [45, 61, 64, 69], [47, 59, 63, 66], [44, 59, 64, 68]], kick=True),
    'luxe':    dict(bpm=72, dark=[[38, 57, 62, 65], [34, 58, 62, 65]], lift=[[38, 57, 62, 66], [43, 59, 62, 67], [45, 57, 61, 64], [38, 57, 62, 66]], kick=False),
}
REV = None
def reverb(x):
    global REV
    if REV is None:
        d = 2.2; n = int(d * SR); r = np.random.default_rng(7)
        REV = [lp(r.standard_normal(n) * np.exp(-np.arange(n) / SR * 3.2), 5000) for _ in range(2)]
        REV = [i / np.sqrt((i ** 2).sum()) for i in REV]
    return np.stack([fftconvolve(x[c], REV[c])[: x.shape[1]] for c in range(2)])

def score(meta, mood, transpose=0):
    T = meta['total']; N = int(T * SR); m = MOODS[mood]
    music = np.zeros((2, N)); fx = np.zeros((2, N))
    beat = 60 / m['bpm']; bar = beat * 4
    sc = meta['scenes']; lift_t = sc[2]['start']; end_t = sc[-1]['start']
    t, k = 0.0, 0
    while t < T:
        phase = 'dark' if t < lift_t - .01 else 'lift'
        chords = m[phase]; ch = [n + transpose for n in chords[k % len(chords)]]
        d = min(bar * (2 if m['bpm'] > 80 else 1), T - t)
        if d < .3: break
        add(music, pad(ch[1:], d + .8), t, .55)
        add(music, bass(ch[0], d), t, .5 if phase == 'lift' else .32)
        if phase == 'lift' and t < end_t - .05:
            step = beat / 2; seq = [ch[1], ch[2], ch[3], ch[2] + 12, ch[3], ch[2], ch[1] + 12, ch[3]]
            for j in range(int(d / step)):
                add(music, pluck(seq[j % 8] + 12, .8), t + j * step, .32, pan=(.35 if j % 2 else -.35))
            if m['kick']:
                for j in range(int(d / beat)):
                    add(music, kick(), t + j * beat, .28); add(music, hat(), t + j * beat + beat / 2, .6)
        elif phase == 'dark':
            for j in range(int(d / beat)):
                add(music, pluck(ch[3], .6, .5), t + j * beat, .10)
        t += d; k += 1
    # final resolve under the logo
    root = m['lift'][0]
    add(music, pad([n + transpose + 12 for n in root[1:]], T - end_t + .5), end_t, .5)
    for s in sc:
        if s['start'] > 0: add(fx, sfx('hit') * .5 if s['tr'] == 'cut' else sfx('whoosh'), max(0, s['start'] - (.02 if s['tr'] == 'cut' else .3)))
        for e in s.get('sfx', []):
            name, at = e.split('@'); add(fx, sfx(name), s['start'] + float(at), 1.0, pan=RNG.uniform(-.25, .25))
    add(fx, sfx('chime'), end_t + .25, 1.3)
    wet = reverb(music * .9 + fx * .6)
    mix = music + fx + wet * .32
    mix = np.stack([hp(mix[c], 28) for c in range(2)])
    n_in, n_out = int(.25 * SR), int(.9 * SR)
    mix[:, :n_in] *= np.linspace(0, 1, n_in); mix[:, -n_out:] *= np.linspace(1, 0, n_out) ** 1.5
    peak = np.abs(mix).max(); mix = mix / peak * .82
    return np.tanh(mix * 1.15) / np.tanh(1.15) * .9

if __name__ == '__main__':
    meta_path, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    meta = json.load(open(meta_path))
    moods = json.load(open(os.path.join(os.path.dirname(meta_path), 'moods.json')))
    for i, ad in enumerate(sorted(meta)):
        x = score(meta[ad]['fi'], moods[ad], transpose=[0, 2, -1, 3, -2, 1, 4, -3, 2, 0, -2, 1][i % 12])
        wavfile.write(os.path.join(out, ad + '.wav'), SR, (x.T * 32767).astype(np.int16))
        print(ad, moods[ad], f"{x.shape[1] / SR:.2f}s peak {np.abs(x).max():.2f} rms {np.sqrt((x ** 2).mean()):.3f}")
