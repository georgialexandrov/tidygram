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
# Chrome's screenshot is taller than the diagram (the window is padded because the viewport comes up short by a
# variable amount), which left a white band. Keep exactly the first $height rows: PNG scanline filters only look
# upwards, so dropping rows from the bottom needs no re-encoding.
python3 - "$2" "$width" "$height" <<'PY'
import struct, sys, zlib
path, w, h = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
data = open(path, 'rb').read()
pos, chunks = 8, []
while pos < len(data):
    n, t = struct.unpack('>I4s', data[pos:pos + 8])
    chunks.append((t, data[pos + 8:pos + 8 + n]))
    pos += 12 + n
ihdr = next(c for t, c in chunks if t == b'IHDR')
W, H, depth, ctype = struct.unpack('>IIBB', ihdr[:10])
if H > h and W == w and depth == 8 and ctype in (2, 6) and ihdr[12] == 0:
    stride = 1 + W * (4 if ctype == 6 else 3)
    raw = zlib.decompress(b''.join(c for t, c in chunks if t == b'IDAT'))[: stride * h]
    out = [(t, struct.pack('>IIBBBBB', W, h, *ihdr[8:13]) if t == b'IHDR' else c) for t, c in chunks if t != b'IDAT']
    out.insert(1, (b'IDAT', zlib.compress(raw)))
    with open(path, 'wb') as f:
        f.write(data[:8])
        for t, c in out:
            f.write(struct.pack('>I', len(c)) + t + c + struct.pack('>I', zlib.crc32(t + c)))
PY
echo "$2 (${width}x${height})"
