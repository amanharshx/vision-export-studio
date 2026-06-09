#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <version> <appimage-path> <output-dir>" >&2
  exit 1
fi

VERSION="$1"
APPIMAGE_PATH="$2"
OUTPUT_DIR="$3"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"
ICON_PATH="${REPO_ROOT}/src-tauri/icons/128x128@2x.png"

if [[ -z "$VERSION" ]]; then
  echo "missing version" >&2
  exit 1
fi

if [[ ! -f "$APPIMAGE_PATH" ]]; then
  echo "missing AppImage: $APPIMAGE_PATH" >&2
  exit 1
fi

if [[ ! -f "$ICON_PATH" ]]; then
  echo "missing icon: $ICON_PATH" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

ROOT_DIR="${WORK_DIR}/vision-export-studio-linux-x86_64"

mkdir -p \
  "${ROOT_DIR}/bin" \
  "${ROOT_DIR}/libexec" \
  "${ROOT_DIR}/share/applications" \
  "${ROOT_DIR}/share/icons/hicolor/256x256/apps"

install -m 0755 "$APPIMAGE_PATH" "${ROOT_DIR}/libexec/vision-export-studio.AppImage"

cat > "${ROOT_DIR}/bin/vision-export-studio" <<'SH'
#!/usr/bin/env sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
PREFIX="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"

exec "${PREFIX}/libexec/vision-export-studio.AppImage" "$@"
SH
chmod 0755 "${ROOT_DIR}/bin/vision-export-studio"

cat > "${ROOT_DIR}/share/applications/vision-export-studio.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Vision Export Studio
Exec=vision-export-studio
Icon=vision-export-studio
Categories=Development;Utility;
Terminal=false
DESKTOP

install -m 0644 \
  "$ICON_PATH" \
  "${ROOT_DIR}/share/icons/hicolor/256x256/apps/vision-export-studio.png"

mkdir -p "$OUTPUT_DIR"
tar -C "$WORK_DIR" -czf \
  "${OUTPUT_DIR}/vision-export-studio-linux-x86_64.tar.gz" \
  "vision-export-studio-linux-x86_64"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "${OUTPUT_DIR}/vision-export-studio-linux-x86_64.tar.gz"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "${OUTPUT_DIR}/vision-export-studio-linux-x86_64.tar.gz"
else
  echo "missing checksum tool: need sha256sum or shasum" >&2
  exit 1
fi
