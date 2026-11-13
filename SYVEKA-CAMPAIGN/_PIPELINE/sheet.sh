#!/bin/bash
# contact sheet for review: sheet.sh AD01 fi [times]
set -e
cd "$(dirname "$0")"
D=work/stills/$1_$2; rm -rf "$D"; node render.mjs $1 $2 --stills "$D" ${3:-mid}
ffmpeg -y -loglevel error -pattern_type glob -i "$D/*.png" -vf "scale=432:768,tile=6x1:padding=6" -frames:v 1 work/sheet_$1_$2.png
