// extracts each ad's music mood from js/ads*.js for audio.py
import { readFileSync, writeFileSync } from 'node:fs';
const m = {};
for (const f of ['../js/ads.js', '../js/ads2.js', '../js/ads3.js', '../js/ads4.js'])
  for (const x of readFileSync(new URL(f, import.meta.url), 'utf8').matchAll(/\b((?:ST|[GSVFH])\d\d): (?:Object\.assign\()?\{[\s\S]*?music: '(\w+)'/g)) m[x[1]] = x[2];
writeFileSync(new URL('../work/moods.json', import.meta.url), JSON.stringify(m));
