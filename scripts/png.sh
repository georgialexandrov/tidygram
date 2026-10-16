#!/bin/sh
# Rasterise an SVG with headless Chrome: scripts/png.sh in.svg out.png [width]
set -e
svg="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
width="${3:-1600}"
dims=$(grep -oE 'viewBox="[^"]+"' "$1" | head -1 | tr -d '"' | cut -d= -f2)
w=$(echo "$dims" | awk '{print $3}'); h=$(echo "$dims" | awk '{print $4}')
height=$(awk -v w="$w" -v h="$h" -v W="$width" 'BEGIN { printf "%d", W * h / w + 0.5 }')
html="$(mktemp -t svgpng).html"
printf '<html><body style="margin:0"><img src="file://%s" style="display:block;width:%spx;height:%spx"></body></html>' "$svg" "$width" "$height" > "$html"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --allow-file-access-from-files --window-size="$width,$((height + 200))" --screenshot="$2" "file://$html" >/dev/null 2>&1
rm -f "$html"
echo "$2 (${width}x${height})"
