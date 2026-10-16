#!/usr/bin/env bash
# Vendoriza los módulos de EasyIndustry que usa la app, tal cual, en vendor/.
#
#   scripts/vendor.sh                     # desde GitHub, en la versión de VERSIONS abajo
#   scripts/vendor.sh /ruta/a/los/repos   # desde clones locales (con cambios locales que esperan su issue)
#
# Cada copia lleva su VERSION (de dónde salió: etiqueta o rama, y el commit exacto) y su LICENSE.
# La copia no se edita en la app: un cambio va al repo del módulo, como issue (ver POLITICA.md).
set -euo pipefail
cd "$(dirname "$0")/.."

# repo  carpeta-en-vendor  versión(etiqueta o rama)  qué se copia
MODULOS=(
  "ThreeJS-cad-SDK threejs-cad-sdk main src,adapters,LICENSE"
  "threejs-render-engine threejs-render-engine main src,LICENSE"
  "threejs-material-engine threejs-material-engine main src,adapters,LICENSE"
)
LOCAL="${1:-}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for m in "${MODULOS[@]}"; do
  read -r repo dir ref que <<<"$m"
  if [[ -n "$LOCAL" ]]; then
    src="$LOCAL/$repo"
    ref="$(git -C "$src" rev-parse --abbrev-ref HEAD)"
  else
    src="$TMP/$repo"
    git clone -q --depth 1 --branch "$ref" "https://github.com/EasyIndustry/$repo.git" "$src"
  fi
  dest="vendor/$dir"
  rm -rf "$dest" && mkdir -p "$dest"
  IFS=',' read -ra partes <<<"$que"
  for p in "${partes[@]}"; do cp -r "$src/$p" "$dest/"; done
  version="$(node -p "require('$src/package.json').version")"
  echo "$version $ref $(git -C "$src" rev-parse HEAD)" > "$dest/VERSION"
  if [[ -n "$(git -C "$src" status --porcelain)" ]]; then echo "ojo: $repo tiene cambios sin commitear" >&2; fi
  echo "$dest ← $repo $(cat "$dest/VERSION")"
done
