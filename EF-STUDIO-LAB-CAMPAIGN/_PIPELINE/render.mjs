// Renders one ad/language to a silent H.264 MP4 by stepping the deterministic timeline in headless Chromium.
// Usage: node render.mjs AD01 fi out.mp4            (full video)
//        node render.mjs AD01 fi --stills dir 1.5,6  (PNG stills at given seconds; "mid" = middle of each scene)
//        node render.mjs --meta out.json             (timing + caption metadata for every ad/language)
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright'); // resolves a globally installed Playwright too
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FPS = 30;
const url = (ad, lang) => pathToFileURL(path.join(HERE, 'player.html')).href + `?ad=${ad}&lang=${lang}`;
const args = process.argv.slice(2);

const browser = await chromium.launch({ args: ['--force-color-profile=srgb', '--font-render-hinting=none'] });
const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
const page = await ctx.newPage();
page.on('pageerror', e => { console.error('PAGE ERROR', e.message); process.exitCode = 2; });
page.on('console', m => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
const open = async (ad, lang) => { await page.goto(url(ad, lang)); return page.evaluate(() => window.ready); };

if (args[0] === '--meta') {
  const out = {};
  for (let i = 1; i <= 12; i++) { const ad = 'AD' + String(i).padStart(2, '0'); out[ad] = {}; for (const l of ['fi', 'en', 'ar']) out[ad][l] = await open(ad, l); }
  writeFileSync(args[1], JSON.stringify(out, null, 1));
} else if (args[2] === '--stills') {
  const [ad, lang, , dir, times] = args; mkdirSync(dir, { recursive: true });
  const meta = await open(ad, lang);
  const ts = (!times || times === 'mid') ? meta.scenes.map(s => s.start + (s.end - s.start) * .72) : times.split(',').map(Number);
  for (const t of ts) { await page.evaluate(t => window.seek(t), t); await page.screenshot({ path: path.join(dir, `${ad}_${lang}_${t.toFixed(2).padStart(5, '0')}.png`) }); }
  console.log(ad, lang, 'total', meta.total, 'stills', ts.length);
} else {
  const [ad, lang, out] = args;
  const meta = await open(ad, lang);
  const n = Math.round(meta.total * FPS);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.2',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-movflags', '+faststart', '-r', String(FPS), out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => ff.on('close', c => c ? rej(new Error('ffmpeg ' + c)) : res()));
  for (let f = 0; f < n; f++) {
    await page.evaluate(t => window.seek(t), f / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 97 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  }
  ff.stdin.end(); await done;
  console.log('rendered', ad, lang, n, 'frames', meta.total + 's');
}
await browser.close();
