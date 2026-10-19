#!/usr/bin/env bash
# Wrap a Covexcode .deb as a Flatpak bundle.
# Usage: stores/flatpak/build.sh [path-to-amd64.deb]
# FLATPAK_STAGE_ONLY=1 stops after staging the builder dir (used by apply.test.sh).
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$( cd "${SCRIPT_DIR}/../.." && pwd )"
APP_ID="com.covexcode.Covexcode"
APP_NAME="${APP_NAME:-Covexcode}"
FLATPAK_ARCH="${FLATPAK_ARCH:-x86_64}"
ASSETS_DIR="${REPO_ROOT}/assets"

DEB="${1:-}"
if [[ -z "${DEB}" ]]; then
  shopt -s nullglob
  candidates=( "${ASSETS_DIR}"/covexcode-ide_*_amd64.deb "${ASSETS_DIR}"/*_amd64.deb )
  shopt -u nullglob
  if [[ ${#candidates[@]} -eq 0 ]]; then
    echo "No amd64 .deb found. Pass one: $0 path/to/covexcode-ide_*_amd64.deb" >&2
    exit 1
  fi
  DEB="${candidates[0]}"
fi
if [[ ! -f "${DEB}" ]]; then
  echo "deb not found: ${DEB}" >&2
  exit 1
fi
DEB="$( cd "$( dirname "${DEB}" )" && pwd )/$( basename "${DEB}" )"

VERSION="${RELEASE_VERSION:-}"
if [[ -z "${VERSION}" ]]; then
  VERSION="$( basename "${DEB}" | sed -n 's/^covexcode-ide_\(.*\)_amd64\.deb$/\1/p' )"
fi
if [[ -z "${VERSION}" ]]; then
  VERSION="0.0.0"
fi
DATE="$( date -u +%Y-%m-%d )"

mkdir -p "${ASSETS_DIR}"
WORK="${SCRIPT_DIR}/.work"
rm -rf "${WORK}"
mkdir -p "${WORK}"

cp "${SCRIPT_DIR}/com.covexcode.Covexcode.yml" "${WORK}/"
cp "${SCRIPT_DIR}/apply.sh" "${WORK}/"
cp "${SCRIPT_DIR}/covexcode-ide.sh" "${WORK}/"
cp "${REPO_ROOT}/src/stable/resources/linux/code.svg" "${WORK}/code.svg"
cp "${DEB}" "${WORK}/covexcode.deb"
sed \
  -e "s/@@VERSION@@/${VERSION}/g" \
  -e "s/@@DATE@@/${DATE}/g" \
  "${SCRIPT_DIR}/com.covexcode.Covexcode.metainfo.xml.in" \
  > "${WORK}/com.covexcode.Covexcode.metainfo.xml"

if grep -q '@@VERSION@@\|@@DATE@@' "${WORK}/com.covexcode.Covexcode.metainfo.xml"; then
  echo "metainfo still has unsubstituted placeholders" >&2
  exit 1
fi
if ! grep -q "<release version=\"${VERSION}\"" "${WORK}/com.covexcode.Covexcode.metainfo.xml"; then
  echo "metainfo version was not set to ${VERSION}" >&2
  exit 1
fi

if [[ "${FLATPAK_STAGE_ONLY:-}" == "1" ]]; then
  echo "Staged ${WORK} version=${VERSION}"
  exit 0
fi

if ! command -v flatpak-builder >/dev/null 2>&1; then
  echo "flatpak-builder is not installed" >&2
  exit 1
fi

if ! flatpak remotes | grep -q flathub; then
  flatpak remote-add --if-not-exists --user flathub https://flathub.org/repo/flathub.flatpakrepo
fi

cd "${WORK}"
flatpak-builder \
  --user \
  --force-clean \
  --disable-rofiles-fuse \
  --install-deps-from=flathub \
  --repo=repo \
  build-dir \
  com.covexcode.Covexcode.yml

BUNDLE="${ASSETS_DIR}/${APP_NAME}-${FLATPAK_ARCH}.flatpak"
flatpak build-bundle repo "${BUNDLE}" "${APP_ID}" --arch="${FLATPAK_ARCH}"
echo "Wrote ${BUNDLE}"
