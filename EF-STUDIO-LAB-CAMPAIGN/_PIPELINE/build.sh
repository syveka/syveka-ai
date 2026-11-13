#!/bin/bash
# Full campaign build: 12 ads x 3 languages -> ../ADxx/ and ../FINAL-EXPORTS/. Zero paid services.
# Usage: ./build.sh            (everything)      ./build.sh AD03 ar   (one export)
set -e
cd "$(dirname "$0")"
mkdir -p work/video work/audio
one() {
  ad=$1; l=$2; L=$(echo $l | tr a-z A-Z); out=../$ad/EF-Studio-Lab_${ad}_$L.mp4
  node render.mjs $ad $l work/video/${ad}_$l.mp4
  ffmpeg -y -loglevel error -i work/video/${ad}_$l.mp4 -i work/audio/$ad.wav -map 0:v -map 1:a -c:v copy \
    -af "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000" -c:a aac -b:a 192k -shortest -movflags +faststart "$out"
  cp "$out" ../FINAL-EXPORTS/
}
export -f one
if [ -n "$1" ]; then one $1 $2; exit; fi
node render.mjs --meta work/meta.json
node tools/moods.mjs
python3 audio.py work/meta.json work/audio
for a in 01 02 03 04 05 06 07 08 09 10 11 12 13; do for l in fi en ar; do echo "AD$a $l"; done; done | xargs -P 4 -L 1 bash -c 'one $0 $1'
python3 tools/docs.py
