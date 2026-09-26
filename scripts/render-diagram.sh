#!/usr/bin/env sh
# Render docs/diagrams/*.excalidraw to SVG via Kroki and pad the viewBox so
# rasterizers never clip edge content (Kroki's computed bounds can be tight).
#
# Usage: scripts/render-diagram.sh [file.excalidraw ...]
# Default: all .excalidraw files under docs/diagrams.
set -eu

cd "$(dirname "$0")/.."

files=${*:-}
[ -n "$files" ] || files=$(ls docs/diagrams/*.excalidraw)

for src in $files; do
  out=${src%.excalidraw}.svg
  curl -fsSL --data-binary @"$src" -H "Content-Type: text/plain" \
    https://kroki.io/excalidraw/svg -o "$out"
  # Pad the viewBox with a 20px margin on every side.
  python3 - "$out" <<'EOF'
import re, sys

path = sys.argv[1]
s = open(path).read()
m = re.search(r'viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"', s)
if not m:
    sys.exit(f"no viewBox found in {path}")
x, y, w, h = (float(g) for g in m.groups())
x, y, w, h = x - 20, y - 20, w + 40, h + 40
s = s[:m.start()] + f'viewBox="{x:g} {y:g} {w:g} {h:g}"' + s[m.end():]
s = re.sub(r'(<svg[^>]*?)width="[\d.]+" height="[\d.]+"',
           rf'\g<1>width="{w:g}" height="{h:g}"', s, count=1)
open(path, "w").write(s)
EOF
  echo "rendered $src -> $out"
done
