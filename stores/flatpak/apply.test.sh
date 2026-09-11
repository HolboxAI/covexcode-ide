#!/usr/bin/env bash
# Prove apply.sh unpacks a Code-OSS-shaped .deb the way gulpfile.vscode.linux.ts
# actually writes one (usr/share/<applicationName>, desktop Exec pointing at
# the electron binary). No vscode checkout and no flatpak-builder required.
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/../.." && pwd )"
APP_ID="ai.holbox.Boxcode"
SHARE_NAME="boxcode-ide"

ROOT="$( mktemp -d "${TMPDIR:-/tmp}/boxcode-flatpak.XXXXXX" )"
cleanup() { rm -rf "${ROOT}"; }
trap cleanup EXIT

PKG="${ROOT}/pkg"
WORK="${ROOT}/work"
APP="${ROOT}/app"
DEB="${ROOT}/boxcode-ide_1.126.06080_amd64.deb"
mkdir -p \
  "${PKG}/usr/share/${SHARE_NAME}/bin" \
  "${PKG}/usr/share/applications" \
  "${PKG}/usr/share/pixmaps" \
  "${PKG}/usr/share/mime/packages" \
  "${WORK}"

printf '#!/bin/sh\necho electron\n' > "${PKG}/usr/share/${SHARE_NAME}/${SHARE_NAME}"
printf '#!/bin/sh\necho cli\n' > "${PKG}/usr/share/${SHARE_NAME}/bin/${SHARE_NAME}"
printf 'suid-stub\n' > "${PKG}/usr/share/${SHARE_NAME}/chrome-sandbox"
chmod 755 "${PKG}/usr/share/${SHARE_NAME}/${SHARE_NAME}" "${PKG}/usr/share/${SHARE_NAME}/bin/${SHARE_NAME}"

# Same Exec as gulp's replace of @@EXEC@@.
cat > "${PKG}/usr/share/applications/${SHARE_NAME}.desktop" << EOF
[Desktop Entry]
Name=Boxcode IDE
Exec=/usr/share/${SHARE_NAME}/${SHARE_NAME} %F
Icon=${SHARE_NAME}
Type=Application
Actions=new-empty-window;

[Desktop Action new-empty-window]
Exec=/usr/share/${SHARE_NAME}/${SHARE_NAME} --new-window %F
Icon=${SHARE_NAME}
EOF

cat > "${PKG}/usr/share/applications/${SHARE_NAME}-url-handler.desktop" << EOF
[Desktop Entry]
Name=Boxcode IDE - URL Handler
Exec=/usr/share/${SHARE_NAME}/${SHARE_NAME} --open-url %U
Icon=${SHARE_NAME}
NoDisplay=true
EOF

printf 'png\n' > "${PKG}/usr/share/pixmaps/${SHARE_NAME}.png"
printf '<mime/>\n' > "${PKG}/usr/share/mime/packages/${SHARE_NAME}-workspace.xml"

( cd "${PKG}" && tar czf "${WORK}/data.tar.gz" usr )
printf 'Package: boxcode-ide\nVersion: 1.126.06080\nArchitecture: amd64\n' > "${WORK}/control"
( cd "${WORK}" && tar czf control.tar.gz control )
printf '2.0\n' > "${WORK}/debian-binary"
( cd "${WORK}" && ar r "${DEB}" debian-binary control.tar.gz data.tar.gz )

cp "${SCRIPT_DIR}/apply.sh" "${WORK}/"
cp "${SCRIPT_DIR}/boxcode-ide.sh" "${WORK}/"
cp "${REPO_ROOT}/src/stable/resources/linux/code.svg" "${WORK}/code.svg"
printf '<component><release version="test"/></component>\n' > "${WORK}/ai.holbox.Boxcode.metainfo.xml"
cp "${DEB}" "${WORK}/boxcode.deb"

(
  cd "${WORK}"
  FLATPAK_DEST="${APP}" FLATPAK_ID="${APP_ID}" bash apply.sh
)

fail() { echo "FAIL: $*" >&2; exit 1; }

[[ -x "${APP}/bin/boxcode-ide" ]] || fail "wrapper missing"
[[ -x "${APP}/share/${SHARE_NAME}/${SHARE_NAME}" ]] || fail "electron binary missing"
[[ -x "${APP}/share/${SHARE_NAME}/bin/${SHARE_NAME}" ]] || fail "cli launcher missing"
[[ ! -e "${APP}/share/${SHARE_NAME}/chrome-sandbox" ]] || fail "chrome-sandbox was not removed"
[[ -f "${APP}/share/icons/hicolor/scalable/apps/${APP_ID}.svg" ]] || fail "svg icon missing"
[[ -f "${APP}/share/icons/hicolor/128x128/apps/${APP_ID}.png" ]] || fail "png icon missing"
[[ -f "${APP}/share/mime/packages/${APP_ID}-workspace.xml" ]] || fail "mime xml missing"
[[ -f "${APP}/share/metainfo/${APP_ID}.metainfo.xml" ]] || fail "metainfo missing"

desktop="${APP}/share/applications/${APP_ID}.desktop"
grep -q '^Exec=boxcode-ide %F$' "${desktop}" || fail "desktop Exec not rewritten: $(grep '^Exec=' "${desktop}")"
grep -q '^Exec=boxcode-ide --new-window %F$' "${desktop}" || fail "action Exec not rewritten"
grep -q "^Icon=${APP_ID}$" "${desktop}" || fail "desktop Icon not rewritten"

handler="${APP}/share/applications/${APP_ID}-url-handler.desktop"
grep -q '^Exec=boxcode-ide --open-url %U$' "${handler}" || fail "url-handler Exec not rewritten"

grep -q '\.local/bin' "${APP}/bin/boxcode-ide" || fail "wrapper does not put ~/.local/bin on PATH"
grep -q -- '--no-sandbox' "${APP}/bin/boxcode-ide" || fail "wrapper does not pass --no-sandbox"
grep -q '/app/share/boxcode-ide/boxcode-ide' "${APP}/bin/boxcode-ide" || fail "wrapper does not launch the electron binary"
if grep -q '/app/share/boxcode-ide/bin/boxcode-ide' "${APP}/bin/boxcode-ide"; then
  fail "wrapper must not launch the CLI script (that is ELECTRON_RUN_AS_NODE / cli.js)"
fi

FLATPAK_STAGE_ONLY=1 "${SCRIPT_DIR}/build.sh" "${DEB}" >/dev/null
staged="${SCRIPT_DIR}/.work/ai.holbox.Boxcode.metainfo.xml"
[[ -f "${staged}" ]] || fail "build.sh did not stage metainfo"
grep -q '<release version="1.126.06080"' "${staged}" || fail "build.sh did not substitute version from the deb name"
rm -rf "${SCRIPT_DIR}/.work"

echo "ok: apply.sh unpacks a Code-OSS .deb and rewrites desktop files"
