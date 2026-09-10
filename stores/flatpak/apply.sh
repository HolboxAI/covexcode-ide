#!/usr/bin/env bash
# Unpack the .deb into $APP_ROOT (default /app). Run by flatpak-builder.
# APP_ROOT is overridable so apply.test.sh can exercise this without writing
# to a real /app (and without GNU install -D, which macOS /usr/bin/install
# does not have).
set -euo pipefail

APP_ID="${FLATPAK_ID:-ai.holbox.Boxcode}"
APP_ROOT="${FLATPAK_DEST:-/app}"
SHARE_NAME="boxcode-ide"

install_file() {
  local mode="$1" src="$2" dest="$3"
  mkdir -p "$(dirname "${dest}")"
  cp "${src}" "${dest}"
  chmod "${mode}" "${dest}"
}

install_file 644 code.svg "${APP_ROOT}/share/icons/hicolor/scalable/apps/${APP_ID}.svg"
install_file 644 ai.holbox.Boxcode.metainfo.xml "${APP_ROOT}/share/metainfo/${APP_ID}.metainfo.xml"
install_file 755 boxcode-ide.sh "${APP_ROOT}/bin/boxcode-ide"

ar x boxcode.deb

shopt -s nullglob
data_tars=( data.tar.* )
if [[ ${#data_tars[@]} -eq 0 ]]; then
  echo "boxcode.deb has no data.tar.*" >&2
  exit 1
fi
tar -xf "${data_tars[0]}"

if [[ ! -d "usr/share/${SHARE_NAME}" ]]; then
  echo "deb did not unpack usr/share/${SHARE_NAME}" >&2
  find usr/share -maxdepth 2 -type d >&2 || true
  exit 1
fi

mkdir -p "${APP_ROOT}/share"
cp -a "usr/share/${SHARE_NAME}" "${APP_ROOT}/share/${SHARE_NAME}"
rm -f "${APP_ROOT}/share/${SHARE_NAME}/chrome-sandbox"

rewrite_desktop() {
  local src="$1"
  local dest="$2"
  local tmp
  [[ -f "${src}" ]] || return 0
  tmp="$(basename "${dest}").tmp"
  sed \
    -e "s|Icon=.*|Icon=${APP_ID}|" \
    -e "s|Exec=.*/${SHARE_NAME}|Exec=${SHARE_NAME}|" \
    "${src}" > "${tmp}"
  install_file 644 "${tmp}" "${dest}"
  rm -f "${tmp}"
}

if [[ ! -f "usr/share/applications/${SHARE_NAME}.desktop" ]]; then
  echo "deb is missing usr/share/applications/${SHARE_NAME}.desktop" >&2
  exit 1
fi
rewrite_desktop \
  "usr/share/applications/${SHARE_NAME}.desktop" \
  "${APP_ROOT}/share/applications/${APP_ID}.desktop"
rewrite_desktop \
  "usr/share/applications/${SHARE_NAME}-url-handler.desktop" \
  "${APP_ROOT}/share/applications/${APP_ID}-url-handler.desktop"

if [[ -f usr/share/pixmaps/${SHARE_NAME}.png ]]; then
  install_file 644 "usr/share/pixmaps/${SHARE_NAME}.png" \
    "${APP_ROOT}/share/icons/hicolor/128x128/apps/${APP_ID}.png"
fi

if [[ -f usr/share/mime/packages/${SHARE_NAME}-workspace.xml ]]; then
  install_file 644 "usr/share/mime/packages/${SHARE_NAME}-workspace.xml" \
    "${APP_ROOT}/share/mime/packages/${APP_ID}-workspace.xml"
fi
