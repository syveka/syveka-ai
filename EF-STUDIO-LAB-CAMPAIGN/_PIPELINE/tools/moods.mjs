// extracts each ad's music mood from js/ads.js for audio.py
import { readFileSync, writeFileSync } from 'node:fs';
const m = {}; for (const x of readFileSync(new URL('../js/ads.js', import.meta.url), 'utf8').matchAll(/(AD\d\d): \{[\s\S]*?music: '(\w+)'/g)) m[x[1]] = x[2];
writeFileSync(new URL('../work/moods.json', import.meta.url), JSON.stringify(m));
