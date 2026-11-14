#!/bin/bash
# Full campaign build: 12 ads x 3 languages -> ../ADxx/ and ../FINAL-EXPORTS/. Zero paid services.
# Usage: ./build.sh            (everything)      ./build.sh AD03 ar   (one export)
set -e
cd "$(dirname "$0")"
mkdir -p work/video work/audio
one() {
  ad=$1; l=$2; mkdir -p ../$ad ../FINAL-EXPORTS; L=$(echo $l | tr a-z A-Z); out=../$ad/Syveka_${ad}_$L.mp4
  node render.mjs $ad $l work/video/${ad}_$l.mp4
  ffmpeg -y -loglevel error -i work/video/${ad}_$l.mp4 -i work/audio/$ad.wav -map 0:v -map 1:a -c:v copy \
    -af "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000" -c:a aac -b:a 192k -shortest -movflags +faststart "$out"
  cp "$out" ../FINAL-EXPORTS/
}
export -f one
if [ -n "$1" ]; then one $1 $2; exit; fi
# frames of the owner-supplied reference clip (slowed 1.6x) for the hologram-style ads
if [ ! -f work/clip/0239.jpg ]; then mkdir -p work/clip; ffmpeg -y -loglevel error -i ../HOLOGRAM-STYLE/source/reference-clip.mp4 -vf "minterpolate=fps=48:mi_mode=mci:mc_mode=aobmc:vsbmc=1,setpts=1.6*PTS,scale=1080:1882:flags=lanczos,crop=1080:1882,unsharp=5:5:0.6,pad=1080:1920:0:19:black" -r 30 -q:v 3 work/clip/%04d.jpg; fi
node render.mjs --meta work/meta.json
node tools/moods.mjs
python3 audio.py work/meta.json work/audio
for a in $(node -e "console.log(Object.keys(require('./work/meta.json')).join(' '))"); do for l in fi en ar; do echo "$a $l"; done; done | xargs -P 4 -L 1 bash -c 'one $0 $1'
python3 tools/docs.py
