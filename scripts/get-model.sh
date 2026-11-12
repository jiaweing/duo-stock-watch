#!/bin/bash
# Downloads Apple's own iPhone Duo AR model from apple.com and prepares it for the page background.
#
#   ./scripts/get-model.sh
#   COLOR=Night_Sky ./scripts/get-model.sh
#
# The model is Apple's copyrighted file. This script fetches it to your machine for your own use;
# it is saved under model/, which is gitignored. Do not commit or redistribute it.
#
# macOS only: it uses usdcat, which ships with macOS. The page works without the model.

set -euo pipefail

URL="${1:-https://www.apple.com/105/media/us/iphone-duo/2026/9305e4b9-72d9-4c05-9381-b572adadd5e5/ar/iPhone_Duo_e-sim_Star-White_Variant.usdz}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
COLOR="${COLOR:-Star_White}" # or Night_Sky

command -v usdcat >/dev/null || { echo "usdcat not found. This script needs macOS."; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Downloading model from apple.com (about 8 MB)..."
curl -fsSL -o "$WORK/apple.usdz" "$URL"

# Apple's file is several layers that reference each other. The browser loader cannot follow
# those references, so flatten everything into one layer and point textures at relative paths.
mkdir "$WORK/src"
unzip -q "$WORK/apple.usdz" -d "$WORK/src"
FIRST="$(unzip -Z1 "$WORK/apple.usdz" | head -1)"

DEFAULT_PRIM="$(usdcat "$WORK/src/$FIRST" | sed -n 's/^ *defaultPrim = "\(.*\)"$/\1/p' | head -1)"
mkdir -p "$ROOT/model"

# Apple's file holds two still poses, "Closed" and "Landscape" (unfolded), and no fold animation.
# The page folds the phone itself, starting from the unfolded pose, so that is the one to build.
build() { # build <pose variant> <output name>
  local pose="$1" out="$ROOT/model/$2"
  echo "Building $2..."
  cat > "$WORK/pick.usda" <<USDA
#usda 1.0
(
    defaultPrim = "$DEFAULT_PRIM"
    metersPerUnit = 0.01
    upAxis = "Y"
)

def "$DEFAULT_PRIM" (
    prepend references = @$WORK/src/$FIRST@
    variants = {
        string Color = "$COLOR"
        string Pose = "$pose"
    }
)
{
}
USDA
  usdcat --flatten "$WORK/pick.usda" -o "$WORK/flat.usda"
  sed "s#@$WORK/src/#@#g" "$WORK/flat.usda" > "$WORK/src/duo.usda"
  usdcat "$WORK/src/duo.usda" -o "$WORK/src/duo.usdc"
  rm -f "$out"
  (
    cd "$WORK/src"
    # The flattened layer goes first; keep only image files from the rest.
    zip -q -0 "$out" duo.usdc
    find . -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' -o -name '*.avif' \) | sed 's#^\./##' | zip -q -0 "$out" -@
  )
}

build Landscape duo.usdz
rm -f "$ROOT/model/duo-closed.usdz" "$ROOT/model/duo-open.usdz" # names used by an earlier version

echo "Saved model/duo.usdz ($(du -h "$ROOT/model/duo.usdz" | cut -f1 | tr -d ' '))."
echo "Reload http://localhost:4173 to see it."
